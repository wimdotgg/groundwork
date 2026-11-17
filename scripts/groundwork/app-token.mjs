import { KeyObject, createPrivateKey, createSign } from 'node:crypto';
import { GitHubError, apiPath, createClient } from '../lib/github.mjs';

/** @typedef {import('../lib/github.mjs').GitHubClient} GitHubClient */

// GitHub accepts up to 10 minutes of validity; we mint for 9 to absorb clock skew.
const CLOCK_SKEW_SECONDS = 60;
const TOKEN_VALID_SECONDS = 540;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const PERMISSION_LEVELS = new Set(['read', 'write']);
const ALL_REPOSITORIES = 'all';
const UNUSABLE_KEY_MESSAGE = 'app-token: cannot sign JWT (private key is not a usable RSA PEM)';

/**
 * @param {{ clientId: string, privateKey: string|import('node:crypto').KeyObject, now?: Date }} options
 * @returns {string} RS256 JWT, base64url segments
 */
export function createAppJwt({ clientId, privateKey, now = new Date() }) {
  if (typeof clientId !== 'string' || clientId === '') {
    throw new GitHubError('app-token: clientId must be a non-empty string');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new GitHubError('app-token: now must be a valid Date');
  }
  const key = parseRsaPrivateKey(privateKey);
  const seconds = Math.floor(now.getTime() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iat: seconds - CLOCK_SKEW_SECONDS,
    exp: seconds + TOKEN_VALID_SECONDS,
    iss: clientId,
  }));
  try {
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    signer.end();
    return `${header}.${payload}.${signer.sign(key, 'base64url')}`;
  } catch {
    throw new GitHubError(UNUSABLE_KEY_MESSAGE);
  }
}

/**
 * @param {string|import('node:crypto').KeyObject} privateKey
 * @returns {import('node:crypto').KeyObject}
 */
function parseRsaPrivateKey(privateKey) {
  let key;
  try {
    key = privateKey instanceof KeyObject ? privateKey : createPrivateKey(privateKey);
  } catch {
    throw new GitHubError(UNUSABLE_KEY_MESSAGE);
  }
  if (key.asymmetricKeyType !== 'rsa') throw new GitHubError(UNUSABLE_KEY_MESSAGE);
  return key;
}

/**
 * @param {string} json
 * @returns {string}
 */
function base64url(json) {
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * @param {unknown} permissions
 * @returns {Record<string, string>}
 */
function validatePermissions(permissions) {
  if (typeof permissions !== 'object' || permissions === null || Array.isArray(permissions)
    || Object.keys(permissions).length === 0) {
    throw new GitHubError('app-token: permissions must be a non-empty object of read/write values');
  }
  for (const [name, level] of Object.entries(permissions)) {
    if (!PERMISSION_LEVELS.has(level)) {
      throw new GitHubError(`app-token: permission ${name} must be read or write`);
    }
  }
  return /** @type {Record<string, string>} */ (permissions);
}

/**
 * @param {unknown} repositories
 * @returns {string[]|undefined} undefined for an installation-wide token
 */
function validateRepositories(repositories) {
  if (repositories === ALL_REPOSITORIES) return undefined;
  if (!Array.isArray(repositories) || repositories.length === 0) {
    throw new GitHubError(`app-token: repositories must be a non-empty array of names or '${ALL_REPOSITORIES}'`);
  }
  for (const name of repositories) {
    if (typeof name !== 'string' || !REPOSITORY_NAME_PATTERN.test(name)) {
      throw new GitHubError('app-token: repository names must match ^[A-Za-z0-9._-]+$');
    }
  }
  return repositories;
}

/**
 * Granted must equal requested: narrower means the App lacks a permission,
 * broader means more power than the op asked for. The one exception is
 * `metadata: read`, which GitHub adds to every repository-scoped token.
 * @param {Record<string, string>} requested
 * @param {unknown} granted
 * @returns {boolean}
 */
function samePermissions(requested, granted) {
  if (typeof granted !== 'object' || granted === null || Array.isArray(granted)) return false;
  const requestedKeys = Object.keys(requested);
  const metadataAutoGranted = !requestedKeys.includes('metadata') && granted.metadata === 'read';
  const grantedKeyCount = Object.keys(granted).length - (metadataAutoGranted ? 1 : 0);
  if (grantedKeyCount !== requestedKeys.length) return false;
  return requestedKeys.every((name) => granted[name] === requested[name]);
}

/**
 * @param {string[]} requested
 * @param {unknown} granted GitHub returns objects with a name field
 * @returns {boolean}
 */
function sameRepositoryNames(requested, granted) {
  if (!Array.isArray(granted)) return false;
  const grantedNames = granted.map((entry) => (entry !== null && typeof entry === 'object' ? entry.name : entry));
  if (grantedNames.length !== requested.length) return false;
  const sort = (names) => [...names].sort();
  return JSON.stringify(sort(grantedNames)) === JSON.stringify(sort(requested));
}

/**
 * Mints an installation token restricted to the op's repositories and
 * permissions. Fails closed: when GitHub grants a different scope (see
 * `samePermissions` for the `metadata: read` exception) or the response is
 * malformed, the token is revoked and a GitHubError is thrown. If revocation
 * itself fails the error says so, because the token then stays valid until expiry.
 *
 * `repositories` is required: a non-empty array of names, or `'all'` for an
 * installation-wide token (org-level ops), which sends no repositories key and
 * skips the repository comparison. `makeClient` builds a client on an
 * installation token; it defaults to one built from `env` and is a test seam.
 * @param {{
 *   client: GitHubClient, org: string, repositories: string[]|'all',
 *   permissions: Record<string, 'read'|'write'>,
 *   env?: Record<string, string|undefined>,
 *   makeClient?: (token: string) => GitHubClient,
 * }} options
 * @returns {Promise<{ token: string, expiresAt: Date }>}
 */
export async function mintInstallationToken({
  client, org, repositories, permissions, env = {}, makeClient = (token) => createClient({ env, token }),
}) {
  if (typeof org !== 'string' || org === '') {
    throw new GitHubError('app-token: org must be a non-empty string');
  }
  const wantedPermissions = validatePermissions(permissions);
  const wantedRepositories = validateRepositories(repositories);
  const installation = await client.request('GET', apiPath('/orgs/{org}/installation', { org }));
  const installationId = installation.data?.id;
  if (typeof installationId !== 'number') {
    throw new GitHubError(`app-token: GET /orgs/${org}/installation returned no installation id`, { status: 0 });
  }

  const body = { permissions: wantedPermissions };
  if (wantedRepositories !== undefined) body.repositories = wantedRepositories;
  const response = await client.request(
    'POST', apiPath('/app/installations/{id}/access_tokens', { id: installationId }), { body },
  );

  const token = response.data?.token;
  const expiresAt = typeof response.data?.expires_at === 'string' ? new Date(response.data.expires_at) : null;
  const problem = findGrantProblem({ token, expiresAt, wantedPermissions, wantedRepositories, data: response.data });
  if (problem === undefined) return { token, expiresAt };
  await revokeThenThrow(token, problem, makeClient);
}

/**
 * @param {{ token: unknown, expiresAt: Date|null, wantedPermissions: Record<string, string>,
 *   wantedRepositories: string[]|undefined, data: any }} grant
 * @returns {string|undefined} what is wrong, or undefined when the grant matches the request
 */
function findGrantProblem({ token, expiresAt, wantedPermissions, wantedRepositories, data }) {
  if (!isUsableToken(token) || expiresAt === null || Number.isNaN(expiresAt.getTime())) {
    return 'access_tokens response is missing token or expires_at';
  }
  if (!samePermissions(wantedPermissions, data?.permissions)) {
    return 'granted permissions differ from requested';
  }
  if (wantedRepositories !== undefined && !sameRepositoryNames(wantedRepositories, data?.repositories)) {
    return 'granted repositories differ from requested';
  }
  return undefined;
}

/** @param {unknown} token */
function isUsableToken(token) {
  return typeof token === 'string' && token !== '';
}

/**
 * @param {unknown} token revoked only when it is a usable string
 * @param {string} problem
 * @param {(token: string) => GitHubClient} makeClient
 * @returns {Promise<never>}
 */
async function revokeThenThrow(token, problem, makeClient) {
  if (!isUsableToken(token)) throw new GitHubError(`app-token: ${problem}`, { status: 0 });
  try {
    await revokeInstallationToken(makeClient(/** @type {string} */ (token)));
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : 0;
    throw new GitHubError(
      `app-token: ${problem}; revocation failed (status ${status}), token valid until expiry`,
      { status: 0 },
    );
  }
  throw new GitHubError(`app-token: ${problem}`, { status: 0 });
}

/** @param {GitHubClient} client a client authenticated with the installation token */
export async function revokeInstallationToken(client) {
  await client.request('DELETE', '/installation/token');
}


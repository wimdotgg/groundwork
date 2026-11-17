import { createSign } from 'node:crypto';
import { GitHubError, apiPath, createClient } from '../lib/github.mjs';

/** @typedef {import('../lib/github.mjs').GitHubClient} GitHubClient */

// GitHub accepts up to 10 minutes of validity; we mint for 9 to absorb clock skew.
const CLOCK_SKEW_SECONDS = 60;
const TOKEN_VALID_SECONDS = 540;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const PERMISSION_LEVELS = new Set(['read', 'write']);

/**
 * @param {{ clientId: string, privateKey: string|import('node:crypto').KeyObject, now?: Date }} options
 * @returns {string} RS256 JWT, base64url segments
 */
export function createAppJwt({ clientId, privateKey, now = new Date() }) {
  if (typeof clientId !== 'string' || clientId === '') {
    throw new GitHubError('app-token: clientId must be a non-empty string');
  }
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
    return `${header}.${payload}.${signer.sign(privateKey, 'base64url')}`;
  } catch {
    throw new GitHubError('app-token: cannot sign JWT (private key is not a usable RSA PEM)');
  }
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
 * @returns {string[]|undefined} undefined when omitted
 */
function validateRepositories(repositories) {
  if (repositories === undefined) return undefined;
  if (!Array.isArray(repositories) || repositories.length === 0) {
    throw new GitHubError('app-token: repositories must be a non-empty array of names');
  }
  for (const name of repositories) {
    if (typeof name !== 'string' || !REPOSITORY_NAME_PATTERN.test(name)) {
      throw new GitHubError('app-token: repository names must match ^[A-Za-z0-9._-]+$');
    }
  }
  return repositories;
}

/**
 * Grants narrower than requested mean the App lacks a permission; refuse rather
 * than run the op half-scoped.
 * @param {Record<string, string>} requested
 * @param {unknown} granted
 * @returns {boolean}
 */
function samePermissions(requested, granted) {
  if (typeof granted !== 'object' || granted === null || Array.isArray(granted)) return false;
  const grantedKeys = Object.keys(granted);
  const requestedKeys = Object.keys(requested);
  if (grantedKeys.length !== requestedKeys.length) return false;
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
 * permissions; revokes it and throws when GitHub grants different scope.
 * `makeClient` builds a client on an installation token; it is a test seam.
 * @param {{
 *   client: GitHubClient, org: string, repositories?: string[],
 *   permissions: Record<string, 'read'|'write'>,
 *   makeClient?: (token: string) => GitHubClient,
 * }} options
 * @returns {Promise<{ token: string, expiresAt: Date }>}
 */
export async function mintInstallationToken({
  client, org, repositories, permissions, makeClient = defaultMakeClient,
}) {
  if (typeof org !== 'string' || org === '') {
    throw new GitHubError('app-token: org must be a non-empty string');
  }
  const orgName = org;
  const wantedPermissions = validatePermissions(permissions);
  const wantedRepositories = validateRepositories(repositories);
  const installation = await client.request('GET', apiPath('/orgs/{org}/installation', { org: orgName }));
  const installationId = installation.data?.id;
  if (typeof installationId !== 'number') {
    throw new GitHubError(`app-token: GET /orgs/${orgName}/installation returned no installation id`, { status: 0 });
  }

  const body = { permissions: wantedPermissions };
  if (wantedRepositories !== undefined) body.repositories = wantedRepositories;
  const response = await client.request(
    'POST', apiPath('/app/installations/{id}/access_tokens', { id: installationId }), { body },
  );

  const token = response.data?.token;
  const expiresAt = typeof response.data?.expires_at === 'string' ? new Date(response.data.expires_at) : null;
  try {
    if (typeof token !== 'string' || token === '' || expiresAt === null || Number.isNaN(expiresAt.getTime())) {
      throw new GitHubError('app-token: access_tokens response is missing token or expires_at', { status: 0 });
    }
    if (!samePermissions(wantedPermissions, response.data?.permissions)) {
      throw new GitHubError('app-token: granted permissions differ from requested permissions', { status: 0 });
    }
    if (wantedRepositories !== undefined
      && !sameRepositoryNames(wantedRepositories, response.data?.repositories)) {
      throw new GitHubError('app-token: granted repositories differ from requested repositories', { status: 0 });
    }
  } catch (error) {
    await makeClient(token).request('DELETE', '/installation/token');
    throw error;
  }
  return { token, expiresAt };
}

/** @param {string} token */
function defaultMakeClient(token) {
  return createClient({ env: {}, token });
}

/** @param {GitHubClient} client a client authenticated with the installation token */
export async function revokeInstallationToken(client) {
  await client.request('DELETE', '/installation/token');
}


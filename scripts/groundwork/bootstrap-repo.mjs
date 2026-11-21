import { GitHubError, apiPath } from '../lib/github.mjs';
import { sameLogin } from '../lib/trust.mjs';

// Same value as bootstrap-tree.mjs (#144); the integration task (#149) may share one export.
const KIT_VERSION_PATH = '.github/groundwork/kit-version.txt';
const DEFAULT_BRANCH = 'main';
const TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;
const TAG_REF_PREFIX = 'refs/tags/';
const RETRY_STATUSES = new Set([403, 404]);
const FRESH_ROOT_FILE = 'README.md';

function repoPath(org, repo, suffix) {
  return `${apiPath('/repos/{org}/{repo}', { org, repo })}${suffix}`;
}

// Slashes stay literal: the contents endpoint takes a nested path, not one encoded segment.
function contentsPath(org, repo, filePath) {
  const encoded = filePath.split('/').map(encodeURIComponent).join('/');
  return repoPath(org, repo, `/contents/${encoded}`);
}

function decodeBase64(text) {
  return Buffer.from(String(text ?? ''), 'base64').toString('utf8');
}

function compareVersions(left, right) {
  for (let part = 1; part <= 3; part += 1) {
    const difference = Number(left[part]) - Number(right[part]);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * @param {{ client: import('../lib/github.mjs').GitHubClient, org: string, controlRepo: string }} options
 * @returns {Promise<string>} the highest vMAJOR.MINOR.PATCH tag
 */
export async function latestReleaseTag({ client, org, controlRepo }) {
  const refs = await client.paginate(repoPath(org, controlRepo, '/git/matching-refs/tags/v'));
  const versions = refs
    .map((ref) => TAG_PATTERN.exec(String(ref.ref ?? '').slice(TAG_REF_PREFIX.length)))
    .filter(Boolean);
  if (versions.length === 0) throw new GitHubError(`${org}/${controlRepo} has no vMAJOR.MINOR.PATCH release tag`);
  versions.sort(compareVersions);
  return versions.at(-1)[0];
}

/**
 * @param {{ client: import('../lib/github.mjs').GitHubClient, org: string, controlRepo: string, tag: string }} options
 * @returns {Promise<Array<{ path: string, mode: string, sha: string }>>} blobs only
 */
export async function readReleaseTree({ client, org, controlRepo, tag }) {
  const path = repoPath(org, controlRepo, `/git/trees/${encodeURIComponent(tag)}`);
  const { data } = await client.request('GET', path, { query: { recursive: 1 } });
  if (data?.truncated) throw new GitHubError(`release tree of ${org}/${controlRepo} at ${tag} is truncated`);
  return (data?.tree ?? [])
    .filter((entry) => entry.type === 'blob')
    .map(({ path: entryPath, mode, sha }) => ({ path: entryPath, mode, sha }));
}

/**
 * @param {{ client: import('../lib/github.mjs').GitHubClient, org: string, controlRepo: string,
 *   entries: Array<{ path: string, sha: string }>, paths: string[] }} options
 * @returns {Promise<Record<string, string>>} UTF-8 text by path
 */
export async function readBlobTexts({ client, org, controlRepo, entries, paths }) {
  const shaByPath = new Map(entries.map((entry) => [entry.path, entry.sha]));
  const texts = {};
  for (const path of paths) {
    const sha = shaByPath.get(path);
    if (sha === undefined) throw new GitHubError(`${path} is not in the release tree of ${org}/${controlRepo}`);
    const { data } = await client.request('GET', repoPath(org, controlRepo, `/git/blobs/${encodeURIComponent(sha)}`));
    texts[path] = decodeBase64(data?.content);
  }
  return texts;
}

async function hasKitVersion(client, org, repo) {
  const { status } = await client.request('GET', contentsPath(org, repo, KIT_VERSION_PATH), { okStatuses: [404, 409] });
  return status === 200;
}

async function isFreshAutoInit(client, org, repo, adminBot) {
  const { status, data: commits } = await client.request('GET', repoPath(org, repo, '/commits'), {
    query: { per_page: 2 },
    okStatuses: [409],
  });
  if (status === 409 || commits.length !== 1) return false;
  if (!sameLogin(commits[0].author?.login ?? '', adminBot)) return false;
  const { data: root } = await client.request('GET', repoPath(org, repo, '/contents/'));
  return Array.isArray(root) && root.length === 1 && root[0].name === FRESH_ROOT_FILE;
}

/**
 * @param {{ client: import('../lib/github.mjs').GitHubClient, org: string, repo: string, adminBot: string }} options
 * @returns {Promise<'absent'|'fresh'|'ours'|'foreign'>}
 */
export async function inspectRepo({ client, org, repo, adminBot }) {
  const { status, data: repository } = await client.request('GET', repoPath(org, repo, ''), { okStatuses: [404] });
  if (status === 404) return 'absent';
  if (await hasKitVersion(client, org, repo)) return 'ours';
  if (repository.default_branch !== DEFAULT_BRANCH) return 'foreign';
  return (await isFreshAutoInit(client, org, repo, adminBot)) ? 'fresh' : 'foreign';
}

/**
 * @param {{ client: import('../lib/github.mjs').GitHubClient, org: string, repo: string }} options
 * @returns {Promise<string>} the vX.Y.Z tag pinned in the repository's kit-version file
 */
export async function readKitVersion({ client, org, repo }) {
  const { data } = await client.request('GET', contentsPath(org, repo, KIT_VERSION_PATH));
  const tag = decodeBase64(data?.content).trim();
  if (!TAG_PATTERN.test(tag)) throw new GitHubError(`${org}/${repo} ${KIT_VERSION_PATH} does not hold a vX.Y.Z tag`);
  return tag;
}

// The callback records a refused create instead of throwing, so the token is revoked before the caller decides to retry.
async function attemptCreate({ withToken, scope, org, body }) {
  let failure = null;
  await withToken(scope, async ({ client }) => {
    try {
      await client.request('POST', apiPath('/orgs/{org}/repos', { org }), { body });
    } catch (error) {
      failure = error;
    }
  });
  return failure;
}

/**
 * Creates the repository with a token restricted to the control repository; only a 403 or 404 retries
 * once with an installation-wide token (V7 decides which variant ships).
 * @param {{ withToken: Function, org: string, controlRepo: string, repo: string, description: string,
 *   permissions: Record<string, string> }} options
 * @returns {Promise<void>}
 */
export async function createRepo({ withToken, org, controlRepo, repo, description, permissions }) {
  const body = { name: repo, description, private: false, auto_init: true };
  const restricted = await attemptCreate({ withToken, scope: { repositories: [controlRepo], permissions }, org, body });
  if (restricted === null) return;
  if (!(restricted instanceof GitHubError) || !RETRY_STATUSES.has(restricted.status)) throw restricted;
  const installationWide = await attemptCreate({ withToken, scope: { repositories: 'all', permissions }, org, body });
  if (installationWide !== null) throw installationWide;
}

/**
 * @param {{ client: import('../lib/github.mjs').GitHubClient, org: string, repo: string, tag: string,
 *   treeEntries: Array<{ path: string, mode: string, sha?: string, content?: string }> }} options
 * @returns {Promise<{ sha: string, created: boolean }>} `created` is false when the kit-version file is already on main
 */
export async function commitBootstrapTree({ client, org, repo, tag, treeEntries }) {
  const { data: ref } = await client.request('GET', repoPath(org, repo, `/git/ref/heads/${DEFAULT_BRANCH}`));
  const head = ref.object.sha;
  if (await hasKitVersion(client, org, repo)) return { sha: head, created: false };
  const tree = treeEntries.map((entry) => ({ ...entry, type: 'blob' }));
  const { data: createdTree } = await client.request('POST', repoPath(org, repo, '/git/trees'), { body: { tree } });
  const message = `chore: bootstrap from groundwork ${tag}`;
  const { data: commit } = await client.request('POST', repoPath(org, repo, '/git/commits'), {
    body: { message, tree: createdTree.sha, parents: [head] },
  });
  await client.request('PATCH', repoPath(org, repo, `/git/refs/heads/${DEFAULT_BRANCH}`), {
    body: { sha: commit.sha, force: false },
  });
  return { sha: commit.sha, created: true };
}

import { setTimeout as delay } from 'node:timers/promises';
import { GitHubError, apiPath } from '../lib/github.mjs';
import { SettingsError } from '../lib/settings.mjs';
import { sameLogin } from '../lib/trust.mjs';

// Same value as bootstrap-tree.mjs (#144); the integration task (#149) may share one export.
const KIT_VERSION_PATH = '.github/groundwork/kit-version.txt';
const DEFAULT_BRANCH = 'main';
const TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;
const TAG_REF_PREFIX = 'refs/tags/';
const FRESH_ROOT_FILE = 'README.md';
// GitHub's secondary limit on content creation: 60 blob POSTs per minute.
const BLOB_POST_SPACING_MS = 1000;

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

async function hasKitVersion({ client, org, repo, ref }) {
  const { status } = await client.request('GET', contentsPath(org, repo, KIT_VERSION_PATH), {
    query: { ref },
    okStatuses: [404, 409],
  });
  return status === 200;
}

async function isFreshAutoInit({ client, org, repo, adminBot }) {
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
  if (await hasKitVersion({ client, org, repo })) return 'ours';
  if (repository.default_branch !== DEFAULT_BRANCH) return 'foreign';
  return (await isFreshAutoInit({ client, org, repo, adminBot })) ? 'fresh' : 'foreign';
}

/**
 * @param {{ client: import('../lib/github.mjs').GitHubClient, org: string, repo: string }} options
 * @returns {Promise<string>} the vX.Y.Z tag pinned in the repository's kit-version file
 */
export async function readKitVersion({ client, org, repo }) {
  const { data } = await client.request('GET', contentsPath(org, repo, KIT_VERSION_PATH), { query: { ref: DEFAULT_BRANCH } });
  const tag = decodeBase64(data?.content).trim();
  if (!TAG_PATTERN.test(tag)) throw new GitHubError(`${org}/${repo} ${KIT_VERSION_PATH} does not hold a vX.Y.Z tag`);
  return tag;
}

/**
 * Creates the repository with a token restricted to the control repository (V7: GitHub accepts it, so no
 * installation-wide variant exists).
 * @param {{ withToken: Function, org: string, controlRepo: string, repo: string, description: string,
 *   permissions: Record<string, string> }} options
 * @returns {Promise<void>}
 */
export async function createRepo({ withToken, org, controlRepo, repo, description, permissions }) {
  const body = { name: repo, description, private: false, auto_init: true };
  await withToken({ repositories: [controlRepo], permissions }, ({ client }) => (
    client.request('POST', apiPath('/orgs/{org}/repos', { org }), { body })
  ));
}

/**
 * Raw blobs for the tree entries that keep a control-repository `sha`; the target holds no such objects.
 * @param {{ client: import('../lib/github.mjs').GitHubClient, org: string, controlRepo: string,
 *   entries: Array<{ path: string, sha?: string, content?: string }> }} options
 * @returns {Promise<Map<string, string>>} base64 content by path
 */
export async function readBlobContents({ client, org, controlRepo, entries }) {
  const blobs = new Map();
  for (const { path, sha, content } of entries) {
    if (sha === undefined || content !== undefined) continue;
    const { data } = await client.request('GET', repoPath(org, controlRepo, `/git/blobs/${encodeURIComponent(sha)}`));
    if (typeof data?.content !== 'string') throw new SettingsError(`control blob ${sha} for ${path} has no content`);
    blobs.set(path, data.content.replace(/\s+/g, ''));
  }
  return blobs;
}

async function createTargetBlobs({ client, org, repo, treeEntries, blobs, sleep }) {
  const resolved = [];
  let posted = 0;
  for (const entry of treeEntries) {
    if (entry.sha === undefined) {
      resolved.push({ ...entry, type: 'blob' });
      continue;
    }
    const content = blobs?.get(entry.path);
    if (content === undefined) throw new SettingsError(`no base64 content for ${entry.path}`);
    if (posted > 0) await sleep(BLOB_POST_SPACING_MS);
    const body = { content, encoding: 'base64' };
    const { data } = await client.request('POST', repoPath(org, repo, '/git/blobs'), { body });
    posted += 1;
    if (data.sha !== entry.sha) throw new SettingsError(`blob ${entry.path} came back as ${data.sha}, expected ${entry.sha}`);
    resolved.push({ path: entry.path, mode: entry.mode, sha: data.sha, type: 'blob' });
  }
  return resolved;
}

/**
 * @param {{ client: import('../lib/github.mjs').GitHubClient, org: string, repo: string, tag: string,
 *   treeEntries: Array<{ path: string, mode: string, sha?: string, content?: string }>,
 *   blobs: Map<string, string>, sleep?: (ms: number) => Promise<unknown> }} options
 *   `blobs` is `readBlobContents` output; `sleep` spaces the blob POSTs.
 * @returns {Promise<{ sha: string, created: boolean }>} `created` is false when the kit-version file is already on main
 */
export async function commitBootstrapTree({ client, org, repo, tag, treeEntries, blobs, sleep = delay }) {
  const { data: ref } = await client.request('GET', repoPath(org, repo, `/git/ref/heads/${DEFAULT_BRANCH}`));
  const head = ref.object.sha;
  if (await hasKitVersion({ client, org, repo, ref: DEFAULT_BRANCH })) return { sha: head, created: false };
  const tree = await createTargetBlobs({ client, org, repo, treeEntries, blobs, sleep });
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

import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { GitHubError, apiPath } from '../lib/github.mjs';
import { validateIssueBody } from '../lib/issue-model.mjs';
import { SettingsError } from '../lib/settings.mjs';
import { normalizeLabel, sameLogin } from '../lib/trust.mjs';

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

const MAX_TAG_DEREFERENCES = 5;

/**
 * Annotated tags are dereferenced, so the result is always a commit SHA.
 * @param {{ client: import('../lib/github.mjs').GitHubClient, org: string, controlRepo: string, tag: string }} options
 * @returns {Promise<string>} the commit the tag points at
 */
export async function resolveTagCommit({ client, org, controlRepo, tag }) {
  const { data } = await client.request('GET', repoPath(org, controlRepo, `/git/ref/tags/${encodeURIComponent(tag)}`));
  let target = data?.object;
  for (let depth = 0; depth < MAX_TAG_DEREFERENCES && target?.type === 'tag'; depth += 1) {
    const { data: annotated } = await client.request('GET', repoPath(org, controlRepo, `/git/tags/${encodeURIComponent(target.sha)}`));
    target = annotated?.object;
  }
  if (target?.type !== 'commit') throw new GitHubError(`tag ${tag} of ${org}/${controlRepo} does not resolve to a commit`);
  return target.sha;
}

/**
 * Reads the tree by the tag's commit SHA, the same SHA the workflow refs are pinned to.
 * @param {{ client: import('../lib/github.mjs').GitHubClient, org: string, controlRepo: string, commitSha: string }} options
 * @returns {Promise<Array<{ path: string, mode: string, sha: string }>>} blobs only
 */
export async function readReleaseTree({ client, org, controlRepo, commitSha }) {
  const path = repoPath(org, controlRepo, `/git/trees/${encodeURIComponent(commitSha)}`);
  const { data } = await client.request('GET', path, { query: { recursive: 1 } });
  if (data?.truncated) throw new GitHubError(`release tree of ${org}/${controlRepo} at ${commitSha} is truncated`);
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

// Spec 14.4: the project's README and LICENSE are kept and kit lines are appended to its CODEOWNERS.
const ADOPT_KEPT_PATHS = new Set(['README.md', 'LICENSE', '.github/CODEOWNERS']);
// admin-run cuts a plan fact at 200 characters; this budget leaves room for the row name and the count.
const LIST_BUDGET = 120;
const NOT_CHECKED_EMPTY = 'not checked: empty repository';

const gapRow = (name, fail, detail) => ({ name, fail, detail });

function listNames(names) {
  if (names.length === 0) return 'none';
  let shown = 0;
  while (shown < names.length && names.slice(0, shown + 1).join(', ').length <= LIST_BUDGET) shown += 1;
  const listed = names.slice(0, shown).join(', ');
  if (shown === names.length) return listed;
  return `${listed}${shown > 0 ? ' ' : ''}and ${names.length - shown} more`;
}

const gitBlobSha = (text) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex');

async function readMainProtection({ client, org, repo }) {
  const { status, data } = await client.request('GET', repoPath(org, repo, `/branches/${DEFAULT_BRANCH}`), { okStatuses: [404] });
  const isProtected = status === 200 && data?.protected === true;
  return gapRow('protected main', isProtected, isProtected ? 'set; rulesets replace it, delete the branch protection rule in the browser' : 'not set');
}

const ancestorsOf = (path) => path.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'));

/** A kit path collides when the target holds it as a non-blob, holds an ancestor as a non-tree, or holds other content. */
function collisionsOf(kitEntries, targetByPath) {
  const collisions = new Set();
  for (const entry of kitEntries) {
    for (const ancestor of ancestorsOf(entry.path)) {
      const type = targetByPath.get(ancestor)?.type;
      if (type !== undefined && type !== 'tree') collisions.add(`${ancestor} is a ${type}`);
    }
    const target = targetByPath.get(entry.path);
    if (target === undefined) continue;
    if (target.type !== 'blob') collisions.add(`${entry.path} is a ${target.type}`);
    else if (!ADOPT_KEPT_PATHS.has(entry.path) && target.sha !== (entry.content === undefined ? entry.sha : gitBlobSha(entry.content))) collisions.add(entry.path);
  }
  return [...collisions];
}

/** Reads the tree by the head commit SHA, so a tag named like the branch cannot answer and the kit merge can reuse the SHA. */
async function readCollisions({ client, org, repo, branch, kitEntries }) {
  const { data: ref } = await client.request('GET', repoPath(org, repo, `/git/ref/heads/${encodeURIComponent(branch)}`));
  const headSha = ref?.object?.sha;
  if (typeof headSha !== 'string') return { row: gapRow('collisions', true, `heads/${branch} has no commit SHA`) };
  const { data } = await client.request('GET', repoPath(org, repo, `/git/trees/${encodeURIComponent(headSha)}`), { query: { recursive: 1 } });
  if (data?.truncated) return { row: gapRow('collisions', true, 'target tree is truncated, so it cannot be compared'), headSha };
  if (!Array.isArray(data?.tree)) return { row: gapRow('collisions', true, 'target tree response has no tree list'), headSha };
  const collisions = collisionsOf(kitEntries, new Map(data.tree.map((entry) => [entry.path, entry])));
  return { row: gapRow('collisions', collisions.length > 0, listNames(collisions)), headSha };
}

/** The failing rows of spec 14.4 against the built kit tree, from GET calls; `headSha` is the commit the tree was read at. */
export async function readAdoptionGaps({ client, org, repo, kitEntries }) {
  const { data: repository } = await client.request('GET', repoPath(org, repo, ''));
  const branch = repository.default_branch;
  const { status } = await client.request('GET', repoPath(org, repo, '/commits'), { query: { per_page: 1 }, okStatuses: [409] });
  const empty = status === 409;
  const rows = [
    gapRow('default branch', branch !== DEFAULT_BRANCH, branch === DEFAULT_BRANCH ? branch : `${branch}, must be ${DEFAULT_BRANCH}`),
    gapRow('empty repository', empty, empty ? 'yes' : 'no'),
    gapRow('archived', repository.archived === true, repository.archived === true ? 'yes' : 'no'),
  ];
  if (empty) return { rows: [...rows, gapRow('protected main', false, NOT_CHECKED_EMPTY), gapRow('collisions', false, NOT_CHECKED_EMPTY)], empty };
  rows.push(await readMainProtection({ client, org, repo }));
  const { row, headSha } = await readCollisions({ client, org, repo, branch, kitEntries });
  return { rows: [...rows, row], empty, headSha };
}

/** The reported rows of spec 14.4, which never fail; merge settings and secret names are not read. */
export async function readAdoptionReport({ client, org, repo, kitLabels, empty }) {
  const kept = new Set(kitLabels.map(normalizeLabel));
  const labels = (await client.paginate(repoPath(org, repo, '/labels'))).map((label) => label.name).filter((name) => !kept.has(normalizeLabel(name)));
  const tags = empty ? [] : (await client.paginate(repoPath(org, repo, '/git/matching-refs/tags/v'))).map((ref) => String(ref.ref).slice(TAG_REF_PREFIX.length));
  const environments = await client.paginate(repoPath(org, repo, '/environments'), { itemsKey: 'environments' });
  const issues = (await client.paginate(repoPath(org, repo, '/issues'), { query: { state: 'open' } })).filter((issue) => !issue.pull_request);
  const unformatted = issues.filter((issue) => !validateIssueBody({ type: issue.type?.name ?? null, body: issue.body ?? '' }).ok);
  return [
    { name: 'labels the sync deletes', detail: listNames(labels) },
    { name: 'v* tags', detail: listNames(tags) },
    { name: 'environments', detail: listNames(environments.map((environment) => environment.name)) },
    { name: 'open issues failing issue-format', detail: String(unformatted.length) },
    { name: 'secrets', detail: 'not read; check them in the browser' },
    { name: 'merge settings', detail: 'not read; pass 1 sets squash-only' },
  ];
}

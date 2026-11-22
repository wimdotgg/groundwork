import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { CONFIG_DIR, loadConfig, repoRoot } from './lib/config.mjs';
import { GitHubError, createClient } from './lib/github.mjs';

/** @typedef {import('./lib/github.mjs').GitHubClient} GitHubClient */
/** @typedef {{ path: string, mode: string, sha: string }} TreeBlob */
/** @typedef {{ content: Buffer, executable: boolean }} FileWrite */

const execFileAsync = promisify(execFile);

/** Kit paths (spec 13.1): directory prefixes end in `/`, `*` matches within one path segment. */
export const KIT_PATHS = [
  '.github/ISSUE_TEMPLATE/',
  '.github/pull_request_template.md',
  '.github/groundwork/templates/',
  '.github/workflows/issue-format.yml',
  '.github/workflows/pr-metadata.yml',
  '.github/workflows/protected-labels.yml',
  '.github/workflows/plan-lint.yml',
  '.github/workflows/release-please.yml',
  '.github/workflows/failure-alert.yml',
  'scripts/agent/',
  'scripts/human/',
  'scripts/admin/',
  'scripts/ci/',
  'scripts/lib/',
  'scripts/kit-update.mjs',
  '.claude/skills/groundwork-*/',
];

/** Copied only while the project's file equals the old tag's; else reported in `skipped`. */
export const UNMODIFIED_ONLY_PATHS = ['.github/dependabot.yml', '.claude/settings.json', 'AGENTS.md', 'CLAUDE.md'];

/** Copied only into a project that has no such file; an existing one is never touched. */
export const CREATE_ONLY_PATHS = ['.github/workflows/deploy.yml'];

const TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;
const BRANCH_PATTERN = /^issue\/\d+$/;
const KIT_VERSION_PATH = `${CONFIG_DIR}/kit-version.txt`;
const CONFIG_PATH = `${CONFIG_DIR}/config.json`;
const REGULAR_MODE = '100644';
const EXECUTABLE_MODE = '100755';
const USAGE = 'usage: kit-update.mjs <vX.Y.Z> [--json]';
const MAX_TAG_DEREFERENCES = 5;
const KIT_PATH_MATCHERS = KIT_PATHS.map(toMatcher);
const WORKFLOWS_DIR = '.github/workflows';
const CI_WORKFLOW_PATH = `${WORKFLOWS_DIR}/ci.yml`;
const LOCAL_REFERENCE = /\.\/\.github\/workflows\/(reusable-[\w-]+\.yml)([ \t]*# zizmor: ignore\[self-repository\][^\r\n]*)?/g;

export class KitUpdateRefusal extends Error {}

function toMatcher(pattern) {
  const source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(pattern.endsWith('/') ? `^${source}` : `^${source}$`);
}

/** @param {string} filePath */
export function isKitPath(filePath) {
  return KIT_PATH_MATCHERS.some((matcher) => matcher.test(filePath));
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Three-way merge by key, recursing into objects; arrays are values. A key equal to base takes theirs, a key the
 * project changed or deleted keeps ours, a key only in theirs is added.
 * @param {{ base: object, ours: object, theirs: object }} versions
 * @returns {object}
 */
export function mergeConfig({ base, ours, theirs }) {
  const merged = {};
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const value = mergeValue({ base: base[key], ours: ours[key], theirs: theirs[key] });
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function mergeValue({ base, ours, theirs }) {
  const bothObjects = isPlainObject(ours) && isPlainObject(theirs);
  if (bothObjects && (base === undefined || isPlainObject(base))) return mergeConfig({ base: base ?? {}, ours, theirs });
  return sameValue(ours, base) ? theirs : ours;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Points every existing `uses: [quote]<org>/<controlRepo>/.github/workflows/reusable-*.yml@<ref>[quote]` at the tag's
 * commit with the tag as the trailing comment (spec 8.6), as `bootstrap` writes it. Any other trailing comment on a
 * pin is replaced. Other `uses:` lines, local `./.github/...` references included, are left alone.
 * @param {{ text: string, org: string, controlRepo: string, tag: string, tagSha: string }} options
 * @returns {string}
 */
export function rewritePins({ text, org, controlRepo, tag, tagSha }) {
  const existingPin = new RegExp(
    `(uses:[ \\t]*)(["']?)(${escapeRegExp(org)}/${escapeRegExp(controlRepo)}/\\.github/workflows/reusable-[\\w-]+\\.yml)@[^\\s#"']+\\2[ \\t]*(#[^\\r\\n]*)?`,
    'gi',
  );
  return text.replace(existingPin, `$1$2$3@${tagSha}$2 # ${tag}`);
}

/** The tag's own `ci.yml` calls the reusable workflows locally; `bootstrap` writes them as pins, and so does this. */
function pinLocalReferences({ text, org, controlRepo, tag, tagSha }) {
  return text.replace(
    LOCAL_REFERENCE,
    (_match, name) => `${org}/${controlRepo}/.github/workflows/${name}@${tagSha} # ${tag}`,
  );
}

/** @returns {string} the blob SHA git computes for `content` */
function gitBlobSha(content) {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

function parseTag(tag) {
  const match = TAG_PATTERN.exec(tag ?? '');
  return match ? match.slice(1).map(Number) : null;
}

function compareTags(left, right) {
  const [leftParts, rightParts] = [parseTag(left), parseTag(right)];
  const index = leftParts.findIndex((part, position) => part !== rightParts[position]);
  return index === -1 ? 0 : leftParts[index] - rightParts[index];
}

async function readLocal(root, filePath) {
  try {
    return await readFile(path.join(root, filePath));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function controlPath({ org, controlRepo }, suffix) {
  return `/repos/${encodeURIComponent(org)}/${encodeURIComponent(controlRepo)}/${suffix}`;
}

async function resolveTagCommit(client, control, tag) {
  const { data } = await client.request('GET', controlPath(control, `git/ref/tags/${encodeURIComponent(tag)}`), { okStatuses: [404] });
  if (data?.object === undefined) throw new KitUpdateRefusal(`tag ${tag} does not exist in ${control.org}/${control.controlRepo}`);
  let target = data.object;
  for (let depth = 0; depth < MAX_TAG_DEREFERENCES && target?.type === 'tag'; depth += 1) {
    ({ data: { object: target } } = await client.request('GET', controlPath(control, `git/tags/${target.sha}`)));
  }
  if (target?.type !== 'commit') throw new GitHubError(`tag ${tag} does not resolve to a commit`);
  return target.sha;
}

function requireInsideRoot(root, entryPath) {
  const relative = path.relative(root, path.resolve(root, entryPath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new KitUpdateRefusal(`tree path ${entryPath} leaves the project`);
}

/** @returns {Promise<Map<string, TreeBlob>>} the regular files of the tag's tree by path; symlinks are dropped */
async function readTree({ client, control, root, commitSha }) {
  const { data } = await client.request('GET', controlPath(control, `git/trees/${commitSha}`), { query: { recursive: 1 } });
  if (data?.truncated) throw new GitHubError(`tree at ${commitSha} is truncated`);
  const files = data.tree.filter((entry) => entry.type === 'blob' && [REGULAR_MODE, EXECUTABLE_MODE].includes(entry.mode));
  for (const { path: entryPath } of files) requireInsideRoot(root, entryPath);
  return new Map(files.map(({ path: entryPath, mode, sha }) => [entryPath, { path: entryPath, mode, sha }]));
}

async function readBlob(client, control, entry) {
  const { data } = await client.request('GET', controlPath(control, `git/blobs/${entry.sha}`));
  return Buffer.from(data.content, 'base64');
}

/**
 * Whether the project's copy of a file may be overwritten: kit paths always, the create-only files when absent, the
 * unmodified-only files while they still equal the old tag's.
 * @returns {{ copy: boolean, skipped: boolean }}
 */
function classify({ filePath, local, oldTree }) {
  if (isKitPath(filePath)) return { copy: true, skipped: false };
  if (CREATE_ONLY_PATHS.includes(filePath)) return { copy: local === null, skipped: false };
  if (!UNMODIFIED_ONLY_PATHS.includes(filePath)) return { copy: false, skipped: false };
  const oldEntry = oldTree.get(filePath);
  const untouched = local === null ? oldEntry === undefined : oldEntry?.sha === gitBlobSha(local);
  return { copy: untouched, skipped: !untouched };
}

async function planFileWrites({ client, control, root, oldTree, newTree }) {
  /** @type {Map<string, FileWrite>} */
  const writes = new Map();
  const skipped = [];
  for (const entry of newTree.values()) {
    const local = await readLocal(root, entry.path);
    const { copy, skipped: wasSkipped } = classify({ filePath: entry.path, local, oldTree });
    if (wasSkipped) skipped.push(entry.path);
    if (!copy || (local !== null && gitBlobSha(local) === entry.sha)) continue;
    writes.set(entry.path, { content: await readBlob(client, control, entry), executable: entry.mode === EXECUTABLE_MODE });
  }
  const removals = [];
  for (const filePath of oldTree.keys()) {
    if (isKitPath(filePath) && !newTree.has(filePath) && (await readLocal(root, filePath)) !== null) removals.push(filePath);
  }
  return { writes, removals, skipped };
}

async function planConfigMerge({ client, control, root, oldTree, newTree }) {
  const oursText = (await readLocal(root, CONFIG_PATH)).toString('utf8');
  const ours = JSON.parse(oursText);
  const readTagVersion = async (tree) => {
    if (!tree.has(CONFIG_PATH)) return {};
    return JSON.parse((await readBlob(client, control, tree.get(CONFIG_PATH))).toString('utf8'));
  };
  const merged = mergeConfig({ base: await readTagVersion(oldTree), ours, theirs: await readTagVersion(newTree) });
  if (sameValue(merged, ours)) return null;
  return { content: Buffer.from(`${JSON.stringify(merged, null, 2)}\n`), executable: false };
}

function ignoreMissing(error) {
  if (error.code === 'ENOENT') return [];
  throw error;
}

/** Copies the tag's `ci.yml` with its local reusable-workflow references pinned, as `bootstrap` writes it (13.1). */
async function planCiWorkflow({ client, control, root, newTree, writes, pinTarget }) {
  if (!newTree.has(CI_WORKFLOW_PATH)) return;
  const original = await readBlob(client, control, newTree.get(CI_WORKFLOW_PATH));
  const content = Buffer.from(pinLocalReferences({ text: original.toString('utf8'), ...pinTarget }));
  const local = await readLocal(root, CI_WORKFLOW_PATH);
  if (local !== null && content.equals(local)) return;
  writes.set(CI_WORKFLOW_PATH, { content, executable: newTree.get(CI_WORKFLOW_PATH).mode === EXECUTABLE_MODE });
}

/** Rewrites the pins of every project workflow, on top of the copy this run already plans for it. */
async function planPinRewrites({ root, writes, pinTarget }) {
  const names = (await readdir(path.join(root, WORKFLOWS_DIR)).catch(ignoreMissing)).filter((name) => name.endsWith('.yml'));
  for (const name of names) {
    const filePath = `${WORKFLOWS_DIR}/${name}`;
    const planned = writes.get(filePath);
    const current = planned?.content ?? (await readLocal(root, filePath));
    const rewritten = Buffer.from(rewritePins({ text: current.toString('utf8'), ...pinTarget }));
    if (rewritten.equals(current)) continue;
    writes.set(filePath, { content: rewritten, executable: planned?.executable ?? false });
  }
}

async function applyPlan({ root, writes, removals }) {
  for (const [filePath, { content, executable }] of writes) {
    const target = path.join(root, filePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    if (executable) await chmod(target, 0o755);
  }
  for (const filePath of removals) await rm(path.join(root, filePath));
}

async function requireCleanIssueBranch(git) {
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (!BRANCH_PATTERN.test(branch)) throw new KitUpdateRefusal(`run on an issue/N branch, not ${branch}`);
  const status = await git(['status', '--porcelain', '--untracked-files=all']);
  if (status.trim() !== '') throw new KitUpdateRefusal('working tree has uncommitted changes');
  return branch;
}

async function isAheadOfRemote(git, branch) {
  const remoteRef = `refs/remotes/origin/${branch}`;
  // Without a remote-tracking ref nothing says the commit is on the remote, and pushing an up-to-date branch is a no-op.
  if ((await git(['for-each-ref', '--format=%(objectname)', remoteRef])).trim() === '') return true;
  return Number((await git(['rev-list', '--count', `${remoteRef}..HEAD`])).trim()) > 0;
}

async function exists(root, filePath) {
  try {
    await stat(path.join(root, filePath));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Undoes a failed run. The tree was clean, so `reset` restores everything the plan touched that existed; only paths
 * the plan created are cleaned (ignored ones included), never anything that was already there.
 */
async function restoreTree({ git, createdPaths }) {
  await git(['reset', '--hard', 'HEAD']);
  if (createdPaths.length > 0) await git(['clean', '-fdx', '--', ...createdPaths]);
}

async function commitPlan({ root, git, publish, plan, tag }) {
  const paths = [...plan.writes.keys(), ...plan.removals];
  const createdPaths = [];
  for (const filePath of plan.writes.keys()) {
    if (!(await exists(root, filePath))) createdPaths.push(filePath);
  }
  try {
    await applyPlan({ root, ...plan });
    // --force: a plan path the project gitignores would otherwise make `add` fail.
    await git(['add', '-A', '--force', '--', ...paths]);
    await publish(['git', 'commit', '-m', `chore(kit): update to ${tag}`]);
  } catch (error) {
    try {
      await restoreTree({ git, createdPaths });
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `${error.message}; restoring the tree also failed: ${restoreError.message}`);
    }
    throw error;
  }
}

async function readCurrentTag(root) {
  const text = (await readLocal(root, KIT_VERSION_PATH))?.toString('utf8').trim();
  if (parseTag(text) === null) throw new KitUpdateRefusal(`${KIT_VERSION_PATH} does not hold a vX.Y.Z tag`);
  return text;
}

/**
 * @param {{ root: string, tag: string, client: GitHubClient,
 *   git: (args: string[]) => Promise<string>, publish: (args: string[]) => Promise<string> }} options
 *   `git` runs read-only commands and `add`; `publish` runs the commit and push under `token.mjs exec`.
 * @returns {Promise<{ ok: true, tag: string, changed: string[], skipped: string[] }>}
 * @throws {KitUpdateRefusal} before any write
 */
export async function run({ root, tag, client, git, publish }) {
  if (parseTag(tag) === null) throw new KitUpdateRefusal(`${tag ?? '(none)'} is not a vX.Y.Z tag; ${USAGE}`);
  const { org, controlRepo } = await loadConfig({ root });
  const control = { org, controlRepo };
  const branch = await requireCleanIssueBranch(git);
  const currentTag = await readCurrentTag(root);
  if (compareTags(tag, currentTag) < 0) throw new KitUpdateRefusal(`${tag} is lower than ${currentTag} in kit-version.txt`);
  if (tag === currentTag) {
    if (await isAheadOfRemote(git, branch)) await publish(['git', 'push', 'origin', branch]);
    return { ok: true, tag, changed: [], skipped: [] };
  }

  const [tagSha, currentTagSha] = await Promise.all([tag, currentTag].map((name) => resolveTagCommit(client, control, name)));
  const [newTree, oldTree] = await Promise.all([tagSha, currentTagSha].map((commitSha) => readTree({ client, control, root, commitSha })));
  const { writes, removals, skipped } = await planFileWrites({ client, control, root, oldTree, newTree });
  const mergedConfig = await planConfigMerge({ client, control, root, oldTree, newTree });
  if (mergedConfig) writes.set(CONFIG_PATH, mergedConfig);
  const pinTarget = { org, controlRepo, tag, tagSha };
  await planCiWorkflow({ client, control, root, newTree, writes, pinTarget });
  await planPinRewrites({ root, writes, pinTarget });
  writes.set(KIT_VERSION_PATH, { content: Buffer.from(`${tag}\n`), executable: false });

  await commitPlan({ root, git, publish, plan: { writes, removals }, tag });
  await publish(['git', 'push', 'origin', branch]);
  return { ok: true, tag, changed: [...writes.keys(), ...removals].sort(), skipped: skipped.sort() };
}

function report({ json, result }) {
  if (json) console.log(JSON.stringify(result));
  else if (!result.ok) console.error(result.reason);
  else if (result.changed.length === 0) console.log(`already on ${result.tag}`);
  else {
    const skippedLines = result.skipped.map((file) => `\n  skipped ${file}`).join('');
    console.log(`updated to ${result.tag}: ${result.changed.length} changed, ${result.skipped.length} skipped${skippedLines}`);
  }
}

export async function main({ argv, env, scriptUrl = import.meta.url }) {
  const json = argv.includes('--json');
  try {
    const root = repoRoot(scriptUrl);
    const tag = argv.find((argument) => !argument.startsWith('--'));
    const inRoot = async (command, args) => (await execFileAsync(command, args, { cwd: root })).stdout;
    const result = await run({
      root,
      tag,
      client: createClient({ env }),
      git: (args) => inRoot('git', args),
      publish: (args) => inRoot(process.execPath, [path.join(root, 'scripts/agent/token.mjs'), 'exec', '--', ...args]),
    });
    report({ json, result });
    return 0;
  } catch (error) {
    report({ json, result: { ok: false, reason: error.message } });
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main({ argv: process.argv.slice(2), env: process.env });

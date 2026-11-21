import { GitHubError, apiPath } from '../lib/github.mjs';

/** @typedef {{ id: string, name: string, ok: boolean, detail: string }} ProbeRow */

/** Probe ids in run order (12.1): V3, V11, V16 and the section 13 push probe. */
export const PROBE_IDS = ['V3', 'V11', 'V16', 'push-main'];

const STATUS_OK = 200;
const STATUS_CREATED = 201;
const STATUS_ALREADY_EXISTS = 422;
const REJECTED_STATUSES = [409, 422];
const V3_BRANCH = 'selftest-v3';
const V16_BRANCH = 'issue/1';
const TAG_RULESET_NAME = 'release-tag-immutability';
const PROBE_MESSAGE = 'chore(selftest): probe';
const REPO_PATH = '/repos/{org}/{repo}';

function fail(message) {
  throw new GitHubError(message);
}

function repoPath(context, suffix) {
  return apiPath(`${REPO_PATH}${suffix}`, { org: context.org, repo: context.repo });
}

/** `branch` may hold slashes (`issue/1`), which `apiPath` would encode. */
function branchRefPath(context, branch) {
  const encoded = branch.split('/').map(encodeURIComponent).join('/');
  return repoPath(context, `/git/refs/heads/${encoded}`);
}

function shaOf(response, label) {
  const value = response.data?.sha ?? response.data?.object?.sha;
  return typeof value === 'string' ? value : fail(`${label}: response has no SHA`);
}

async function readMain(context) {
  const ref = await context.client.request('GET', repoPath(context, '/git/ref/heads/main'));
  const head = shaOf(ref, 'GET ref main');
  const commit = await context.client.request('GET', repoPath(context, `/git/commits/${head}`));
  const tree = commit.data?.tree?.sha;
  return { head, tree: typeof tree === 'string' ? tree : fail('GET commit: response has no tree SHA') };
}

async function createCommit(context, { tree, parent }) {
  const created = await context.client.request('POST', repoPath(context, '/git/commits'), {
    body: { message: PROBE_MESSAGE, tree, parents: [parent] },
  });
  return shaOf(created, 'POST commit');
}

function createBranch(context, { branch, head }) {
  return context.client.request('POST', repoPath(context, '/git/refs'), {
    body: { ref: `refs/heads/${branch}`, sha: head },
    okStatuses: [STATUS_ALREADY_EXISTS],
  });
}

function updateBranch(context, { branch, target, force }) {
  return context.client.request('PATCH', branchRefPath(context, branch), {
    body: { sha: target, force },
    okStatuses: REJECTED_STATUSES,
  });
}

function expectStatus(label, actual, expected) {
  if (!expected.includes(actual)) fail(`${label} returned ${actual}, expected ${expected.join(' or ')}`);
}

async function probeV3(context) {
  const { head } = await readMain(context);
  const first = await createBranch(context, { branch: V3_BRANCH, head });
  expectStatus('first create', first.status, [STATUS_CREATED]);
  const second = await createBranch(context, { branch: V3_BRANCH, head });
  expectStatus('second create', second.status, [STATUS_ALREADY_EXISTS]);
  await context.client.request('DELETE', branchRefPath(context, V3_BRANCH));
  return `create ${first.status}, repeat ${second.status}`;
}

async function probeV11(context) {
  const rulesets = await context.client.paginate(repoPath(context, '/rulesets'));
  const listed = rulesets.find((ruleset) => ruleset.name === TAG_RULESET_NAME);
  if (!listed) fail(`ruleset ${TAG_RULESET_NAME} not found`);
  const detail = await context.client.request('GET', repoPath(context, `/rulesets/${encodeURIComponent(listed.id)}`));
  const hasUpdateRule = (detail.data?.rules ?? []).some((rule) => rule.type === 'update');
  if (!hasUpdateRule) fail(`ruleset ${TAG_RULESET_NAME} has no update rule`);
  return 'update rule present';
}

async function probeV16(context) {
  const { head, tree } = await readMain(context);
  const created = await createBranch(context, { branch: V16_BRANCH, head });
  expectStatus(`create ${V16_BRANCH}`, created.status, [STATUS_CREATED]);
  const child = await createCommit(context, { tree, parent: head });
  const forward = await updateBranch(context, { branch: V16_BRANCH, target: child, force: false });
  expectStatus('fast-forward', forward.status, [STATUS_OK]);
  const rewind = await updateBranch(context, { branch: V16_BRANCH, target: head, force: true });
  expectStatus('forced rewind', rewind.status, REJECTED_STATUSES);
  await context.client.request('DELETE', branchRefPath(context, V16_BRANCH));
  return `fast-forward ${forward.status}, forced rewind ${rewind.status}, delete ok`;
}

async function probePushMain(context) {
  const { head, tree } = await readMain(context);
  const dangling = await createCommit(context, { tree, parent: head });
  const update = await updateBranch(context, { branch: 'main', target: dangling, force: false });
  expectStatus('push to main', update.status, REJECTED_STATUSES);
  return `push rejected with ${update.status}`;
}

const PROBES = {
  V3: { name: 'create ref twice', run: probeV3 },
  V11: { name: 'tag ruleset holds an update rule', run: probeV11 },
  V16: { name: 'issue branch takes fast-forward and delete, rejects rewrite', run: probeV16 },
  'push-main': { name: 'main rejects a non-forced push', run: probePushMain },
};

/**
 * One row per `PROBE_IDS` entry, in that order; a probe that throws becomes a failed row, so one failing probe never throws.
 * @param {{ client: import('../lib/github.mjs').GitHubClient, org: string, repo: string, log: (line: string) => void }} options
 * @returns {Promise<ProbeRow[]>}
 */
export async function runProbes({ client, org, repo, log }) {
  const context = { client, org, repo };
  const rows = [];
  for (const id of PROBE_IDS) {
    const { name, run } = PROBES[id];
    const row = await runProbe(id, name, run, context);
    log(`${row.ok ? 'pass' : 'FAIL'} ${id}: ${row.detail}`);
    rows.push(row);
  }
  return rows;
}

async function runProbe(id, name, run, context) {
  try {
    return { id, name, ok: true, detail: await run(context) };
  } catch (error) {
    return { id, name, ok: false, detail: error.message };
  }
}

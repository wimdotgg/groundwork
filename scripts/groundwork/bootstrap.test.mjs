import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitHubError, createFixtureClient } from '../lib/github.mjs';
import { SettingsError } from '../lib/settings.mjs';
import {
  CONTROL_READ_PERMISSIONS, CREATE_PERMISSIONS, DESCRIPTION_MAX_LENGTH, OP, PERMISSIONS, TOKEN_SCOPE, run, validateArgs,
} from './bootstrap.mjs';
import { buildBootstrapTree, contentPaths, settingsFiles } from './bootstrap-tree.mjs';

test('bootstrap identity', () => {
  assert.equal(OP, 'bootstrap');
  assert.equal(TOKEN_SCOPE, 'deferred');
});

test('validateArgs accepts a printable description up to the limit', () => {
  assert.deepEqual(validateArgs({ description: 'd' }), []);
  assert.deepEqual(validateArgs({ description: 'x'.repeat(DESCRIPTION_MAX_LENGTH) }), []);
});

for (const [name, args, errors] of [
  ['missing description', {}, ['description is required: a non-empty string']],
  ['empty description', { description: '' }, ['description is required: a non-empty string']],
  ['non-string description', { description: 7 }, ['description is required: a non-empty string']],
  ['over-long description', { description: 'x'.repeat(DESCRIPTION_MAX_LENGTH + 1) }, [`description must be at most ${DESCRIPTION_MAX_LENGTH} characters`]],
  ['newline in description', { description: 'a\nb' }, ['description must be printable ASCII']],
  ['DEL in description', { description: 'a\x7fb' }, ['description must be printable ASCII']],
  ['non-ASCII description', { description: 'café' }, ['description must be printable ASCII']],
  ['unknown key', { description: 'd', extra: 1 }, ['unknown argument "extra"']],
  ['array args', [], ['args must be a JSON object']],
  ['null args', null, ['args must be a JSON object']],
]) {
  test(`validateArgs rejects ${name}`, () => {
    assert.deepEqual(validateArgs(args), errors);
  });
}

test('CONTROL_READ_PERMISSIONS is a contents read grant', () => {
  assert.deepEqual(CONTROL_READ_PERMISSIONS, { contents: 'read' });
});

const ORG = 'wimdotgg';
const CONTROL = 'groundwork';
const REPO = 'widget';
const TAG = 'v0.2.0';
const TAG_SHA = 'd'.repeat(40);
const DESCRIPTION = 'A widget shop';
const TOKEN = 'installation-token';
const ADMIN_BOT = 'wimdotgg-admin[bot]';
const CONFIG = {
  org: ORG, controlRepo: CONTROL, accounts: { owner: 'wianvdm', agent: 'wimdotgg-agent[bot]' }, apps: { admin: 'wimdotgg-admin', release: 'wimdotgg-release' }, deploy: 'scripts',
};
const CONTROL_PATH = `/repos/${ORG}/${CONTROL}`;
const TARGET_PATH = `/repos/${ORG}/${REPO}`;
const KIT_PATH = `${TARGET_PATH}/contents/.github/groundwork/kit-version.txt`;
const SETUP_DIR = 'scripts/groundwork/stubs/setup/';

const LABELS = [
  { name: 'dependencies', color: '0366d6', description: 'Dependabot' },
  { name: 'accepted', color: '0e8a16', description: 'Epic authorized' },
];
const SETTINGS = {
  schemaVersion: 1,
  security: { vulnerability_alerts: true },
  variables: { GROUNDWORK_READY: { value: 'true', assertWhen: 'kitInstalled' } },
};
const MAIN_RULESET = {
  name: 'main', target: 'branch', enforcement: 'active',
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, bypass_actors: [], rules: [{ type: 'deletion' }],
};
const RELEASE_FILES = {
  '.github/dependabot.yml': 'version: 2\n',
  '.github/workflows/ci.yml': 'uses: ./.github/workflows/reusable-verify.yml # zizmor: ignore[self-repository] local\n',
  '.github/groundwork/config.json': JSON.stringify({ org: ORG }),
  '.github/groundwork/settings.json': JSON.stringify(SETTINGS),
  '.github/groundwork/labels.json': JSON.stringify({ schemaVersion: 1, labels: LABELS }),
  '.github/groundwork/rulesets/main.json': JSON.stringify(MAIN_RULESET),
  'README.md': 'control readme\n',
  'docs/spec.md': 'spec\n',
  'scripts/verify': 'control verify\n',
  'scripts/verify.cmd': 'control verify\n',
  'scripts/groundwork/admin-run.mjs': 'control only\n',
  'scripts/groundwork/stubs/verify': 'stub verify\n',
  'scripts/groundwork/stubs/verify.cmd': 'stub verify\n',
  'scripts/groundwork/stubs/README.md': '# __REPO__\n\n__DESCRIPTION__\n',
  'scripts/groundwork/stubs/docs/guide.md': 'guide\n',
  ...Object.fromEntries(['deploy', 'smoke', 'rollback'].flatMap((name) => [name, `${name}.cmd`])
    .map((file) => [`scripts/groundwork/stubs/deploy/${file}`, 'stub deploy\n'])),
  [`${SETUP_DIR}epic.md`]: '# Set up __REPO__\n\n## Goal\n\n__DESCRIPTION__\n',
  [`${SETUP_DIR}01-stack.md`]: '# Pick the stack\n<!-- size: M -->\n\n## Outcome\n\nStack.\n',
  [`${SETUP_DIR}02-deploy.md`]: '# Decide deploy\n<!-- size: S -->\n<!-- blocked-by: 01 -->\n\n## Outcome\n\nDeploy.\n',
};

const base64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const reply = (status, data = {}) => ({ status, data, headers: {} });
const urlKey = (path) => path.split('?')[0];

function releaseEntries(files) {
  return Object.keys(files).map((path, index) => ({ path, mode: '100644', sha: `sha-${index}` }));
}

function expectedTree(files) {
  const entries = releaseEntries(files);
  const contents = Object.fromEntries(contentPaths(entries).map((path) => [path, files[path]]));
  const treeEntries = buildBootstrapTree({ entries, contents, org: ORG, controlRepo: CONTROL, repo: REPO, description: DESCRIPTION, tag: TAG, tagSha: TAG_SHA });
  return { entries, contents, treeEntries };
}

/** Status of each kit-version read without a ref, in call order: one per `inspectRepo` (not when absent) and per `applySections` call. */
const KIT_READS = { absent: [404, 200, 200, 200, 200], fresh: [404, 404, 200, 200, 200, 200], ours: [200, 200, 200, 200, 200, 200] };

function targetRoutes(state, files) {
  const { treeEntries } = expectedTree(files);
  const onMain = state === 'ours' ? reply(200, { content: base64(`${TAG}\n`) }) : reply(404);
  return {
    [`GET ${TARGET_PATH}`]: state === 'absent' ? reply(404) : reply(200, { default_branch: 'main' }),
    [`GET ${KIT_PATH}`]: KIT_READS[state].map((status) => reply(status)),
    [`GET ${KIT_PATH}?ref=main`]: onMain,
    [`GET ${TARGET_PATH}/commits?per_page=2`]: reply(200, [{ sha: 'c0', author: { login: ADMIN_BOT } }]),
    [`GET ${TARGET_PATH}/contents/`]: reply(200, [{ name: 'README.md', type: 'file' }]),
    [`GET ${TARGET_PATH}/git/ref/heads/main`]: reply(200, { object: { sha: 'head-0' } }),
    [`POST ${TARGET_PATH}/git/blobs`]: treeEntries.filter((entry) => entry.sha).map((entry) => reply(201, { sha: entry.sha })),
    [`POST ${TARGET_PATH}/git/trees`]: reply(201, { sha: 'tree-1' }),
    [`POST ${TARGET_PATH}/git/commits`]: reply(201, { sha: 'commit-1' }),
    [`PATCH ${TARGET_PATH}/git/refs/heads/main`]: reply(200),
    [`GET ${TARGET_PATH}/code-scanning/default-setup`]: reply(200, { state: 'not-configured' }),
    [`GET ${TARGET_PATH}/labels?per_page=100`]: [reply(200, []), reply(200, LABELS)],
    [`POST ${TARGET_PATH}/labels`]: reply(201),
    [`PUT ${TARGET_PATH}/vulnerability-alerts`]: reply(204),
    [`GET ${TARGET_PATH}/rulesets?includes_parents=false&per_page=100`]: reply(200, []),
    [`POST ${TARGET_PATH}/rulesets`]: reply(201),
    [`GET ${TARGET_PATH}/actions/variables?per_page=100`]: reply(200, { variables: [] }),
    [`POST ${TARGET_PATH}/actions/variables`]: reply(201),
    [`GET ${TARGET_PATH}/issues?per_page=100&state=all`]: reply(200, []),
    [`POST ${TARGET_PATH}/issues`]: [reply(201, { number: 10, id: 100 }), reply(201, { number: 11, id: 101 }), reply(201, { number: 12, id: 102 })],
    [`POST ${TARGET_PATH}/issues/10/sub_issues`]: reply(201),
    [`POST ${TARGET_PATH}/issues/12/dependencies/blocked_by`]: reply(201),
    [`POST /orgs/${ORG}/repos`]: reply(201),
  };
}

function controlRoutes(files) {
  const routes = {
    [`GET ${CONTROL_PATH}/git/ref/tags/${TAG}`]: reply(200, { object: { type: 'commit', sha: TAG_SHA } }),
    [`GET ${CONTROL_PATH}/git/matching-refs/tags/v?per_page=100`]: reply(200, [{ ref: 'refs/tags/v0.1.0' }, { ref: `refs/tags/${TAG}` }]),
    [`GET ${CONTROL_PATH}/git/trees/${TAG_SHA}?recursive=1`]: reply(200, {
      truncated: false, tree: releaseEntries(files).map((entry) => ({ ...entry, type: 'blob' })),
    }),
  };
  for (const entry of releaseEntries(files)) {
    routes[`GET ${CONTROL_PATH}/git/blobs/${entry.sha}`] = reply(200, { content: base64(files[entry.path]), encoding: 'base64' });
  }
  return routes;
}

/** One run's world: a fixture client that logs every call with the grant it ran under, and the ctx `admin-run` would build. */
function createWorld({ state = 'absent', files = RELEASE_FILES, overrides = {}, repo = REPO, config = CONFIG, args = { description: DESCRIPTION } } = {}) {
  const calls = [];
  const bodies = [];
  const grants = [];
  const written = [];
  const sleeps = [];
  let grant = null;
  const fixture = createFixtureClient(
    { ...targetRoutes(state, files), ...controlRoutes(files), ...overrides },
    { onCall: ({ method, path, status }) => calls.push({ grant, method, path: urlKey(path), status }) },
  );
  const client = {
    ...fixture,
    request(method, path, options) {
      if (method !== 'GET') bodies.push({ method, path: urlKey(path), body: options?.body });
      return fixture.request(method, path, options);
    },
  };
  const withToken = async (request, callback) => {
    grant = request;
    grants.push(request);
    try {
      return await callback({ client, token: TOKEN });
    } finally {
      grant = null;
    }
  };
  const writeSettings = async (settings) => {
    written.push(settings);
    const root = await mkdtemp(path.join(os.tmpdir(), 'bootstrap-'));
    temporaryRoots.push(root);
    for (const [file, text] of Object.entries(settings)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), text);
    }
    return { settingsRoot: root, config };
  };
  const logs = [];
  const env = { INPUT_ARGS: JSON.stringify(args), RELEASE_APP_KEY: 'key', RELEASE_APP_CLIENT_ID: 'id', PATH: '/bin' };
  const ctx = { client: null, token: null, org: ORG, repo, settingsRoot: '/control', config, env, log: (line) => logs.push(line), withToken, writeSettings };
  const spawnGh = async ({ args: ghArgs }) => {
    calls.push({ grant, method: 'gh', path: ghArgs.join(' '), status: 0 });
    return { code: 0, stderr: '' };
  };
  const seams = { sleep: async (ms) => { sleeps.push(ms); }, settingsDependencies: { spawnGh } };
  return { ctx, seams, calls, bodies, grants, written, sleeps, logs };
}

const temporaryRoots = [];
test.after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

const writesOf = (world) => world.calls.filter((call) => call.method !== 'GET');
const lineOf = (call) => `${call.method} ${call.path}`;
const indexOfLine = (world, line) => world.calls.findIndex((call) => lineOf(call) === line);

test('AC1 a fresh run reads the control repo under the read grant, creates under the create grant, then writes in 14.2 order', async () => {
  const world = createWorld({ state: 'absent' });
  const result = await run(world.ctx, world.seams);
  assert.equal(result.ok, true);

  const controlCalls = world.calls.filter((call) => call.path.startsWith(CONTROL_PATH));
  assert.ok(controlCalls.length > 0);
  for (const call of controlCalls) assert.deepEqual(call.grant, { repositories: [CONTROL], permissions: CONTROL_READ_PERMISSIONS });
  const create = world.calls.find((call) => call.path === `/orgs/${ORG}/repos`);
  assert.deepEqual(create.grant, { repositories: [CONTROL], permissions: CREATE_PERMISSIONS });
  const createIndex = world.calls.findIndex((call) => call.path === `/orgs/${ORG}/repos`);
  const targetCalls = world.calls.map((call, index) => ({ ...call, index })).filter((call) => call.path.startsWith(TARGET_PATH));
  const inspection = targetCalls.filter((call) => call.index < createIndex);
  assert.deepEqual(inspection.map(lineOf), [`GET ${TARGET_PATH}`]);
  for (const call of inspection) assert.deepEqual(call.grant, { repositories: [CONTROL], permissions: CONTROL_READ_PERMISSIONS });
  for (const call of targetCalls.filter((candidate) => candidate.index > createIndex)) {
    assert.deepEqual(call.grant, { repositories: [REPO], permissions: PERMISSIONS }, lineOf(call));
  }

  const labels = indexOfLine(world, `POST ${TARGET_PATH}/labels`);
  assert.ok(indexOfLine(world, `POST /orgs/${ORG}/repos`) < labels);
  assert.ok(labels < indexOfLine(world, `PATCH ${TARGET_PATH}/git/refs/heads/main`));
  const rulesets = indexOfLine(world, `POST ${TARGET_PATH}/rulesets`);
  const ready = indexOfLine(world, `POST ${TARGET_PATH}/actions/variables`);
  const otherSettingsWrites = [`PUT ${TARGET_PATH}/vulnerability-alerts`, 'gh secret set RELEASE_APP_KEY --env release --repo wimdotgg/widget'];
  for (const line of otherSettingsWrites) assert.ok(indexOfLine(world, line) < rulesets, line);
  assert.ok(rulesets < ready);
  assert.ok(ready < indexOfLine(world, `POST ${TARGET_PATH}/issues`));
  assert.deepEqual(world.grants.map((grant) => Object.keys(grant.permissions).length), [1, 1, 8]);
});

test('AC1 each token grant is minted once and ctx carries no client of its own', async () => {
  const world = createWorld({ state: 'absent' });
  await run(world.ctx, world.seams);
  assert.deepEqual(world.grants.map((grant) => grant.repositories), [[CONTROL], [CONTROL], [REPO]]);
  assert.equal(world.ctx.client, null);
});

test('AC2 a foreign target fails with zero writes and no grant beyond the control read', async () => {
  const world = createWorld({ state: 'fresh', overrides: { [`GET ${TARGET_PATH}/commits?per_page=2`]: reply(200, [{ sha: 'c0', author: { login: 'someone' } }]) } });
  await assert.rejects(run(world.ctx, world.seams), (error) => error instanceof SettingsError && /neither a groundwork project/.test(error.message));
  assert.deepEqual(writesOf(world), []);
  assert.deepEqual(world.grants.map((grant) => grant.permissions), [CONTROL_READ_PERMISSIONS]);
});

test('AC2 a fresh target skips creation and still commits', async () => {
  const world = createWorld({ state: 'fresh' });
  const result = await run(world.ctx, world.seams);
  assert.equal(world.calls.some((call) => call.path === `/orgs/${ORG}/repos`), false);
  assert.equal(world.calls.some((call) => call.path === `${TARGET_PATH}/git/commits`), true);
  assert.match(result.summary, /- inspect: fresh/);
  assert.match(result.summary, /- create repository: skipped/);
});

test('AC2 an ours target takes the tag from kit-version.txt and makes no commit', async () => {
  const world = createWorld({ state: 'ours' });
  const result = await run(world.ctx, world.seams);
  assert.equal(world.calls.some((call) => call.path.includes('matching-refs')), false);
  const controlBlobReads = world.calls.filter((call) => call.path.startsWith(`${CONTROL_PATH}/git/blobs/`));
  assert.equal(controlBlobReads.length, contentPaths(releaseEntries(RELEASE_FILES)).length);
  assert.equal(world.calls.some((call) => call.path.includes('/git/blobs') && call.method === 'POST'), false);
  assert.equal(world.calls.some((call) => call.path.includes('/git/commits') || call.path.includes('/git/refs/')), false);
  assert.match(result.summary, new RegExp(`- release tag: ${TAG}`));
  assert.match(result.summary, /- bootstrap commit: already on main/);
});

test('AC2 a run that fails at the settings step and reruns creates no second repository, commit or epic', async () => {
  const failing = createWorld({ state: 'absent', overrides: { [`PUT ${TARGET_PATH}/vulnerability-alerts`]: reply(403, { message: 'Forbidden' }) } });
  await assert.rejects(run(failing.ctx, failing.seams), GitHubError);
  const rerun = createWorld({ state: 'ours' });
  const result = await run(rerun.ctx, rerun.seams);
  assert.equal(result.ok, true);

  const both = [...failing.bodies, ...rerun.bodies];
  const count = (line) => both.filter((write) => lineOf(write) === line).length;
  assert.equal(count(`POST /orgs/${ORG}/repos`), 1);
  assert.equal(count(`POST ${TARGET_PATH}/git/commits`), 1);
  assert.equal(count(`POST ${TARGET_PATH}/issues`), 3);
  assert.equal(failing.bodies.some((write) => write.path.includes('/issues')), false);
});

test('AC2 the control repository is refused inside run before any token is minted', async () => {
  const world = createWorld({ repo: CONTROL });
  await assert.rejects(run(world.ctx, world.seams), (error) => error instanceof SettingsError && /control repository/.test(error.message));
  world.ctx.repo = 'GroundWork';
  await assert.rejects(run(world.ctx, world.seams), /control repository/);
  assert.deepEqual(world.grants, []);
  assert.deepEqual(world.calls, []);
});

test('AC4 settings are read from the built tree written through writeSettings, and no label is written but the size labels', async () => {
  const world = createWorld({ state: 'absent' });
  await run(world.ctx, world.seams);
  const { contents, treeEntries } = expectedTree(RELEASE_FILES);
  assert.equal(world.written.length, 1);
  assert.deepEqual(world.written[0], settingsFiles(treeEntries, contents));
  assert.deepEqual(world.bodies.filter((write) => write.path === `${TARGET_PATH}/labels`).map((write) => write.body.name), LABELS.map((label) => label.name));
  const issueBodies = world.bodies.filter((write) => write.path === `${TARGET_PATH}/issues`).map((write) => write.body);
  assert.deepEqual(issueBodies.map((body) => body.labels), [undefined, ['size:M'], ['size:S']]);
  assert.equal(world.bodies.some((write) => /\/issues\/\d+\/labels/.test(write.path)), false);
});

test('AC4 the bootstrap commit holds the same settings files the run applies', async () => {
  const world = createWorld({ state: 'absent' });
  await run(world.ctx, world.seams);
  const { treeEntries } = expectedTree(RELEASE_FILES);
  const posted = world.bodies.find((write) => write.path === `${TARGET_PATH}/git/trees`).body.tree;
  assert.deepEqual(posted.filter((entry) => entry.path.startsWith('.github/groundwork/')).map((entry) => entry.path),
    treeEntries.filter((entry) => entry.path.startsWith('.github/groundwork/')).map((entry) => entry.path));
});

test('AC5 the summary lists every pass 1 step with its result and the tag', async () => {
  const world = createWorld({ state: 'absent' });
  const { summary } = await run(world.ctx, world.seams);
  const steps = ['inspect: absent', `release tag: ${TAG}`, 'create repository: created', 'labels: 2 created', 'bootstrap commit: pushed commit-1',
    'security: 1 switch(es) applied', 'variables: 1 created', 'rulesets: 1 created', 'setup epic: #10, 3 issue(s) created'];
  const lines = summary.split('\n');
  for (const step of steps) assert.ok(lines.includes(`- ${step}`), step);
  assert.deepEqual(lines.slice(0, 2), [`### bootstrap ${ORG}/${REPO}`, '']);
});

test('AC8 the last step lists labels again and deletes the defaults GitHub seeded meanwhile', async () => {
  const defaults = ['bug', 'documentation', 'duplicate', 'enhancement', 'good first issue', 'help wanted', 'invalid', 'question', 'wontfix', 'accessibility']
    .map((name) => ({ name, color: 'ededed', description: '' }));
  const world = createWorld({
    state: 'absent',
    overrides: {
      [`GET ${TARGET_PATH}/labels?per_page=100`]: [reply(200, []), reply(200, [...LABELS, ...defaults])],
      ...Object.fromEntries(defaults.map(({ name }) => [`DELETE ${TARGET_PATH}/labels/${encodeURIComponent(name)}`, reply(204)])),
    },
  });
  const { summary } = await run(world.ctx, world.seams);
  const deletes = world.calls.filter((call) => call.method === 'DELETE' && call.path.startsWith(`${TARGET_PATH}/labels/`));
  assert.equal(deletes.length, defaults.length);
  const lastLabelsStep = world.calls.findLastIndex((call) => call.path === `${TARGET_PATH}/labels` && call.method === 'GET');
  const lastEpicWrite = world.calls.findLastIndex((call) => call.method === 'POST' && /\/(sub_issues|dependencies\/blocked_by)$/.test(call.path));
  assert.ok(lastEpicWrite > -1 && lastLabelsStep > lastEpicWrite, 'the cleanup runs after the last setup epic write');
  assert.ok(summary.split('\n').includes('- labels (final pass): 10 deleted'));
});

test('issue and blob creations are paced through the injected sleep', async () => {
  const world = createWorld({ state: 'absent' });
  await run(world.ctx, world.seams);
  assert.ok(world.sleeps.length >= 2);
});

test('a bad description in INPUT_ARGS fails before any token is minted', async () => {
  for (const args of [{}, { description: 'bad\nline' }]) {
    const world = createWorld({ args });
    await assert.rejects(run(world.ctx, world.seams), SettingsError);
    assert.deepEqual(world.grants, []);
  }
  const unparsable = createWorld();
  unparsable.ctx.env.INPUT_ARGS = 'not json';
  await assert.rejects(run(unparsable.ctx, unparsable.seams), /not valid JSON/);
});

test('a missing release value fails before any token is minted', async () => {
  for (const missing of ['RELEASE_APP_KEY', 'RELEASE_APP_CLIENT_ID']) {
    const world = createWorld({ state: 'absent' });
    delete world.ctx.env[missing];
    await assert.rejects(run(world.ctx, world.seams), new RegExp(`${missing} is not set`));
    assert.deepEqual(world.grants, []);
    assert.deepEqual(world.calls, []);
  }
});

test('a broken setup template fails before the repository or any other write', async () => {
  const withoutEpic = { ...RELEASE_FILES };
  delete withoutEpic[`${SETUP_DIR}epic.md`];
  const world = createWorld({ state: 'absent', files: withoutEpic });
  await assert.rejects(run(world.ctx, world.seams), SettingsError);
  assert.deepEqual(writesOf(world), []);
  assert.equal(world.grants.length, 1);
});

const ISSUES_ROUTE = `GET ${TARGET_PATH}/issues?per_page=100&state=all`;
const setupEpicIssue = (fields) => ({ number: 10, id: 100, state: 'open', labels: [], body: '# Project setup\n\n<!-- groundwork:setup-epic -->', user: { login: ADMIN_BOT }, ...fields });

/** Routes for a run that finds the epic already open: its sub-issue list is read live and only the two tasks are created. */
const existingEpicRoutes = (fields) => ({
  [ISSUES_ROUTE]: reply(200, [setupEpicIssue(fields)]),
  [`GET ${TARGET_PATH}/issues/10/sub_issues?per_page=100`]: reply(200, []),
  [`POST ${TARGET_PATH}/issues`]: [reply(201, { number: 11, id: 101 }), reply(201, { number: 12, id: 102 })],
});

async function refusedWorld(fields) {
  const world = createWorld({ state: 'ours', overrides: { [ISSUES_ROUTE]: reply(200, [setupEpicIssue(fields)]) } });
  await assert.rejects(run(world.ctx, world.seams), (error) => error instanceof SettingsError && /apply-settings/.test(error.message));
  return world;
}

test('AC1 an ours run refuses on an accepted setup epic before any write and names apply-settings', async () => {
  const world = await refusedWorld({ labels: [{ name: 'accepted' }] });
  assert.deepEqual(writesOf(world), []);
  assert.equal(world.grants.length, 1);
  assert.equal(world.calls.some((call) => call.method === 'gh'), false);
});

test('AC2 an ours run refuses on a closed setup epic before any write and names apply-settings', async () => {
  const world = await refusedWorld({ state: 'closed' });
  assert.deepEqual(writesOf(world), []);
  assert.equal(world.grants.length, 1);
  assert.equal(world.calls.some((call) => call.method === 'gh'), false);
});

test('AC3 an ours run resumes on an open unaccepted setup epic and on none', async () => {
  const open = createWorld({ state: 'ours', overrides: existingEpicRoutes({ labels: [{ name: 'size:M' }] }) });
  assert.equal((await run(open.ctx, open.seams)).ok, true);
  const none = createWorld({ state: 'ours' });
  assert.equal((await run(none.ctx, none.seams)).ok, true);
});

test('a fresh run is not refused by an accepted setup epic', async () => {
  const world = createWorld({ state: 'fresh', overrides: existingEpicRoutes({ labels: [{ name: 'accepted' }] }) });
  assert.equal((await run(world.ctx, world.seams)).ok, true);
});

test('an ours run whose setup-epic marker was planted by another login fails the author check before any write', async () => {
  const world = createWorld({ state: 'ours', overrides: { [ISSUES_ROUTE]: reply(200, [setupEpicIssue({ user: { login: 'stranger' } })]) } });
  await assert.rejects(run(world.ctx, world.seams), /was not written by/);
  assert.deepEqual(writesOf(world), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubError, createFixtureClient } from '../lib/github.mjs';
import { SettingsError } from '../lib/settings.mjs';
import { OP, PERMISSIONS, TOKEN_SCOPE, run, validateArgs } from './apply-settings.mjs';

const REAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG = {
  org: 'wimdotgg',
  controlRepo: 'groundwork',
  accounts: { owner: 'wianvdm', agent: 'wimdotgg-agent[bot]' },
  apps: { admin: 'wimdotgg-admin', release: 'wimdotgg-release' },
  deploy: 'scripts',
};
const CONTROL = 'groundwork';
const PROJECT = 'widget';
const TOKEN = 'installation-token';
const KEY_VALUE = 'key-value-that-must-never-be-logged';
const CLIENT_ID_VALUE = 'client-id-value';
const RELEASE_ENV = { RELEASE_APP_KEY: KEY_VALUE, RELEASE_APP_CLIENT_ID: CLIENT_ID_VALUE, PATH: '/bin' };
const OK = { status: 200, data: {} };
const CODE_SCANNING_RULE = { type: 'code_scanning', parameters: { code_scanning_tools: [{ tool: 'CodeQL' }] } };
const repoPath = (repo) => `/repos/wimdotgg/${repo}`;

const temporaryRoots = [];

async function makeRoot({ settings = { schemaVersion: 1 }, labels = [], rulesets = [mainRuleset([{ type: 'deletion' }])] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'apply-settings-'));
  temporaryRoots.push(root);
  const directory = path.join(root, '.github', 'groundwork');
  await mkdir(path.join(directory, 'rulesets'), { recursive: true });
  await writeFile(path.join(directory, 'settings.json'), JSON.stringify(settings));
  await writeFile(path.join(directory, 'labels.json'), JSON.stringify({ schemaVersion: 1, labels }));
  for (const ruleset of rulesets) {
    await writeFile(path.join(directory, 'rulesets', `${ruleset.name}.json`), JSON.stringify(ruleset));
  }
  return root;
}

/** The shipped settings.json and rulesets, with a small label set so the expected calls stay readable. */
async function makeShippedRoot(labels) {
  const root = await makeRoot({ labels });
  const directory = path.join('.github', 'groundwork');
  await cp(path.join(REAL_ROOT, directory, 'settings.json'), path.join(root, directory, 'settings.json'));
  await cp(path.join(REAL_ROOT, directory, 'rulesets'), path.join(root, directory, 'rulesets'), { recursive: true });
  return root;
}

test.after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Reads the op performs, keyed for createFixtureClient. */
function readRoutes(repo, { kitInstalled = true, setupState = 'configured', liveRulesets = [], mainRules = [], variables = [], labels = [], policies = {} } = {}) {
  const base = repoPath(repo);
  const routes = {
    [`GET ${base}/code-scanning/default-setup`]: { status: 200, data: { state: setupState } },
    [`GET ${base}/rulesets?includes_parents=false&per_page=100`]: { status: 200, data: liveRulesets },
    [`GET ${base}/actions/variables?per_page=100`]: { status: 200, data: { variables } },
    [`GET ${base}/labels?per_page=100`]: { status: 200, data: labels },
    'GET /users/wianvdm': { status: 200, data: { id: 11 } },
    'GET /apps/wimdotgg-release': { status: 200, data: { id: 4242 } },
  };
  routes[`GET ${base}/contents/.github/groundwork/kit-version.txt`] = kitInstalled ? OK : { status: 404, data: { message: 'Not Found' } };
  for (const summary of liveRulesets) {
    const rules = summary.name === 'main' ? mainRules : [];
    routes[`GET ${base}/rulesets/${summary.id}`] = { status: 200, data: { ...summary, rules } };
  }
  for (const name of ['release', 'production', 'admin']) {
    const refs = policies[name] ?? [];
    routes[`GET ${base}/environments/${name}/deployment-branch-policies?per_page=100`] = { status: 200, data: { branch_policies: refs } };
  }
  return routes;
}

/** The write every default root makes in step 9, since the gate needs a desired `main` ruleset. */
const createMain = (repo) => `POST ${repoPath(repo)}/rulesets`;
const writeLines = (events) => events.filter((event) => !event.gh).map((event) => event.line);

/**
 * Runs the op with a fixture client. Non-GET requests are served from `writes` ("METHOD path" lines, 200 by default,
 * or a response object) and recorded with their bodies, together with every `gh` invocation, in call order.
 */
async function runOp({ root, repo = CONTROL, reads, writes = {}, env = RELEASE_ENV, config = CONFIG }) {
  const events = [];
  const logs = [];
  const inner = createFixtureClient({ ...reads, ...writes });
  const client = {
    ...inner,
    request(method, requestPath, options) {
      if (method !== 'GET') events.push({ line: `${method} ${requestPath}`, body: options?.body });
      return inner.request(method, requestPath, options);
    },
  };
  const spawnGh = async (invocation) => {
    events.push({ line: `gh ${invocation.args.join(' ')}`, gh: invocation });
    return { code: 0, stderr: '' };
  };
  const context = { client, token: TOKEN, org: 'wimdotgg', repo, settingsRoot: root, config, env, log: (line) => logs.push(line) };
  try {
    return { events, logs, result: await run(context, { spawnGh }) };
  } catch (error) {
    return { events, logs, error };
  }
}

/** Fixture routes for every expected write line, so a missing or extra call fails the test. */
const okWrites = (lines) => Object.fromEntries(lines.filter((line) => !line.startsWith('gh ')).map((line) => [line, OK]));

function succeeded(outcome) {
  if (outcome.error) throw outcome.error;
  return outcome;
}

const body = (events, line) => events.find((event) => event.line === line)?.body;

const SMALL_LABELS = [{ name: 'accepted', color: '0e8a16', description: 'Epic authorized by the owner' }];

test('exports the admin op contract', () => {
  assert.equal(OP, 'apply-settings');
  assert.equal(TOKEN_SCOPE, 'target');
  assert.deepEqual(PERMISSIONS, {
    administration: 'write', environments: 'write', actions_variables: 'write', issues: 'write',
    contents: 'read', members: 'read', actions: 'read',
  });
});

test('validateArgs accepts an empty object and rejects unknown keys and non-objects', () => {
  assert.deepEqual(validateArgs({}), []);
  assert.deepEqual(validateArgs({ ref: 'abc' }), ['unknown key "ref"']);
  assert.deepEqual(validateArgs(null), ['args must be a JSON object']);
  assert.deepEqual(validateArgs([]), ['args must be a JSON object']);
});

test('control repo: full apply in spec order with rulesets last and controlRepository sent', async () => {
  const root = await makeShippedRoot(SMALL_LABELS);
  const base = repoPath(CONTROL);
  const expected = [
    `PATCH ${base}`,
    `PUT /orgs/wimdotgg/teams/agents/repos/wimdotgg/${CONTROL}`,
    `PUT ${base}/private-vulnerability-reporting`,
    `PUT ${base}/vulnerability-alerts`,
    `PUT ${base}/automated-security-fixes`,
    `PUT ${base}/actions/permissions`,
    `PUT ${base}/actions/permissions/workflow`,
    `PUT ${base}/actions/permissions/fork-pr-contributor-approval`,
    `POST ${base}/actions/variables`,
    `PUT ${base}/environments/release`,
    `POST ${base}/environments/release/deployment-branch-policies`,
    `PUT ${base}/environments/admin`,
    `POST ${base}/environments/admin/deployment-branch-policies`,
    `gh secret set RELEASE_APP_KEY --env release --repo wimdotgg/${CONTROL}`,
    `gh variable set RELEASE_APP_CLIENT_ID --env release --repo wimdotgg/${CONTROL}`,
    `POST ${base}/labels`,
    `DELETE ${base}/labels/bug`,
    `POST ${base}/rulesets`,
    `POST ${base}/rulesets`,
    `POST ${base}/rulesets`,
    `POST ${base}/rulesets`,
  ];
  const reads = readRoutes(CONTROL, { setupState: 'not_configured', labels: [{ name: 'bug', color: 'd73a4a', description: null }] });
  const outcome = succeeded(await runOp({ root, reads, writes: okWrites(expected) }));
  assert.deepEqual(outcome.events.map((event) => event.line), expected);
  assert.equal(body(outcome.events, `PATCH ${base}`).is_template, true);
  assert.equal(outcome.result.ok, true);
  assert.match(outcome.result.summary, /^### apply-settings wimdotgg\/groundwork/);
});

test('control repo: every step is logged once, in order, before its calls', async () => {
  const root = await makeRoot();
  const reads = readRoutes(CONTROL);
  const outcome = succeeded(await runOp({ root, reads, writes: okWrites([createMain(CONTROL)]) }));
  assert.deepEqual(outcome.logs.map((line) => line.replace(/ .*/, '')), ['reading', ...Array(9).fill('step')]);
  assert.match(outcome.logs[1], /^step 1\/9 repository$/);
  assert.match(outcome.logs[9], /^step 9\/9 rulesets$/);
});

test('project repo: no controlRepository fields and project environments only', async () => {
  const root = await makeShippedRoot(SMALL_LABELS);
  const base = repoPath(PROJECT);
  const expected = [
    `PATCH ${base}`,
    `PUT /orgs/wimdotgg/teams/agents/repos/wimdotgg/${PROJECT}`,
    `PUT ${base}/private-vulnerability-reporting`,
    `PUT ${base}/vulnerability-alerts`,
    `PUT ${base}/automated-security-fixes`,
    `PUT ${base}/actions/permissions`,
    `PUT ${base}/actions/permissions/workflow`,
    `PUT ${base}/actions/permissions/fork-pr-contributor-approval`,
    `POST ${base}/actions/variables`,
    `PUT ${base}/environments/release`,
    `POST ${base}/environments/release/deployment-branch-policies`,
    `PUT ${base}/environments/production`,
    `POST ${base}/environments/production/deployment-branch-policies`,
    `gh secret set RELEASE_APP_KEY --env release --repo wimdotgg/${PROJECT}`,
    `gh variable set RELEASE_APP_CLIENT_ID --env release --repo wimdotgg/${PROJECT}`,
    `POST ${base}/labels`,
    `POST ${base}/rulesets`,
    `POST ${base}/rulesets`,
    `POST ${base}/rulesets`,
    `POST ${base}/rulesets`,
  ];
  const reads = readRoutes(PROJECT, { setupState: 'not_configured' });
  const outcome = succeeded(await runOp({ root, repo: PROJECT, reads, writes: okWrites(expected) }));
  assert.deepEqual(outcome.events.map((event) => event.line), expected);
  assert.equal(Object.hasOwn(body(outcome.events, `PATCH ${base}`), 'is_template'), false);
  const production = body(outcome.events, `PUT ${base}/environments/production`);
  assert.deepEqual(production, {
    reviewers: [{ type: 'User', id: 11 }],
    prevent_self_review: false,
    can_admins_bypass: false,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  });
  assert.deepEqual(body(outcome.events, `POST ${base}/environments/production/deployment-branch-policies`), { name: 'v*', type: 'tag' });
});

test('variables: asserted only while the signal holds, otherwise left alone', async () => {
  const settings = {
    schemaVersion: 1,
    variables: {
      GROUNDWORK_READY: { value: 'true', assertWhen: 'kitInstalled' },
      DEPLOY_ENABLED: { value: 'true', assertWhen: 'deployReady' },
    },
  };
  const root = await makeRoot({ settings });
  const base = repoPath(PROJECT);
  const before = succeeded(await runOp({
    root, repo: PROJECT, reads: readRoutes(PROJECT, { setupState: 'not_configured' }),
    writes: okWrites([`POST ${base}/actions/variables`, createMain(PROJECT)]),
  }));
  const variableWrites = (events) => events.filter((event) => event.line.includes('/actions/variables'));
  assert.deepEqual(variableWrites(before.events).map((event) => event.body), [{ name: 'GROUNDWORK_READY', value: 'true' }]);

  const after = succeeded(await runOp({
    root, repo: PROJECT,
    reads: readRoutes(PROJECT, { variables: [{ name: 'GROUNDWORK_READY', value: 'false' }] }),
    writes: okWrites([`PATCH ${base}/actions/variables/GROUNDWORK_READY`, `POST ${base}/actions/variables`, createMain(PROJECT)]),
  }));
  assert.deepEqual(variableWrites(after.events).map((event) => [event.line, event.body]), [
    [`PATCH ${base}/actions/variables/GROUNDWORK_READY`, { name: 'GROUNDWORK_READY', value: 'true' }],
    [`POST ${base}/actions/variables`, { name: 'DEPLOY_ENABLED', value: 'true' }],
  ]);
});

test('variables: deploy none keeps deployReady variables alone even when CodeQL is configured', async () => {
  const settings = { schemaVersion: 1, variables: { DEPLOY_ENABLED: { value: 'true', assertWhen: 'deployReady' } } };
  const root = await makeRoot({ settings });
  const config = { ...CONFIG, deploy: 'none' };
  const outcome = succeeded(await runOp({ root, reads: readRoutes(CONTROL), config, writes: okWrites([createMain(CONTROL)]) }));
  assert.deepEqual(writeLines(outcome.events), [createMain(CONTROL)]);
});

test('labels: missing created, differing updated, matching kept, defaults deleted', async () => {
  const labels = [
    { name: 'accepted', color: '0e8a16', description: 'Epic authorized' },
    { name: 'flaky', color: 'f9d0c4', description: 'Flaky test' },
    { name: 'needs-decision', color: 'e99695', description: 'Owner decides' },
  ];
  const live = [
    { name: 'bug', color: 'd73a4a', description: null },
    { name: 'Accepted', color: 'FFFFFF', description: 'Old text' },
    { name: 'flaky', color: 'F9D0C4', description: 'Flaky test' },
  ];
  const root = await makeRoot({ labels });
  const base = repoPath(CONTROL);
  const expected = [`PATCH ${base}/labels/Accepted`, `POST ${base}/labels`, `DELETE ${base}/labels/bug`];
  const outcome = succeeded(await runOp({ root, reads: readRoutes(CONTROL, { labels: live }), writes: okWrites([...expected, createMain(CONTROL)]) }));
  const labelEvents = outcome.events.filter((event) => event.line.includes('/labels'));
  assert.deepEqual(labelEvents.map((event) => event.line), expected);
  assert.deepEqual(labelEvents[0].body, { color: '0e8a16', description: 'Epic authorized' });
  assert.deepEqual(labelEvents[1].body, { name: 'needs-decision', color: 'e99695', description: 'Owner decides' });
});

const mainRuleset = (rules) => ({
  name: 'main', target: 'branch', enforcement: 'active',
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  bypass_actors: [], rules,
});
const tagRuleset = {
  name: 'release-tag-creation', target: 'tag', enforcement: 'active',
  conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
  bypass_actors: [{ actor_type: 'Integration', actor_id: '{{app-id:release}}', bypass_mode: 'always' }],
  rules: [{ type: 'creation' }],
};

test('rulesets: updated by id when present, created otherwise, placeholders resolved', async () => {
  const root = await makeRoot({ rulesets: [mainRuleset([{ type: 'deletion' }]), tagRuleset] });
  const base = repoPath(CONTROL);
  const expected = [`PUT ${base}/rulesets/5`, `POST ${base}/rulesets`];
  const reads = readRoutes(CONTROL, { liveRulesets: [{ id: 5, name: 'main', target: 'branch' }] });
  const outcome = succeeded(await runOp({ root, reads, writes: okWrites(expected) }));
  const rulesetEvents = outcome.events.filter((event) => event.line.includes('/rulesets'));
  assert.deepEqual(rulesetEvents.map((event) => event.line), expected);
  assert.equal(rulesetEvents[1].body.bypass_actors[0].actor_id, 4242);
  assert.equal(Object.hasOwn(rulesetEvents[0].body, 'id'), false);
});

test('rulesets: code_scanning is stripped before pass 2 and kept after it', async () => {
  const root = await makeRoot({ rulesets: [mainRuleset([{ type: 'deletion' }, CODE_SCANNING_RULE])] });
  const base = repoPath(CONTROL);
  const types = (outcome) => body(outcome.events, `POST ${base}/rulesets`).rules.map((rule) => rule.type);
  const writes = okWrites([`POST ${base}/rulesets`]);

  const beforePass2 = succeeded(await runOp({ root, reads: readRoutes(CONTROL, { setupState: 'not_configured' }), writes }));
  assert.deepEqual(types(beforePass2), ['deletion']);

  const configured = succeeded(await runOp({ root, reads: readRoutes(CONTROL, { setupState: 'configured' }), writes }));
  assert.deepEqual(types(configured), ['deletion', 'code_scanning']);

  const ranPass2 = succeeded(await runOp({
    root,
    reads: readRoutes(CONTROL, {
      setupState: 'not_configured', liveRulesets: [{ id: 5, name: 'main', target: 'branch' }], mainRules: [CODE_SCANNING_RULE],
    }),
    writes: okWrites([`PUT ${base}/rulesets/5`]),
  }));
  assert.deepEqual(body(ranPass2.events, `PUT ${base}/rulesets/5`).rules.map((rule) => rule.type), ['deletion', 'code_scanning']);
});

test('a second run against matching live state creates and deletes nothing', async () => {
  const settings = {
    schemaVersion: 1,
    variables: { GROUNDWORK_READY: { value: 'true', assertWhen: 'kitInstalled' } },
    environments: {
      release: {
        repos: 'all', reviewers: [], prevent_self_review: false, can_admins_bypass: true,
        deployment_refs: [{ name: 'main', type: 'branch' }], secrets: [], variables: [],
      },
    },
  };
  const root = await makeRoot({ settings, labels: SMALL_LABELS, rulesets: [mainRuleset([{ type: 'deletion' }])] });
  const base = repoPath(CONTROL);
  const reads = readRoutes(CONTROL, {
    variables: [{ name: 'GROUNDWORK_READY', value: 'true' }],
    labels: [{ name: 'accepted', color: '0E8A16', description: 'Epic authorized by the owner' }],
    policies: { release: [{ id: 3, name: 'main', type: 'branch' }] },
    liveRulesets: [{ id: 5, name: 'main', target: 'branch' }],
  });
  const outcome = succeeded(await runOp({ root, reads, writes: okWrites([`PUT ${base}/environments/release`, `PUT ${base}/rulesets/5`]) }));
  assert.deepEqual(writeLines(outcome.events), [`PUT ${base}/environments/release`, `PUT ${base}/rulesets/5`]);
  assert.equal(outcome.events.filter((event) => event.gh).length, 2);
});

test('deployment refs: missing refs are added, then extras deleted by id', async () => {
  const settings = {
    schemaVersion: 1,
    environments: {
      release: {
        repos: 'all', reviewers: [], prevent_self_review: false, can_admins_bypass: true,
        deployment_refs: [{ name: 'main', type: 'branch' }], secrets: [], variables: [],
      },
    },
  };
  const root = await makeRoot({ settings });
  const base = repoPath(CONTROL);
  const policies = { release: [{ id: 8, name: 'main', type: 'tag' }] };
  const expected = [
    `PUT ${base}/environments/release`,
    `POST ${base}/environments/release/deployment-branch-policies`,
    `DELETE ${base}/environments/release/deployment-branch-policies/8`,
    createMain(CONTROL),
  ];
  const outcome = succeeded(await runOp({ root, reads: readRoutes(CONTROL, { policies }), writes: okWrites(expected) }));
  assert.deepEqual(writeLines(outcome.events), expected);
  assert.deepEqual(outcome.events[1].body, { name: 'main', type: 'branch' });
});

test('the first failed call stops the run and the error names the step', async () => {
  const root = await makeShippedRoot(SMALL_LABELS);
  const base = repoPath(CONTROL);
  const failing = `PUT /orgs/wimdotgg/teams/agents/repos/wimdotgg/${CONTROL}`;
  const writes = { ...okWrites([`PATCH ${base}`]), [failing]: { status: 403, data: { message: 'Forbidden' } } };
  const outcome = await runOp({ root, reads: readRoutes(CONTROL), writes });
  assert.ok(outcome.error instanceof GitHubError);
  assert.equal(outcome.error.status, 403);
  assert.match(outcome.error.message, /^step 2\/9 teamAccess: PUT .* 403 Forbidden$/);
  assert.deepEqual(outcome.events.map((event) => event.line), [`PATCH ${base}`, failing]);
  assert.equal(outcome.logs.at(-1), 'step 2/9 teamAccess');
});

test('a missing release value throws before any step runs', async () => {
  const settings = { schemaVersion: 1 };
  const root = await makeRoot({ settings });
  const withoutKey = await runOp({ root, reads: readRoutes(CONTROL), env: { RELEASE_APP_CLIENT_ID: CLIENT_ID_VALUE } });
  assert.ok(withoutKey.error instanceof SettingsError);
  assert.match(withoutKey.error.message, /^RELEASE_APP_KEY is not set/);
  assert.equal(withoutKey.events.length, 0);
  assert.equal(withoutKey.logs.length, 0);

  const withoutClientId = await runOp({ root, reads: readRoutes(CONTROL), env: { RELEASE_APP_KEY: KEY_VALUE } });
  assert.match(withoutClientId.error.message, /RELEASE_APP_CLIENT_ID is not set/);
  assert.equal(withoutClientId.events.length, 0);
});

test('gh gets argument arrays, the value on stdin and the installation token only', async () => {
  const root = await makeRoot();
  const env = { ...RELEASE_ENV, GH_TOKEN: 'ambient-token', ADMIN_APP_KEY: 'admin-key', GITHUB_TOKEN: 'other-token' };
  const outcome = succeeded(await runOp({ root, repo: PROJECT, reads: readRoutes(PROJECT), writes: okWrites([createMain(PROJECT)]), env }));
  const invocations = outcome.events.filter((event) => event.gh).map((event) => event.gh);
  assert.deepEqual(invocations.map((invocation) => invocation.args), [
    ['secret', 'set', 'RELEASE_APP_KEY', '--env', 'release', '--repo', `wimdotgg/${PROJECT}`],
    ['variable', 'set', 'RELEASE_APP_CLIENT_ID', '--env', 'release', '--repo', `wimdotgg/${PROJECT}`],
  ]);
  assert.deepEqual(invocations.map((invocation) => invocation.stdin), [KEY_VALUE, CLIENT_ID_VALUE]);
  for (const invocation of invocations) {
    assert.equal(invocation.env.GH_TOKEN, TOKEN);
    assert.equal(invocation.env.PATH, '/bin');
    assert.equal(Object.hasOwn(invocation.env, 'RELEASE_APP_KEY'), false);
    assert.equal(Object.hasOwn(invocation.env, 'RELEASE_APP_CLIENT_ID'), false);
    assert.equal(Object.hasOwn(invocation.env, 'ADMIN_APP_KEY'), false);
    assert.equal(Object.hasOwn(invocation.env, 'GITHUB_TOKEN'), false);
    assert.equal(invocation.env.GH_PROMPT_DISABLED, '1');
    assert.deepEqual(Object.keys(invocation.env).sort(), ['GH_PROMPT_DISABLED', 'GH_TOKEN', 'PATH']);
  }
});

test('a failing gh call throws a GitHubError with its first stderr line', async () => {
  const root = await makeRoot();
  const events = [];
  const context = {
    client: createFixtureClient(readRoutes(CONTROL)), token: TOKEN, org: 'wimdotgg', repo: CONTROL,
    settingsRoot: root, config: CONFIG, env: RELEASE_ENV, log: (line) => events.push(line),
  };
  const spawnGh = async () => ({ code: 1, stderr: 'HTTP 404: Not Found\nsecond line' });
  await assert.rejects(run(context, { spawnGh }), (error) => {
    assert.ok(error instanceof GitHubError);
    assert.match(error.message, /^step 7\/9 release environment: gh secret set RELEASE_APP_KEY failed: HTTP 404: Not Found$/);
    return true;
  });
  assert.equal(events.at(-1), 'step 7/9 release environment');
});

test('recordCall gets one row per gh write, with the exit status and no value', async () => {
  const root = await makeRoot();
  const rows = [];
  const context = {
    client: createFixtureClient(readRoutes(CONTROL)), token: TOKEN, org: 'wimdotgg', repo: CONTROL,
    settingsRoot: root, config: CONFIG, env: RELEASE_ENV, log: () => {}, recordCall: (row) => rows.push(row),
  };
  const spawnGh = async ({ args }) => ({ code: args[0] === 'variable' ? 1 : 0, stderr: 'denied' });
  await assert.rejects(run(context, { spawnGh }), GitHubError);
  assert.deepEqual(rows, [
    { method: 'gh', path: `secret set RELEASE_APP_KEY --env release --repo wimdotgg/${CONTROL}`, status: 0 },
    { method: 'gh', path: `variable set RELEASE_APP_CLIENT_ID --env release --repo wimdotgg/${CONTROL}`, status: 1 },
  ]);
  for (const value of Object.values(RELEASE_ENV)) assert.ok(!JSON.stringify(rows).includes(value));
});

test('no log line or summary holds a secret value', async () => {
  const root = await makeShippedRoot(SMALL_LABELS);
  const base = repoPath(CONTROL);
  const writes = okWrites([
    `PATCH ${base}`, `PUT /orgs/wimdotgg/teams/agents/repos/wimdotgg/${CONTROL}`,
    `PUT ${base}/private-vulnerability-reporting`, `PUT ${base}/vulnerability-alerts`, `PUT ${base}/automated-security-fixes`,
    `PUT ${base}/actions/permissions`, `PUT ${base}/actions/permissions/workflow`, `PUT ${base}/actions/permissions/fork-pr-contributor-approval`,
    `POST ${base}/actions/variables`,
    `PUT ${base}/environments/release`, `POST ${base}/environments/release/deployment-branch-policies`,
    `PUT ${base}/environments/admin`, `POST ${base}/environments/admin/deployment-branch-policies`,
    `POST ${base}/labels`, `POST ${base}/rulesets`,
  ]);
  const outcome = succeeded(await runOp({ root, reads: readRoutes(CONTROL), writes }));
  const everything = [...outcome.logs, outcome.result.summary].join('\n');
  assert.equal(everything.includes(KEY_VALUE), false);
  assert.equal(everything.includes(CLIENT_ID_VALUE), false);
  assert.equal(everything.includes(TOKEN), false);
});

test('unknown security and actions keys fail before a call is made for that step', async () => {
  const insecure = await makeRoot({ settings: { schemaVersion: 1, security: { dependabot_alerts: true } } });
  const outcome = await runOp({ root: insecure, reads: readRoutes(CONTROL), writes: okWrites([`PATCH ${repoPath(CONTROL)}`]) });
  assert.match(outcome.error.message, /^step 3\/9 security: settings.json: unknown security key "dependabot_alerts"/);
  assert.deepEqual(writeLines(outcome.events), []);
});

test('a missing target repository is rejected before any call', async () => {
  const root = await makeRoot();
  const outcome = await runOp({ root, repo: null, reads: {} });
  assert.ok(outcome.error instanceof SettingsError);
  assert.equal(outcome.events.length, 0);
});

test('security: a false switch sends DELETE and a true switch sends PUT', async () => {
  const settings = { schemaVersion: 1, security: { vulnerability_alerts: false, private_vulnerability_reporting: true } };
  const root = await makeRoot({ settings });
  const base = repoPath(CONTROL);
  const expected = [`PUT ${base}/private-vulnerability-reporting`, `DELETE ${base}/vulnerability-alerts`, createMain(CONTROL)];
  const outcome = succeeded(await runOp({ root, reads: readRoutes(CONTROL), writes: okWrites(expected) }));
  assert.deepEqual(writeLines(outcome.events), expected);
});

test('rulesets: undeclared repository rulesets are deleted, organization rulesets and a second run are left alone', async () => {
  const root = await makeRoot({ rulesets: [mainRuleset([{ type: 'deletion' }])] });
  const base = repoPath(CONTROL);
  const mainSummary = { id: 5, name: 'main', target: 'branch', source_type: 'Repository' };
  const stale = { id: 9, name: 'stale', target: 'branch', source_type: 'Repository' };
  const organization = { id: 12, name: 'org-wide', target: 'branch', source_type: 'Organization' };

  const first = succeeded(await runOp({
    root, reads: readRoutes(CONTROL, { liveRulesets: [mainSummary, stale, organization] }),
    writes: okWrites([`PUT ${base}/rulesets/5`, `DELETE ${base}/rulesets/9`]),
  }));
  assert.deepEqual(writeLines(first.events), [`PUT ${base}/rulesets/5`, `DELETE ${base}/rulesets/9`]);
  assert.match(first.result.summary, /rulesets: 1 updated, 1 deleted/);

  const second = succeeded(await runOp({
    root, reads: readRoutes(CONTROL, { liveRulesets: [mainSummary, organization] }), writes: okWrites([`PUT ${base}/rulesets/5`]),
  }));
  assert.deepEqual(writeLines(second.events), [`PUT ${base}/rulesets/5`]);
});

test('rulesets: an unreadable pass-2 signal with code_scanning desired throws before any ruleset write', async () => {
  const root = await makeRoot({ rulesets: [mainRuleset([{ type: 'deletion' }, CODE_SCANNING_RULE]), tagRuleset] });
  const base = repoPath(CONTROL);
  const reads = {
    ...readRoutes(CONTROL),
    [`GET ${base}/rulesets?includes_parents=false&per_page=100`]: { status: 403, data: { message: 'Forbidden' } },
  };
  const outcome = await runOp({ root, reads });
  assert.ok(outcome.error instanceof SettingsError);
  assert.match(outcome.error.message, /^code_scanning signals are unreadable/);
  assert.equal(outcome.events.length, 0);
});

test('rulesets: after pass 2 a desired main without code_scanning throws before any ruleset write', async () => {
  const root = await makeRoot({ rulesets: [mainRuleset([{ type: 'deletion' }]), tagRuleset] });
  const reads = readRoutes(CONTROL, {
    setupState: 'not_configured', liveRulesets: [{ id: 5, name: 'main', target: 'branch', source_type: 'Repository' }], mainRules: [CODE_SCANNING_RULE],
  });
  const outcome = await runOp({ root, reads });
  assert.ok(outcome.error instanceof SettingsError);
  assert.match(outcome.error.message, /^pass 2 has run or its state is unreadable, and the desired main ruleset has no code_scanning rule/);
  assert.deepEqual(writeLines(outcome.events), []);
});

test('rulesets: the pass-2 gate runs after reading signals and before step 1, with no write of any kind', async () => {
  const root = await makeRoot({ rulesets: [mainRuleset([{ type: 'deletion' }])] });
  const reads = readRoutes(CONTROL, { liveRulesets: [{ id: 5, name: 'main', target: 'branch', source_type: 'Repository' }], mainRules: [CODE_SCANNING_RULE] });
  const outcome = await runOp({ root, reads });
  assert.ok(outcome.error instanceof SettingsError);
  assert.deepEqual(outcome.logs, ['reading live signals']);
  assert.equal(outcome.events.length, 0);
});

test('rulesets: no desired main ruleset throws whatever the signals say', async () => {
  const root = await makeRoot({ rulesets: [tagRuleset] });
  const base = repoPath(CONTROL);
  const liveMain = { id: 5, name: 'main', target: 'branch', source_type: 'Repository' };
  const afterPass2 = await runOp({ root, reads: readRoutes(CONTROL, { liveRulesets: [liveMain], mainRules: [CODE_SCANNING_RULE] }) });
  const beforePass2 = await runOp({ root, reads: readRoutes(CONTROL, { setupState: 'not_configured', liveRulesets: [liveMain] }) });
  for (const outcome of [afterPass2, beforePass2]) {
    assert.ok(outcome.error instanceof SettingsError);
    assert.match(outcome.error.message, /^no main ruleset is desired/);
    assert.equal(outcome.events.length, 0);
  }
  assert.equal(afterPass2.events.some((event) => event.line === `DELETE ${base}/rulesets/5`), false);
});

test('rulesets: an unreadable main ruleset with a desired main lacking code_scanning throws before any write', async () => {
  const root = await makeRoot({ rulesets: [mainRuleset([{ type: 'deletion' }])] });
  const base = repoPath(CONTROL);
  const reads = {
    ...readRoutes(CONTROL, { liveRulesets: [{ id: 5, name: 'main', target: 'branch', source_type: 'Repository' }] }),
    [`GET ${base}/rulesets/5`]: { status: 403, data: { message: 'Forbidden' } },
  };
  const outcome = await runOp({ root, reads });
  assert.ok(outcome.error instanceof SettingsError);
  assert.match(outcome.error.message, /^pass 2 has run or its state is unreadable/);
  assert.equal(outcome.events.length, 0);
});

test('rulesets: a live name differing from a desired name only by case throws before any ruleset write', async () => {
  const root = await makeRoot({ rulesets: [mainRuleset([{ type: 'deletion' }]), tagRuleset] });
  const reads = readRoutes(CONTROL, { liveRulesets: [{ id: 7, name: 'Release-Tag-Creation', target: 'tag', source_type: 'Repository' }] });
  const outcome = await runOp({ root, reads, writes: okWrites([createMain(CONTROL)]) });
  assert.ok(outcome.error instanceof SettingsError);
  assert.match(outcome.error.message, /^step 9\/9 rulesets: live ruleset "Release-Tag-Creation" differs from desired "release-tag-creation" only by case/);
  assert.equal(writeLines(outcome.events).some((line) => line.includes('/rulesets')), false);
});

test('rulesets: a live summary without source_type is kept, not deleted', async () => {
  const root = await makeRoot({ rulesets: [mainRuleset([{ type: 'deletion' }])] });
  const base = repoPath(CONTROL);
  const live = [{ id: 5, name: 'main', target: 'branch' }, { id: 9, name: 'unknown-source', target: 'branch' }];
  const outcome = succeeded(await runOp({ root, reads: readRoutes(CONTROL, { liveRulesets: live }), writes: okWrites([`PUT ${base}/rulesets/5`]) }));
  assert.deepEqual(writeLines(outcome.events), [`PUT ${base}/rulesets/5`]);
  assert.match(outcome.result.summary, /rulesets: 1 updated$/m);
});

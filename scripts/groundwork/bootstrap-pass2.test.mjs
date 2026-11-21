import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubError, createFixtureClient } from '../lib/github.mjs';
import { SettingsError } from '../lib/settings.mjs';
import {
  OP, STUB_MARKER, TOKEN_SCOPE, addCodeScanningRule, deployChecklist, readVerifyState, run, validateArgs,
  waitForFirstCodeqlRun, withCodeScanningRule,
} from './bootstrap-pass2.mjs';

const REAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = '/repos/wimdotgg/widget';
const CODE_SCANNING = { type: 'code_scanning', parameters: { code_scanning_tools: [{ tool: 'CodeQL' }] } };
const LIVE_RULES = [{ type: 'deletion' }, { type: 'non_fast_forward' }];
const LIVE_MAIN = {
  id: 7, name: 'main', target: 'branch', enforcement: 'active', source_type: 'Repository',
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, bypass_actors: [], rules: LIVE_RULES,
};
const encode = (text) => Buffer.from(text).toString('base64');
const instantSleep = async () => {};
const DEPENDENCIES = { sleep: instantSleep, timeoutMs: 30, pollMs: 10 };

const temporaryRoots = [];

/** The shipped settings, with `code_scanning` added to main.json and the production secrets filled in. */
async function makeRoot({ withRule = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bootstrap-pass2-'));
  temporaryRoots.push(root);
  const directory = path.join(root, '.github', 'groundwork');
  await cp(path.join(REAL_ROOT, '.github', 'groundwork'), directory, { recursive: true });
  const mainFile = path.join(directory, 'rulesets', 'main.json');
  const main = JSON.parse(await readFile(mainFile, 'utf8'));
  if (withRule) main.rules.push(CODE_SCANNING);
  await writeFile(mainFile, JSON.stringify(main));
  const settingsFile = path.join(directory, 'settings.json');
  const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
  settings.environments.production.secrets = ['DEPLOY_KEY', 'DEPLOY_HOST'];
  await writeFile(settingsFile, JSON.stringify(settings));
  return root;
}

test.after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Fixture client that also records every write with its body. */
function recordingClient(routes) {
  const calls = [];
  const client = createFixtureClient(routes, { onCall: ({ method, path: callPath }) => calls.push(`${method} ${callPath}`) });
  const writes = [];
  const request = client.request;
  return {
    calls,
    writes,
    client: {
      ...client,
      request: (method, requestPath, options) => {
        if (method !== 'GET') writes.push({ method, path: requestPath, body: options?.body });
        return request(method, requestPath, options);
      },
    },
  };
}

function routesFor({
  verify = 'echo real', setupStates = ['none', 'configured'], runs = [{ name: 'CodeQL', id: 55, conclusion: 'success' }],
  liveRules = LIVE_RULES, variable = { status: 404, data: {} },
} = {}) {
  const verifyRoute = verify === null ? { status: 404, data: {} } : { status: 200, data: { content: encode(verify) } };
  return {
    [`GET ${BASE}/contents/scripts/verify?ref=main`]: verifyRoute,
    [`GET ${BASE}/code-scanning/default-setup`]: setupStates.map((state) => ({ status: 200, data: { state } })),
    [`PATCH ${BASE}/code-scanning/default-setup`]: { status: 202, data: {} },
    [`GET ${BASE}/actions/runs?branch=main&status=completed`]: { status: 200, data: { workflow_runs: runs } },
    [`GET ${BASE}/rulesets?includes_parents=false&per_page=100`]: { status: 200, data: [{ id: 7, name: 'main', target: 'branch' }] },
    [`GET ${BASE}/rulesets/7`]: { status: 200, data: { ...LIVE_MAIN, rules: liveRules } },
    [`PUT ${BASE}/rulesets/7`]: { status: 200, data: {} },
    [`GET ${BASE}/actions/variables/DEPLOY_ENABLED`]: variable,
    [`POST ${BASE}/actions/variables`]: { status: 201, data: {} },
  };
}

const context = (client, settingsRoot, deploy = 'scripts') => ({ client, org: 'wimdotgg', repo: 'widget', settingsRoot, config: { deploy } });

test('identity and validateArgs', () => {
  assert.equal(OP, 'bootstrap-pass2');
  assert.equal(TOKEN_SCOPE, 'target');
  assert.deepEqual(validateArgs({}), []);
  assert.deepEqual(validateArgs({ deploy: 'none' }), ['unknown argument "deploy"']);
  assert.deepEqual(validateArgs(null), ['args must be a JSON object']);
});

test('AC1: the stub and a missing scripts/verify fail before any write', async () => {
  const root = await makeRoot();
  for (const [verify, reason] of [[`# ${STUB_MARKER}`, 'stub'], [null, 'missing']]) {
    const { client, writes, calls } = recordingClient(routesFor({ verify }));
    const result = await run(context(client, root), DEPENDENCIES);
    assert.equal(result.ok, false);
    assert.match(result.summary, /^scripts\/verify is .* on main/);
    assert.match(result.summary, reason === 'stub' ? /GROUNDWORK_STUB/ : /missing/);
    assert.deepEqual(writes, []);
    assert.equal(calls.length, 1);
  }
});

test('readVerifyState tells stub, real and missing apart', async () => {
  const state = async (verify) => readVerifyState({ client: recordingClient(routesFor({ verify })).client, org: 'wimdotgg', repo: 'widget' });
  assert.equal(await state(`#!/bin/sh\n# ${STUB_MARKER}`), 'stub');
  assert.equal(await state('npm test'), 'real');
  assert.equal(await state(null), 'missing');
});

test('AC2: default setup, then the run wait, then one ruleset PUT that keeps every rule', async () => {
  const root = await makeRoot();
  const { client, writes, calls } = recordingClient(routesFor());
  const result = await run(context(client, root), DEPENDENCIES);
  assert.equal(result.ok, true);
  const order = [`PATCH ${BASE}/code-scanning/default-setup`, `GET ${BASE}/actions/runs?branch=main&status=completed`, `PUT ${BASE}/rulesets/7`];
  assert.deepEqual(order.map((call) => calls.indexOf(call)), order.map((call) => calls.indexOf(call)).toSorted((a, b) => a - b));
  assert.ok(order.every((call) => calls.includes(call)));
  const puts = writes.filter((write) => write.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].body.rules, [...LIVE_RULES, CODE_SCANNING]);
  assert.equal(puts[0].body.id, undefined);
});

test('AC2: withCodeScanningRule replaces an existing rule and throws without a desired one', () => {
  const stale = { type: 'code_scanning', parameters: { code_scanning_tools: [] } };
  const live = { ...LIVE_MAIN, rules: [stale, { type: 'deletion' }] };
  assert.deepEqual(withCodeScanningRule({ live, desired: { rules: [CODE_SCANNING] } }).rules, [{ type: 'deletion' }, CODE_SCANNING]);
  assert.throws(() => withCodeScanningRule({ live, desired: { rules: [{ type: 'deletion' }] } }), SettingsError);
});

test('AC2: a project main.json without code_scanning stops before any write', async () => {
  const root = await makeRoot({ withRule: false });
  const { client, writes } = recordingClient(routesFor());
  await assert.rejects(() => run(context(client, root), DEPENDENCIES), SettingsError);
  assert.deepEqual(writes, []);
});

test('AC3: deploy none writes no variable', async () => {
  const root = await makeRoot();
  const { client, writes } = recordingClient(routesFor());
  const result = await run(context(client, root, 'none'), DEPENDENCIES);
  assert.equal(result.ok, true);
  assert.equal(writes.some((write) => write.path.includes('/actions/variables')), false);
  assert.doesNotMatch(result.summary, /DEPLOY_ENABLED/);
});

test('AC3: deploy scripts sets DEPLOY_ENABLED and lists the production secrets', async () => {
  const root = await makeRoot();
  const { client, writes } = recordingClient(routesFor());
  const result = await run(context(client, root), DEPENDENCIES);
  assert.deepEqual(writes.find((write) => write.path.endsWith('/actions/variables')).body, { name: 'DEPLOY_ENABLED', value: 'true' });
  assert.match(result.summary, /settings\/environments/);
  assert.match(result.summary, /- DEPLOY_KEY\n- DEPLOY_HOST/);
});

test('AC3: deployChecklist names the page and each secret', () => {
  const lines = deployChecklist({ org: 'wimdotgg', repo: 'widget', secrets: ['A', 'B'] });
  assert.match(lines[0], /production environment .*github\.com\/wimdotgg\/widget\/settings\/environments/);
  assert.deepEqual(lines.slice(1), ['- A', '- B']);
});

test('AC4: no completed CodeQL run within the bound fails with no ruleset write', async () => {
  const root = await makeRoot();
  const { client, writes } = recordingClient(routesFor({ runs: [{ name: 'Check', id: 1, conclusion: 'success' }] }));
  await assert.rejects(() => run(context(client, root), DEPENDENCIES), (error) => error instanceof GitHubError && /within 30 ms/.test(error.message));
  assert.equal(writes.some((write) => write.path.includes('/rulesets')), false);
});

test('AC4: a CodeQL conclusion other than success fails with no ruleset write', async () => {
  const root = await makeRoot();
  const { client, writes } = recordingClient(routesFor({ runs: [{ name: 'CodeQL', id: 55, conclusion: 'failure' }] }));
  const result = await run(context(client, root), DEPENDENCIES);
  assert.equal(result.ok, false);
  assert.match(result.summary, /run 55 on main concluded failure/);
  assert.equal(writes.some((write) => write.path.includes('/rulesets')), false);
});

test('waitForFirstCodeqlRun sleeps between polls until the run appears', async () => {
  const routes = routesFor();
  routes[`GET ${BASE}/actions/runs?branch=main&status=completed`] = [
    { status: 200, data: { workflow_runs: [] } },
    { status: 200, data: { workflow_runs: [{ name: 'CodeQL', id: 9, conclusion: 'success' }] } },
  ];
  const sleeps = [];
  const found = await waitForFirstCodeqlRun({
    client: recordingClient(routes).client, org: 'wimdotgg', repo: 'widget', timeoutMs: 30, pollMs: 10, sleep: async (ms) => sleeps.push(ms),
  });
  assert.deepEqual(found, { runId: 9, conclusion: 'success' });
  assert.deepEqual(sleeps, [10]);
});

test('AC5: a rerun after success writes nothing', async () => {
  const root = await makeRoot();
  const routes = routesFor({
    setupStates: ['configured'], liveRules: [...LIVE_RULES, CODE_SCANNING], variable: { status: 200, data: { value: 'true' } },
  });
  const { client, writes } = recordingClient(routes);
  const result = await run(context(client, root), DEPENDENCIES);
  assert.equal(result.ok, true);
  assert.deepEqual(writes, []);
  assert.match(result.summary, /code_scanning rule: present/);
});

test('addCodeScanningRule reports added, then present', async () => {
  const desired = { rules: [CODE_SCANNING] };
  const added = recordingClient(routesFor());
  assert.equal(await addCodeScanningRule({ client: added.client, org: 'wimdotgg', repo: 'widget', desired }), 'added');
  const present = recordingClient(routesFor({ liveRules: [CODE_SCANNING] }));
  assert.equal(await addCodeScanningRule({ client: present.client, org: 'wimdotgg', repo: 'widget', desired }), 'present');
});

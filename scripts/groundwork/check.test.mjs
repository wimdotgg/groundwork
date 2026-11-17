import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFixtureClient } from '../lib/github.mjs';
import { OP, PERMISSIONS, TOKEN_SCOPE, run, runCheck, validateArgs } from './check.mjs';

const OWNER = 'wimdotgg';
const REPO = 'groundwork';
const R = `/repos/${OWNER}/${REPO}`;
const CONFIG = {
  controlRepo: 'groundwork',
  accounts: { owner: 'wianvdm', agent: 'wianvdm-agent' },
  apps: { admin: 'wimdotgg-admin', release: 'wimdotgg-release' },
  deploy: 'scripts',
};

const ok = (data) => ({ status: 200, data });
const failure = (status) => ({ status, data: { message: `status ${status}` } });

const MATCH_FILES = {
  'settings.json': { schemaVersion: 1, repository: { has_issues: true } },
  'labels.json': { labels: [{ name: 'bug', color: 'cc0000', description: 'Something is broken' }] },
  'rulesets/main.json': {
    name: 'main', target: 'branch', enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: [], rules: [],
  },
};

const PASS_2_FILES = {
  'settings.json': {
    schemaVersion: 1,
    repository: { has_issues: true },
    security: { code_scanning_default_setup: { state: 'configured' } },
  },
  'labels.json': { labels: [] },
  'rulesets/main.json': {
    name: 'main', target: 'branch', enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: [],
    rules: [{ type: 'code_scanning', parameters: { code_scanning_tools: [{ tool: 'CodeQL' }] } }],
  },
};

/** Fixture routes for a live control repo that satisfies MATCH_FILES. */
function liveRoutes(overrides = {}) {
  return {
    [`GET ${R}`]: ok({ has_issues: true, name: 'groundwork' }),
    [`GET ${R}/teams?per_page=100`]: ok([]),
    [`GET ${R}/private-vulnerability-reporting`]: ok({ enabled: true }),
    [`GET ${R}/vulnerability-alerts`]: { status: 204 },
    [`GET ${R}/automated-security-fixes`]: ok({ enabled: true, paused: false }),
    [`GET ${R}/code-scanning/default-setup`]: ok({ state: 'configured' }),
    [`GET ${R}/actions/permissions`]: ok({}),
    [`GET ${R}/actions/permissions/workflow`]: ok({}),
    [`GET ${R}/actions/permissions/fork-pr-contributor-approval`]: ok({}),
    [`GET ${R}/actions/variables?per_page=100`]: ok({ variables: [] }),
    [`GET ${R}/environments?per_page=100`]: ok({ environments: [] }),
    [`GET ${R}/labels?per_page=100`]: ok([{ name: 'bug', color: 'CC0000', description: 'Something is broken' }]),
    [`GET ${R}/rulesets?includes_parents=false&per_page=100`]: ok([{ id: 1, name: 'main', target: 'branch' }]),
    [`GET ${R}/rulesets/1`]: ok({
      id: 1, name: 'main', target: 'branch', enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      bypass_actors: [], rules: [],
    }),
    ...overrides,
  };
}

async function withTempRoot(files, runTest) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'check-test-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(root, '.github', 'groundwork', name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(content));
    }
    return await runTest(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const opContext = (client, settingsRoot) => ({
  client, token: 'minted-token', org: OWNER, repo: REPO, settingsRoot, config: CONFIG, env: {}, log: () => {},
});

test('module contract: op name, target scope and read-only permissions', () => {
  assert.equal(OP, 'check');
  assert.equal(TOKEN_SCOPE, 'target');
  assert.deepEqual(PERMISSIONS, {
    administration: 'read', contents: 'read', environments: 'read', variables: 'read',
    actions: 'read', issues: 'read', members: 'read',
  });
});

test('validateArgs accepts no keys and rejects unknown ones', () => {
  assert.deepEqual(validateArgs({}), []);
  assert.deepEqual(validateArgs(null), []);
  assert.deepEqual(validateArgs({ dry: true }), ['unknown argument "dry"']);
  assert.deepEqual(validateArgs(['dry']), ['args must be a JSON object']);
});

test('runCheck: a control repo matching its desired state passes with only match rows', async () => {
  await withTempRoot(MATCH_FILES, async (root) => {
    const result = await runCheck(opContext(createFixtureClient(liveRoutes()), root));
    assert.equal(result.ok, true);
    assert.ok(result.rows.length > 0);
    assert.ok(result.rows.every((row) => row.result === 'match'));
  });
});

test('runCheck: one differing setting fails and the row lands in the summary table', async () => {
  await withTempRoot(MATCH_FILES, async (root) => {
    const client = createFixtureClient(liveRoutes({ [`GET ${R}`]: ok({ has_issues: false, name: 'groundwork' }) }));
    const logged = [];
    const checkResult = await runCheck(opContext(client, root));
    assert.equal(checkResult.ok, false);
    const row = checkResult.rows.find((entry) => entry.section === 'repository' && entry.key === 'has_issues');
    assert.equal(row.result, 'differ');
    const result = await run({ ...opContext(client, root), log: (line) => logged.push(line) });
    assert.match(result.summary, /Result: \*\*fail\*\*/);
    assert.match(result.summary, /\| repository \| has_issues \| differ \| `true` \| `false` \|/);
    assert.match(result.summary, /- match: \d+/);
    assert.deepEqual(logged, [`check wimdotgg/groundwork: ${checkResult.rows.length} rows, 1 mismatching`]);
  });
});

test('runCheck: code scanning rows are deferred before pass 2 and the check passes', async () => {
  await withTempRoot(PASS_2_FILES, async (root) => {
    const client = createFixtureClient(liveRoutes({
      [`GET ${R}/labels?per_page=100`]: ok([]),
      [`GET ${R}/code-scanning/default-setup`]: ok({ state: 'not-configured' }),
      [`GET ${R}/rulesets/1`]: ok({
        id: 1, name: 'main', target: 'branch', enforcement: 'active',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
        bypass_actors: [], rules: [],
      }),
    }));
    const result = await runCheck(opContext(client, root));
    assert.equal(result.ok, true);
    const deferred = result.rows.filter((row) => row.result === 'deferred');
    assert.deepEqual(
      deferred.map((row) => `${row.section}/${row.key}`).sort(),
      ['rulesets/main.rules.code_scanning', 'security/code_scanning_default_setup.state'],
    );
  });
});

test('runCheck: an unreadable section fails the check with unreadable rows', async () => {
  await withTempRoot(MATCH_FILES, async (root) => {
    const client = createFixtureClient(liveRoutes({ [`GET ${R}/labels?per_page=100`]: failure(403) }));
    const result = await runCheck(opContext(client, root));
    assert.equal(result.ok, false);
    const labelRows = result.rows.filter((row) => row.section === 'labels');
    assert.ok(labelRows.length > 0);
    assert.ok(labelRows.every((row) => row.result === 'unreadable'));
  });
});

test('run: live values are JSON-encoded, backtick-stripped, truncated and code-spanned', async () => {
  await withTempRoot({
    ...MATCH_FILES,
    'settings.json': { schemaVersion: 1, repository: { description: `${'x'.repeat(200)}` } },
  }, async (root) => {
    const injected = 'a`b';
    const client = createFixtureClient(liveRoutes({ [`GET ${R}`]: ok({ description: injected, name: 'groundwork' }) }));
    const result = await run(opContext(client, root));
    const cell = result.summary.split('\n').find((line) => line.includes('| repository | description |'));
    const rendered = cell.match(/\| `([^`]*)` \| `([^`]*)` \|$/).slice(1);
    assert.equal(rendered[0].length, 120);
    assert.equal(rendered[1], JSON.stringify(injected).replaceAll('`', ''));
  });
});

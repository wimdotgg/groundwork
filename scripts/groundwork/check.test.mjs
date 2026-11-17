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
    administration: 'read', contents: 'read', environments: 'read', actions_variables: 'read',
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
    assert.match(result.summary, /\| `repository` \| `has_issues` \| differ \| `true` \| `false` \|/);
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

test('run: a hostile extra label cannot break the summary table', async () => {
  await withTempRoot({ ...MATCH_FILES, 'labels.json': { labels: [] } }, async (root) => {
    const name = 'evil|label\r\n[link](https://evil.example) ![img](https://evil.example/x.png) `tick` '.repeat(8);
    const liveLabel = { name, color: 'FF0000', description: 'hostile' };
    const client = createFixtureClient(liveRoutes({ [`GET ${R}/labels?per_page=100`]: ok([liveLabel]) }));
    const result = await run(opContext(client, root));
    const row = result.summary.split('\n').find((line) => line.includes('| `labels` |') && line.includes('| extra |'));
    assert.ok(row, 'extra label row renders');
    // Same pipeline as renderCell: JSON-encode, strip backticks and CR/LF, truncate with ellipsis, escape pipes.
    const stripped = JSON.stringify(liveLabel).replaceAll('`', '').replace(/[\r\n]/g, '');
    const expected = (stripped.length > 120 ? `${stripped.slice(0, 120)}...` : stripped).replaceAll('|', '\\|');
    assert.ok(row.includes(`\`${expected}\``), 'live cell is sanitized, truncated and pipe-escaped');
    assert.ok(row.startsWith('| `labels` | ') && row.endsWith(' |'), 'row stays on one line with six cells');
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
    const cell = result.summary.split('\n').find((line) => line.includes('| `repository` | `description` |'));
    const rendered = cell.match(/\| `([^`]*)` \| `([^`]*)` \|$/).slice(1);
    assert.equal(rendered[0], `"${'x'.repeat(119)}...`);
    assert.equal(rendered[1], JSON.stringify(injected).replaceAll('`', ''));
  });
});

test('runCheck: empty desired state against an empty repo fails instead of passing vacuously', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'check-test-'));
  try {
    const dir = path.join(root, '.github', 'groundwork');
    await mkdir(path.join(dir, 'rulesets'), { recursive: true });
    await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ schemaVersion: 1 }));
    await writeFile(path.join(dir, 'labels.json'), JSON.stringify({ labels: [] }));
    const client = createFixtureClient(liveRoutes({
      [`GET ${R}`]: ok({ name: 'groundwork' }),
      [`GET ${R}/labels?per_page=100`]: ok([]),
      [`GET ${R}/rulesets?includes_parents=false&per_page=100`]: ok([]),
    }));
    const result = await runCheck(opContext(client, root));
    assert.equal(result.rows.length, 0);
    assert.equal(result.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runCheck: an unreadable section with nothing desired still fails the check', async () => {
  await withTempRoot({ ...MATCH_FILES, 'labels.json': { labels: [] } }, async (root) => {
    const client = createFixtureClient(liveRoutes({ [`GET ${R}/labels?per_page=100`]: failure(403) }));
    const result = await runCheck(opContext(client, root));
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.rows.filter((row) => row.section === 'labels'),
      [{ section: 'labels', key: '(section)', desired: null, live: null, result: 'unreadable' }],
    );
  });
});

test('runCheck: control repo reads only control and all environments and resolves the app-id placeholder', async () => {
  const settings = {
    schemaVersion: 1,
    repository: { has_issues: true },
    environments: {
      build: { repos: 'control', can_admins_bypass: false, prevent_self_review: false },
      staging: { repos: 'projects', can_admins_bypass: true, prevent_self_review: false },
      publish: { repos: 'all', can_admins_bypass: true, prevent_self_review: true },
    },
  };
  const ruleset = {
    name: 'main', target: 'branch', enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: [{ actor_type: 'Integration', actor_id: '{{app-id:release}}', bypass_mode: 'always' }],
    rules: [],
  };
  const files = {
    'settings.json': settings,
    'labels.json': { labels: [] },
    'rulesets/main.json': ruleset,
  };
  await withTempRoot(files, async (root) => {
    const client = createFixtureClient(liveRoutes({
      [`GET ${R}/labels?per_page=100`]: ok([]),
      // The staging (projects) environment gets no fixtures for its sub-requests: any request for
      // them throws from the fixture client, proving the repos filter kept it name-only.
      [`GET ${R}/environments?per_page=100`]: ok({
        environments: [
          { name: 'build', can_admins_bypass: false, protection_rules: [] },
          { name: 'staging', can_admins_bypass: true, protection_rules: [] },
          { name: 'publish', can_admins_bypass: true, protection_rules: [{ type: 'required_reviewers', prevent_self_review: true, reviewers: [] }] },
        ],
      }),
      [`GET ${R}/environments/build/secrets?per_page=100`]: ok({ secrets: [] }),
      [`GET ${R}/environments/build/variables?per_page=100`]: ok({ variables: [] }),
      [`GET ${R}/environments/publish/secrets?per_page=100`]: ok({ secrets: [] }),
      [`GET ${R}/environments/publish/variables?per_page=100`]: ok({ variables: [] }),
      [`GET ${R}/rulesets/1`]: ok({
        id: 1, name: 'main', target: 'branch', enforcement: 'active',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
        bypass_actors: [{ actor_type: 'Integration', actor_id: 9911, bypass_mode: 'always' }],
        rules: [],
      }),
      'GET /apps/wimdotgg-release': ok({ id: 9911 }),
    }));
    const result = await runCheck(opContext(client, root));
    assert.equal(result.ok, true);
    assert.ok(result.rows.length > 0);
    assert.ok(result.rows.every((row) => row.result === 'match'));
    const environmentKeys = result.rows.filter((row) => row.section === 'environments').map((row) => row.key);
    assert.ok(environmentKeys.some((key) => key.startsWith('build.')));
    assert.ok(environmentKeys.some((key) => key.startsWith('publish.')));
    assert.ok(!environmentKeys.some((key) => key.startsWith('staging.')), 'projects environment is not compared on a control repo');
  });
});

test('runCheck: a null repo throws SettingsError before any reading', async () => {
  await withTempRoot(MATCH_FILES, async (root) => {
    await assert.rejects(
      runCheck({ ...opContext(createFixtureClient(liveRoutes()), root), repo: null }),
      /^SettingsError: check: repo is required$/,
    );
  });
});

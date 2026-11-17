import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { GitHubError, createFixtureClient } from './github.mjs';
import {
  SettingsError, compareStates, loadDesiredState, readLiveState, readSignals, repoKind, resolvePlaceholders,
} from './settings.mjs';

const REAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG = {
  controlRepo: 'groundwork',
  accounts: { owner: 'wianvdm', agent: 'wianvdm-agent' },
  apps: { admin: 'wimdotgg-admin', release: 'wimdotgg-release' },
  deploy: 'scripts',
};
const SIGNALS = { kitInstalled: true, codeScanningConfigured: true, pass2Ran: true };
const BEFORE_PASS_2 = { kitInstalled: true, codeScanningConfigured: false, pass2Ran: false };

const CODE_SCANNING_RULE = { type: 'code_scanning', parameters: { code_scanning_tools: [{ tool: 'CodeQL' }] } };

function desiredState() {
  return {
    settings: {
      repository: { has_issues: true, security_and_analysis: { secret_scanning: { status: 'enabled' } } },
      controlRepository: { is_template: true },
      teamAccess: [{ team: 'agents', permission: 'push' }],
      security: { vulnerability_alerts: true, code_scanning_default_setup: { state: 'configured' } },
      actions: { workflow: { default_workflow_permissions: 'read' } },
      variables: {
        GROUNDWORK_READY: { value: 'true', assertWhen: 'kitInstalled' },
        DEPLOY_ENABLED: { value: 'true', assertWhen: 'deployReady' },
      },
      environments: {
        release: {
          repos: 'all', reviewers: [], prevent_self_review: false, can_admins_bypass: true,
          deployment_refs: [{ name: 'main', type: 'branch' }], secrets: ['RELEASE_APP_KEY'], variables: ['RELEASE_APP_CLIENT_ID'],
        },
        production: {
          repos: 'projects', reviewers: ['owner'], prevent_self_review: false, can_admins_bypass: false,
          deployment_refs: [{ name: 'v*', type: 'tag' }], secrets: [], variables: [],
        },
        admin: {
          repos: 'control', reviewers: ['owner'], prevent_self_review: false, can_admins_bypass: false,
          deployment_refs: [{ name: 'main', type: 'branch' }], secrets: ['ADMIN_APP_KEY'], variables: [],
        },
      },
    },
    labels: [{ name: 'accepted', color: '0e8a16', description: 'Epic authorized' }],
    rulesets: [
      {
        name: 'main', target: 'branch', enforcement: 'active',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
        bypass_actors: [{ actor_type: 'OrganizationAdmin', actor_id: 1, bypass_mode: 'pull_request' }],
        rules: [{ type: 'deletion' }, CODE_SCANNING_RULE],
      },
      {
        name: 'release-tag-creation', target: 'tag', enforcement: 'active',
        conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
        bypass_actors: [{ actor_type: 'Integration', actor_id: 77, bypass_mode: 'always' }],
        rules: [{ type: 'creation' }],
      },
    ],
  };
}

const section = (value) => ({ readable: true, value });

function liveState() {
  return {
    repository: section({ has_issues: true, name: 'x', security_and_analysis: { secret_scanning: { status: 'enabled' } }, is_template: true }),
    teamAccess: section([{ team: 'agents', permission: 'push' }]),
    security: section({ vulnerability_alerts: true, code_scanning_default_setup: { state: 'configured' } }),
    actions: section({ workflow: { default_workflow_permissions: 'read' } }),
    variables: section([{ name: 'GROUNDWORK_READY', value: 'true' }, { name: 'DEPLOY_ENABLED', value: 'true' }]),
    environments: section([
      {
        name: 'release', can_admins_bypass: true, prevent_self_review: false, reviewers: [],
        deployment_refs: [{ name: 'main', type: 'branch' }], secrets: ['RELEASE_APP_KEY'], variables: ['RELEASE_APP_CLIENT_ID'],
      },
      {
        name: 'admin', can_admins_bypass: false, prevent_self_review: false, reviewers: ['wianvdm'],
        deployment_refs: [{ name: 'main', type: 'branch' }], secrets: ['ADMIN_APP_KEY'], variables: [],
      },
    ]),
    labels: section([{ name: 'accepted', color: '0E8A16', description: 'Epic authorized' }]),
    rulesets: section([
      {
        id: 5, name: 'main', target: 'branch', enforcement: 'active', source: 'x',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
        bypass_actors: [{ actor_type: 'OrganizationAdmin', actor_id: null, bypass_mode: 'pull_request' }],
        rules: [{ type: 'deletion' }, structuredClone(CODE_SCANNING_RULE)],
      },
      {
        id: 6, name: 'release-tag-creation', target: 'tag', enforcement: 'active',
        conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
        bypass_actors: [{ actor_type: 'Integration', actor_id: 77, bypass_mode: 'always' }],
        rules: [{ type: 'creation' }],
      },
    ]),
  };
}

const compare = (live, overrides = {}) => compareStates(desiredState(), live, {
  repoKind: 'control', config: CONFIG, signals: SIGNALS, ...overrides,
});
const find = (rows, section_, key) => rows.find((entry) => entry.section === section_ && entry.key === key);

async function withTempRoot(files, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'settings-test-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(root, '.github', 'groundwork', name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const validFiles = () => ({
  'settings.json': { schemaVersion: 1, variables: { A: { value: '1', assertWhen: 'kitInstalled' } } },
  'labels.json': { schemaVersion: 1, labels: [{ name: 'a', color: '000000', description: 'd' }] },
  'rulesets/main.json': { name: 'main', target: 'branch', enforcement: 'active', conditions: {}, bypass_actors: [], rules: [] },
});

test('loadDesiredState loads the real repository files', async () => {
  const state = await loadDesiredState({ root: REAL_ROOT });
  assert.ok(state.labels.length > 0);
  assert.ok(state.rulesets.some((ruleset) => ruleset.name === 'main'));
  assert.equal(state.rulesets.find((ruleset) => ruleset.name === 'release-tag-creation').bypass_actors[0].actor_id, '{{app-id:release}}');
  assert.ok(state.settings.variables);
});

test('loadDesiredState accepts a minimal valid tree', async () => {
  await withTempRoot(validFiles(), async (root) => {
    const state = await loadDesiredState({ root });
    assert.equal(state.rulesets.length, 1);
  });
});

async function assertLoadFails(mutate, pattern) {
  const files = validFiles();
  mutate(files);
  await withTempRoot(files, async (root) => {
    await assert.rejects(loadDesiredState({ root }), (error) => {
      assert.ok(error instanceof SettingsError);
      assert.match(error.message, pattern);
      assert.equal(typeof error.file, 'string');
      assert.ok(!error.message.includes('\n'));
      return true;
    });
  });
}

test('loadDesiredState rejects an unknown top-level key', () => assertLoadFails((files) => { files['settings.json'].extra = {}; }, /unknown top-level key "extra"/));
test('loadDesiredState rejects an unknown assertWhen', () => assertLoadFails((files) => { files['settings.json'].variables.A.assertWhen = 'always'; }, /assertWhen/));
test('loadDesiredState rejects a ruleset with an id', () => assertLoadFails((files) => { files['rulesets/main.json'].id = 3; }, /no id/));
test('loadDesiredState rejects a ruleset name that differs from its file', () => assertLoadFails((files) => { files['rulesets/main.json'].name = 'other'; }, /must equal the file name/));
test('loadDesiredState rejects duplicate labels case-insensitively', () => assertLoadFails((files) => {
  files['labels.json'].labels.push({ name: 'A', color: '111111', description: 'x' });
}, /duplicate label/));
test('loadDesiredState rejects a placeholder outside bypass actor ids', () => assertLoadFails((files) => {
  files['rulesets/main.json'].enforcement = '{{app-id:release}}';
}, /placeholder/));
test('loadDesiredState rejects a missing settings file', () => assertLoadFails((files) => { delete files['settings.json']; }, /file not found/));

test('resolvePlaceholders resolves an app id through the fixture client and copies', async () => {
  const config = await loadConfig({ root: REAL_ROOT });
  const client = createFixtureClient({ 'GET /apps/wimdotgg-release': { status: 200, data: { id: 4242 } } });
  const ruleset = { name: 'x', bypass_actors: [{ actor_type: 'Integration', actor_id: '{{app-id:release}}', bypass_mode: 'always' }] };
  const resolved = await resolvePlaceholders(ruleset, { client, config });
  assert.equal(resolved.bypass_actors[0].actor_id, 4242);
  assert.equal(ruleset.bypass_actors[0].actor_id, '{{app-id:release}}');
});

test('resolvePlaceholders throws SettingsError for an unknown key and a failed lookup', async () => {
  const ruleset = (key) => ({ bypass_actors: [{ actor_type: 'Integration', actor_id: `{{app-id:${key}}}`, bypass_mode: 'always' }] });
  const client = createFixtureClient({});
  await assert.rejects(resolvePlaceholders(ruleset('nope'), { client, config: CONFIG }), SettingsError);
  await assert.rejects(resolvePlaceholders(ruleset('release'), { client, config: CONFIG }), SettingsError);
});

test('repoKind compares the control repo name case-insensitively', () => {
  assert.equal(repoKind('Groundwork', CONFIG), 'control');
  assert.equal(repoKind('app', CONFIG), 'project');
});

test('compareStates: everything matching yields only match rows, tolerant of OrganizationAdmin null id', () => {
  const rows = compare(liveState());
  assert.ok(rows.length > 10);
  assert.deepEqual(rows.filter((entry) => entry.result !== 'match'), []);
});

test('compareStates: Integration bypass with a different id is differ', () => {
  const live = liveState();
  live.rulesets.value[1].bypass_actors[0].actor_id = 78;
  const rows = compare(live);
  assert.equal(find(rows, 'rulesets', 'release-tag-creation.bypass_actors').result, 'differ');
});

test('compareStates: OrganizationAdmin bypass mode mismatch is differ', () => {
  const live = liveState();
  live.rulesets.value[0].bypass_actors[0].bypass_mode = 'always';
  assert.equal(find(compare(live), 'rulesets', 'main.bypass_actors').result, 'differ');
});

test('compareStates: variables are deferred when their signal does not hold', () => {
  const live = liveState();
  live.variables.value = [];
  const rows = compare(live, { signals: { kitInstalled: false, codeScanningConfigured: false, pass2Ran: false } });
  assert.equal(find(rows, 'variables', 'GROUNDWORK_READY').result, 'deferred');
  assert.equal(find(rows, 'variables', 'DEPLOY_ENABLED').result, 'deferred');
});

test('compareStates: variables are compared while their signal holds', () => {
  const live = liveState();
  live.variables.value = [{ name: 'GROUNDWORK_READY', value: 'false' }];
  const rows = compare(live);
  assert.equal(find(rows, 'variables', 'GROUNDWORK_READY').result, 'differ');
  assert.equal(find(rows, 'variables', 'DEPLOY_ENABLED').result, 'missing');
});

test('compareStates: deployReady is deferred when deploy is none', () => {
  const live = liveState();
  live.variables.value = [];
  const rows = compare(live, { config: { ...CONFIG, deploy: 'none' } });
  assert.equal(find(rows, 'variables', 'DEPLOY_ENABLED').result, 'deferred');
});

test('compareStates: code_scanning rule and default setup are deferred before pass 2', () => {
  const live = liveState();
  live.rulesets.value[0].rules = [{ type: 'deletion' }];
  live.security.value.code_scanning_default_setup.state = 'not-configured';
  const rows = compare(live, { signals: BEFORE_PASS_2 });
  assert.equal(find(rows, 'rulesets', 'main.rules.code_scanning').result, 'deferred');
  assert.equal(find(rows, 'security', 'code_scanning_default_setup.state').result, 'deferred');
});

test('compareStates: after pass 2 an unconfigured default setup and a missing rule fail closed', () => {
  const live = liveState();
  live.security.value.code_scanning_default_setup.state = 'not-configured';
  live.rulesets.value[0].rules = [{ type: 'deletion' }];
  const rows = compare(live, { signals: { kitInstalled: true, codeScanningConfigured: false, pass2Ran: true } });
  assert.equal(find(rows, 'security', 'code_scanning_default_setup.state').result, 'differ');
  assert.equal(find(rows, 'rulesets', 'main.rules.code_scanning').result, 'missing');
});

test('compareStates: DEPLOY_ENABLED unset after pass 2 is missing, not deferred', () => {
  const live = liveState();
  live.variables.value = [{ name: 'GROUNDWORK_READY', value: 'true' }];
  const rows = compare(live, { signals: { kitInstalled: true, codeScanningConfigured: false, pass2Ran: true } });
  assert.equal(find(rows, 'variables', 'DEPLOY_ENABLED').result, 'missing');
});

test('compareStates: a null signal makes the dependent rows unreadable', () => {
  const live = liveState();
  live.variables.value = [];
  live.security.value.code_scanning_default_setup.state = 'not-configured';
  const rows = compare(live, { signals: { kitInstalled: true, codeScanningConfigured: null, pass2Ran: null } });
  assert.equal(find(rows, 'variables', 'DEPLOY_ENABLED').result, 'unreadable');
  assert.equal(find(rows, 'security', 'code_scanning_default_setup.state').result, 'unreadable');
  assert.equal(find(rows, 'variables', 'GROUNDWORK_READY').result, 'missing');
});

test('compareStates: an unreadable section yields unreadable rows', () => {
  const live = liveState();
  live.labels = { readable: false, status: 403 };
  live.rulesets = { readable: false, status: 404 };
  delete live.teamAccess;
  const rows = compare(live);
  for (const name of ['labels', 'rulesets', 'teamAccess']) {
    const sectionRows = rows.filter((entry) => entry.section === name);
    assert.ok(sectionRows.length > 0);
    assert.ok(sectionRows.every((entry) => entry.result === 'unreadable'));
  }
});

test('compareStates: environment reviewer logins compare case-insensitively', () => {
  const live = liveState();
  live.environments.value[1].reviewers = ['WianVDM'];
  assert.equal(find(compare(live), 'environments', 'admin.reviewers').result, 'match');
  live.environments.value[1].reviewers = ['someone-else'];
  assert.equal(find(compare(live), 'environments', 'admin.reviewers').result, 'differ');
});

test('compareStates: can_admins_bypass mismatch is differ and missing secrets are missing', () => {
  const live = liveState();
  live.environments.value[0].can_admins_bypass = false;
  live.environments.value[0].secrets = [];
  const rows = compare(live);
  assert.equal(find(rows, 'environments', 'release.can_admins_bypass').result, 'differ');
  assert.equal(find(rows, 'environments', 'release.secrets.RELEASE_APP_KEY').result, 'missing');
});

test('compareStates: environments and controlRepository are selected by repo kind', () => {
  const live = liveState();
  const projectRows = compare(live, { repoKind: 'project' });
  assert.equal(find(projectRows, 'environments', 'production').result, 'missing');
  assert.equal(find(projectRows, 'environments', 'admin.reviewers'), undefined);
  assert.equal(find(projectRows, 'repository', 'is_template'), undefined);
  assert.equal(find(compare(live), 'repository', 'is_template').result, 'match');
});

test('compareStates: repository, team and label mismatches', () => {
  const live = liveState();
  live.repository.value.has_issues = false;
  live.teamAccess.value[0].permission = 'pull';
  live.labels.value = [{ name: 'ACCEPTED', color: 'ffffff', description: null }, { name: 'bug', color: '000000', description: '' }];
  const rows = compare(live);
  assert.equal(find(rows, 'repository', 'has_issues').result, 'differ');
  assert.equal(find(rows, 'teamAccess', 'agents').result, 'differ');
  assert.equal(find(rows, 'labels', 'accepted').result, 'differ');
  assert.equal(find(rows, 'labels', 'bug').result, 'extra');
});

test('compareStates: a missing ruleset, an extra live ruleset and an extra rule type', () => {
  const live = liveState();
  live.rulesets.value.splice(1, 1, { name: 'stray', target: 'branch', rules: [] });
  live.rulesets.value[0].rules.push({ type: 'non_fast_forward' });
  const rows = compare(live);
  assert.equal(find(rows, 'rulesets', 'release-tag-creation').result, 'missing');
  assert.equal(find(rows, 'rulesets', 'stray').result, 'extra');
  assert.equal(find(rows, 'rulesets', 'main.rules.non_fast_forward').result, 'extra');
});

test('compareStates: an unresolved placeholder never matches a live actor id', () => {
  const desired = desiredState();
  desired.rulesets[1].bypass_actors[0].actor_id = '{{app-id:release}}';
  const rows = compareStates(desired, liveState(), { repoKind: 'control', config: CONFIG, signals: SIGNALS });
  assert.equal(find(rows, 'rulesets', 'release-tag-creation.bypass_actors').result, 'differ');
});

test('compareStates: a live ruleset without a bypass_actors array is unreadable, never a match', () => {
  const live = liveState();
  delete live.rulesets.value[0].bypass_actors;
  const desired = desiredState();
  desired.rulesets[0].bypass_actors = [];
  const rows = compareStates(desired, live, { repoKind: 'control', config: CONFIG, signals: SIGNALS });
  assert.equal(find(rows, 'rulesets', 'main.bypass_actors').result, 'unreadable');
});

test('compareStates: weaker live rule parameters, dropped checks and extra bypass actors are differ', () => {
  const desired = desiredState();
  desired.rulesets[0].rules = [
    { type: 'pull_request', parameters: { require_code_owner_review: true } },
    { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'a' }, { context: 'b' }] } },
  ];
  const live = liveState();
  live.rulesets.value[0].rules = [
    { type: 'pull_request', parameters: { require_code_owner_review: false } },
    { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'a' }] } },
  ];
  live.rulesets.value[1].bypass_actors.push({ actor_type: 'Integration', actor_id: 9, bypass_mode: 'always' });
  const rows = compareStates(desired, live, { repoKind: 'control', config: CONFIG, signals: SIGNALS });
  assert.equal(find(rows, 'rulesets', 'main.rules.pull_request').result, 'differ');
  assert.equal(find(rows, 'rulesets', 'main.rules.required_status_checks').result, 'differ');
  assert.equal(find(rows, 'rulesets', 'release-tag-creation.bypass_actors').result, 'differ');
});

test('compareStates: a live rule with extra keys still matches', () => {
  const live = liveState();
  live.rulesets.value[0].rules[0] = { type: 'deletion', ruleset_id: 5, ruleset_source: 'x' };
  assert.equal(find(compare(live), 'rulesets', 'main.rules.deletion').result, 'match');
});

test('compareStates: extra team reviewer and extra user reviewer are differ', () => {
  const live = liveState();
  live.environments.value[1].reviewers = ['wianvdm', 'team:ops'];
  assert.equal(find(compare(live), 'environments', 'admin.reviewers').result, 'differ');
  live.environments.value[1].reviewers = ['wianvdm', 'other'];
  assert.equal(find(compare(live), 'environments', 'admin.reviewers').result, 'differ');
});

test('compareStates: prevent_self_review defaults to false when the live value is absent', () => {
  const live = liveState();
  delete live.environments.value[0].prevent_self_review;
  assert.equal(find(compare(live), 'environments', 'release.prevent_self_review').result, 'match');
});

test('compareStates: kitInstalled that is not a boolean makes GROUNDWORK_READY unreadable', () => {
  const rows = compare(liveState(), { signals: { ...SIGNALS, kitInstalled: undefined } });
  assert.equal(find(rows, 'variables', 'GROUNDWORK_READY').result, 'unreadable');
});

test('compareStates: a weaker live code_scanning rule is differ even before pass 2', () => {
  const live = liveState();
  live.rulesets.value[0].rules[1] = { type: 'code_scanning', parameters: { code_scanning_tools: [] } };
  const rows = compare(live, { signals: BEFORE_PASS_2 });
  assert.equal(find(rows, 'rulesets', 'main.rules.code_scanning').result, 'differ');
});

test('compareStates: deferred variable rows carry the live value', () => {
  const rows = compare(liveState(), { signals: { ...BEFORE_PASS_2, kitInstalled: false } });
  const variableRow = find(rows, 'variables', 'GROUNDWORK_READY');
  assert.equal(variableRow.result, 'deferred');
  assert.equal(variableRow.live, 'true');
});

test('compareStates: security keys that only share the default-setup prefix are not deferred', () => {
  const desired = desiredState();
  desired.settings.security.code_scanning_default_setup_extra = true;
  const rows = compareStates(desired, liveState(), { repoKind: 'control', config: CONFIG, signals: BEFORE_PASS_2 });
  assert.equal(find(rows, 'security', 'code_scanning_default_setup_extra').result, 'missing');
});

test('compareStates: a non-array live array section is unreadable', () => {
  const live = liveState();
  live.labels = section({ not: 'an array' });
  assert.ok(compare(live).filter((entry) => entry.section === 'labels').every((entry) => entry.result === 'unreadable'));
});

test('loadDesiredState rejects a missing rulesets directory', () => assertLoadFails((files) => { delete files['rulesets/main.json']; }, /rulesets: directory not found/));
test('loadDesiredState rejects an invalid environment repos value', () => assertLoadFails((files) => {
  files['settings.json'].environments = { e: { repos: 'some', can_admins_bypass: true, prevent_self_review: false } };
}, /repos must be/));
test('loadDesiredState rejects a non-boolean can_admins_bypass', () => assertLoadFails((files) => {
  files['settings.json'].environments = { e: { repos: 'all', can_admins_bypass: 'yes', prevent_self_review: false } };
}, /can_admins_bypass must be a boolean/));
test('loadDesiredState rejects a label without a string color', () => assertLoadFails((files) => { files['labels.json'].labels[0].color = 5; }, /string color/));
test('loadDesiredState rejects bypass_actors that is not an array of objects', () => assertLoadFails((files) => {
  files['rulesets/main.json'].bypass_actors = [null];
}, /bypass_actors must be an array/));
test('loadDesiredState rejects a teamAccess that is not an array', () => assertLoadFails((files) => { files['settings.json'].teamAccess = {}; }, /teamAccess must be an array/));
test('loadDesiredState rejects a string actor_id that is not a placeholder', () => assertLoadFails((files) => {
  files['rulesets/main.json'].bypass_actors = [{ actor_type: 'Integration', actor_id: '123', bypass_mode: 'always' }];
}, /not a \{\{app-id/));

const REPO = { owner: 'wimdotgg', repo: 'groundwork' };
const R = '/repos/wimdotgg/groundwork';
const CUSTOM_POLICIES = { protected_branches: false, custom_branch_policies: true };
const ok = (data, headers) => ({ status: 200, data, headers });
const failure = (status) => ({ status, data: { message: `status ${status}` } });
const RULESET_LIST = `GET ${R}/rulesets?includes_parents=false&per_page=100`;

async function resolvedDesiredState() {
  const desired = await loadDesiredState({ root: REAL_ROOT });
  const client = createFixtureClient({
    'GET /apps/wimdotgg-release': ok({ id: 4242 }),
    'GET /apps/wimdotgg-admin': ok({ id: 4243 }),
  });
  desired.rulesets = await Promise.all(desired.rulesets.map((ruleset) => resolvePlaceholders(ruleset, { client, config: CONFIG })));
  return desired;
}

function environmentRoutes(name, secrets, variables, refs) {
  const base = `GET ${R}/environments/${name}`;
  return {
    [`${base}/deployment-branch-policies?per_page=100`]: ok({ total_count: refs.length, branch_policies: refs }),
    [`${base}/secrets?per_page=100`]: ok({ total_count: secrets.length, secrets: secrets.map((entry) => ({ name: entry })) }),
    [`${base}/variables?per_page=100`]: ok({ total_count: variables.length, variables: variables.map((entry) => ({ name: entry })) }),
  };
}

/** Fixture routes describing a live control repo that satisfies the real desired state. */
function liveRoutes(desired) {
  const { settings } = desired;
  const rulesets = desired.rulesets.map((ruleset, index) => ({ id: index + 1, source: 'x', ...structuredClone(ruleset) }));
  return {
    [`GET ${R}`]: ok({ ...settings.repository, ...settings.controlRepository, name: 'groundwork' }),
    [`GET ${R}/teams?per_page=100`]: ok([{ slug: 'agents', permission: 'push', name: 'Agents' }]),
    [`GET ${R}/private-vulnerability-reporting`]: ok({ enabled: true }),
    [`GET ${R}/vulnerability-alerts`]: { status: 204 },
    [`GET ${R}/automated-security-fixes`]: ok({ enabled: true, paused: false }),
    [`GET ${R}/code-scanning/default-setup`]: ok({ state: 'configured' }),
    [`GET ${R}/actions/permissions`]: ok({ ...settings.actions.permissions, extra: 1 }),
    [`GET ${R}/actions/permissions/workflow`]: ok(settings.actions.workflow),
    [`GET ${R}/actions/permissions/fork-pr-contributor-approval`]: ok(settings.actions.fork_pr_contributor_approval),
    [`GET ${R}/actions/variables?per_page=100`]: ok({ variables: [
      { name: 'GROUNDWORK_READY', value: 'true' }, { name: 'DEPLOY_ENABLED', value: 'true' },
    ] }),
    [`GET ${R}/environments?per_page=100`]: ok({ environments: [
      { name: 'release', can_admins_bypass: true, deployment_branch_policy: CUSTOM_POLICIES, protection_rules: [] },
      {
        name: 'admin',
        can_admins_bypass: false,
        deployment_branch_policy: CUSTOM_POLICIES,
        protection_rules: [
          { type: 'wait_timer' },
          { type: 'required_reviewers', prevent_self_review: false, reviewers: [{ type: 'User', reviewer: { login: 'wianvdm' } }] },
        ],
      },
    ] }),
    ...environmentRoutes('release', ['RELEASE_APP_KEY'], ['RELEASE_APP_CLIENT_ID'], [{ id: 1, name: 'main', type: 'branch' }]),
    ...environmentRoutes('admin', ['ADMIN_APP_KEY', 'RELEASE_APP_KEY'], ['ADMIN_APP_CLIENT_ID', 'RELEASE_APP_CLIENT_ID'], [{ id: 2, name: 'main', type: 'branch' }]),
    [`GET ${R}/labels?per_page=100`]: ok(desired.labels.map((label) => ({ id: 9, ...label }))),
    [RULESET_LIST]: ok(rulesets.map(({ id, name, target }) => ({ id, name, target }))),
    ...Object.fromEntries(rulesets.map((ruleset) => [`GET ${R}/rulesets/${ruleset.id}`, ok(ruleset)])),
  };
}

const readLive = async (overrides = {}, options) => {
  const desired = await resolvedDesiredState();
  const client = createFixtureClient({ ...liveRoutes(desired), ...overrides });
  return readLiveState(client, REPO, options);
};

test('readLiveState: every section is readable and has the documented shape', async () => {
  const live = await readLive();
  for (const value of Object.values(live)) assert.equal(value.readable, true);
  assert.equal(live.repository.value.name, 'groundwork');
  assert.deepEqual(live.teamAccess.value, [{ team: 'agents', permission: 'push' }]);
  assert.deepEqual(live.security.value, {
    private_vulnerability_reporting: true,
    vulnerability_alerts: true,
    automated_security_fixes: true,
    code_scanning_default_setup: { state: 'configured' },
  });
  assert.equal(live.actions.value.permissions.sha_pinning_required, true);
  assert.equal(live.actions.value.workflow.default_workflow_permissions, 'read');
  assert.equal(live.actions.value.fork_pr_contributor_approval.approval_policy, 'all_external_contributors');
  assert.deepEqual(live.variables.value[0], { name: 'GROUNDWORK_READY', value: 'true' });
  assert.deepEqual(live.environments.value[1], {
    name: 'admin',
    can_admins_bypass: false,
    prevent_self_review: false,
    reviewers: ['wianvdm'],
    deployment_refs: [{ name: 'main', type: 'branch' }],
    secrets: ['ADMIN_APP_KEY', 'RELEASE_APP_KEY'],
    variables: ['ADMIN_APP_CLIENT_ID', 'RELEASE_APP_CLIENT_ID'],
  });
  assert.equal(live.labels.value[0].name, 'accepted');
  assert.equal(live.rulesets.value.length, 4);
  assert.equal(live.rulesets.value[0].id, 1);
});

test('readLiveState output feeds compareStates unchanged and matches the real desired state', async () => {
  const desired = await resolvedDesiredState();
  const live = await readLive();
  const context = { repoKind: 'control', config: CONFIG, signals: SIGNALS };
  const rows = compareStates(desired, live, context);
  assert.ok(rows.length > 40);
  assert.deepEqual(rows.filter((entry) => entry.result !== 'match'), []);

  const drifted = await readLive({
    [`GET ${R}/actions/permissions/workflow`]: ok({ default_workflow_permissions: 'write', can_approve_pull_request_reviews: false }),
    [`GET ${R}/vulnerability-alerts`]: failure(404),
    [`GET ${R}/labels?per_page=100`]: ok([{ name: 'stray', color: '000000', description: null }]),
  });
  const driftedRows = compareStates(desired, drifted, context);
  assert.equal(find(driftedRows, 'actions', 'workflow.default_workflow_permissions').result, 'differ');
  assert.equal(find(driftedRows, 'security', 'vulnerability_alerts').result, 'differ');
  assert.equal(find(driftedRows, 'labels', 'accepted').result, 'missing');
  assert.equal(find(driftedRows, 'labels', 'stray').result, 'extra');
});

const SECTION_FAILURE_ROUTES = {
  repository: `GET ${R}`,
  teamAccess: `GET ${R}/teams?per_page=100`,
  security: `GET ${R}/private-vulnerability-reporting`,
  actions: `GET ${R}/actions/permissions/fork-pr-contributor-approval`,
  variables: `GET ${R}/actions/variables?per_page=100`,
  environments: `GET ${R}/environments/admin/secrets?per_page=100`,
  labels: `GET ${R}/labels?per_page=100`,
  rulesets: `GET ${R}/rulesets/2`,
};

for (const [name, route] of Object.entries(SECTION_FAILURE_ROUTES)) {
  for (const status of [403, 404]) {
    test(`readLiveState: ${status} on ${name} makes only that section unreadable`, async () => {
      const live = await readLive({ [route]: failure(status) });
      assert.deepEqual(live[name], { readable: false, status });
      const others = Object.entries(live).filter(([key]) => key !== name);
      assert.ok(others.every(([, value]) => value.readable === true));
    });
  }

  test(`readLiveState: 500 on ${name} throws`, async () => {
    await assert.rejects(readLive({ [route]: failure(500) }), (error) => error instanceof GitHubError && error.status === 500);
  });
}

test('readLiveState: vulnerability-alerts 404 is disabled, 204 is enabled', async () => {
  const disabled = await readLive({ [`GET ${R}/vulnerability-alerts`]: failure(404) });
  assert.equal(disabled.security.readable, true);
  assert.equal(disabled.security.value.vulnerability_alerts, false);
  const enabled = await readLive();
  assert.equal(enabled.security.value.vulnerability_alerts, true);
});

test('readLiveState: vulnerability-alerts 403 and 500 are not treated as disabled', async () => {
  const forbidden = await readLive({ [`GET ${R}/vulnerability-alerts`]: failure(403) });
  assert.deepEqual(forbidden.security, { readable: false, status: 403 });
  await assert.rejects(readLive({ [`GET ${R}/vulnerability-alerts`]: failure(500) }), GitHubError);
});

test('readLiveState: automated_security_fixes is false when disabled or paused', async () => {
  const paused = await readLive({ [`GET ${R}/automated-security-fixes`]: ok({ enabled: true, paused: true }) });
  assert.equal(paused.security.value.automated_security_fixes, false);
  const disabled = await readLive({ [`GET ${R}/automated-security-fixes`]: ok({ enabled: false, paused: false }) });
  assert.equal(disabled.security.value.automated_security_fixes, false);
});

test('readLiveState: lists rulesets with includes_parents=false then reads each by id', async () => {
  const desired = await resolvedDesiredState();
  const calls = [];
  const client = createFixtureClient(liveRoutes(desired), { onCall: (record) => calls.push(record.path) });
  await readLiveState(client, REPO, { sections: ['rulesets'] });
  assert.deepEqual(calls.slice(0, 2), [`${R}/rulesets?includes_parents=false&per_page=100`, `${R}/rulesets/1`]);
  assert.equal(calls.length, 5);
});

test('readLiveState: only the requested sections are read, and an unknown one is a SettingsError', async () => {
  const desired = await resolvedDesiredState();
  const calls = [];
  const client = createFixtureClient(liveRoutes(desired), { onCall: (record) => calls.push(record.path) });
  const live = await readLiveState(client, REPO, { sections: ['labels'] });
  assert.deepEqual(Object.keys(live), ['labels']);
  assert.deepEqual(calls, [`${R}/labels?per_page=100`]);
  await assert.rejects(readLiveState(client, REPO, { sections: ['nope'] }), SettingsError);
});

test('readLiveState: team and user reviewers are encoded, and no required_reviewers rule means no self-review prevention', async () => {
  const live = await readLive({
    [`GET ${R}/environments?per_page=100`]: ok({ environments: [
      {
        name: 'admin',
        can_admins_bypass: false,
        deployment_branch_policy: CUSTOM_POLICIES,
        protection_rules: [{
          type: 'required_reviewers',
          prevent_self_review: true,
          reviewers: [{ type: 'User', reviewer: { login: 'wianvdm' } }, { type: 'Team', reviewer: { slug: 'agents', name: 'Agents' } }],
        }],
      },
      { name: 'release', can_admins_bypass: true, protection_rules: [{ type: 'wait_timer', wait_timer: 5 }] },
    ] }),
  });
  const [admin, release] = live.environments.value;
  assert.deepEqual(admin.reviewers, ['wianvdm', 'team:agents']);
  assert.equal(admin.prevent_self_review, true);
  assert.deepEqual(release.reviewers, []);
  assert.equal(release.prevent_self_review, false);
});

test('readLiveState: environment names are encoded in request paths', async () => {
  const calls = [];
  const routes = {
    [`GET ${R}/environments?per_page=100`]: ok({ environments: [{ name: 'a b', can_admins_bypass: true, deployment_branch_policy: CUSTOM_POLICIES, protection_rules: [] }] }),
    ...environmentRoutes('a%20b', [], [], []),
  };
  const client = createFixtureClient(routes, { onCall: (record) => calls.push(record.path) });
  const live = await readLiveState(client, REPO, { sections: ['environments'] });
  assert.equal(live.environments.readable, true);
  assert.ok(calls.every((entry) => !entry.includes(' ')));
});

test('readLiveState: paginates labels across pages', async () => {
  const link = { link: `<https://api.github.com${R}/labels?page=2&per_page=100>; rel="next"` };
  const live = await readLive({
    [`GET ${R}/labels?per_page=100`]: ok([{ name: 'a', color: '000000', description: 'x' }], link),
    [`GET ${R}/labels?page=2&per_page=100`]: ok([{ name: 'b', color: '111111', description: null }]),
  }, { sections: ['labels'] });
  assert.deepEqual(live.labels.value.map((label) => label.name), ['a', 'b']);
});

const KIT_ROUTE = `GET ${R}/contents/.github/groundwork/kit-version.txt`;
const SETUP_ROUTE = `GET ${R}/code-scanning/default-setup`;

function signalRoutes({ rules = [{ type: 'code_scanning' }], setup = ok({ state: 'configured' }), kit = ok('1.0.0') } = {}) {
  return {
    [KIT_ROUTE]: kit,
    [SETUP_ROUTE]: setup,
    [RULESET_LIST]: ok([{ id: 1, name: 'other', target: 'branch' }, { id: 2, name: 'main', target: 'branch' }]),
    [`GET ${R}/rulesets/2`]: ok({ id: 2, name: 'main', rules }),
    [`GET ${R}/rulesets/1`]: ok({ id: 1, name: 'other', rules: [{ type: 'code_scanning' }] }),
  };
}

const signals = (routes, kind = 'project') => readSignals(createFixtureClient(routes), REPO, { repoKind: kind });

test('readSignals: a project with the kit file and everything configured', async () => {
  assert.deepEqual(await signals(signalRoutes()), { kitInstalled: true, codeScanningConfigured: true, pass2Ran: true });
});

test('readSignals: kitInstalled is true for the control repo without any request, false for a project 404', async () => {
  const calls = [];
  const client = createFixtureClient(signalRoutes({ kit: failure(404) }), { onCall: (record) => calls.push(record.path) });
  assert.equal((await readSignals(client, REPO, { repoKind: 'control' })).kitInstalled, true);
  assert.ok(!calls.some((entry) => entry.includes('kit-version')));
  assert.equal((await signals(signalRoutes({ kit: failure(404) }))).kitInstalled, false);
});

test('readSignals: kit-version errors other than 404 throw', async () => {
  await assert.rejects(signals(signalRoutes({ kit: failure(500) })), GitHubError);
  await assert.rejects(signals(signalRoutes({ kit: failure(403) })), GitHubError);
});

test('readSignals: pass2Ran is read from the ruleset named main only', async () => {
  assert.equal((await signals(signalRoutes({ rules: [{ type: 'deletion' }] }))).pass2Ran, false);
  const noMain = signalRoutes();
  noMain[RULESET_LIST] = ok([{ id: 1, name: 'other', target: 'branch' }]);
  assert.equal((await signals(noMain)).pass2Ran, false);
});

test('readSignals: codeScanningConfigured is false for any state other than configured', async () => {
  const result = await signals(signalRoutes({ setup: ok({ state: 'not-configured' }) }));
  assert.equal(result.codeScanningConfigured, false);
});

test('readSignals: 403 makes the code scanning and ruleset signals null', async () => {
  const routes = signalRoutes({ setup: failure(403) });
  routes[RULESET_LIST] = failure(403);
  assert.deepEqual(await signals(routes), { kitInstalled: true, codeScanningConfigured: null, pass2Ran: null });
  const rulesetBody = signalRoutes();
  rulesetBody[`GET ${R}/rulesets/2`] = failure(403);
  assert.equal((await signals(rulesetBody)).pass2Ran, null);
});

test('readSignals: other errors throw', async () => {
  await assert.rejects(signals(signalRoutes({ setup: failure(500) })), GitHubError);
  const routes = signalRoutes();
  routes[RULESET_LIST] = failure(500);
  await assert.rejects(signals(routes), GitHubError);
});

test('readSignals: 404 gives null for default-setup, the ruleset list and rulesets/{id}', async () => {
  assert.equal((await signals(signalRoutes({ setup: failure(404) }))).codeScanningConfigured, null);
  const noList = signalRoutes();
  noList[RULESET_LIST] = failure(404);
  assert.equal((await signals(noList)).pass2Ran, null);
  const noBody = signalRoutes();
  noBody[`GET ${R}/rulesets/2`] = failure(404);
  assert.equal((await signals(noBody)).pass2Ran, null);
});

test('readSignals: a tag ruleset named main does not count for pass2Ran', async () => {
  const routes = signalRoutes();
  routes[RULESET_LIST] = ok([{ id: 2, name: 'main', target: 'tag' }]);
  assert.equal((await signals(routes)).pass2Ran, false);
});

test('readLiveState: an absent can_admins_bypass is not read as false and differs from desired false', async () => {
  const desired = await resolvedDesiredState();
  const live = await readLive({
    [`GET ${R}/environments?per_page=100`]: ok({ total_count: 2, environments: [
      { name: 'release', can_admins_bypass: true, deployment_branch_policy: CUSTOM_POLICIES, protection_rules: [] },
      { name: 'admin', deployment_branch_policy: CUSTOM_POLICIES, protection_rules: [] },
    ] }),
  });
  assert.equal(live.environments.value[1].can_admins_bypass, undefined);
  const rows = compareStates(desired, live, { repoKind: 'control', config: CONFIG, signals: SIGNALS });
  assert.equal(find(rows, 'environments', 'admin.can_admins_bypass').result, 'differ');
});

test('readLiveState: branch policies are read only for custom_branch_policies environments', async () => {
  const desired = await resolvedDesiredState();
  const calls = [];
  const routes = {
    ...liveRoutes(desired),
    [`GET ${R}/environments?per_page=100`]: ok({ total_count: 3, environments: [
      { name: 'release', can_admins_bypass: true, deployment_branch_policy: null, protection_rules: [] },
      { name: 'admin', can_admins_bypass: false, deployment_branch_policy: { protected_branches: true, custom_branch_policies: false }, protection_rules: [] },
      { name: 'extra', can_admins_bypass: false, protection_rules: [] },
    ] }),
    ...environmentRoutes('extra', [], [], []),
  };
  const client = createFixtureClient(routes, { onCall: (record) => calls.push(record.path) });
  const live = await readLiveState(client, REPO, { sections: ['environments'] });
  assert.ok(live.environments.value.every((entry) => entry.deployment_refs.length === 0));
  assert.ok(!calls.some((entry) => entry.includes('deployment-branch-policies')));
});

test('readLiveState: environmentNames limits sub-requests and lists other environments by name only', async () => {
  const desired = await resolvedDesiredState();
  const calls = [];
  const client = createFixtureClient(liveRoutes(desired), { onCall: (record) => calls.push(record.path) });
  const live = await readLiveState(client, REPO, { sections: ['environments'], environmentNames: ['release'] });
  assert.deepEqual(live.environments.value[1], { name: 'admin' });
  assert.equal(live.environments.value[0].secrets[0], 'RELEASE_APP_KEY');
  assert.ok(calls.every((entry) => !entry.includes('/environments/admin/')));
});

test('readLiveState: automated-security-fixes 404 is disabled, not unreadable', async () => {
  const live = await readLive({ [`GET ${R}/automated-security-fixes`]: failure(404) });
  assert.equal(live.security.readable, true);
  assert.equal(live.security.value.automated_security_fixes, false);
  await assert.rejects(readLive({ [`GET ${R}/automated-security-fixes`]: failure(500) }), GitHubError);
});

test('readLiveState: 403 and 404 on default-setup leave the rest of security readable with an empty setup', async () => {
  const desired = await resolvedDesiredState();
  for (const status of [403, 404]) {
    const live = await readLive({ [SETUP_ROUTE]: failure(status) });
    assert.equal(live.security.readable, true);
    assert.deepEqual(live.security.value.code_scanning_default_setup, {});
    assert.equal(live.security.value.vulnerability_alerts, true);
    const rows = compareStates(desired, live, { repoKind: 'control', config: CONFIG, signals: SIGNALS });
    assert.equal(find(rows, 'security', 'code_scanning_default_setup.state').result, 'missing');
  }
  await assert.rejects(readLive({ [SETUP_ROUTE]: failure(500) }), GitHubError);
});

test('readSignals output feeds compareStates: null signals make dependent rows unreadable', async () => {
  const desired = await resolvedDesiredState();
  const routes = signalRoutes({ setup: failure(403) });
  routes[RULESET_LIST] = failure(403);
  const live = await readLive();
  const rows = compareStates(desired, live, { repoKind: 'project', config: CONFIG, signals: await signals(routes) });
  assert.equal(find(rows, 'variables', 'DEPLOY_ENABLED').result, 'unreadable');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { createFixtureClient } from './github.mjs';
import {
  SettingsError, compareStates, loadDesiredState, repoKind, resolvePlaceholders,
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

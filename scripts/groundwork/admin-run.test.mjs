import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFixtureClient } from '../lib/github.mjs';
import { repoRoot } from '../lib/config.mjs';
import { REGISTRY, apply, materialiseSettings, plan, validateRequest, writeSummary } from './admin-run.mjs';
import { mintInstallationToken, revokeInstallationToken } from './app-token.mjs';

const ORG = 'acme';
const TARGET = 'proj';
const REF = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const MAIN_SHA = 'c'.repeat(40);
const JWT = 'jwt-secret-value';
const TOKEN = 'ghs_installation_secret';
const CONTROL_ROOT = path.join(path.sep, 'checkout');
const MAIN_REF = 'refs/heads/main';
const WORKFLOW_FILE = path.join(repoRoot(import.meta.url), '.github', 'workflows', 'admin-run.yml');

const ok = (data = {}) => ({ status: 200, data });
const asBlob = (text) => ({ encoding: 'base64', content: Buffer.from(text).toString('base64') });
const CONTROL_REPO = 'groundwork';
const stubConfig = ({ root }) => ({ org: ORG, controlRepo: CONTROL_REPO, root });

const dispatchEnv = (overrides = {}) => ({
  GITHUB_REF: MAIN_REF,
  INPUT_OP: 'check',
  INPUT_TARGET_REPO: TARGET,
  INPUT_REF: '',
  INPUT_ARGS: '{}',
  ADMIN_APP_CLIENT_ID: 'client-id',
  ADMIN_APP_KEY: 'PRIVATE-KEY-MATERIAL',
  ...overrides,
});

const inputs = (overrides = {}) => ({ op: 'check', targetRepo: TARGET, ref: '', scriptPath: '', argsText: '{}', ...overrides });

/** Real contract values (scope, permissions, validateArgs) with a stubbed run. */
function stubRegistry(runs = {}) {
  return Object.fromEntries(Object.entries(REGISTRY).map(([name, module]) => [name, {
    OP: module.OP,
    TOKEN_SCOPE: module.TOKEN_SCOPE,
    PERMISSIONS: module.PERMISSIONS,
    CREATE_PERMISSIONS: module.CREATE_PERMISSIONS,
    CONTROL_READ_PERMISSIONS: module.CONTROL_READ_PERMISSIONS,
    validateArgs: module.validateArgs,
    run: runs[name] ?? (async () => ({ ok: true, summary: `${name} done` })),
  }]));
}

/**
 * Everything apply touches, injected: ordered events, mint and revoke records, a temp dir that is real so
 * removal is observable, and fixture clients keyed by token.
 */
function harness({ registry = stubRegistry(), routes = {}, jwtRoutes = {}, mint, mintFails } = {}) {
  const events = [];
  const stdout = [];
  const mints = [];
  const configRoots = [];
  const tempDirs = [];
  const overrides = {
    registry,
    controlRoot: CONTROL_ROOT,
    loadConfig: async ({ root }) => {
      configRoots.push(root);
      return stubConfig({ root });
    },
    createAppJwt: () => JWT,
    createClient: ({ token, onCall }) => createFixtureClient(token === TOKEN ? routes : jwtRoutes, { onCall }),
    mintInstallationToken: async (options) => {
      mints.push(options);
      events.push('mint');
      if (mintFails) throw new Error(mintFails);
      return mint ?? { token: TOKEN, expiresAt: new Date() };
    },
    revokeInstallationToken: async (client) => {
      events.push('revoke');
      await revokeInstallationToken(client);
    },
    makeTempDir: async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'admin-run-test-'));
      tempDirs.push(directory);
      return directory;
    },
    stdout: (text) => {
      stdout.push(text);
      events.push(`stdout:${text.trim()}`);
    },
  };
  return { overrides, events, stdout, mints, configRoots, tempDirs };
}

const revokeRoute = { 'DELETE /installation/token': { status: 204, data: '' } };

// --- validation matrix --------------------------------------------------------------------------------------------

test('validateRequest: valid dispatches pass for every op', () => {
  const cases = [
    inputs(),
    inputs({ op: 'apply-settings', ref: REF }),
    inputs({ op: 'create-issue-types', targetRepo: '' }),
    inputs({ targetRepo: 'my.repo_1-x' }),
  ];
  for (const candidate of cases) {
    const { problems, request } = validateRequest(candidate, REGISTRY);
    assert.deepEqual(problems, [], candidate.op);
    assert.equal(request.op, candidate.op);
    assert.deepEqual(request.args, {});
  }
});

test('validateRequest: each rule rejects', () => {
  const cases = [
    ['unknown op', inputs({ op: 'nonexistent' })],
    ['empty op', inputs({ op: '' })],
    ['inherited op name', inputs({ op: 'constructor' })],
    ['target missing for check', inputs({ targetRepo: '' })],
    ['target with slash', inputs({ targetRepo: 'a/b' })],
    ['target with space', inputs({ targetRepo: 'a b' })],
    ['target dot', inputs({ targetRepo: '.' })],
    ['target dotdot', inputs({ targetRepo: '..' })],
    ['target given for org op', inputs({ op: 'create-issue-types' })],
    ['apply-settings without ref', inputs({ op: 'apply-settings' })],
    ['apply-settings short ref', inputs({ op: 'apply-settings', ref: 'a'.repeat(39) })],
    ['apply-settings uppercase ref', inputs({ op: 'apply-settings', ref: 'A'.repeat(40) })],
    ['apply-settings non-hex ref', inputs({ op: 'apply-settings', ref: 'g'.repeat(40) })],
    ['ref given to check', inputs({ ref: REF })],
    ['ref given to org op', inputs({ op: 'create-issue-types', targetRepo: '', ref: REF })],
    ['args empty', inputs({ argsText: '' })],
    ['args not JSON', inputs({ argsText: '{nope' })],
    ['args array', inputs({ argsText: '[]' })],
    ['args null', inputs({ argsText: 'null' })],
    ['args string', inputs({ argsText: '"x"' })],
    ['args unknown key', inputs({ argsText: '{"extra":1}' })],
  ];
  for (const [label, candidate] of cases) {
    const { problems, request } = validateRequest(candidate, REGISTRY);
    assert.ok(problems.length > 0, label);
    assert.equal(request, undefined, label);
  }
});

test('validateRequest: reasons are one printable line without code-span or tag characters', () => {
  const hostile = '::add-mask::x\nsecret `tick`';
  const { problems } = validateRequest(inputs({ op: hostile }), REGISTRY);
  const second = validateRequest(inputs({ targetRepo: hostile, argsText: `{"${hostile.replace('\n', '')}":1}` }), REGISTRY);
  for (const reason of [...problems, ...second.problems]) {
    assert.match(reason, /^[ -~]+$/);
    assert.ok(!reason.includes('<'), reason);
    assert.ok(!reason.includes('`'), reason);
    assert.ok(!reason.includes('\n'), reason);
  }
});

test('REGISTRY: keys equal each module OP and the workflow op choices', async () => {
  for (const [key, module] of Object.entries(REGISTRY)) assert.equal(module.OP, key);
  const lines = (await readFile(WORKFLOW_FILE, 'utf8')).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === 'options:');
  const options = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^\s+- (\S+)\s*$/.exec(line);
    if (!match) break;
    options.push(match[1]);
  }
  assert.deepEqual(options.sort(), Object.keys(REGISTRY).sort());
  assert.ok(options.includes('bootstrap') && options.includes('bootstrap-pass2'));
});

// --- workflow shape -----------------------------------------------------------------------------------------------

test('admin-run.yml: no expression in run lines, admin environment only on apply, inputs via env', async () => {
  const text = await readFile(WORKFLOW_FILE, 'utf8');
  const lines = text.split(/\r?\n/);
  for (const line of lines.filter((candidate) => /^\s*run:/.test(candidate))) {
    assert.ok(!line.includes('${{'), line);
  }
  const planJob = text.slice(text.indexOf('\n  plan:'), text.indexOf('\n  apply:'));
  const applyJob = text.slice(text.indexOf('\n  apply:'));
  assert.ok(!planJob.includes('environment:'));
  assert.ok(!/secrets\./.test(planJob));
  assert.match(applyJob, /needs: plan/);
  assert.match(applyJob, /environment: admin/);
  assert.match(applyJob, /timeout-minutes:/);
  assert.match(planJob, /timeout-minutes:/);
  for (const name of ['INPUT_OP', 'INPUT_TARGET_REPO', 'INPUT_REF', 'INPUT_SCRIPT_PATH', 'INPUT_ARGS']) {
    assert.match(planJob, new RegExp(`${name}: \\$\\{\\{ inputs\\.`));
    assert.match(applyJob, new RegExp(`${name}: \\$\\{\\{ inputs\\.`));
  }
  for (const name of ['ADMIN_APP_KEY', 'RELEASE_APP_KEY']) assert.match(applyJob, new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`));
  for (const name of ['ADMIN_APP_CLIENT_ID', 'RELEASE_APP_CLIENT_ID']) assert.match(applyJob, new RegExp(`${name}: \\$\\{\\{ vars\\.${name} \\}\\}`));
  assert.match(text, /group: admin-\$\{\{ inputs\.target_repo \|\| 'org' \}\}/);
  assert.match(text, /cancel-in-progress: false/);
});

// --- plan ---------------------------------------------------------------------------------------------------------

const mainRefPath = `/repos/${ORG}/${TARGET}/git/ref/heads/main`;
const comparePath = `/repos/${ORG}/${TARGET}/compare/${REF}...${MAIN_SHA}`;
const IDENTICAL = { status: 'identical', ahead_by: 0 };
const AHEAD = { status: 'ahead', ahead_by: 3 };

/** Routes for the ancestry check: the main ref lookup, then the compare against its SHA. */
const compareRoutes = (compare, mainRef = ok({ object: { sha: MAIN_SHA } })) => ({
  [`GET ${mainRefPath}`]: mainRef,
  [`GET ${comparePath}`]: ok(compare),
});

function planOverrides(routes, calls = []) {
  return {
    controlRoot: CONTROL_ROOT,
    loadConfig: async ({ root }) => stubConfig({ root }),
    createClient: () => createFixtureClient(routes, { onCall: (call) => calls.push(call) }),
  };
}

test('plan: apply-settings passes when ref is main head or an ancestor, and reports how far behind', async () => {
  const cases = [[IDENTICAL, 'ref is main head'], [AHEAD, 'ref is 3 commits behind main'], [{ status: 'ahead', ahead_by: 1 }, 'ref is 1 commit behind main']];
  for (const [compare, wording] of cases) {
    const calls = [];
    const result = await plan(dispatchEnv({ INPUT_OP: 'apply-settings', INPUT_REF: REF }), planOverrides(compareRoutes(compare), calls));
    assert.equal(result.exitCode, 0, wording);
    assert.deepEqual(calls, [{ method: 'GET', path: mainRefPath, status: 200 }, { method: 'GET', path: comparePath, status: 200 }]);
    assert.match(result.summary, new RegExp(`- Ancestry: ${wording}\\n`));
  }
});

test('plan: compares against the resolved main SHA, never the bare name', async () => {
  const calls = [];
  await plan(dispatchEnv({ INPUT_OP: 'apply-settings', INPUT_REF: REF }), planOverrides(compareRoutes(AHEAD), calls));
  const compareCall = calls.find((call) => call.path.includes('/compare/'));
  assert.ok(compareCall.path.endsWith(`...${MAIN_SHA}`));
  assert.ok(calls.every((call) => !call.path.endsWith('...main')));
});

test('plan: apply-settings fails when ref is behind, diverged, unknown or unreadable', async () => {
  const compares = [{ status: 'behind', ahead_by: 0 }, { status: 'diverged', ahead_by: 2 }, {}, { status: 'ahead' }, { status: 'ahead', ahead_by: 0 }];
  for (const compare of compares) {
    const result = await plan(dispatchEnv({ INPUT_OP: 'apply-settings', INPUT_REF: REF }), planOverrides(compareRoutes(compare)));
    assert.equal(result.exitCode, 1, JSON.stringify(compare));
    assert.match(result.reason, /not main or an ancestor/);
  }
  const unreadable = planOverrides({ [`GET ${mainRefPath}`]: ok({ object: { sha: MAIN_SHA } }), [`GET ${comparePath}`]: { status: 404, data: { message: 'Not Found' } } });
  const result = await plan(dispatchEnv({ INPUT_OP: 'apply-settings', INPUT_REF: REF }), unreadable);
  assert.equal(result.exitCode, 1);
  assert.match(result.reason, /ancestry check failed/);
});

test('plan: an unresolvable main fails the ancestry check', async () => {
  const badRefs = [ok({}), ok({ object: { sha: 'not-a-sha' } }), ok({ object: { sha: MAIN_SHA.toUpperCase() } }), { status: 404, data: { message: 'Not Found' } }];
  for (const mainRef of badRefs) {
    const result = await plan(dispatchEnv({ INPUT_OP: 'apply-settings', INPUT_REF: REF }), planOverrides(compareRoutes(AHEAD, mainRef)));
    assert.equal(result.exitCode, 1);
    assert.match(result.reason, /ancestry check failed/);
  }
});

test('plan: other ops make no ancestry call', async () => {
  const calls = [];
  const result = await plan(dispatchEnv(), planOverrides({}, calls));
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, []);
});

test('plan: refused unless GITHUB_REF is refs/heads/main', async () => {
  for (const ref of ['refs/heads/feature', 'refs/pull/9/merge', 'refs/tags/v1', undefined, 'refs/heads/main2']) {
    let clientBuilt = false;
    const overrides = { ...planOverrides({}), createClient: () => { clientBuilt = true; } };
    const result = await plan(dispatchEnv({ GITHUB_REF: ref }), overrides);
    assert.equal(result.exitCode, 1, String(ref));
    assert.match(result.reason, /refs\/heads\/main/);
    assert.equal(clientBuilt, false);
  }
});

test('plan: invalid inputs fail with a one-line reason', async () => {
  const result = await plan(dispatchEnv({ INPUT_TARGET_REPO: '../x' }), planOverrides({}));
  assert.equal(result.exitCode, 1);
  assert.ok(!result.reason.includes('\n'));
  assert.match(result.summary, /Result: \*\*fail\*\*/);
});

test('plan: summary names op, target, ref, args, token scope and permissions', async () => {
  const env = dispatchEnv({ INPUT_OP: 'apply-settings', INPUT_REF: REF });
  const result = await plan(env, { ...planOverrides(compareRoutes(AHEAD)), registry: REGISTRY });
  assert.equal(result.exitCode, 0);
  assert.match(result.summary, /- Op: `apply-settings`/);
  assert.match(result.summary, new RegExp(`- Target: \`${ORG}/${TARGET}\``));
  assert.match(result.summary, new RegExp(`- Ref: \`${REF}\``));
  assert.match(result.summary, /restricted to `proj`/);
  assert.match(result.summary, /```json\n\{\}\n```/);
  assert.match(result.summary, /\| administration \| write \|/);
  assert.match(result.summary, /\| contents \| read \|/);
});

test('plan: org op summary shows an installation-wide token and the single permission', async () => {
  const env = dispatchEnv({ INPUT_OP: 'create-issue-types', INPUT_TARGET_REPO: '' });
  const result = await plan(env, planOverrides({}));
  assert.equal(result.exitCode, 0);
  assert.match(result.summary, /installation-wide/);
  assert.match(result.summary, /\| issue_types \| write \|/);
  assert.match(result.summary, new RegExp(`organisation \`${ORG}\``));
});

test('plan: args render in a fence longer than any backtick run inside', async () => {
  const registry = stubRegistry();
  registry.check.validateArgs = () => [];
  const argsText = JSON.stringify({ note: 'close ``` early ```` and <b>' });
  const result = await plan(dispatchEnv({ INPUT_ARGS: argsText }), { ...planOverrides({}), registry });
  assert.equal(result.exitCode, 0);
  assert.match(result.summary, /`````json\n/);
  assert.ok(result.summary.includes('\n`````\n') || result.summary.includes('\n`````'));
});

test('plan: needs no admin secrets', async () => {
  const env = dispatchEnv();
  delete env.ADMIN_APP_KEY;
  delete env.ADMIN_APP_CLIENT_ID;
  const result = await plan(env, planOverrides({}));
  assert.equal(result.exitCode, 0);
});

// --- apply: mint --------------------------------------------------------------------------------------------------

const opCases = [
  ['apply-settings', { INPUT_OP: 'apply-settings', INPUT_REF: REF }, [TARGET]],
  ['check', { INPUT_OP: 'check' }, [TARGET]],
  ['create-issue-types', { INPUT_OP: 'create-issue-types', INPUT_TARGET_REPO: '' }, 'all'],
];

test('apply: mints with the op repositories and permissions', async () => {
  for (const [op, overrides, repositories] of opCases) {
    const { overrides: deps, mints } = harness({
      routes: { ...compareRoutes(IDENTICAL), ...settingsRoutes(REF), ...settingsRoutes(HEAD), ...revokeRoute },
    });
    const env = dispatchEnv(overrides);
    const result = await apply(env, deps);
    assert.equal(result.exitCode, 0, `${op}: ${result.reason}`);
    assert.equal(mints.length, 1, op);
    assert.deepEqual(mints[0].repositories, repositories, op);
    assert.deepEqual(mints[0].permissions, REGISTRY[op].PERMISSIONS, op);
    assert.equal(mints[0].org, ORG);
    assert.equal(mints[0].env, env);
  }
});

test('apply: org op gets no repositories and the checkout as settings root', async () => {
  let seen;
  const registry = stubRegistry({ 'create-issue-types': async (ctx) => { seen = ctx; return { ok: true, summary: 'types' }; } });
  const { overrides, mints, configRoots } = harness({ registry, routes: revokeRoute });
  const result = await apply(dispatchEnv({ INPUT_OP: 'create-issue-types', INPUT_TARGET_REPO: '' }), overrides);
  assert.equal(result.exitCode, 0);
  assert.equal(mints[0].repositories, 'all');
  assert.equal(seen.repo, null);
  assert.equal(seen.settingsRoot, CONTROL_ROOT);
  assert.equal(seen.token, TOKEN);
  assert.ok(!configRoots.some((root) => root !== CONTROL_ROOT));
});

test('apply: re-validates and never mints on invalid input, wrong ref or missing credentials', async () => {
  const bad = [
    dispatchEnv({ INPUT_TARGET_REPO: '' }),
    dispatchEnv({ GITHUB_REF: 'refs/heads/feature' }),
    dispatchEnv({ INPUT_ARGS: '{"x":1}' }),
    dispatchEnv({ ADMIN_APP_KEY: '' }),
    dispatchEnv({ ADMIN_APP_CLIENT_ID: undefined }),
  ];
  for (const env of bad) {
    const { overrides, mints, events } = harness();
    const result = await apply(env, overrides);
    assert.equal(result.exitCode, 1);
    assert.equal(mints.length, 0);
    assert.deepEqual(events, []);
  }
});

test('apply: a failed mint fails the run without a revoke', async () => {
  const { overrides, events } = harness({ mintFails: 'app-token: granted permissions differ from requested', routes: revokeRoute });
  const result = await apply(dispatchEnv(), overrides);
  assert.equal(result.exitCode, 1);
  assert.match(result.reason, /granted permissions differ/);
  assert.deepEqual(events, [`stdout:::add-mask::${JWT}`, 'mint']);
});

// --- apply: masking and output ------------------------------------------------------------------------------------

test('apply: masks the token before any later output and scrubs it from the summary', async () => {
  const registry = stubRegistry({
    check: async (ctx) => {
      ctx.log(`token is ${TOKEN}`);
      return { ok: true, summary: `leaked ${TOKEN} and PRIVATE-KEY-MATERIAL` };
    },
  });
  const { overrides, stdout, events } = harness({ registry, routes: { ...settingsRoutes(HEAD), ...revokeRoute } });
  const result = await apply(dispatchEnv(), overrides);
  assert.equal(result.exitCode, 0);
  const maskIndex = events.indexOf(`stdout:::add-mask::${TOKEN}`);
  assert.ok(maskIndex > events.indexOf('mint'), 'mask comes right after mint');
  assert.ok(maskIndex < events.indexOf('revoke'));
  assert.ok(stdout.every((text) => text.startsWith('::add-mask::')), 'nothing else is printed to stdout');
  assert.ok(!result.summary.includes(TOKEN));
  assert.ok(!result.summary.includes('PRIVATE-KEY-MATERIAL'));
  assert.match(result.summary, /leaked \*\*\*/);
});

test('apply: call table lists method, path and status and never bodies', async () => {
  const registry = stubRegistry({
    check: async (ctx) => {
      await ctx.client.request('GET', `/repos/${ORG}/${TARGET}/labels`);
      await ctx.client.request('POST', `/repos/${ORG}/${TARGET}/labels`, { body: { name: 'SECRET-BODY-VALUE' } });
      return { ok: true, summary: 'check done' };
    },
  });
  const routes = {
    ...settingsRoutes(HEAD),
    [`GET /repos/${ORG}/${TARGET}/labels`]: ok([{ name: 'RESPONSE-BODY-VALUE' }]),
    [`POST /repos/${ORG}/${TARGET}/labels`]: { status: 201, data: { name: 'RESPONSE-BODY-VALUE' } },
    ...revokeRoute,
  };
  const { overrides } = harness({ registry, routes });
  const result = await apply(dispatchEnv(), overrides);
  assert.equal(result.exitCode, 0);
  assert.match(result.summary, /\| POST \| `\/repos\/acme\/proj\/labels` \| 201 \|/);
  assert.match(result.summary, /\| GET \| `\/repos\/acme\/proj\/labels` \| 200 \|/);
  assert.match(result.summary, /\| DELETE \| `\/installation\/token` \| 204 \|/);
  assert.ok(!result.summary.includes('SECRET-BODY-VALUE'));
  assert.ok(!result.summary.includes('RESPONSE-BODY-VALUE'));
});

// --- apply: composition and revoke --------------------------------------------------------------------------------

test('apply: apply-settings is followed by check with the same client and settings root', async () => {
  const seen = [];
  const registry = stubRegistry({
    'apply-settings': async (ctx) => { seen.push(['apply-settings', ctx]); return { ok: true, summary: 'applied' }; },
    check: async (ctx) => { seen.push(['check', ctx]); return { ok: true, summary: 'verified' }; },
  });
  const { overrides } = harness({ registry, routes: { ...compareRoutes(AHEAD), ...settingsRoutes(REF), ...revokeRoute } });
  const result = await apply(dispatchEnv({ INPUT_OP: 'apply-settings', INPUT_REF: REF }), overrides);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(seen.map(([name]) => name), ['apply-settings', 'check']);
  assert.equal(seen[0][1].client, seen[1][1].client);
  assert.equal(seen[0][1].settingsRoot, seen[1][1].settingsRoot);
  assert.ok(result.summary.indexOf('applied') < result.summary.indexOf('verified'));
});

test('apply: a failing check after apply-settings fails the run and keeps both summaries', async () => {
  const registry = stubRegistry({
    'apply-settings': async () => ({ ok: true, summary: 'applied' }),
    check: async () => ({ ok: false, summary: 'two rows differ' }),
  });
  const { overrides, events } = harness({ registry, routes: { ...compareRoutes(AHEAD), ...settingsRoutes(REF), ...revokeRoute } });
  const result = await apply(dispatchEnv({ INPUT_OP: 'apply-settings', INPUT_REF: REF }), overrides);
  assert.equal(result.exitCode, 1);
  assert.match(result.summary, /Result: \*\*fail\*\*/);
  assert.match(result.summary, /applied/);
  assert.match(result.summary, /two rows differ/);
  assert.ok(events.includes('revoke'));
});

test('apply: check alone runs once; a not-ok apply-settings skips check', async () => {
  const checkRuns = [];
  const registry = stubRegistry({
    'apply-settings': async () => ({ ok: false, summary: 'stopped' }),
    check: async () => { checkRuns.push('check'); return { ok: true, summary: 'verified' }; },
  });
  const routes = { ...compareRoutes(AHEAD), ...settingsRoutes(REF), ...settingsRoutes(HEAD), ...revokeRoute };
  const skipped = await apply(dispatchEnv({ INPUT_OP: 'apply-settings', INPUT_REF: REF }), harness({ registry, routes }).overrides);
  assert.equal(skipped.exitCode, 1);
  assert.deepEqual(checkRuns, []);
  const alone = await apply(dispatchEnv(), harness({ registry, routes }).overrides);
  assert.equal(alone.exitCode, 0);
  assert.deepEqual(checkRuns, ['check']);
});

test('apply: revokes after success', async () => {
  const { overrides, events } = harness({ routes: { ...settingsRoutes(HEAD), ...revokeRoute } });
  const result = await apply(dispatchEnv(), overrides);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(events.filter((event) => !event.startsWith('stdout')), ['mint', 'revoke']);
  assert.match(result.summary, /\| DELETE \| `\/installation\/token` \| 204 \|/);
});

test('apply: revokes when the op throws and reports its one-line message', async () => {
  const registry = stubRegistry({ check: async () => { throw new Error('boom\nsecond line'); } });
  const { overrides, events, tempDirs } = harness({ registry, routes: { ...settingsRoutes(HEAD), ...revokeRoute } });
  const result = await apply(dispatchEnv(), overrides);
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, 'boom second line');
  assert.match(result.summary, /Result: \*\*fail\*\*: `boom second line`/);
  assert.ok(events.includes('revoke'));
  assert.ok(tempDirs.every((directory) => !existsSync(directory)));
});

test('apply: a failed revoke fails the run even when the op passed', async () => {
  const { overrides } = harness({ routes: { ...settingsRoutes(HEAD), 'DELETE /installation/token': { status: 500, data: { message: 'down' } } } });
  const result = await apply(dispatchEnv(), overrides);
  assert.equal(result.exitCode, 1);
  assert.match(result.reason, /revocation failed, valid until expiry/);
});

// --- apply: settings materialisation ------------------------------------------------------------------------------

/** Tree and blob routes for one commit: valid settings files plus entries that must be skipped. */
const GITHUB_TREE = 't-github';
const SETTINGS_TREE = 't-groundwork';
const treePath = (sha) => `/repos/${ORG}/${TARGET}/git/trees/${sha}`;
const tree = (entries, truncated = false) => ok({ truncated, tree: entries });
const subtree = (name, sha) => ({ path: name, type: 'tree', mode: '040000', sha });

/** Entries of the settings subtree (paths relative to it): valid files plus ones that must be skipped. */
const SETTINGS_ENTRIES = [
  { path: 'config.json', type: 'blob', mode: '100644', sha: 's1' },
  { path: 'rulesets/main.json', type: 'blob', mode: '100644', sha: 's2' },
  { path: 'templates/feature.md', type: 'blob', mode: '100644', sha: 's3' },
  { path: '../escape.json', type: 'blob', mode: '100644', sha: 's4' },
  { path: 'link.json', type: 'blob', mode: '120000', sha: 's5' },
  { path: 'rulesets', type: 'tree', mode: '040000', sha: 's6' },
  { path: 'back\\slash.json', type: 'blob', mode: '100644', sha: 's7' },
  { path: 'drive:colon.json', type: 'blob', mode: '100644', sha: 's8' },
];

/** Walk routes for one commit (root, .github, settings subtree) plus the blobs, and the default-branch lookup. */
function settingsRoutes(sha, settingsEntries = SETTINGS_ENTRIES) {
  return {
    [`GET /repos/${ORG}/${TARGET}`]: ok({ default_branch: 'main' }),
    [`GET /repos/${ORG}/${TARGET}/branches/main`]: ok({ commit: { sha: HEAD } }),
    [`GET ${treePath(sha)}`]: tree([subtree('.github', GITHUB_TREE), subtree('src', 't-src')]),
    [`GET ${treePath(GITHUB_TREE)}`]: tree([subtree('groundwork', SETTINGS_TREE), subtree('workflows', 't-workflows')]),
    [`GET ${treePath(SETTINGS_TREE)}?recursive=1`]: tree(settingsEntries),
    [`GET /repos/${ORG}/${TARGET}/git/blobs/s1`]: ok(asBlob('{"config":true}')),
    [`GET /repos/${ORG}/${TARGET}/git/blobs/s2`]: ok(asBlob('{"ruleset":"main"}')),
  };
}

async function listFiles(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort();
}

test('apply: check materialises settings at the default branch head', async () => {
  let files;
  let content;
  let seenRoot;
  const registry = stubRegistry({
    check: async (ctx) => {
      seenRoot = ctx.settingsRoot;
      files = await listFiles(ctx.settingsRoot);
      content = await readFile(path.join(ctx.settingsRoot, '.github', 'groundwork', 'config.json'), 'utf8');
      return { ok: true, summary: 'checked' };
    },
  });
  const { overrides, configRoots, tempDirs } = harness({ registry, routes: { ...settingsRoutes(HEAD), ...revokeRoute } });
  const result = await apply(dispatchEnv(), overrides);
  assert.equal(result.exitCode, 0, result.reason);
  assert.deepEqual(files, ['.github/groundwork/config.json', '.github/groundwork/rulesets/main.json']);
  assert.equal(content, '{"config":true}');
  assert.ok(configRoots.includes(seenRoot), 'config is loaded from the materialised root');
  assert.match(result.summary, new RegExp(`git/trees/${HEAD}\` \\| 200`));
  assert.match(result.summary, new RegExp(`git/trees/${SETTINGS_TREE}\\?recursive=1\` \\| 200`));
  assert.ok(!result.summary.includes(`git/trees/${HEAD}?recursive`), 'the full tree is never listed recursively');
  assert.ok(!existsSync(seenRoot), 'temp dir removed');
  assert.ok(tempDirs.every((directory) => !existsSync(directory)));
});

test('apply: apply-settings materialises at the input ref, not at the branch head', async () => {
  const roots = [];
  const registry = stubRegistry({ 'apply-settings': async (ctx) => { roots.push(await listFiles(ctx.settingsRoot)); return { ok: true, summary: 'applied' }; } });
  const routes = { ...compareRoutes(AHEAD), ...settingsRoutes(REF), ...revokeRoute };
  const { overrides } = harness({ registry, routes });
  const result = await apply(dispatchEnv({ INPUT_OP: 'apply-settings', INPUT_REF: REF }), overrides);
  assert.equal(result.exitCode, 0, result.reason);
  assert.equal(roots[0].length, 2);
  assert.ok(!result.summary.includes('/branches/main'), 'no default-branch lookup for apply-settings');
});

test('apply: ancestry is re-checked with the minted token; failure stops before the op and still revokes', async () => {
  const ran = [];
  const registry = stubRegistry({ 'apply-settings': async () => { ran.push('apply-settings'); return { ok: true, summary: 'applied' }; } });
  for (const status of ['behind', 'diverged']) {
    const routes = { ...compareRoutes({ status, ahead_by: 0 }), ...settingsRoutes(REF), ...revokeRoute };
    const { overrides, events } = harness({ registry, routes });
    const result = await apply(dispatchEnv({ INPUT_OP: 'apply-settings', INPUT_REF: REF }), overrides);
    assert.equal(result.exitCode, 1, status);
    assert.match(result.reason, /not main or an ancestor/);
    assert.ok(events.includes('revoke'));
  }
  assert.deepEqual(ran, []);
});

test('apply: a truncated settings subtree or directory listing fails closed', async () => {
  const truncations = [`${treePath(SETTINGS_TREE)}?recursive=1`, treePath(GITHUB_TREE), treePath(HEAD)];
  for (const route of truncations) {
    const routes = { ...settingsRoutes(HEAD), [`GET ${route}`]: tree([], true), ...revokeRoute };
    const { overrides, events } = harness({ routes });
    const result = await apply(dispatchEnv(), overrides);
    assert.equal(result.exitCode, 1, route);
    assert.match(result.reason, /truncated/, route);
    assert.ok(events.includes('revoke'), route);
  }
});

// --- guards: one failing input each -------------------------------------------------------------------------------

async function materialiseInto(routes, sha = HEAD) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'admin-run-materialise-'));
  const client = createFixtureClient(routes);
  await materialiseSettings(client, { org: ORG, repo: TARGET, sha, directory });
  return directory;
}

test('materialiseSettings: skips segments with a backslash or colon without fetching them', async () => {
  const directory = await materialiseInto(settingsRoutes(HEAD));
  assert.deepEqual(await listFiles(directory), ['.github/groundwork/config.json', '.github/groundwork/rulesets/main.json']);
});

test('materialiseSettings: rejects a tree response that is not an array', async () => {
  const routes = { ...settingsRoutes(HEAD), [`GET ${treePath(SETTINGS_TREE)}?recursive=1`]: ok({ truncated: false, tree: { path: 'config.json' } }) };
  await assert.rejects(materialiseInto(routes), /truncated or malformed/);
});

test('materialiseSettings: rejects a blob whose encoding is not base64', async () => {
  const routes = { ...settingsRoutes(HEAD), [`GET /repos/${ORG}/${TARGET}/git/blobs/s1`]: ok({ encoding: 'utf-8', content: '{}' }) };
  await assert.rejects(materialiseInto(routes), /blob is not base64/);
});

test('materialiseSettings: rejects a commit without .github/groundwork', async () => {
  const withoutGithub = { ...settingsRoutes(HEAD), [`GET ${treePath(HEAD)}`]: tree([subtree('src', 't-src')]) };
  await assert.rejects(materialiseInto(withoutGithub), /has no \.github\/groundwork directory/);
  const withoutGroundwork = { ...settingsRoutes(HEAD), [`GET ${treePath(GITHUB_TREE)}`]: tree([subtree('workflows', 't-workflows')]) };
  await assert.rejects(materialiseInto(withoutGroundwork), /has no \.github\/groundwork directory/);
  const fileNamedGroundwork = { ...settingsRoutes(HEAD), [`GET ${treePath(GITHUB_TREE)}`]: tree([{ path: 'groundwork', type: 'blob', mode: '100644', sha: 'x' }]) };
  await assert.rejects(materialiseInto(fileNamedGroundwork), /has no \.github\/groundwork directory/);
});

test('apply: check fails when the repository response has no default_branch', async () => {
  for (const repository of [ok({}), ok({ default_branch: '' }), ok({ default_branch: 7 })]) {
    const routes = { ...settingsRoutes(HEAD), [`GET /repos/${ORG}/${TARGET}`]: repository, ...revokeRoute };
    const { overrides, events } = harness({ routes });
    const result = await apply(dispatchEnv(), overrides);
    assert.equal(result.exitCode, 1);
    assert.match(result.reason, /no default_branch/);
    assert.ok(events.includes('revoke'));
  }
});

test('apply: check fails when the branch head SHA is malformed', async () => {
  for (const branch of [ok({}), ok({ commit: { sha: 'abc123' } }), ok({ commit: { sha: HEAD.toUpperCase() } }), ok({ commit: { sha: 42 } })]) {
    const routes = { ...settingsRoutes(HEAD), [`GET /repos/${ORG}/${TARGET}/branches/main`]: branch, ...revokeRoute };
    const { overrides } = harness({ routes });
    const result = await apply(dispatchEnv(), overrides);
    assert.equal(result.exitCode, 1);
    assert.match(result.reason, /no commit SHA/);
  }
});

test('apply: a failing op and a failing revoke are both reported', async () => {
  const registry = stubRegistry({ check: async () => { throw new Error('op exploded'); } });
  const routes = { ...settingsRoutes(HEAD), 'DELETE /installation/token': { status: 500, data: { message: 'down' } } };
  const { overrides } = harness({ registry, routes });
  const result = await apply(dispatchEnv(), overrides);
  assert.equal(result.exitCode, 1);
  assert.match(result.reason, /^op exploded; token revocation failed, valid until expiry: /);
  assert.match(result.summary, /Result: \*\*fail\*\*: `op exploded; token revocation failed/);
});

// --- apply: ancestry, scrubbing, accounting, rendering ------------------------------------------------------------

test('apply: the ancestry check resolves main to a SHA and the summary says how far behind', async () => {
  const routes = { ...compareRoutes(AHEAD), ...settingsRoutes(REF), ...revokeRoute };
  const { overrides } = harness({ routes });
  const result = await apply(dispatchEnv({ INPUT_OP: 'apply-settings', INPUT_REF: REF }), overrides);
  assert.equal(result.exitCode, 0, result.reason);
  assert.match(result.summary, /- Ancestry: ref is 3 commits behind main\n/);
  assert.match(result.summary, new RegExp(`\\| GET \\| \`${mainRefPath}\` \\| 200 \\|`));
  assert.match(result.summary, new RegExp(`compare/${REF}\\.\\.\\.${MAIN_SHA}\` \\| 200 \\|`));
  assert.ok(!result.summary.includes('...main`'), 'compare never uses the bare branch name');
  const identical = harness({ routes: { ...compareRoutes(IDENTICAL), ...settingsRoutes(REF), ...revokeRoute } });
  const second = await apply(dispatchEnv({ INPUT_OP: 'apply-settings', INPUT_REF: REF }), identical.overrides);
  assert.match(second.summary, /- Ancestry: ref is main head\n/);
});

const PEM_LINES = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).trim().split('\n');
const ADMIN_PEM = PEM_LINES.join('\n');
const RELEASE_PEM = PEM_LINES.map((line) => `R-${line}`).join('\n');

function assertNoSecretLines(result, lines) {
  for (const line of lines.filter((candidate) => candidate.length > 16)) {
    assert.ok(!result.summary.includes(line), `summary leaks ${line}`);
    assert.ok(!result.reason.includes(line), `reason leaks ${line}`);
  }
}

test('apply: a multi-line key in an error message never reaches the summary or stderr text', async () => {
  const messages = [
    `bad key ${ADMIN_PEM}`,
    `reflowed ${PEM_LINES.join(' ')}`,
    `${'x'.repeat(190)}${ADMIN_PEM}`,
    `release ${RELEASE_PEM}`,
    `jwt ${JWT} token ${TOKEN}`,
  ];
  for (const message of messages) {
    const registry = stubRegistry({ check: async () => { throw new Error(message); } });
    const { overrides } = harness({ registry, routes: { ...settingsRoutes(HEAD), ...revokeRoute } });
    const result = await apply(dispatchEnv({ ADMIN_APP_KEY: ADMIN_PEM, RELEASE_APP_KEY: RELEASE_PEM }), overrides);
    assert.equal(result.exitCode, 1);
    assertNoSecretLines(result, [...PEM_LINES, ...RELEASE_PEM.split('\n'), JWT, TOKEN]);
    assert.ok(!result.summary.includes('-----BEGIN'), 'no partial line survives truncation');
  }
});

test('apply: key lines are also scrubbed from op logs and a failing revoke message', async () => {
  const registry = stubRegistry({ check: async (ctx) => { ctx.log(`dump ${ADMIN_PEM}`); return { ok: true, summary: 'ok' }; } });
  const routes = { ...settingsRoutes(HEAD), 'DELETE /installation/token': { status: 500, data: { message: `down ${RELEASE_PEM}` } } };
  const { overrides } = harness({ registry, routes });
  const result = await apply(dispatchEnv({ ADMIN_APP_KEY: ADMIN_PEM, RELEASE_APP_KEY: RELEASE_PEM }), overrides);
  assert.equal(result.exitCode, 1);
  assertNoSecretLines(result, [...PEM_LINES, ...RELEASE_PEM.split('\n')]);
});

test('apply: the fail-closed revoke inside mint is recorded and uses the injected client', async () => {
  const createdFor = [];
  const jwtRoutes = {
    [`GET /orgs/${ORG}/installation`]: ok({ id: 7 }),
    'POST /app/installations/7/access_tokens': { status: 201, data: { token: TOKEN, expires_at: '2030-01-01T00:00:00Z', permissions: { issues: 'write' }, repositories: [{ name: TARGET }] } },
  };
  const { overrides } = harness({ jwtRoutes, routes: revokeRoute });
  const createClient = overrides.createClient;
  overrides.createClient = (options) => {
    createdFor.push(options.token);
    return createClient(options);
  };
  overrides.mintInstallationToken = (options) => mintInstallationToken(options);
  const result = await apply(dispatchEnv(), overrides);
  assert.equal(result.exitCode, 1);
  assert.match(result.reason, /granted permissions differ/);
  assert.deepEqual(createdFor, [JWT, TOKEN], 'the revoke client came from deps.createClient');
  assert.match(result.summary, /\| DELETE \| `\/installation\/token` \| 204 \|/);
  assert.equal(result.summary.match(/\/installation\/token/g).length, 1, 'no second revoke for a token that was never handed out');
});

test('apply: mint receives a makeClient that builds on the injected createClient', async () => {
  const { overrides, mints } = harness({ routes: { ...settingsRoutes(HEAD), ...revokeRoute } });
  await apply(dispatchEnv(), overrides);
  const client = mints[0].makeClient(TOKEN);
  assert.equal((await client.request('DELETE', '/installation/token')).status, 204);
});

test('apply: calls an op records through ctx.recordCall land in the call table', async () => {
  const registry = stubRegistry({
    check: async (ctx) => {
      ctx.recordCall({ method: 'gh', path: 'secret set RELEASE_APP_KEY --env release --repo acme/proj', status: 0 });
      return { ok: true, summary: 'ok' };
    },
  });
  const { overrides } = harness({ registry, routes: { ...settingsRoutes(HEAD), ...revokeRoute } });
  const result = await apply(dispatchEnv(), overrides);
  assert.match(result.summary, /\| gh \| `secret set RELEASE_APP_KEY --env release --repo acme\/proj` \| 0 \|/);
});

test('apply: ops get an env without ADMIN_APP_KEY, mint keeps the original', async () => {
  let seenEnv;
  const registry = stubRegistry({ check: async (ctx) => { seenEnv = ctx.env; return { ok: true, summary: 'ok' }; } });
  const { overrides, mints } = harness({ registry, routes: { ...settingsRoutes(HEAD), ...revokeRoute } });
  const env = dispatchEnv({ RELEASE_APP_KEY: 'release-key' });
  const result = await apply(env, overrides);
  assert.equal(result.exitCode, 0);
  assert.ok(!('ADMIN_APP_KEY' in seenEnv));
  assert.equal(seenEnv.RELEASE_APP_KEY, 'release-key');
  assert.equal(seenEnv.INPUT_OP, 'check');
  assert.equal(mints[0].env.ADMIN_APP_KEY, 'PRIVATE-KEY-MATERIAL');
  assert.equal(env.ADMIN_APP_KEY, 'PRIVATE-KEY-MATERIAL', 'the caller env is not mutated');
});

test('apply: op code reads no ADMIN_APP_KEY from process.env while minting still works', async (context) => {
  const previous = process.env.ADMIN_APP_KEY;
  process.env.ADMIN_APP_KEY = 'PRIVATE-KEY-MATERIAL';
  context.after(() => {
    if (previous === undefined) return delete process.env.ADMIN_APP_KEY;
    process.env.ADMIN_APP_KEY = previous;
  });
  let seenInProcess = 'not run';
  const registry = stubRegistry({
    check: async () => {
      seenInProcess = process.env.ADMIN_APP_KEY;
      return { ok: true, summary: 'ok' };
    },
  });
  const { overrides, mints } = harness({ registry, routes: { ...settingsRoutes(HEAD), ...revokeRoute } });
  const result = await apply(dispatchEnv(), overrides);
  assert.equal(result.exitCode, 0);
  assert.equal(seenInProcess, undefined);
  assert.equal(mints[0].env.ADMIN_APP_KEY, 'PRIVATE-KEY-MATERIAL');
});

test('apply: refuses process.env itself before any mint', async () => {
  const { overrides, mints } = harness();
  const result = await apply(process.env, overrides);
  assert.equal(result.exitCode, 1);
  assert.match(result.reason, /needs a copy of process\.env/);
  assert.equal(mints.length, 0);
});

test('apply: the token is revoked even when building the op client throws', async () => {
  const { overrides, events } = harness({ routes: { ...settingsRoutes(HEAD), ...revokeRoute } });
  const createClient = overrides.createClient;
  let opClientBuilds = 0;
  overrides.createClient = (options) => {
    if (options.token === TOKEN && opClientBuilds++ === 0) throw new Error('client construction failed');
    return createClient(options);
  };
  const result = await apply(dispatchEnv(), overrides);
  assert.equal(result.exitCode, 1);
  assert.match(result.reason, /client construction failed/);
  assert.ok(events.includes('revoke'));
  assert.match(result.summary, /\| DELETE \| `\/installation\/token` \| 204 \|/);
});

test('apply and plan: error text renders in code spans so links and images stay inert', async () => {
  const hostile = 'oops ![x](https://example.invalid) [y](https://example.invalid)';
  const registry = stubRegistry({ check: async (ctx) => { ctx.log(hostile); throw new Error(hostile); } });
  const { overrides } = harness({ registry, routes: { ...settingsRoutes(HEAD), ...revokeRoute } });
  const result = await apply(dispatchEnv(), overrides);
  assert.ok(result.summary.includes(`Result: **fail**: \`${hostile}\``));
  assert.ok(result.summary.includes(`- \`${hostile}\``));
  const failed = await plan(dispatchEnv({ INPUT_OP: 'apply-settings', INPUT_REF: REF }), planOverrides({ ...compareRoutes({ status: 'diverged' }) }));
  assert.match(failed.summary, /Result: \*\*fail\*\*: `[^`]+`$/);
});

test('apply: a non-GitHub error from the ancestry check fails the run and still revokes', async () => {
  const registry = stubRegistry();
  const routes = { ...compareRoutes(AHEAD), ...settingsRoutes(REF), ...revokeRoute };
  const { overrides, events } = harness({ registry, routes });
  const createClient = overrides.createClient;
  overrides.createClient = (options) => {
    const client = createClient(options);
    if (options.token !== TOKEN) return client;
    return { ...client, request: async (method, requestPath, requestOptions) => {
      if (requestPath.includes('/git/ref/')) throw new TypeError('unexpected');
      return client.request(method, requestPath, requestOptions);
    } };
  };
  const result = await apply(dispatchEnv({ INPUT_OP: 'apply-settings', INPUT_REF: REF }), overrides);
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, 'unexpected');
  assert.ok(events.includes('revoke'));
});

// --- deferred scope: withToken, writeSettings, trailing check -------------------------------------------------------

const BOOTSTRAP_ENV = { INPUT_OP: 'bootstrap', INPUT_ARGS: '{"description":"demo"}' };
const BOOTSTRAP = REGISTRY.bootstrap;
const withTokenRoutes = () => ({ ...settingsRoutes(HEAD), [`GET ${mainRefPath}`]: ok({ object: { sha: HEAD } }), ...revokeRoute });
const nonStdout = (events) => events.filter((event) => !event.startsWith('stdout'));

function deferredHarness(run, { routes = withTokenRoutes(), checkRun, ...rest } = {}) {
  const registry = stubRegistry({ bootstrap: run, ...(checkRun ? { check: checkRun } : {}) });
  const built = harness({ registry, routes, ...rest });
  const jwts = [];
  built.overrides.createAppJwt = () => {
    jwts.push(`${JWT}-${jwts.length + 1}`);
    return jwts.at(-1);
  };
  return { ...built, jwts };
}

const targetGrant = { repositories: [TARGET], permissions: { contents: 'write', members: 'read' } };
const controlRead = { repositories: [CONTROL_REPO], permissions: BOOTSTRAP.CONTROL_READ_PERMISSIONS };
const createGrant = { repositories: [CONTROL_REPO], permissions: BOOTSTRAP.CREATE_PERMISSIONS };
const stopHere = { ok: false, summary: 'stop' };

test('admin-run.yml: run-name carries every input for the owner delegation', async () => {
  const lines = (await readFile(WORKFLOW_FILE, 'utf8')).split(/\r?\n/);
  assert.ok(lines.includes('run-name: admin-run ${{ inputs.op }} ${{ inputs.target_repo }} ref=${{ inputs.ref }} script=${{ inputs.script_path }} args=${{ inputs.args }}'));
});

test('admin-run.yml: lists script and selftest, declares script_path and carries it in run-name', async () => {
  const text = await readFile(WORKFLOW_FILE, 'utf8');
  const options = text.slice(text.indexOf('options:'), text.indexOf('target_repo:')).split(/\r?\n/).map((line) => line.trim());
  assert.ok(options.includes('- script') && options.includes('- selftest'));
  assert.match(text, /^\s+script_path:$/m);
  assert.match(text, /^run-name: .*inputs\.script_path/m);
  assert.match(text, /script_sha256: \$\{\{ steps\.plan\.outputs\.script_sha256 \}\}/);
  assert.match(text, /PLAN_SCRIPT_SHA256: \$\{\{ needs\.plan\.outputs\.script_sha256 \}\}/);
});

const SCRIPT_PATH = 'admin-ops/example.mjs';
const SKELETON_ENVS = {
  script: { INPUT_OP: 'script', INPUT_REF: REF, INPUT_SCRIPT_PATH: SCRIPT_PATH },
  selftest: { INPUT_OP: 'selftest', INPUT_TARGET_REPO: '' },
};

test('validateRequest: script needs a SHA ref and an admin-ops path, selftest takes neither target nor ref', () => {
  const script = inputs({ op: 'script', ref: REF, scriptPath: SCRIPT_PATH });
  const rejected = [
    ['script without ref', { ...script, ref: '' }],
    ['script without path', { ...script, scriptPath: '' }],
    ['script path outside admin-ops', { ...script, scriptPath: 'scripts/example.mjs' }],
    ['script path nested', { ...script, scriptPath: 'admin-ops/sub/example.mjs' }],
    ['script path traversal', { ...script, scriptPath: 'admin-ops/../x.mjs' }],
    ['script path not mjs', { ...script, scriptPath: 'admin-ops/example.js' }],
    ['script without target', { ...script, targetRepo: '' }],
    ['script path given to check', inputs({ scriptPath: SCRIPT_PATH })],
    ['selftest with target', inputs({ op: 'selftest' })],
    ['selftest with ref', inputs({ op: 'selftest', targetRepo: '', ref: REF })],
  ];
  for (const [label, candidate] of rejected) assert.ok(validateRequest(candidate, REGISTRY).problems.length > 0, label);
  const onlySkeletonProblem = (candidate) => validateRequest(candidate, REGISTRY).problems;
  assert.deepEqual(onlySkeletonProblem(script), ['args: not implemented']);
  assert.deepEqual(onlySkeletonProblem(inputs({ op: 'selftest', targetRepo: '' })), ['args: not implemented']);
});

for (const [op, env] of Object.entries(SKELETON_ENVS)) {
  test(`plan and apply: ${op} refuses not implemented before any call, mint or write`, async () => {
    const calls = [];
    const planned = await plan(dispatchEnv({ INPUT_TARGET_REPO: TARGET, ...env }), { ...planOverrides({}, calls), registry: REGISTRY });
    assert.equal(planned.exitCode, 1);
    assert.match(planned.reason, /not implemented/);
    assert.deepEqual(calls, []);
    const { overrides, mints, jwts, tempDirs } = deferredHarness(async () => assert.fail('op must not run'));
    const applied = await apply(dispatchEnv({ INPUT_TARGET_REPO: op === 'script' ? TARGET : '', ...env }), { ...overrides, registry: REGISTRY });
    assert.equal(applied.exitCode, 1);
    assert.match(applied.reason, /not implemented/);
    assert.deepEqual([mints.length, jwts.length, tempDirs.length], [0, 0, 0]);
  });
}

test('apply: a deferred op mints nothing before run and gets no client, token or target settings', async () => {
  let seen;
  const { overrides, mints, configRoots, jwts } = deferredHarness(async (ctx) => {
    seen = { client: ctx.client, token: ctx.token, settingsRoot: ctx.settingsRoot, mintsAtRun: mints.length, jwtsAtRun: jwts.length };
    return stopHere;
  });
  await apply(dispatchEnv(BOOTSTRAP_ENV), overrides);
  assert.deepEqual(seen, { client: null, token: null, settingsRoot: CONTROL_ROOT, mintsAtRun: 0, jwtsAtRun: 0 });
  assert.equal(configRoots[0], CONTROL_ROOT);
});

test('withToken: every accepted grant signs a fresh JWT, mints exactly the request, masks and revokes', async () => {
  const grants = [targetGrant, controlRead, createGrant];
  const values = [];
  const { overrides, mints, jwts, events, stdout } = deferredHarness(async (ctx) => {
    for (const grant of grants) values.push(await ctx.withToken(grant, async ({ client, token }) => (client ? token : null)));
    return stopHere;
  });
  await apply(dispatchEnv(BOOTSTRAP_ENV), overrides);
  assert.deepEqual(values, grants.map(() => TOKEN), 'resolves to the callback value');
  assert.equal(new Set(jwts).size, grants.length);
  assert.deepEqual(mints.map(({ repositories, permissions }) => ({ repositories, permissions })), grants);
  assert.deepEqual(nonStdout(events), grants.flatMap(() => ['mint', 'revoke']));
  assert.ok(stdout.includes(`::add-mask::${TOKEN}\n`));
  assert.ok(stdout.includes(`::add-mask::${jwts[0]}\n`));
  assert.ok(events.indexOf(`stdout:::add-mask::${TOKEN}`) < events.indexOf('revoke'));
});

test('withToken: a callback error is rethrown after the revoke', async () => {
  let thrown;
  const { overrides, events } = deferredHarness(async (ctx) => {
    await ctx.withToken(controlRead, async () => { throw new Error('callback failed'); }).catch((error) => { thrown = error.message; });
    return stopHere;
  });
  await apply(dispatchEnv(BOOTSTRAP_ENV), overrides);
  assert.equal(thrown, 'callback failed');
  assert.deepEqual(nonStdout(events), ['mint', 'revoke']);
});

test('withToken: a failed mint runs no callback and revokes nothing', async () => {
  const outcomes = [];
  const { overrides, events } = deferredHarness(async (ctx) => {
    await ctx.withToken(controlRead, async () => outcomes.push('callback')).catch((error) => outcomes.push(error.message));
    return stopHere;
  }, { mintFails: 'mint refused' });
  await apply(dispatchEnv(BOOTSTRAP_ENV), overrides);
  assert.deepEqual(outcomes, ['mint refused']);
  assert.ok(!events.includes('revoke'));
});

test('plan and apply: bootstrap refuses the control repository as target before any mint', async () => {
  const overrides = { ...BOOTSTRAP_ENV, INPUT_TARGET_REPO: 'Groundwork' };
  const planned = await plan(dispatchEnv(overrides), { ...planOverrides({}), registry: REGISTRY });
  assert.equal(planned.exitCode, 1);
  assert.match(planned.reason, /control repository/);
  const { overrides: deps, mints, jwts } = deferredHarness(async () => assert.fail('op must not run'));
  const applied = await apply(dispatchEnv(overrides), { ...deps, registry: REGISTRY });
  assert.equal(applied.exitCode, 1);
  assert.match(applied.reason, /control repository/);
  assert.deepEqual([mints.length, jwts.length], [0, 0]);
});

const PASS2 = REGISTRY['bootstrap-pass2'];

test('plan: bootstrap-pass2 may target the control repository and the summary says so', async () => {
  for (const targetRepo of [CONTROL_REPO, 'Groundwork']) {
    const result = await plan(dispatchEnv({ INPUT_OP: 'bootstrap-pass2', INPUT_TARGET_REPO: targetRepo }), { ...planOverrides({}), registry: REGISTRY });
    assert.equal(result.exitCode, 0, result.reason);
    assert.ok(result.summary.includes(`- Target: \`${ORG}/${CONTROL_REPO}\` (the control repository)`), result.summary);
    assert.match(result.summary, new RegExp(`- Token: restricted to \`${CONTROL_REPO}\``));
    for (const [name, level] of Object.entries(PASS2.PERMISSIONS)) assert.ok(result.summary.includes(`| ${name} | ${level} |`), name);
  }
  const other = await plan(dispatchEnv({ INPUT_OP: 'bootstrap-pass2' }), { ...planOverrides({}), registry: REGISTRY });
  assert.doesNotMatch(other.summary, /control repository/);
});

test('apply: bootstrap-pass2 on the control repository mints once, restricted to it, with the op permissions', async () => {
  const onControl = (routes) => Object.fromEntries(Object.entries(routes).map(([key, value]) => [key.replace(`/repos/${ORG}/${TARGET}`, `/repos/${ORG}/${CONTROL_REPO}`), value]));
  for (const targetRepo of [CONTROL_REPO, 'Groundwork']) {
    const seen = [];
    const run = (name) => async () => { seen.push(name); return { ok: true, summary: `${name} done` }; };
    const { overrides, mints } = harness({ registry: stubRegistry({ 'bootstrap-pass2': run('pass2'), check: run('check') }), routes: onControl(withTokenRoutes()) });
    const result = await apply(dispatchEnv({ INPUT_OP: 'bootstrap-pass2', INPUT_TARGET_REPO: targetRepo }), overrides);
    assert.equal(result.exitCode, 0, result.reason);
    assert.deepEqual(seen, ['pass2', 'check']);
    assert.equal(mints.length, 1, targetRepo);
    assert.deepEqual(mints[0].repositories, [CONTROL_REPO], targetRepo);
    assert.deepEqual(mints[0].permissions, PASS2.PERMISSIONS);
    assert.match(result.summary, /\(the control repository\)/);
    assert.match(result.summary, new RegExp(`git/trees/${HEAD}\` \\| 200`));
  }
});

test('withToken: a failed revoke fails the run even when the op swallows the outcome', async () => {
  const routes = { ...settingsRoutes(HEAD), 'DELETE /installation/token': { status: 500, data: { message: 'down' } } };
  const { overrides } = deferredHarness(async (ctx) => {
    await ctx.withToken(controlRead, async () => 1);
    return { ok: true, summary: 'op passed' };
  }, { routes });
  const result = await apply(dispatchEnv(BOOTSTRAP_ENV), overrides);
  assert.equal(result.exitCode, 1);
  assert.match(result.summary, /token revocation failed/);
});

test('withToken: the op never sees ADMIN_APP_KEY or a JWT', async () => {
  let readable;
  const { overrides, jwts } = deferredHarness(async (ctx) => {
    readable = JSON.stringify({ env: ctx.env, ctx, callbackArgument: await ctx.withToken(targetGrant, async (argument) => argument) });
    return stopHere;
  });
  await apply(dispatchEnv(BOOTSTRAP_ENV), overrides);
  assert.ok(!readable.includes('PRIVATE-KEY-MATERIAL'));
  assert.ok(!readable.includes(jwts[0]));
  assert.ok(readable.includes(TOKEN), 'the callback gets its own installation token');
});

const refusals = [
  ['permission above the op on the target', { repositories: [TARGET], permissions: { members: 'write' } }],
  ['permission the op lacks on the target', { repositories: [TARGET], permissions: { pages: 'read' } }],
  ['no permissions on the target', { repositories: [TARGET], permissions: {} }],
  ['control read plus an extra key', { repositories: [CONTROL_REPO], permissions: { contents: 'read', issues: 'read' } }],
  ['control read at write level', { repositories: [CONTROL_REPO], permissions: { contents: 'write' } }],
  ['create permissions on another repository', { repositories: ['other'], permissions: BOOTSTRAP.CREATE_PERMISSIONS }],
  ['create permissions plus an extra key', { repositories: [CONTROL_REPO], permissions: { administration: 'write', contents: 'read' } }],
  ['all with the create permissions', { repositories: 'all', permissions: BOOTSTRAP.CREATE_PERMISSIONS }],
  ['all with control read', { repositories: 'all', permissions: BOOTSTRAP.CONTROL_READ_PERMISSIONS }],
  ['all with the op permissions', { repositories: 'all', permissions: BOOTSTRAP.PERMISSIONS }],
  ['an undeclared key with an undefined value', { repositories: [CONTROL_REPO], permissions: { foo: undefined } }],
  ['no request', undefined],
];

test('withToken: every undeclared grant is refused before any mint', async () => {
  const messages = [];
  const { overrides, mints, jwts } = deferredHarness(async (ctx) => {
    for (const [label, request] of refusals) {
      await ctx.withToken(request, async () => assert.fail(label)).catch((error) => messages.push([label, error.message]));
    }
    return stopHere;
  });
  await apply(dispatchEnv(BOOTSTRAP_ENV), overrides);
  assert.equal(messages.length, refusals.length);
  for (const [label, message] of messages) assert.match(message, /^withToken refused/, label);
  assert.equal(mints.length, 0);
  assert.equal(jwts.length, 0);
});

test('withToken: the request is copied at call time, later mutation never reaches the mint', async () => {
  const { overrides, mints } = deferredHarness(async (ctx) => {
    const request = { repositories: [TARGET], permissions: { contents: 'read' } };
    const pending = ctx.withToken(request, async () => 1);
    request.permissions.secrets = 'write';
    request.repositories[0] = CONTROL_REPO;
    await pending;
    const swapped = { repositories: [TARGET], permissions: { ...BOOTSTRAP.PERMISSIONS } };
    const second = ctx.withToken(swapped, async () => 1);
    swapped.repositories[0] = CONTROL_REPO;
    await second;
    return stopHere;
  });
  await apply(dispatchEnv(BOOTSTRAP_ENV), overrides);
  assert.deepEqual(mints.map(({ repositories, permissions }) => ({ repositories, permissions })), [
    { repositories: [TARGET], permissions: { contents: 'read' } },
    { repositories: [TARGET], permissions: BOOTSTRAP.PERMISSIONS },
  ]);
});

test('withToken: a nested call is refused and the outer token is still revoked', async () => {
  let nested;
  const { overrides, mints, events } = deferredHarness(async (ctx) => {
    await ctx.withToken(controlRead, () => ctx.withToken(controlRead, async () => 1)).catch((error) => { nested = error.message; });
    return stopHere;
  });
  await apply(dispatchEnv(BOOTSTRAP_ENV), overrides);
  assert.equal(nested, 'withToken calls do not nest');
  assert.equal(mints.length, 1);
  assert.deepEqual(nonStdout(events), ['mint', 'revoke']);
});

test('withToken: ops with a token up front cannot mint another', async () => {
  let message;
  const check = async (ctx) => {
    await ctx.withToken(targetGrant, async () => 1).catch((error) => { message = error.message; });
    return { ok: true, summary: 'ok' };
  };
  const { overrides, mints } = harness({ registry: stubRegistry({ check }), routes: withTokenRoutes() });
  await apply(dispatchEnv(), overrides);
  assert.match(message, /^withToken refused/);
  assert.equal(mints.length, 1, 'only the up-front mint');
});

test('apply: after a passing deferred op, check runs with its own token against the target main head', async () => {
  let checkCtx;
  const { overrides, mints, events, tempDirs } = deferredHarness(async () => ({ ok: true, summary: 'bootstrapped' }), {
    checkRun: async (ctx) => { checkCtx = ctx; return { ok: true, summary: 'verified' }; },
  });
  const result = await apply(dispatchEnv(BOOTSTRAP_ENV), overrides);
  assert.equal(result.exitCode, 0, result.reason);
  assert.deepEqual(mints.map(({ repositories, permissions }) => ({ repositories, permissions })), [{ repositories: [TARGET], permissions: REGISTRY.check.PERMISSIONS }]);
  assert.deepEqual(nonStdout(events), ['mint', 'revoke']);
  assert.equal(checkCtx.repo, TARGET);
  assert.equal(checkCtx.token, TOKEN);
  assert.ok(checkCtx.settingsRoot.startsWith(tempDirs[0]));
  assert.match(result.summary, new RegExp(`git/trees/${HEAD}\` \\| 200`));
  assert.ok(result.summary.includes(`git/ref/heads/main`) && !result.summary.includes('/branches/'), 'settings come from the main ref, not the default branch');
  assert.ok(result.summary.indexOf('bootstrapped') < result.summary.indexOf('verified'));
});

test('AC7 the check token after a deferred op carries administration write', async () => {
  const { overrides, mints } = deferredHarness(async () => ({ ok: true, summary: 'bootstrapped' }));
  const result = await apply(dispatchEnv(BOOTSTRAP_ENV), overrides);
  assert.equal(result.exitCode, 0, result.reason);
  assert.equal(mints[0].permissions.administration, 'write');
});

test('AC9 writeSummary with GITHUB_STEP_SUMMARY set writes the file and wraps the same text in a stdout group', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'admin-run-summary-'));
  const file = path.join(directory, 'summary.md');
  const printed = [];
  await writeSummary({ GITHUB_STEP_SUMMARY: file }, '## admin-run apply', (text) => printed.push(text));
  assert.equal(await readFile(file, 'utf8'), '## admin-run apply\n');
  assert.equal(printed.join(''), '::group::admin-run summary\n## admin-run apply\n::endgroup::\n');
  await rm(directory, { recursive: true, force: true });
});

test('AC9 writeSummary without GITHUB_STEP_SUMMARY prints the plain text once', async () => {
  const printed = [];
  await writeSummary({}, '## admin-run apply', (text) => printed.push(text));
  assert.equal(printed.join(''), '## admin-run apply\n');
});

test('apply: a failing trailing check fails the run, a failing op skips it, both revoke', async () => {
  const passed = async () => ({ ok: true, summary: 'bootstrapped' });
  const failing = deferredHarness(passed, { checkRun: async () => ({ ok: false, summary: 'one row differs' }) });
  const failed = await apply(dispatchEnv(BOOTSTRAP_ENV), failing.overrides);
  assert.equal(failed.exitCode, 1);
  assert.match(failed.summary, /one row differs/);
  assert.ok(failing.events.includes('revoke'));
  const skipping = deferredHarness(async () => stopHere, { checkRun: async () => assert.fail('check must not run') });
  assert.equal((await apply(dispatchEnv(BOOTSTRAP_ENV), skipping.overrides)).exitCode, 1);
  assert.equal(skipping.mints.length, 0);
});

test('apply: bootstrap-pass2 mints for the target and ends with check on the target main head', async () => {
  const seen = [];
  const run = (name) => async () => { seen.push(name); return { ok: true, summary: `${name} done` }; };
  const { overrides, mints } = harness({ registry: stubRegistry({ 'bootstrap-pass2': run('pass2'), check: run('check') }), routes: withTokenRoutes() });
  const result = await apply(dispatchEnv({ INPUT_OP: 'bootstrap-pass2' }), overrides);
  assert.equal(result.exitCode, 0, result.reason);
  assert.deepEqual(seen, ['pass2', 'check']);
  assert.deepEqual(mints.map(({ repositories }) => repositories), [[TARGET]]);
  assert.match(result.summary, new RegExp(`git/trees/${HEAD}\` \\| 200`));
  assert.ok(!result.summary.includes('/branches/'));
});

test('apply: ctx.writeSettings writes under the temp directory, loads config from it, and the directory is removed', async () => {
  let written;
  let rejected = 0;
  const { overrides, tempDirs } = deferredHarness(async (ctx) => {
    written = await ctx.writeSettings({ '.github/groundwork/config.json': '{"a":1}', '.github/groundwork/rulesets/main.json': '{}' });
    written.files = await listFiles(written.settingsRoot);
    for (const key of ['config.json', '.github/groundwork/../x.json', '.github/groundwork/a\\b.json']) {
      await ctx.writeSettings({ [key]: '{}' }).catch(() => { rejected += 1; });
    }
    return stopHere;
  });
  await apply(dispatchEnv(BOOTSTRAP_ENV), overrides);
  assert.deepEqual(written.files, ['.github/groundwork/config.json', '.github/groundwork/rulesets/main.json']);
  assert.deepEqual([written.settingsRoot, written.config.root, rejected], [tempDirs[0], tempDirs[0], 3]);
  assert.ok(!existsSync(tempDirs[0]));
});

test('plan: a deferred op lists every mintable grant', async () => {
  const result = await plan(dispatchEnv(BOOTSTRAP_ENV), { ...planOverrides({}), registry: REGISTRY });
  assert.equal(result.exitCode, 0, result.reason);
  assert.match(result.summary, /create call on `groundwork`/);
  assert.match(result.summary, /control repository `groundwork` read/);
  assert.equal(result.summary.match(/Token grant,/g).length, 3, 'target, create on the control repository, control read');
  assert.doesNotMatch(result.summary, /installation-wide|\ball\b/i);
  const { PERMISSIONS, CREATE_PERMISSIONS, CONTROL_READ_PERMISSIONS } = BOOTSTRAP;
  for (const [name, level] of [PERMISSIONS, CREATE_PERMISSIONS, CONTROL_READ_PERMISSIONS].flatMap(Object.entries)) {
    assert.ok(result.summary.includes(`| ${name} | ${level} |`), name);
  }
});

test('selftestRepoName builds selftest-<run id> from digits only', () => {
  assert.equal(REGISTRY.selftest.selftestRepoName({ GITHUB_RUN_ID: '4242' }), 'selftest-4242');
  for (const runId of [undefined, '', '12a', '../1']) {
    assert.throws(() => REGISTRY.selftest.selftestRepoName({ GITHUB_RUN_ID: runId }), { name: 'GitHubError' });
  }
});

test('skeleton ops export an empty grant list and refuse every script file', () => {
  assert.deepEqual(REGISTRY.script.grants({}), []);
  assert.deepEqual(REGISTRY.selftest.grants({}), []);
  assert.throws(() => REGISTRY.script.parseScript('export const permissions = {};'), { message: 'not implemented' });
});

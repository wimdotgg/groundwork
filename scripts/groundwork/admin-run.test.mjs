import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFixtureClient } from '../lib/github.mjs';
import { repoRoot } from '../lib/config.mjs';
import { REGISTRY, apply, materialiseSettings, plan, validateRequest } from './admin-run.mjs';
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
const stubConfig = ({ root }) => ({ org: ORG, root });

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

const inputs = (overrides = {}) => ({ op: 'check', targetRepo: TARGET, ref: '', argsText: '{}', ...overrides });

/** Real contract values (scope, permissions, validateArgs) with a stubbed run. */
function stubRegistry(runs = {}) {
  return Object.fromEntries(Object.entries(REGISTRY).map(([name, module]) => [name, {
    OP: module.OP,
    TOKEN_SCOPE: module.TOKEN_SCOPE,
    PERMISSIONS: module.PERMISSIONS,
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
    ['unknown op', inputs({ op: 'bootstrap' })],
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
  for (const name of ['INPUT_OP', 'INPUT_TARGET_REPO', 'INPUT_REF', 'INPUT_ARGS']) {
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

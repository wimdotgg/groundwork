import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubError, createFixtureClient } from '../lib/github.mjs';
import { PROBE_IDS } from './selftest-probes.mjs';
import { CONTROL_READ_PERMISSIONS, CREATE_PERMISSIONS, PERMISSIONS, grants, run as runSelftest } from './selftest.mjs';

const ORG = 'acme';
const CONTROL = 'groundwork';
const RUN_ID = '4242';
const REPO = `selftest-${RUN_ID}`;
const archivePath = `/repos/${ORG}/${REPO}`;

const run = (ctx, seams) => runSelftest(ctx, { inspect: async () => 'absent', ...seams });
const passingProbes =async () => PROBE_IDS.map((id) => ({ id, name: id, ok: true, detail: 'fine' }));

/** `withToken` records every request and hands the callback a fixture client that records each call. */
function harness({ archiveStatus = 200, mintFails = false, checkResult = { ok: true, summary: 'check summary' } } = {}) {
  const requests = [];
  const calls = [];
  const events = [];
  const ctx = {
    org: ORG,
    repo: REPO,
    env: { GITHUB_RUN_ID: RUN_ID, KEEP: 'yes' },
    config: { controlRepo: CONTROL, apps: { admin: 'admin-app' } },
    log: () => {},
    runCheck: async () => {
      events.push('check');
      return checkResult;
    },
    withToken: async (request, callback) => {
      requests.push(request);
      if (mintFails && request.repositories[0] === REPO) throw new GitHubError('mint failed');
      const client = createFixtureClient({ [`PATCH ${archivePath}`]: { status: archiveStatus, data: {} } }, { onCall: (call) => { calls.push(call); events.push(`${call.method} ${call.path}`); } });
      return callback({ client, token: 'ghs_token' });
    },
  };
  return { ctx, requests, calls, events };
}

const rowsOf = (summary) => summary.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Step')).map((line) => line.split(' | ')[0].slice(2));
const succeedingBootstrap = async () => ({ ok: true, summary: 'bootstrapped' });

test('AC1 grants: control read and create exact, the throwaway repository subset, nothing else', () => {
  assert.deepEqual(grants({ env: { GITHUB_RUN_ID: RUN_ID }, controlRepo: CONTROL, targetRepo: 'other-repo' }), [
    { repositories: [CONTROL], permissions: CONTROL_READ_PERMISSIONS, match: 'exact' },
    { repositories: [CONTROL], permissions: CREATE_PERMISSIONS, match: 'exact' },
    { repositories: [REPO], permissions: PERMISSIONS, match: 'subset' },
  ]);
  assert.throws(() => grants({ env: { GITHUB_RUN_ID: 'abc' }, controlRepo: CONTROL }), { name: 'GitHubError' });
});

test('AC1 run: bootstrap gets the repository and the run-id description, and every mint is a declared grant on the throwaway repository', async () => {
  const { ctx, requests } = harness();
  let seen;
  const result = await run(ctx, {
    runBootstrap: async (bootstrapCtx) => { seen = bootstrapCtx; return { ok: true, summary: 'bootstrapped' }; },
    probes: async (probeContext) => { seen = { ...seen, probeContext }; return passingProbes(); },
  });
  assert.equal(result.ok, true, result.summary);
  assert.equal(seen.repo, REPO);
  assert.deepEqual(JSON.parse(seen.env.INPUT_ARGS), { description: `groundwork selftest ${RUN_ID}` });
  assert.equal(seen.env.KEEP, 'yes');
  assert.deepEqual(seen.probeContext, { client: seen.probeContext.client, org: ORG, repo: REPO, log: ctx.log });
  const declared = grants({ env: ctx.env, controlRepo: CONTROL });
  assert.deepEqual(requests, [
    { repositories: [CONTROL], permissions: CONTROL_READ_PERMISSIONS },
    { repositories: [REPO], permissions: PERMISSIONS },
    { repositories: [REPO], permissions: PERMISSIONS },
  ]);
  for (const request of requests) {
    assert.ok(declared.some((grant) => grant.repositories[0] === request.repositories[0] && grant.permissions === request.permissions));
  }
});

test('AC1 run: refuses a repository other than selftest-<run id>, or the control repository, before any mint or step', async () => {
  for (const mutate of [{ repo: 'proj' }, { repo: CONTROL }, { repo: 'selftest-1' }, { config: { controlRepo: REPO.toUpperCase() } }]) {
    const { ctx, requests } = harness();
    await assert.rejects(run({ ...ctx, ...mutate }, { runBootstrap: async () => assert.fail('no step runs'), probes: async () => assert.fail('no probe runs') }), { name: 'GitHubError' });
    assert.deepEqual(requests, []);
  }
  const { ctx } = harness();
  await assert.rejects(run({ ...ctx, env: { GITHUB_RUN_ID: 'abc' } }), { name: 'GitHubError' });
});

test('AC2 run: the archive runs after a failing check and the run fails', async () => {
  const { ctx, calls, events } = harness({ checkResult: { ok: false, summary: 'one row differs' } });
  const result = await run(ctx, { runBootstrap: succeedingBootstrap, probes: passingProbes });
  assert.equal(result.ok, false);
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [`PATCH ${archivePath}`]);
  assert.deepEqual(events, ['check', `PATCH ${archivePath}`]);
  assert.match(result.summary, /\| check \| fail \|/);
  assert.match(result.summary, /one row differs/);
  assert.match(result.summary, /\| archive \| pass \|/);
});

test('AC2 run: the archive runs after a failing or throwing probe and the run fails', async () => {
  const failingRow = async () => [{ id: 'V3', name: 'V3', ok: false, detail: 'second create returned 201' }];
  for (const probes of [failingRow, async () => { throw new GitHubError('probe crashed'); }]) {
    const { ctx, calls } = harness();
    const result = await run(ctx, { runBootstrap: succeedingBootstrap, probes });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 1);
    assert.match(result.summary, /\| archive \| pass \|/);
  }
});

test('AC2 run: a failing bootstrap skips check and probes, still archives and fails', async () => {
  const { ctx, calls, events } = harness();
  const result = await run(ctx, {
    runBootstrap: async () => { throw new GitHubError('release tree unreadable'); },
    probes: async () => assert.fail('probes must not run'),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(events, [`PATCH ${archivePath}`]);
  assert.equal(calls.length, 1);
  assert.match(result.summary, /\| bootstrap \| fail \| release tree unreadable \|/);
  assert.match(result.summary, /\| check \| fail \| skipped: bootstrap failed \|/);
});

test('AC3 run: one table lists bootstrap, check, every probe and archive in order', async () => {
  const { ctx } = harness();
  const result = await run(ctx, { runBootstrap: succeedingBootstrap, probes: passingProbes });
  assert.equal(result.ok, true);
  assert.deepEqual(rowsOf(result.summary), ['bootstrap', 'check', ...PROBE_IDS, 'archive']);
  assert.equal(result.summary.match(/^\| Step /gm).length, 1);
  assert.match(result.summary, /Result: \*\*pass\*\*/);
});

test('AC3 run: a failed archive fails the run, whether the call is rejected or the mint fails', async () => {
  const rejected = harness({ archiveStatus: 403 });
  const rejectedResult = await run(rejected.ctx, { runBootstrap: succeedingBootstrap, probes: passingProbes });
  assert.equal(rejectedResult.ok, false);
  assert.match(rejectedResult.summary, /\| archive \| fail \|/);
  const unminted = harness({ mintFails: true });
  const unmintedResult = await run(unminted.ctx, { runBootstrap: succeedingBootstrap, probes: passingProbes });
  assert.equal(unmintedResult.ok, false);
  assert.match(unmintedResult.summary, /\| archive \| fail \| mint failed \|/);
});

test('AC3 run: a table cell carries no pipe, line break, backtick, tag or unbounded text from a detail', async () => {
  const { ctx } = harness();
  const hostile = async () => [{ id: 'V3', name: 'V3', ok: false, detail: 'a | b\nc `x` <details>é' }, { id: 'V11', name: 'V11', ok: false, detail: 'z'.repeat(5000) }];
  const result = await run(ctx, { runBootstrap: succeedingBootstrap, probes: hostile });
  assert.match(result.summary, /\| V3 \| fail \| a ' b c 'x' 'details' \|/);
  const longRow = result.summary.split('\n').find((line) => line.startsWith('| V11 '));
  assert.ok(longRow.length < 300, String(longRow.length));
});

test('R3 run: a step that throws undefined or null still archives', async () => {
  for (const thrown of [undefined, null]) {
    const { ctx, calls } = harness();
    const result = await run(ctx, { runBootstrap: async () => { throw thrown; }, probes: passingProbes });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 1, String(thrown));
    assert.match(result.summary, new RegExp(`\\| bootstrap \\| fail \\| ${thrown} \\|`));
  }
});

test('R1 run: a repository bootstrap would refuse as foreign is never archived, and the archive row says why', async () => {
  const { ctx, calls, requests } = harness();
  const result = await run(ctx, {
    inspect: async () => 'foreign',
    runBootstrap: async () => assert.fail('bootstrap must not run'),
    probes: async () => assert.fail('probes must not run'),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(calls, [], 'no PATCH or any other call');
  assert.deepEqual(requests, [{ repositories: [CONTROL], permissions: CONTROL_READ_PERMISSIONS }]);
  assert.match(result.summary, /\| archive \| fail \| not archived: selftest-4242 exists and was not created by this kit \|/);
});

test('R1 run: an unreadable repository state is refused and never archived', async () => {
  const { ctx, calls } = harness();
  const result = await run(ctx, { inspect: async () => { throw new GitHubError('boom'); }, runBootstrap: async () => assert.fail('no'), probes: passingProbes });
  assert.equal(result.ok, false);
  assert.deepEqual(calls, []);
  assert.match(result.summary, /\| archive \| fail \| not archived: repository state unreadable: boom \|/);
});

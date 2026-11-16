import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_DIR, repoRoot } from './config.mjs';
import { createFixtureClient, GitHubError } from './github.mjs';
import { applyActions, renderSummary, runValidator } from './ci.mjs';

const realRoot = repoRoot(import.meta.url);
const REPO = { owner: 'acme', repo: 'widgets' };
const BOT = { login: 'github-actions[bot]' };

async function withFixture(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ci-test-'));
  try {
    await mkdir(path.join(dir, 'scripts', 'ci'), { recursive: true });
    await mkdir(path.join(dir, CONFIG_DIR), { recursive: true });
    await copyFile(path.join(realRoot, CONFIG_DIR, 'config.json'), path.join(dir, CONFIG_DIR, 'config.json'));
    const payloadPath = path.join(dir, 'payload.json');
    await writeFile(payloadPath, JSON.stringify({ marker: 'from-env' }));
    const otherPayloadPath = path.join(dir, 'other.json');
    await writeFile(otherPayloadPath, JSON.stringify({ marker: 'from-argv' }));
    await run({
      dir,
      payloadPath,
      otherPayloadPath,
      summaryPath: path.join(dir, 'summary.md'),
      scriptUrl: pathToFileURL(path.join(dir, 'scripts', 'ci', 'x.mjs')).href,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function result(conclusion, extra = {}) {
  return { conclusion, errors: [], warnings: [], details: '', actions: [], ...extra };
}

function validatorReturning(outcome, extra = {}) {
  return { name: 'demo', collect: async () => ({}), evaluate: () => outcome, ...extra };
}

function baseEnv(fixture, extra = {}) {
  return {
    GITHUB_EVENT_PATH: fixture.payloadPath,
    GITHUB_EVENT_NAME: 'issues',
    GITHUB_REPOSITORY: 'acme/widgets',
    GITHUB_STEP_SUMMARY: fixture.summaryPath,
    ...extra,
  };
}

async function run(validator, fixture, { env = baseEnv(fixture), argv = ['node', 'x'], ...rest } = {}) {
  return runValidator(validator, {
    argv,
    env,
    scriptUrl: fixture.scriptUrl,
    createClient: () => createFixtureClient({}),
    setExitCode: false,
    ...rest,
  });
}

test('exit codes: pass and skip are 0, fail is 1, thrown error is 2', async () => {
  await withFixture(async (fixture) => {
    assert.equal(await run(validatorReturning(result('pass')), fixture), 0);
    assert.equal(await run(validatorReturning(result('skip')), fixture), 0);
    assert.equal(await run(validatorReturning(result('fail', { errors: ['bad'] })), fixture), 1);
    const throwing = validatorReturning(null, { collect: async () => { throw new GitHubError('boom\nsecond line'); } });
    assert.equal(await run(throwing, fixture), 2);
    const summary = await readFile(fixture.summaryPath, 'utf8');
    assert.match(summary, /boom second line/);
  });
});

test('exit 2 when evaluate throws, the payload is unreadable, or no payload path exists', async () => {
  await withFixture(async (fixture) => {
    const evaluateThrows = validatorReturning(null, { evaluate: () => { throw new Error('bad evaluate'); } });
    assert.equal(await run(evaluateThrows, fixture), 2);
    assert.equal(await run(validatorReturning(result('pass')), fixture, { env: baseEnv(fixture, { GITHUB_EVENT_PATH: path.join(fixture.dir, 'missing.json') }) }), 2);
    assert.equal(await run(validatorReturning(result('pass')), fixture, { env: baseEnv(fixture, { GITHUB_EVENT_PATH: undefined }) }), 2);
  });
});

test('sets process.exitCode by default', async () => {
  await withFixture(async (fixture) => {
    const previous = process.exitCode;
    try {
      await run(validatorReturning(result('fail')), fixture, { setExitCode: true });
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = previous;
    }
  });
});

test('needsClient false builds no client and tolerates an empty GITHUB_TOKEN', async () => {
  await withFixture(async (fixture) => {
    let contextClient = 'unset';
    let built = 0;
    const validator = validatorReturning(result('pass'), {
      needsClient: false,
      collect: async (ctx) => { contextClient = ctx.client; return {}; },
    });
    const env = baseEnv(fixture, { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: '' });
    assert.equal(await runValidator(validator, { argv: [], env, scriptUrl: fixture.scriptUrl, createClient: () => { built += 1; }, setExitCode: false }), 0);
    assert.equal(contextClient, undefined);
    assert.equal(built, 0);
    assert.equal(await runValidator(validator, { argv: [], env, scriptUrl: fixture.scriptUrl, setExitCode: false }), 0);
  });
});

test('a validator that needs a client gets one, and an empty token is exit 2', async () => {
  await withFixture(async (fixture) => {
    const client = createFixtureClient({});
    let seen;
    const validator = validatorReturning(result('pass'), { collect: async (ctx) => { seen = ctx; return {}; } });
    await run(validator, fixture, { createClient: () => client });
    assert.equal(seen.client, client);
    assert.deepEqual(seen.repo, REPO);
    assert.equal(seen.eventName, 'issues');
    assert.equal(seen.root, path.resolve(fixture.dir));
    assert.equal(typeof seen.config.org, 'string');
    const env = baseEnv(fixture, { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: '' });
    const code = await runValidator(validator, { argv: [], env, scriptUrl: fixture.scriptUrl, setExitCode: false });
    assert.equal(code, 2);
  });
});

test('summary is appended to the file, or written to stdout when GITHUB_STEP_SUMMARY is unset', async () => {
  await withFixture(async (fixture) => {
    await writeFile(fixture.summaryPath, 'existing\n');
    await run(validatorReturning(result('pass')), fixture);
    const text = await readFile(fixture.summaryPath, 'utf8');
    assert.ok(text.startsWith('existing\n'));
    assert.match(text, /## demo/);

    let printed = '';
    const env = baseEnv(fixture, { GITHUB_STEP_SUMMARY: undefined });
    await run(validatorReturning(result('pass')), fixture, { env, stdout: (value) => { printed += value; } });
    assert.match(printed, /## demo/);
    assert.match(printed, /\*\*pass\*\*/);
  });
});

test('payload comes from argv[2] first, else GITHUB_EVENT_PATH', async () => {
  await withFixture(async (fixture) => {
    const payloads = [];
    const validator = validatorReturning(result('pass'), { collect: async (ctx) => { payloads.push(ctx.payload.marker); return {}; } });
    await run(validator, fixture, { argv: ['node', 'x', fixture.otherPayloadPath] });
    await run(validator, fixture);
    assert.deepEqual(payloads, ['from-argv', 'from-env']);
  });
});

test('actions run after evaluate and failures give exit 2', async () => {
  await withFixture(async (fixture) => {
    const calls = [];
    const routes = { 'POST /repos/acme/widgets/issues/7/labels': { status: 200, data: [] } };
    const validator = validatorReturning(result('pass', { actions: [{ kind: 'add-label', number: 7, label: 'x' }] }));
    const createClient = () => createFixtureClient(routes, { onCall: (record) => calls.push(`${record.method} ${record.path}`) });
    assert.equal(await run(validator, fixture, { createClient }), 0);
    assert.deepEqual(calls, ['POST /repos/acme/widgets/issues/7/labels']);
    const failing = validatorReturning(result('pass', { actions: [{ kind: 'comment', number: 7, body: 'hi' }] }));
    assert.equal(await run(failing, fixture, { createClient }), 2);
  });
});

function recorder(routes) {
  const calls = [];
  const bodies = [];
  const base = createFixtureClient(routes, { onCall: (record) => calls.push(`${record.method} ${record.path}`) });
  const client = {
    ...base,
    request: (method, requestPath, options) => {
      if (options?.body) bodies.push(options.body);
      return base.request(method, requestPath, options);
    },
  };
  return { client, calls, bodies };
}

test('add-label and remove-label; remove-label tolerates 404 but not other errors', async () => {
  const { client, calls, bodies } = recorder({
    'POST /repos/acme/widgets/issues/3/labels': { status: 200, data: [] },
    'DELETE /repos/acme/widgets/issues/3/labels/needs%20format': { status: 200, data: [] },
    'DELETE /repos/acme/widgets/issues/3/labels/gone': { status: 404, data: { message: 'Label does not exist' } },
    'DELETE /repos/acme/widgets/issues/3/labels/denied': { status: 403, data: { message: 'no' } },
  });
  await applyActions([
    { kind: 'add-label', number: 3, label: 'bug' },
    { kind: 'remove-label', number: 3, label: 'needs format' },
    { kind: 'remove-label', number: 3, label: 'gone' },
  ], { client, repo: REPO });
  assert.deepEqual(bodies, [{ labels: ['bug'] }]);
  assert.equal(calls[1], 'DELETE /repos/acme/widgets/issues/3/labels/needs%20format');
  assert.equal(calls.length, 3);
  await assert.rejects(applyActions([{ kind: 'remove-label', number: 3, label: 'denied' }], { client, repo: REPO }), GitHubError);
});

test('comment and create-issue post to the issues API', async () => {
  const { client, calls, bodies } = recorder({
    'POST /repos/acme/widgets/issues/4/comments': { status: 201, data: {} },
    'POST /repos/acme/widgets/issues': { status: 201, data: {} },
  });
  await applyActions([
    { kind: 'comment', number: 4, body: 'hello' },
    { kind: 'create-issue', title: 'T', body: 'B' },
  ], { client, repo: REPO });
  assert.deepEqual(calls, ['POST /repos/acme/widgets/issues/4/comments', 'POST /repos/acme/widgets/issues']);
  assert.deepEqual(bodies, [{ body: 'hello' }, { title: 'T', body: 'B' }]);
});

test('upsert-comment edits the newest bot comment carrying the marker', async () => {
  const marked = (id, login, extra = '') => ({ id, user: { login }, body: `text${extra}\n\n<!-- groundwork:fmt -->\n` });
  const { client, calls, bodies } = recorder({
    'GET /repos/acme/widgets/issues/5/comments?per_page=100': {
      status: 200,
      data: [marked(1, 'github-actions[bot]'), marked(2, 'someone'), marked(3, 'github-actions[bot]'), { id: 4, user: BOT, body: 'no marker' }],
    },
    'PATCH /repos/acme/widgets/issues/comments/3': { status: 200, data: {} },
  });
  await applyActions([{ kind: 'upsert-comment', number: 5, marker: 'fmt', body: 'new text' }], { client, repo: REPO });
  assert.equal(calls[1], 'PATCH /repos/acme/widgets/issues/comments/3');
  assert.equal(bodies[0].body, 'new text\n\n<!-- groundwork:fmt -->\n');
});

test('upsert-comment creates a comment when no bot comment has the marker', async () => {
  const { client, calls, bodies } = recorder({
    'GET /repos/acme/widgets/issues/5/comments?per_page=100': {
      status: 200,
      data: [{ id: 2, user: { login: 'someone' }, body: '<!-- groundwork:fmt -->' }],
    },
    'POST /repos/acme/widgets/issues/5/comments': { status: 201, data: {} },
  });
  await applyActions([{ kind: 'upsert-comment', number: 5, marker: 'fmt', body: 'fresh' }], { client, repo: REPO });
  assert.equal(calls[1], 'POST /repos/acme/widgets/issues/5/comments');
  assert.match(bodies[0].body, /<!-- groundwork:fmt -->/);
});

test('close-issue posts the comment then closes the issue', async () => {
  const { client, calls, bodies } = recorder({
    'POST /repos/acme/widgets/issues/9/comments': { status: 201, data: {} },
    'PATCH /repos/acme/widgets/issues/9': { status: 200, data: {} },
  });
  await applyActions([{ kind: 'close-issue', number: 9, comment: 'recovered' }], { client, repo: REPO });
  assert.deepEqual(calls, ['POST /repos/acme/widgets/issues/9/comments', 'PATCH /repos/acme/widgets/issues/9']);
  assert.deepEqual(bodies, [{ body: 'recovered' }, { state: 'closed' }]);
});

test('applyActions stops at the first failure', async () => {
  const { client, calls } = recorder({ 'POST /repos/acme/widgets/issues/1/comments': { status: 500, data: { message: 'x' } } });
  await assert.rejects(
    applyActions([{ kind: 'comment', number: 1, body: 'a' }, { kind: 'comment', number: 2, body: 'b' }], { client, repo: REPO }),
    GitHubError,
  );
  assert.equal(calls.length, 1);
});

test('renderSummary omits empty lists', () => {
  const full = renderSummary('pr-size', result('fail', { errors: ['too big'], warnings: ['careful'], details: 'table' }));
  assert.match(full, /## pr-size/);
  assert.match(full, /\*\*fail\*\*/);
  assert.match(full, /### Errors\n\n- too big/);
  assert.match(full, /### Warnings\n\n- careful/);
  assert.match(full, /table/);
  const bare = renderSummary('pr-size', result('pass'));
  assert.doesNotMatch(bare, /Errors|Warnings/);
  assert.match(bare, /\*\*pass\*\*/);
});

test('an unrecognised or missing conclusion exits 2 and applies no actions', async () => {
  await withFixture(async (fixture) => {
    const calls = [];
    const createClient = () => createFixtureClient({}, { onCall: (record) => calls.push(record.path) });
    const actions = [{ kind: 'comment', number: 1, body: 'x' }];
    assert.equal(await run(validatorReturning({ ...result('failure'), actions }), fixture, { createClient }), 2);
    assert.equal(await run(validatorReturning({ errors: [], warnings: [], details: '', actions }), fixture, { createClient }), 2);
    assert.equal(await run(validatorReturning(null), fixture, { createClient }), 2);
    assert.deepEqual(calls, []);
    assert.match(await readFile(fixture.summaryPath, 'utf8'), /unknown conclusion: failure/);
  });
});

test('error summary has Conclusion error; an action failure keeps the validator result', async () => {
  await withFixture(async (fixture) => {
    const throwing = validatorReturning(null, { collect: async () => { throw new Error('nope'); } });
    await run(throwing, fixture);
    assert.match(await readFile(fixture.summaryPath, 'utf8'), /Conclusion: \*\*error\*\*/);

    await rm(fixture.summaryPath, { force: true });
    const failing = validatorReturning(result('fail', {
      errors: ['bad title'], warnings: ['w1'], details: 'the details',
      actions: [{ kind: 'comment', number: 1, body: 'x' }],
    }));
    assert.equal(await run(failing, fixture), 2);
    const summary = await readFile(fixture.summaryPath, 'utf8');
    for (const text of ['bad title', 'w1', 'the details', 'no fixture for POST']) assert.ok(summary.includes(text), text);
  });
});

test('a failing summary write falls back to stdout and exits 2', async () => {
  await withFixture(async (fixture) => {
    let printed = '';
    const code = await run(validatorReturning(result('pass')), fixture, {
      appendFile: async () => { throw new Error('disk full'); },
      stdout: (value) => { printed += value; },
    });
    assert.equal(code, 2);
    assert.match(printed, /## demo/);
    assert.match(printed, /disk full/);
  });
});

test('a missing GITHUB_EVENT_NAME or env is exit 2, not a crash', async () => {
  await withFixture(async (fixture) => {
    let printed = '';
    const stdout = (value) => { printed += value; };
    const env = baseEnv(fixture, { GITHUB_EVENT_NAME: undefined, GITHUB_STEP_SUMMARY: undefined });
    assert.equal(await run(validatorReturning(result('pass')), fixture, { env, stdout }), 2);
    assert.match(printed, /GITHUB_EVENT_NAME is not set/);
    const code = await runValidator(validatorReturning(result('pass')), { argv: [], scriptUrl: fixture.scriptUrl, setExitCode: false, stdout });
    assert.equal(code, 2);
  });
});

test('actions from a needsClient = false validator exit 2 with a clear message', async () => {
  await withFixture(async (fixture) => {
    const validator = validatorReturning(result('pass', { actions: [{ kind: 'comment', number: 1, body: 'x' }] }), { needsClient: false });
    assert.equal(await run(validator, fixture), 2);
    assert.match(await readFile(fixture.summaryPath, 'utf8'), /needsClient = false/);
  });
});

test('upsert-comment finds the marker on the second comment page', async () => {
  const { client, calls } = recorder({
    'GET /repos/acme/widgets/issues/5/comments?per_page=100': {
      status: 200,
      headers: { link: '<https://api.github.com/repos/acme/widgets/issues/5/comments?page=2&per_page=100>; rel="next"' },
      data: [{ id: 1, user: { login: 'someone' }, body: 'plain' }],
    },
    'GET /repos/acme/widgets/issues/5/comments?page=2&per_page=100': {
      status: 200,
      data: [{ id: 8, user: BOT, body: 'old\n\n<!-- groundwork:fmt -->\n' }],
    },
    'PATCH /repos/acme/widgets/issues/comments/8': { status: 200, data: {} },
  });
  await applyActions([{ kind: 'upsert-comment', number: 5, marker: 'fmt', body: 'new' }], { client, repo: REPO });
  assert.equal(calls.length, 3);
  assert.equal(calls[2], 'PATCH /repos/acme/widgets/issues/comments/8');
});

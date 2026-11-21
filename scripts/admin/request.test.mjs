import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureClient } from '../lib/github.mjs';
import { parseArgs, main } from './request.mjs';

const CONFIG = { org: 'wimdotgg', controlRepo: 'groundwork' };
const MAIN_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const TREE_SHA = 'c'.repeat(40);
const PROBE_SHA = 'd'.repeat(40);
const RUN_URL = 'https://github.com/wimdotgg/groundwork/actions/runs/42';
const DISPATCH_KEY = 'POST /repos/wimdotgg/groundwork/actions/workflows/admin-run.yml/dispatches';
const REF_KEY = 'GET /repos/wimdotgg/demo/git/ref/heads/main';
const PROBE_KEYS = {
  [REF_KEY]: { status: 200, data: { object: { sha: MAIN_SHA } } },
  [`GET /repos/wimdotgg/demo/git/commits/${MAIN_SHA}`]: { status: 200, data: { tree: { sha: TREE_SHA } } },
  'POST /repos/wimdotgg/demo/git/commits': { status: 201, data: { sha: PROBE_SHA } },
};
const PATCH_KEY = 'PATCH /repos/wimdotgg/demo/git/refs/heads/main';
const SCRIPT = 'admin-ops/example.mjs';
const CONTROL_REF_KEY = 'GET /repos/wimdotgg/groundwork/git/ref/heads/main';

/** The fixture client never exposes bodies, so record them around it. */
function recordingClient(routes) {
  const inner = createFixtureClient(routes);
  const calls = [];
  const request = async (method, path, options) => {
    calls.push({ method, path, body: options?.body });
    return inner.request(method, path, options);
  };
  return { client: { ...inner, request }, calls };
}

function run(argv, routes) {
  const { client, calls } = recordingClient(routes);
  return { done: main({ argv, client, config: CONFIG }), calls };
}

test('parseArgs reads op, repo, ref, args and --json', () => {
  const request = parseArgs(['apply-settings', '--repo', 'demo', '--ref', OTHER_SHA, '--args', '{"a":1}', '--json']);
  assert.deepEqual(request, { op: 'apply-settings', repo: 'demo', ref: OTHER_SHA, scriptPath: '', args: { a: 1 }, json: true });
});

test('parseArgs accepts --flag=value and defaults args to {}', () => {
  const request = parseArgs(['check', '--repo=my.repo_1-x']);
  assert.deepEqual(request, { op: 'check', repo: 'my.repo_1-x', ref: '', scriptPath: '', args: {}, json: false });
});

test('parseArgs accepts create-issue-types without a repo', () => {
  assert.equal(parseArgs(['create-issue-types']).repo, '');
});

test('parseArgs rejects bad input before any call', () => {
  const bad = [
    [],
    ['nope'],
    ['check', 'extra', '--repo', 'demo'],
    ['check'],
    ['probe'],
    ['create-issue-types', '--repo', 'demo'],
    ['check', '--repo', 'a/b'],
    ['check', '--repo', ''],
    ['check', '--repo', '.'],
    ['check', '--repo', '..'],
    ['check', '--repo', 'demo', '--bogus', 'x'],
    ['check', '--repo'],
    ['check', '--repo', 'demo', '--repo', 'again'],
    ['apply-settings', '--repo', 'demo', '--ref', 'abc123'],
    ['apply-settings', '--repo', 'demo', '--ref', 'A'.repeat(40)],
    ['check', '--repo', 'demo', '--ref', MAIN_SHA],
    ['check', '--repo', 'demo', '--args', '{oops'],
    ['check', '--repo', 'demo', '--args', '[1]'],
    ['check', '--repo', 'demo', '--args', 'null'],
    ['probe', '--repo', 'demo', '--args', '{}'],
    ['check', '--repo', 'demo', '--json=1'],
    ['bootstrap', '--args', '{"description":"d"}'],
    ['bootstrap-pass2'],
    ['bootstrap-pass2', '--repo', 'demo', '--args', '{}'],
    ['bootstrap', '--repo', 'demo', '--ref', MAIN_SHA],
    ['bootstrap-pass2', '--repo', 'demo', '--ref', MAIN_SHA],
    ['script', '--script', SCRIPT],
    ['script', '--repo', 'demo'],
    ['script', '--repo', 'demo', '--script', 'scripts/x.mjs'],
    ['script', '--repo', 'demo', '--script', 'admin-ops/sub/x.mjs'],
    ['script', '--repo', 'demo', '--script', 'admin-ops/x.js'],
    ['script', '--repo', 'demo', '--script', SCRIPT, '--ref', 'abc'],
    ['check', '--repo', 'demo', '--script', SCRIPT],
    ['selftest', '--repo', 'demo'],
    ['selftest', '--ref', MAIN_SHA],
    ['selftest', '--script', SCRIPT],
    ['selftest', '--args', '{}'],
  ];
  for (const argv of bad) {
    assert.throws(() => parseArgs(argv), { name: 'ConfigError' }, argv.join(' '));
  }
});

test('apply-settings with --ref dispatches the exact body on main', async () => {
  const { done, calls } = run(['apply-settings', '--repo', 'demo', '--ref', OTHER_SHA, '--args', '{"k":"v"}'], {
    [DISPATCH_KEY]: { status: 200, data: { html_url: RUN_URL } },
  });
  const outcome = await done;
  assert.deepEqual(calls, [{
    method: 'POST',
    path: '/repos/wimdotgg/groundwork/actions/workflows/admin-run.yml/dispatches',
    body: {
      ref: 'main',
      inputs: { op: 'apply-settings', target_repo: 'demo', ref: OTHER_SHA, script_path: '', args: '{"k":"v"}' },
      return_run_details: true,
    },
  }]);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.stdout, `dispatched; approve the run: ${RUN_URL}\n`);
});

test('apply-settings without --ref resolves the target main head first', async () => {
  const { done, calls } = run(['apply-settings', '--repo', 'demo'], {
    [REF_KEY]: { status: 200, data: { object: { sha: MAIN_SHA } } },
    [DISPATCH_KEY]: { status: 200, data: { html_url: RUN_URL } },
  });
  await done;
  assert.equal(calls[0].path, '/repos/wimdotgg/demo/git/ref/heads/main');
  assert.equal(calls[1].body.inputs.ref, MAIN_SHA);
});

test('apply-settings fails when the main head response has no SHA', async () => {
  const { done } = run(['apply-settings', '--repo', 'demo'], { [REF_KEY]: { status: 200, data: {} } });
  await assert.rejects(done, { name: 'GitHubError' });
});

test('check sends empty ref and "{}" args', async () => {
  const { done, calls } = run(['check', '--repo', 'demo'], { [DISPATCH_KEY]: { status: 200, data: { html_url: RUN_URL } } });
  await done;
  assert.deepEqual(calls[0].body.inputs, { op: 'check', target_repo: 'demo', ref: '', script_path: '', args: '{}' });
});

test('create-issue-types sends empty target_repo and ref', async () => {
  const { done, calls } = run(['create-issue-types'], { [DISPATCH_KEY]: { status: 200, data: { html_url: RUN_URL } } });
  await done;
  assert.deepEqual(calls[0].body.inputs, { op: 'create-issue-types', target_repo: '', ref: '', script_path: '', args: '{}' });
});

test('bootstrap dispatches the description with empty ref', async () => {
  const { done, calls } = run(['bootstrap', '--repo', 'demo', '--args', '{"description":"d"}'], {
    [DISPATCH_KEY]: { status: 200, data: { html_url: RUN_URL } },
  });
  await done;
  assert.deepEqual(calls[0].body.inputs, { op: 'bootstrap', target_repo: 'demo', ref: '', script_path: '', args: '{"description":"d"}' });
});

test('bootstrap-pass2 dispatches with empty ref and "{}" args', async () => {
  const { done, calls } = run(['bootstrap-pass2', '--repo', 'demo'], { [DISPATCH_KEY]: { status: 200, data: { html_url: RUN_URL } } });
  await done;
  assert.deepEqual(calls[0].body.inputs, { op: 'bootstrap-pass2', target_repo: 'demo', ref: '', script_path: '', args: '{}' });
});

test('script defaults --ref to the groundwork main head and dispatches script_path', async () => {
  const { done, calls } = run(['script', '--repo', 'demo', '--script', SCRIPT, '--args', '{"k":1}'], {
    [CONTROL_REF_KEY]: { status: 200, data: { object: { sha: OTHER_SHA } } },
    [DISPATCH_KEY]: { status: 200, data: { html_url: RUN_URL } },
  });
  await done;
  assert.equal(calls[0].path, '/repos/wimdotgg/groundwork/git/ref/heads/main');
  assert.deepEqual(calls[1].body.inputs, { op: 'script', target_repo: 'demo', ref: OTHER_SHA, script_path: SCRIPT, args: '{"k":1}' });
});

test('script keeps an explicit --ref and makes no lookup', async () => {
  const { done, calls } = run(['script', '--repo', 'demo', '--script', SCRIPT, '--ref', MAIN_SHA], { [DISPATCH_KEY]: { status: 200, data: { html_url: RUN_URL } } });
  await done;
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.inputs, { op: 'script', target_repo: 'demo', ref: MAIN_SHA, script_path: SCRIPT, args: '{}' });
});

test('selftest dispatches with empty target_repo, ref and script_path', async () => {
  const { done, calls } = run(['selftest'], { [DISPATCH_KEY]: { status: 200, data: { html_url: RUN_URL } } });
  await done;
  assert.deepEqual(calls[0].body.inputs, { op: 'selftest', target_repo: '', ref: '', script_path: '', args: '{}' });
});

test('dispatch without run details prints the workflow page URL', async () => {
  const { done } = run(['check', '--repo', 'demo'], { [DISPATCH_KEY]: { status: 204, data: null } });
  const outcome = await done;
  assert.equal(outcome.exitCode, 0);
  assert.match(outcome.stdout, /^dispatched; run URL not returned, find the run here: https:\/\/github\.com\/wimdotgg\/groundwork\/actions\/workflows\/admin-run\.yml\n$/);
});

test('dispatch --json prints a result object', async () => {
  const { done } = run(['check', '--repo', 'demo', '--json'], { [DISPATCH_KEY]: { status: 200, data: { html_url: RUN_URL } } });
  const outcome = await done;
  assert.deepEqual(JSON.parse(outcome.stdout), {
    op: 'check', targetRepo: 'demo', ref: '', approveUrl: RUN_URL, runDetails: true,
  });
});

for (const status of [422, 409]) {
  test(`probe ${status} means main is protected, exit 0`, async () => {
    const { done, calls } = run(['probe', '--repo', 'demo'], { ...PROBE_KEYS, [PATCH_KEY]: { status, data: { message: 'rule violation' } } });
    const outcome = await done;
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.stdout, 'push probe rejected: main is protected\n');
    assert.equal(outcome.stderr, '');
    assert.equal(calls.some((call) => call.path.includes('actions/workflows')), false);
  });
}

test('probe sends the exact commit and ref bodies, no author or committer', async () => {
  const { done, calls } = run(['probe', '--repo', 'demo'], { ...PROBE_KEYS, [PATCH_KEY]: { status: 422, data: {} } });
  await done;
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    'GET /repos/wimdotgg/demo/git/ref/heads/main',
    `GET /repos/wimdotgg/demo/git/commits/${MAIN_SHA}`,
    'POST /repos/wimdotgg/demo/git/commits',
    'PATCH /repos/wimdotgg/demo/git/refs/heads/main',
    'GET /repos/wimdotgg/demo/git/ref/heads/main',
  ]);
  assert.deepEqual(calls[2].body, { message: 'chore(check): probe', tree: TREE_SHA, parents: [MAIN_SHA] });
  assert.deepEqual(calls[3].body, { sha: PROBE_SHA, force: false });
});

test('probe 200 means main is NOT protected, exit 1 with the reason on stderr', async () => {
  const { done } = run(['probe', '--repo', 'demo'], { ...PROBE_KEYS, [PATCH_KEY]: { status: 200, data: {} } });
  const outcome = await done;
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.stdout, '');
  assert.equal(outcome.stderr, 'push probe accepted: main is NOT protected; probe commit left on main as evidence\n');
});

test('probe --json prints the verdict as an object', async () => {
  const { done } = run(['probe', '--repo', 'demo', '--json'], { ...PROBE_KEYS, [PATCH_KEY]: { status: 200, data: {} } });
  const outcome = await done;
  assert.equal(outcome.exitCode, 1);
  assert.deepEqual(JSON.parse(outcome.stdout), {
    op: 'probe', targetRepo: 'demo', protected: false, status: 200, probeSha: PROBE_SHA,
  });
});

for (const status of [403, 404, 500]) {
  test(`probe treats ${status} as an error, not as a verdict`, async () => {
    const { done } = run(['probe', '--repo', 'demo'], { ...PROBE_KEYS, [PATCH_KEY]: { status, data: {} } });
    await assert.rejects(done, { name: 'GitHubError', status });
  });
}

test('probe 422 with main moved since the first read is inconclusive, never a verdict', async () => {
  const movedMain = [
    { status: 200, data: { object: { sha: MAIN_SHA } } },
    { status: 200, data: { object: { sha: OTHER_SHA } } },
  ];
  const { done } = run(['probe', '--repo', 'demo'], { ...PROBE_KEYS, [REF_KEY]: movedMain, [PATCH_KEY]: { status: 422, data: {} } });
  await assert.rejects(done, { name: 'GitHubError', message: /inconclusive: main moved during the probe; rerun/ });
});

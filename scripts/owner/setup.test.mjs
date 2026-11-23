import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { askHidden, clean, gitArguments, main, openCommand, stepsToRun, validateState } from './setup.mjs';

const NOW = '2026-11-23T09:00:00Z';
const STATE_PATH = '/state/setup-state.json';
const REMOVE_SCOPE = 'gh auth refresh --remove-scopes admin:org';
const done = (note = '') => ({ status: note ? 'skipped' : 'done', updatedAt: NOW, note });
const consent = { answer: 'B', classes: ['wizard'], answeredAt: NOW, endedAt: null };
const stateWith = (extra = {}) => ({ schemaVersion: 1, org: 'acme', consent, steps: { 'org-create': done(), 'org-2fa': done() }, ...extra });
const GIT_REPLIES = { remote: 'origin\n', 'rev-parse': 'abc123\n', status: '', diff: '' };
function fakeIo({ state = stateWith(), answers = [], git = {}, scopes = [], stickyScope = false } = {}) {
  const files = new Map([[STATE_PATH, JSON.stringify(state)]]);
  const record = (command, args) => io.calls.push([command, ...args].join(' '));
  const io = {
    env: { GROUNDWORK_SETUP_STATE_FILE: STATE_PATH }, platform: 'linux', stdinTTY: true, stdoutTTY: true,
    output: [], calls: [], opened: [], scopes: new Set(scopes), now: () => NOW, print: (line) => io.output.push(line),
    ask: async (question) => { io.output.push(question); return answers.shift() ?? ''; },
    readText: (file) => files.get(file) ?? null, writeText: (file, text) => files.set(file, text),
    state: () => JSON.parse(files.get(STATE_PATH)), openUrl: (url) => io.opened.push(url),
    capture: (command, args) => {
      record(command, args);
      if (command === 'gh') return { status: 0, stdout: '', stderr: `Token scopes: ${[...io.scopes].join(', ')}` };
      return { status: args[0] === 'diff' && git.diff ? 1 : 0, stdout: { ...GIT_REPLIES, ...git }[args[0]], stderr: '' };
    },
    attach: (command, args) => {
      record(command, args);
      if (args[2] === '-s' || stickyScope) io.scopes.add('admin:org');
      else if (args[2] === '--remove-scopes') io.scopes.delete('admin:org');
      return { status: 0 };
    },
  };
  return io;
}
async function refused(io, argv, reason) {
  assert.equal(await main(io, argv), 1);
  assert.match(io.output.at(-1), reason);
}

test('AC1a refuses without a TTY, with GH_TOKEN, agent GH_CONFIG_DIR or CLAUDECODE, before any call', async () => {
  for (const [override, reason] of [
    [{ stdinTTY: false }, /terminal/], [{ stdoutTTY: false }, /terminal/], [{ env: { GH_TOKEN: 'x' } }, /GH_TOKEN/],
    [{ env: { GH_CONFIG_DIR: 'C:\\repo\\.claude\\gh-agent\\' } }, /GH_CONFIG_DIR/], [{ env: { CLAUDECODE: '1' } }, /CLAUDECODE/],
  ]) {
    const io = Object.assign(fakeIo(), override);
    await refused(io, [], reason);
    assert.deepEqual(io.calls, []);
  }
});

test('AC1b prints HEAD and baseline, refuses local changes or a diff from the baseline', async () => {
  const upstream = fakeIo({ git: { remote: 'upstream\n' }, state: stateWith({ steps: {} }), answers: ['', 'n'] });
  assert.equal(await main(upstream, []), 0);
  assert.match(upstream.output[0], /HEAD abc123, baseline upstream\/main abc123/);
  await refused(fakeIo({ git: { status: ' M scripts/lib/x.mjs' } }), [], /has local changes/);
  await refused(fakeIo({ git: { diff: true } }), [], /differs from origin\/main/);
  assert.deepEqual(gitArguments('/empty', ['status']), ['-c', 'core.hooksPath=/empty', '-c', 'core.fsmonitor=false', 'status']);
});

test('AC1c validates setup-state.json, strips control characters, refuses org steps while org is null', async () => {
  const stamp = (updatedAt) => ({ steps: { 'org-2fa': { ...done(), updatedAt } } });
  for (const [patch, reason] of [
    [{ extra: 1 }, /unknown key extra/], [{ schemaVersion: 2 }, /schemaVersion/], [{ steps: { nope: done() } }, /unknown key nope/],
    [{ steps: { 'org-2fa': { ...done(), status: 'maybe' } } }, /unknown status/], [{ org: 'a/b' }, /valid login/],
    [{ org: null }, /org is null after org-create/], [stamp('2026-11-23 09:00'), /ISO 8601/],
  ]) assert.throws(() => validateState(stateWith(patch)), reason);
  assert.equal(clean('a\u001b[31mb\nc'), 'a[31mbc');
  await refused(fakeIo({ state: stateWith({ org: null, steps: {} }) }), ['--step', 'org-2fa'], /org-2fa needs the org/);
});

test('AC1d AC6 removes a leftover admin:org at start, drops it at the end, fails when it stays', async () => {
  const leftover = fakeIo({ scopes: ['repo', 'admin:org'], answers: ['', 'n'] });
  assert.equal(await main(leftover, []), 0);
  assert.ok(leftover.calls.includes(REMOVE_SCOPE));
  const accepted = fakeIo({ answers: ['', 'y', '', 'n'] });
  assert.equal(await main(accepted, []), 0);
  assert.deepEqual(accepted.calls.slice(-2), [REMOVE_SCOPE, 'gh auth status']);
  assert.ok(!accepted.calls.some((call) => call.includes('logout')));
  await refused(fakeIo({ answers: ['', 'y'], stickyScope: true }), [], /still granted; run: gh auth refresh --remove-scopes admin:org/);
});

test('AC2 AC5 a declined write stays pending and ends the walk; y runs the exact command; a note skips', async () => {
  const declined = fakeIo({ answers: ['', 'n'] });
  assert.equal(await main(declined, []), 0);
  assert.ok(!declined.calls.some((call) => call.startsWith('gh api')));
  assert.equal(declined.state().steps['org-base-permission'], undefined);
  assert.match(declined.output.at(-1), /org-base-permission stays pending/);
  const accepted = fakeIo({ answers: ['', 'y'] });
  await main(accepted, []);
  assert.ok(accepted.calls.includes('gh api -X PATCH /orgs/acme -f default_repository_permission=read -F members_can_create_repositories=false'));
  assert.equal(accepted.state().steps['org-base-permission'].status, 'done');
  const skipped = fakeIo({ answers: ['set by hand\u0007'] });
  await main(skipped, []);
  assert.deepEqual(skipped.state().steps['org-base-permission'], { status: 'skipped', updatedAt: NOW, note: 'set by hand' });
});

test('AC3 AC5 resumes at the first unfinished step; --step runs one step and refuses app or unknown IDs', async () => {
  assert.equal(stepsToRun(stateWith({ steps: { 'org-create': done(), 'org-2fa': done('had it') } }))[0].id, 'org-base-permission');
  assert.throws(() => stepsToRun(stateWith(), 'issue-types'), /app step/);
  assert.throws(() => stepsToRun(stateWith(), 'nope'), /unknown step/);
  const browser = fakeIo({ answers: ['', 'y'] });
  assert.equal(await main(browser, ['--step', 'org-pat-policy']), 0);
  assert.deepEqual(browser.opened, ['https://github.com/organizations/acme/settings/personal-access-tokens']);
  assert.match(browser.output.join('\n'), /Fine-grained personal access tokens: Require administrator approval\n {2}Verify: /);
  const actions = fakeIo({ answers: ['', 'y', 'y', 'y'] });
  assert.equal(await main(actions, ['--step', 'org-actions']), 0);
  assert.ok(actions.calls.includes('gh api -X PUT /orgs/acme/actions/permissions/workflow -F can_approve_pull_request_reviews=false'));
  assert.deepEqual(openCommand('win32', 'https://x'), ['rundll32', ['url.dll,FileProtocolHandler', 'https://x']]);
});

test('AC4 hidden entry never writes the value to any output', async () => {
  const input = Object.assign(new EventEmitter(), { setRawMode() {}, setEncoding() {}, pause() {}, resume() {} });
  let written = '';
  const pending = askHidden({ input, output: { write: (text) => { written += text; } } }, 'Secret: ');
  input.emit('data', 's3cretX\u007f\r');
  assert.equal(await pending, 's3cret');
  assert.equal(written, 'Secret: \n');
});

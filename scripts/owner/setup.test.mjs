import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  askHidden, askLine, clean, ghEnvironment, gitArguments, hardenExecutableLookup, main, openCommand, parseScopes, stepsToRun, validateState, wasInterrupted,
} from './setup.mjs';

const NOW = '2026-11-23T09:00:00Z';
const STATE_PATH = '/state/setup-state.json';
const REMOVE_SCOPE = 'gh auth refresh --remove-scopes admin:org';
const ADD_SCOPE = 'gh auth refresh -s admin:org';
const AUTH_STATUS = 'gh auth status --active --hostname github.com';
const BASE_PERMISSION = 'gh api -X PATCH /orgs/acme -f default_repository_permission=read -F members_can_create_repositories=false';
const done = (note = '') => ({ status: note ? 'skipped' : 'done', updatedAt: NOW, note });
const consent = { answer: 'B', classes: ['wizard'], answeredAt: NOW, endedAt: null };
const stateWith = (extra = {}) => ({ schemaVersion: 1, org: 'acme', consent, steps: { 'org-create': done(), 'org-2fa': done() }, ...extra });
const GIT_REPLIES = { config: 'core.bare\nremote.origin.url\n', remote: 'origin\n', 'rev-parse': 'abc123\n', status: '', diff: '' };

// attachResults maps a call prefix to a status, or to an Error the fake throws (an interrupted child).
function fakeIo({ state = stateWith(), answers = [], git = {}, gitFails = [], scopes = [], stickyScope = false, authStatus = 0, attachResults = {} } = {}) {
  const files = new Map([[STATE_PATH, JSON.stringify(state)]]);
  const record = (command, args) => io.calls.push([command, ...args].join(' '));
  const io = {
    env: { GROUNDWORK_SETUP_STATE_FILE: STATE_PATH }, platform: 'linux', stdinTTY: true, stdoutTTY: true,
    output: [], calls: [], opened: [], scopes: new Set(scopes), now: () => NOW, print: (line) => io.output.push(line),
    ask: async (question) => {
      io.output.push(question);
      const answer = answers.shift() ?? '';
      if (answer instanceof Error) throw answer;
      return answer;
    },
    checkInterrupt: async () => {}, clearInterrupt: () => { io.cleared = (io.cleared ?? 0) + 1; },
    readText: (file) => files.get(file) ?? null, writeText: (file, text) => files.set(file, text),
    state: () => JSON.parse(files.get(STATE_PATH)), openUrl: (url) => io.opened.push(url),
    capture: (command, args) => {
      record(command, args);
      const scopeList = [...io.scopes].map((scope) => `'${scope}'`).join(', ');
      if (command === 'gh') return { status: Array.isArray(authStatus) ? authStatus.shift() ?? 0 : authStatus, stdout: `github.com\n  - Token scopes: ${scopeList}\n`, stderr: '' };
      const status = gitFails.includes(args[0]) ? 128 : (args[0] === 'diff' && git.diff ? 1 : 0);
      return { status, stdout: { ...GIT_REPLIES, ...git }[args[0]], stderr: '' };
    },
    attach: (command, args) => {
      record(command, args);
      const call = [command, ...args].join(' ');
      const result = Object.entries(attachResults).find(([prefix]) => call.startsWith(prefix))?.[1] ?? 0;
      if (result instanceof Error) throw result;
      if (result === 0 && args[2] === '-s') io.scopes.add('admin:org');
      if (result === 0 && args[2] === '--remove-scopes' && !stickyScope) io.scopes.delete('admin:org');
      return { status: result };
    },
  };
  return io;
}

async function refused(io, argv, reason) {
  assert.equal(await main(io, argv), 1);
  assert.match(io.output.join('\n'), reason);
}
const count = (io, call) => io.calls.filter((entry) => entry === call).length;

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

test('Windows lookup skips the working directory for bare command names', () => {
  const env = {};
  hardenExecutableLookup(env);
  assert.equal(env.NoDefaultCurrentDirectoryInExePath, '1');
});

test('AC1b prints HEAD and the full baseline ref, refuses local changes, a diff or a failing git', async () => {
  const upstream = fakeIo({ git: { remote: 'upstream\n' }, state: stateWith({ steps: {} }), answers: ['', 'n'] });
  assert.equal(await main(upstream, []), 0);
  assert.match(upstream.output[0], /HEAD abc123, baseline refs\/remotes\/upstream\/main abc123/);
  assert.ok(upstream.calls.includes('git rev-parse --verify refs/remotes/upstream/main^{commit}'));
  await refused(fakeIo({ git: { status: ' M scripts/lib/x.mjs' } }), [], /has local changes/);
  await refused(fakeIo({ git: { diff: true } }), [], /differs from refs\/remotes\/origin\/main/);
  await refused(fakeIo({ gitFails: ['status'] }), [], /git status failed with exit 128/);
  await refused(fakeIo({ gitFails: ['rev-parse'] }), [], /git rev-parse failed/);
  assert.deepEqual(gitArguments('/empty', ['status']), ['-c', 'core.hooksPath=/empty', '-c', 'core.fsmonitor=false', 'status']);
});

// A repository whose .git/config runs a program on git status (filter.x.clean) and on git diff (diff.external),
// with scripts/lib/x.mjs changed at the same size so git status re-hashes it through the filter.
function unsafeConfigFixture(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'groundwork-unsafe-config-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  const marker = path.join(base, 'ran').replaceAll('\\', '/');
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: repo }).status, 0, args.join(' '));
  mkdirSync(path.join(repo, 'scripts', 'lib'), { recursive: true });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, '.gitattributes'), '* filter=x\n');
  writeFileSync(path.join(repo, 'scripts', 'lib', 'x.mjs'), 'a\n');
  git('add', '.');
  git('-c', 'user.name=Owner', '-c', 'user.email=owner@example.com', 'commit', '-q', '-m', 'init');
  git('remote', 'add', 'origin', 'https://github.com/acme/groundwork.git');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('config', '--local', 'filter.x.clean', `echo filter >> "${marker}"; cat`);
  git('config', '--local', 'diff.external', `echo diff >> "${marker}"; true`);
  writeFileSync(path.join(repo, 'scripts', 'lib', 'x.mjs'), 'b\n');
  return { repo, marker };
}

test('AC6 a .git/config that sets filter.x.clean and diff.external refuses before any other git command', async (t) => {
  const { repo, marker } = unsafeConfigFixture(t);
  const io = fakeIo();
  io.capture = (command, args) => {
    io.calls.push([command, ...args].join(' '));
    const result = spawnSync(command, args, { cwd: repo, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  await refused(io, [], /\.git\/config sets filter\.x\.clean, which the wizard does not run with: remove it \(git config --local --unset-all "filter\.x\.clean"\)/);
  assert.deepEqual(io.calls, ['git config --local --name-only --list']);
  assert.ok(!existsSync(marker), 'a configured program ran');
});

test('AC1c validates setup-state.json, strips control characters, refuses org steps while org is null', async () => {
  const stamp = (updatedAt) => ({ steps: { 'org-2fa': { ...done(), updatedAt } } });
  const { org: _org, ...withoutOrg } = stateWith();
  assert.throws(() => validateState(withoutOrg), /missing key org/);
  for (const [patch, reason] of [
    [{ extra: 1 }, /unknown key extra/], [{ schemaVersion: 2 }, /schemaVersion/], [{ steps: { nope: done() } }, /unknown step nope/],
    [{ steps: { 'org-2fa': { ...done(), status: 'maybe' } } }, /unknown status/], [{ org: 'a/b' }, /valid login/],
    [{ org: ['acme'] }, /valid login/], [{ org: 123 }, /valid login/], [{ org: null }, /org is null after org-create/],
    [{ consent: { ...consent, answer: ['B'] } }, /consent answer/],
    [stamp('2026-11-23 09:00'), /ISO 8601/], [stamp([NOW]), /ISO 8601/], [{ steps: { 'org-2fa': { status: 'done', updatedAt: NOW } } }, /missing key note/],
  ]) assert.throws(() => validateState(stateWith(patch)), reason);
  assert.equal(clean('a\u001b[31mb\nc'), 'a[31mbc');
  await refused(fakeIo({ state: stateWith({ org: null, steps: {} }) }), ['--step', 'org-2fa'], /org-2fa needs the org/);
});

test('AC1c refuses consent A wizard steps and an ended setup', async () => {
  const consentA = { ...consent, answer: 'A', classes: [] };
  await refused(fakeIo({ state: stateWith({ consent: consentA }) }), [], /consent A keeps org-base-permission in the browser/);
  await refused(fakeIo({ state: stateWith({ consent: { ...consent, endedAt: NOW } }) }), [], /setup has ended/);
});

test('AC1d removes a leftover admin:org at start without adding it, and reports the scope gone', async () => {
  const leftover = fakeIo({ scopes: ['repo', 'admin:org'], answers: ['', 'n'] });
  assert.equal(await main(leftover, ['--step', 'org-pat-policy']), 0);
  assert.deepEqual(leftover.calls.filter((call) => call.startsWith('gh')), [AUTH_STATUS, REMOVE_SCOPE, AUTH_STATUS]);
  assert.ok(leftover.output.includes('admin:org is gone'));
});

test('AC1d scope reads fail closed and match the exact scope', async () => {
  assert.deepEqual(parseScopes("  - Token scopes: 'admin:org_hook', 'repo'"), ['admin:org_hook', 'repo']);
  assert.equal(parseScopes('You are not logged into any GitHub hosts.'), null);
  const unreadable = fakeIo({ authStatus: 1, answers: ['', 'n'] });
  await refused(unreadable, [], /refused: cannot read the scopes from gh auth status \(exit 1\)/);
  assert.equal(count(unreadable, REMOVE_SCOPE), 0);
  const unreadableAtEnd = fakeIo({ authStatus: [0, 1], answers: ['', 'n'] });
  await refused(unreadableAtEnd, [], /cannot read the scopes from gh auth status \(exit 1\)\nadmin:org may still be granted/);
  const hook = fakeIo({ scopes: ['admin:org_hook'], answers: ['', 'n'] });
  assert.equal(await main(hook, ['--step', 'org-pat-policy']), 0);
  assert.equal(count(hook, REMOVE_SCOPE), 0);
});

test('AC1d coloured scope lists still match, and gh runs with colour forced off', async () => {
  for (const line of ["Token scopes: \u001b[0;1;39m'admin:org', 'gist'\u001b[0m", "Token scopes: \u001b[0;1;39m'admin:org'\u001b[0m", "Token scopes: 'gist', \u001b[1m'admin:org'\u001b[0m"]) {
    assert.ok(parseScopes(line).includes('admin:org'), JSON.stringify(line));
  }
  const coloured = fakeIo({ scopes: ['admin:org'], answers: ['', 'n'] });
  coloured.capture = ((original) => (command, args) => {
    const result = original(command, args);
    return { ...result, stdout: result.stdout.replace(/Token scopes: (.*)/, 'Token scopes: \u001b[0;1;39m$1\u001b[0m') };
  })(coloured.capture);
  assert.equal(await main(coloured, ['--step', 'org-pat-policy']), 0);
  assert.equal(count(coloured, REMOVE_SCOPE), 1);
  const env = ghEnvironment({ PATH: '/bin', CLICOLOR_FORCE: '1', GH_FORCE_TTY: '1' });
  assert.deepEqual(env, { PATH: '/bin', NO_COLOR: '1' });
});

test('AC1d a failed removal exits non-zero even when the read says the scope is gone', async () => {
  const failed = fakeIo({ answers: ['', 'n'] });
  const attach = failed.attach;
  failed.attach = (command, args) => {
    const result = attach(command, args);
    if (args[2] !== '--remove-scopes') return result;
    failed.scopes.delete('admin:org');
    return { status: 1 };
  };
  await refused(failed, [], /gh auth refresh --remove-scopes admin:org exited 1\nadmin:org may still be granted/);
  assert.ok(!failed.output.includes('admin:org is gone'));
});

test('AC1d AC6 drops admin:org once at the end, never logs out, fails when it stays', async () => {
  const accepted = fakeIo({ answers: ['', 'y', '', 'n'] });
  assert.equal(await main(accepted, []), 0);
  assert.deepEqual(accepted.calls.slice(-2), [REMOVE_SCOPE, AUTH_STATUS]);
  assert.equal(count(accepted, REMOVE_SCOPE), 1);
  assert.ok(!accepted.calls.some((call) => call.includes('logout')));
  await refused(fakeIo({ answers: ['', 'y'], stickyScope: true }), [], /may still be granted; run: gh auth refresh --remove-scopes admin:org/);
});

test('AC1d a failing write or scope grant refuses and still drops admin:org', async () => {
  const failedWrite = fakeIo({ answers: ['', 'y'], attachResults: { 'gh api': 1 } });
  await refused(failedWrite, [], /gh api -X PATCH \/orgs\/acme failed with exit 1/);
  assert.deepEqual(failedWrite.calls.slice(-2), [REMOVE_SCOPE, AUTH_STATUS]);
  const failedGrant = fakeIo({ answers: [''], attachResults: { [ADD_SCOPE]: 1 } });
  await refused(failedGrant, [], /gh auth refresh -s admin:org failed/);
  assert.ok(!failedGrant.calls.some((call) => call.startsWith('gh api')));
  assert.equal(count(failedGrant, REMOVE_SCOPE), 1);
});

test('Ctrl+C during a gh call runs the removal once, re-reads the scope and exits non-zero', async () => {
  const interrupted = fakeIo({ answers: [''], attachResults: { [ADD_SCOPE]: new Error('interrupted') } });
  await refused(interrupted, [], /refused: interrupted/);
  assert.deepEqual(interrupted.calls.slice(-2), [REMOVE_SCOPE, AUTH_STATUS]);
  assert.equal(count(interrupted, REMOVE_SCOPE), 1);
  assert.equal(interrupted.cleared, 1);
  const removalInterrupted = fakeIo({ answers: ['', 'y'], attachResults: { [REMOVE_SCOPE]: new Error('interrupted') } });
  await refused(removalInterrupted, [], /admin:org removal failed: interrupted\n.*may still be granted/);
  const between = fakeIo({ answers: ['', 'y'] });
  between.checkInterrupt = async () => { if (between.scopes.has('admin:org')) throw new Error('interrupted'); };
  await refused(between, [], /refused: interrupted/);
  assert.equal(count(between, REMOVE_SCOPE), 1);
  assert.ok(wasInterrupted({ signal: 'SIGINT', status: null }) && wasInterrupted({ status: 0xc000013a }) && !wasInterrupted({ status: 1 }));
});

test('closed input at a prompt rejects, drops admin:org and exits non-zero', async () => {
  const input = new PassThrough();
  const pending = askLine({ input, output: new PassThrough() }, 'Run it? y/N ');
  input.end();
  await assert.rejects(pending, /input closed/);
  const answered = new PassThrough();
  const reply = askLine({ input: answered, output: new PassThrough() }, 'Run it? y/N ');
  answered.write('y\n');
  assert.equal(await reply, 'y');
  const closed = fakeIo({ answers: ['', 'y', '', new Error('input closed or interrupted at a prompt')] });
  await refused(closed, [], /refused: input closed/);
  assert.deepEqual(closed.calls.slice(-2), [REMOVE_SCOPE, AUTH_STATUS]);
});

test('AC2 AC5 a declined write stays pending and ends the walk; y runs the exact command', async () => {
  const declined = fakeIo({ answers: ['n', 'n'] });
  assert.equal(await main(declined, []), 0);
  assert.ok(!declined.calls.some((call) => call.startsWith('gh api')));
  assert.equal(declined.state().steps['org-base-permission'], undefined);
  assert.deepEqual(declined.output.slice(-2), ['Stop: org-base-permission stays pending; rerun to resume here', 'admin:org is gone']);
  const accepted = fakeIo({ answers: ['', 'y'] });
  await main(accepted, []);
  assert.ok(accepted.calls.includes(BASE_PERMISSION));
  assert.equal(accepted.state().steps['org-base-permission'].status, 'done');
});

test('AC2 a step turns skipped only on y plus a note; an empty note keeps it pending', async () => {
  const skipped = fakeIo({ answers: ['y', 'set by hand\u0007'] });
  await main(skipped, []);
  assert.deepEqual(skipped.state().steps['org-base-permission'], { status: 'skipped', updatedAt: NOW, note: 'set by hand' });
  const noNote = fakeIo({ answers: ['y', ''] });
  assert.equal(await main(noNote, []), 0);
  assert.equal(noNote.state().steps['org-base-permission'], undefined);
  assert.match(noNote.output.at(-1), /org-base-permission stays pending: skipping needs a note/);
  assert.ok(!noNote.calls.some((call) => call.startsWith('gh api')));
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
  const note = actions.output.findIndex((line) => line.includes('enabled_repositories=all (the API requires it)'));
  assert.match(actions.output[note + 1], /^gh api -X PUT \/orgs\/acme\/actions\/permissions -f enabled_repositories=all/);
  assert.deepEqual(openCommand('win32', 'https://x'), ['rundll32', ['url.dll,FileProtocolHandler', 'https://x']]);
});

test('AC4 hidden entry never writes the value to any output; Ctrl+D rejects', async () => {
  const fakeInput = () => Object.assign(new EventEmitter(), { setRawMode() {}, setEncoding() {}, pause() {}, resume() {} });
  let written = '';
  const output = { write: (text) => { written += text; } };
  const input = fakeInput();
  const pending = askHidden({ input, output }, 'Secret: ');
  input.emit('data', 's3cretX\u007f\r');
  assert.equal(await pending, 's3cret');
  assert.equal(written, 'Secret: \n');
  const closing = fakeInput();
  const rejected = askHidden({ input: closing, output }, 'Secret: ');
  closing.emit('data', 'abc\u0004');
  await assert.rejects(rejected, /input closed/);
  assert.ok(!written.includes('abc'));
});

test('#307 AC1 refuses a state org that starts with a hyphen and builds no gh repo argv', async () => {
  assert.throws(() => validateState(stateWith({ org: '-d' })), /org is not a valid login/);
  const io = fakeIo({ state: stateWith({ org: '-d' }), answers: ['y', 'y', 'y', 'y'] });
  await refused(io, ['--step', 'repo-copy'], /org is not a valid login/);
  assert.deepEqual(io.calls.filter((call) => call.includes('-d/groundwork') || call.startsWith('gh repo')), []);
});

test('#307 AC2 refuses a typed organization login that starts with a hyphen, asks once and records nothing', async () => {
  const io = fakeIo({ state: stateWith({ org: null, steps: {} }), answers: ['y', 'created it', '-d', 'acme'] });
  await refused(io, ['--step', 'org-create'], /organization login/);
  assert.equal(io.output.filter((line) => line === 'Organization login: ').length, 1);
  assert.equal(io.state().org, null);
  assert.equal(io.state().steps['org-create'], undefined);
});

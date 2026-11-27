import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { STEP_HANDLERS } from './steps.mjs';
import { childEnvironment, ghEnvironment, gitConfigEnvironment, main, writePrivateFile } from './setup.mjs';

const NOW = '2026-11-23T09:00:00Z';
const NOTE = 'docs/runs/2026-11-23-setup-consent.md';
const CONFIG_PATH = '.github/groundwork/config.json';
const STATE_PATH = '/state/setup-state.json';
const ROOT = '/repo';
const KEY = (marker) => `-----BEGIN RSA PRIVATE KEY-----\n${marker}\n-----END RSA PRIVATE KEY-----\n`;
const CONFIG = {
  schemaVersion: 1, org: 'wimdotgg', controlRepo: 'groundwork', accounts: { owner: 'wianvdm', agent: 'wimdotgg-agent[bot]' },
  apps: { admin: 'acme-admin', agent: 'acme-agent', release: 'acme-release' }, deploy: 'none',
};
// The live file's layout: inline objects that JSON.stringify would reflow.
const INLINE_LINE = '    { "actor": "owner", "scope": "any" }';
const CONFIG_TEXT = `${JSON.stringify(CONFIG, null, 2).replace(/\n}$/, `,\n  "trustedAuthors": [\n${INLINE_LINE}\n  ]\n}`)}\n`;
const COPY_ADD = `git add -- ${CONFIG_PATH} .github/CODEOWNERS .release-please-manifest.json version.txt CHANGELOG.md ${NOTE}`;
const REPO_CREATE = 'gh repo create acme/groundwork --public --source . --remote origin';
const ORG_URL = 'https://github.com/acme/groundwork.git';
const PUSH = 'git push --set-upstream origin main';
const SET_DEFAULT = 'gh repo set-default acme/groundwork';
const COMMIT = 'git commit -m chore: set up acme from groundwork v1.2.3';
const stateWith = (steps = {}, consent = { answer: 'B', classes: ['wizard'] }) => ({
  schemaVersion: 1, org: 'acme', consent: { ...consent, answeredAt: NOW, endedAt: null }, steps,
});
const context = () => ({ state: stateWith(), statePath: STATE_PATH });
const OK = { status: 0, stdout: '', stderr: '' };

// Answers main's own git and gh reads; replies maps a call prefix to a result for everything else.
function defaultReply(call) {
  if (call.startsWith('gh auth status')) return { ...OK, stdout: "  - Token scopes: 'repo'\n" };
  if (call === 'git remote') return { ...OK, stdout: 'origin\n' };
  if (call.startsWith('git rev-parse')) return { ...OK, stdout: 'abc123\n' };
  return OK;
}

function fakeIo({ answers = [], files = {}, platform = 'linux', env = {}, replies = {} } = {}) {
  const reply = (call) => Object.entries(replies).find(([prefix]) => call.startsWith(prefix))?.[1] ?? defaultReply(call);
  const record = (command, args) => {
    const call = [command, ...args].join(' ');
    io.calls.push(call);
    return reply(call);
  };
  const io = {
    root: ROOT, platform, env: { GROUNDWORK_SETUP_STATE_FILE: STATE_PATH, ...env }, stdinTTY: true, stdoutTTY: true,
    output: [], calls: [], opened: [], piped: [], removed: [], privateFiles: new Map(),
    files: new Map([[path.join(ROOT, CONFIG_PATH), JSON.stringify(CONFIG)], ...Object.entries(files)]),
    now: () => NOW, print: (line) => io.output.push(line), openUrl: (url) => io.opened.push(url),
    ask: async (question) => {
      io.output.push(question);
      return answers.shift() ?? '';
    },
    checkInterrupt: async () => {}, clearInterrupt: () => {},
    readText: (file) => io.files.get(file) ?? null, writeText: (file, text) => io.files.set(file, text),
    writePrivateFile: (file, text) => io.privateFiles.set(file, text), removeFile: (file) => io.removed.push(file),
    capture: record, attach: record,
    pipe: (command, args, input) => {
      io.piped.push({ call: [command, ...args].join(' '), input });
      return record(command, args);
    },
  };
  return io;
}
const everything = (io) => [...io.output, ...io.calls].join('\n');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(root, file, text) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}

// An upstream at v1.2.3, the owner's clone of it with the consent note, and an empty bare repository standing in for the org's.
function cloneFixture(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'groundwork-copy-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const [upstream, clone, org] = ['upstream', 'clone', 'org.git'].map((name) => path.join(base, name));
  mkdirSync(upstream);
  git(upstream, 'init', '-q', '-b', 'main');
  for (const [file, text] of [
    [CONFIG_PATH, CONFIG_TEXT], ['.github/CODEOWNERS', '# owners\n/.github/  @wianvdm\n/scripts/ @wianvdm @other # kit\n'],
    ['.release-please-manifest.json', '{".":"1.2.3"}\n'], ['version.txt', '1.2.3\n'], ['CHANGELOG.md', '# Changelog\n\n## 1.2.3\n'], ['README.md', 'kit\n'],
  ]) write(upstream, file, text);
  git(upstream, 'add', '.');
  git(upstream, '-c', 'user.name=Upstream', '-c', 'user.email=upstream@example.com', 'commit', '-q', '-m', 'init');
  git(upstream, 'tag', 'v1.2.3');
  git(base, '-c', 'core.autocrlf=false', 'clone', '-q', '-c', 'core.autocrlf=false', upstream, clone);
  git(clone, 'config', 'user.name', 'Owner');
  git(clone, 'config', 'user.email', 'owner@example.com');
  git(base, 'init', '-q', '--bare', org);
  write(clone, NOTE, 'date: 2026-11-23T09:00:00Z\norg: acme\nanswer: B\n');
  return { clone, org, upstream };
}

// gh repo create without --push adds origin and pushes nothing; gh repo set-default writes the key gh resolves by.
const addOrigin = (clone, url = ORG_URL) => (args) => {
  if (args[1] === 'set-default') git(clone, 'config', 'remote.origin.gh-resolved', 'base');
  else git(clone, 'remote', 'add', 'origin', url);
  return OK;
};

// Runs git for real in the clone; gh is the given fake, and a push to origin lands in the bare org repository.
function cloneIo(clone, { answers, gh = addOrigin(clone), login = 'Owner-Login', org, pushStatus = 0 }) {
  const io = fakeIo({ answers });
  const run = (command, args) => {
    io.calls.push([command, ...args].join(' '));
    if (command === 'gh' && args[0] === 'api' && args[1] === 'user') return { ...OK, stdout: `${login} 4242\n` };
    if (command === 'gh') return gh(args);
    if (args[0] === 'push') return pushToOrg(clone, { org, pushStatus });
    const result = spawnSync('git', args, { cwd: clone, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  return Object.assign(io, {
    root: clone, capture: run, attach: run,
    readText: (file) => { try { return readFileSync(file, 'utf8'); } catch { return null; } },
    writeText: (file, text) => writeFileSync(file, text),
  });
}

function pushToOrg(clone, { org, pushStatus }) {
  if (pushStatus !== 0 || !org) return { ...OK, status: pushStatus };
  git(clone, 'push', '-q', org, 'HEAD:refs/heads/main');
  git(clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return OK;
}

// y to the rename, owner login, three default slugs, then y to the files, the release reset, the commit, the create, the gh default and the push.
const COPY_ANSWERS = ['y', 'Owner-Login', '', '', '', 'y', 'y', 'y', 'y', 'y', 'y'];
const repoCopy = (io) => STEP_HANDLERS['repo-copy'](io, context());

test('AC1 repo-copy renames, writes, resets, stages by name, shows diff, note and author, commits, creates, then pushes last', async (t) => {
  const { clone, org } = cloneFixture(t);
  const io = cloneIo(clone, { answers: [...COPY_ANSWERS], org });
  assert.equal(await repoCopy(io), true);
  const at = (call) => io.calls.indexOf(call);
  assert.ok(at('git remote rename origin upstream') < at(COPY_ADD) && at(COPY_ADD) < at(COMMIT) && at(COMMIT) < at(REPO_CREATE));
  assert.ok(at(REPO_CREATE) < at('git remote get-url --push --all origin'));
  assert.ok(at('git remote get-url --push --all origin') < at(SET_DEFAULT));
  assert.equal(git(clone, 'config', '--get', 'remote.origin.gh-resolved'), 'base');
  assert.equal(io.calls.at(-1), PUSH);
  assert.ok(!io.calls.some((call) => / add (-A|--all|\.)/.test(call) || call.includes('commit -a') || (call.startsWith('gh ') && call.includes('--push'))));
  const shown = io.output.indexOf(COMMIT);
  assert.ok(io.output.findIndex((line) => line === '+0.0.0') < shown);
  assert.ok(io.output.indexOf('answer: B') < shown && io.output.indexOf('answer: B') > -1);
  assert.ok(io.output.indexOf('author: Owner <owner@example.com>') < shown && io.output.indexOf('author: Owner <owner@example.com>') > -1);
  assert.ok(io.output.indexOf(`push to ${ORG_URL}`) < io.output.indexOf(PUSH));
  const read = (file) => readFileSync(path.join(clone, file), 'utf8');
  assert.equal(read('.release-please-manifest.json'), '{}\n');
  assert.equal(read('version.txt'), '0.0.0\n');
  assert.equal(read('CHANGELOG.md'), '');
  assert.equal(read('.github/CODEOWNERS'), '# owners\n/.github/  @owner-login\n/scripts/ @owner-login # kit\n');
  const config = JSON.parse(read(CONFIG_PATH));
  assert.deepEqual([config.org, config.accounts, config.apps], ['acme', { owner: 'owner-login', agent: 'acme-agent[bot]' }, CONFIG.apps]);
  assert.ok(read(CONFIG_PATH).includes(`\n${INLINE_LINE}\n`));
  assert.equal(git(clone, 'log', '-1', '--format=%an %s'), 'Owner chore: set up acme from groundwork v1.2.3');
  assert.equal(git(clone, 'status', '--porcelain'), '');
  assert.equal(git(org, 'rev-parse', 'main'), git(clone, 'rev-parse', 'HEAD'));
});

test('AC1 repo-copy refuses a missing consent note, another branch or a dirty tree, naming the cause', async (t) => {
  const { clone } = cloneFixture(t);
  rmSync(path.join(clone, NOTE));
  await assert.rejects(repoCopy(cloneIo(clone, { answers: [] })), /consent note docs\/runs\/2026-11-23-setup-consent\.md is missing: copy it from docs\/setup\.md/);
  write(clone, NOTE, 'note\n');
  git(clone, 'checkout', '-q', '-b', 'feature');
  await assert.rejects(repoCopy(cloneIo(clone, { answers: [] })), /runs on branch main, not feature/);
  git(clone, 'checkout', '-q', 'main');
  write(clone, 'README.md', 'edited\n');
  const dirty = cloneIo(clone, { answers: [] });
  await assert.rejects(repoCopy(dirty), /README\.md has local changes outside repo-copy/);
  assert.deepEqual(dirty.calls.filter((call) => !call.startsWith('git') || /^git (remote rename|add|commit) /.test(call)), []);
});

test('repo-copy refuses the bot identity and an existing upstream remote beside origin', async (t) => {
  const { clone } = cloneFixture(t);
  git(clone, 'remote', 'add', 'upstream', ORG_URL);
  const both = cloneIo(clone, { answers: ['y'] });
  await assert.rejects(repoCopy(both), /^Error: remotes origin and upstream both exist and origin does not push to github\.com\/acme\/groundwork: create that repository if it does not exist \(gh repo create acme\/groundwork --public\), run git remote set-url origin https:\/\/github\.com\/acme\/groundwork\.git and keep upstream, then rerun$/);
  assert.deepEqual(both.calls.filter((call) => /^git (remote (rename|remove)|add|commit|push)/.test(call)), []);
  git(clone, 'remote', 'remove', 'upstream');
  git(clone, 'config', 'user.name', 'acme-agent[bot]');
  const bot = cloneIo(clone, { answers: [...COPY_ANSWERS] });
  await assert.rejects(repoCopy(bot), /git would commit as acme-agent\[bot\]/);
  assert.ok(!bot.calls.includes(COMMIT));
});

test('repo-copy without a Git identity passes the Git reason through and names user.name and user.email', async (t) => {
  const { clone } = cloneFixture(t);
  const io = cloneIo(clone, { answers: [...COPY_ANSWERS] });
  const capture = io.capture;
  io.capture = (command, args) => (args[0] === 'var'
    ? { status: 128, stdout: '', stderr: 'Author identity unknown\n\n*** Please tell me who you are.\n' }
    : capture(command, args));
  await assert.rejects(repoCopy(io), /Author identity unknown \| \*\*\* Please tell me who you are\.: set user\.name and user\.email/);
  assert.ok(!io.calls.includes(COMMIT));
});

test('repo-copy refuses a push target that is not the org repository, or no upstream remote', async (t) => {
  const { clone } = cloneFixture(t);
  const elsewhere = cloneIo(clone, { answers: [...COPY_ANSWERS], gh: addOrigin(clone, 'https://github.com/other/groundwork.git') });
  await assert.rejects(repoCopy(elsewhere), /origin pushes to https:\/\/github\.com\/other\/groundwork\.git, not github\.com\/acme\/groundwork/);
  assert.ok(!elsewhere.calls.includes(PUSH));
  // A fresh clone with a hand-made setup commit: origin is still upstream.
  const { clone: fresh } = cloneFixture(t);
  write(fresh, '.github/CODEOWNERS', '');
  git(fresh, 'commit', '-q', '-am', 'hand');
  const handMade = cloneIo(fresh, { answers: ['y'] });
  await assert.rejects(repoCopy(handMade), /remote upstream is missing/);
  assert.ok(!handMade.calls.includes(PUSH));
});

test('AC6 after a decline at the commit y/N a rerun passes the prechecks and completes', async (t) => {
  const { clone, org } = cloneFixture(t);
  const declined = cloneIo(clone, { answers: [...COPY_ANSWERS.slice(0, -4), 'n'] });
  assert.equal(await repoCopy(declined), false);
  assert.ok(!declined.calls.includes(REPO_CREATE));
  const rerun = cloneIo(clone, { answers: COPY_ANSWERS.slice(1), org });
  assert.equal(await repoCopy(rerun), true);
  assert.ok(!rerun.calls.includes('git remote rename origin upstream'));
  assert.equal(rerun.calls.at(-1), PUSH);
  assert.equal(git(clone, 'rev-list', '--count', 'refs/remotes/upstream/main..HEAD'), '1');
});

test('AC6 after a failed push a rerun accepts the gh default it wrote, prints the commit, checks origin and pushes it', async (t) => {
  const { clone, org } = cloneFixture(t);
  const failing = cloneIo(clone, { answers: [...COPY_ANSWERS], pushStatus: 1 });
  await assert.rejects(repoCopy(failing), /git push --set-upstream origin failed with exit 1/);
  const rerun = cloneIo(clone, { answers: ['y'], org });
  assert.equal(await repoCopy(rerun), true);
  assert.ok(!rerun.calls.includes(SET_DEFAULT));
  assert.ok(rerun.output.includes('Commit ahead of refs/remotes/upstream/main, from an earlier run:'));
  assert.ok(rerun.output.indexOf('+0.0.0') < rerun.output.indexOf(PUSH));
  assert.ok(!rerun.calls.includes(REPO_CREATE));
  assert.equal(rerun.calls.at(-1), PUSH);
  assert.equal(git(org, 'rev-parse', 'main'), git(clone, 'rev-parse', 'HEAD'));
});

// A clone after the whole step ran and the setup push landed: origin is the org repository, upstream the kit.
async function landedFixture(t) {
  const { clone, org, upstream } = cloneFixture(t);
  assert.equal(await repoCopy(cloneIo(clone, { answers: [...COPY_ANSWERS], org })), true);
  assert.equal(git(clone, 'rev-parse', 'refs/remotes/origin/main'), git(clone, 'rev-parse', 'HEAD'));
  return { clone, org, upstream };
}

const WRITE_CALL = /^git (remote (rename|remove|add|set-url)|add|commit|push)\b|^gh repo create/;
const remoteSnapshot = (clone) => git(clone, 'remote', '-v');
const writeCalls = (io) => io.calls.filter((call) => WRITE_CALL.test(call));
const REMOVE_ADVICE = /git remote remove upstream|remove the groundwork remote/i;

test('AC1 a rerun after the setup push landed finishes with no remote change, commit or push', async (t) => {
  const { clone } = await landedFixture(t);
  const remotesBefore = remoteSnapshot(clone);
  const headBefore = git(clone, 'rev-parse', 'HEAD');
  const rerun = cloneIo(clone, { answers: [] });
  assert.equal(await repoCopy(rerun), true);
  assert.deepEqual(writeCalls(rerun), []);
  assert.equal(remoteSnapshot(clone), remotesBefore);
  assert.equal(git(clone, 'rev-parse', 'HEAD'), headBefore);
  assert.doesNotMatch(everything(rerun), REMOVE_ADVICE);
});

test('AC2 origin elsewhere beside upstream refuses before any write and never advises removing the groundwork remote', async (t) => {
  const other = 'https://github.com/other/groundwork.git';
  // Landed state, then origin repointed.
  const { clone } = await landedFixture(t);
  git(clone, 'remote', 'set-url', 'origin', other);
  const repointed = cloneIo(clone, { answers: [...COPY_ANSWERS] });
  const remotesBefore = remoteSnapshot(clone);
  await assert.rejects(repoCopy(repointed), (error) => !REMOVE_ADVICE.test(error.message));
  assert.deepEqual(writeCalls(repointed), []);
  assert.equal(remoteSnapshot(clone), remotesBefore);
  assert.doesNotMatch(everything(repointed), REMOVE_ADVICE);
  // Fresh clone of the kit with a second remote named origin elsewhere and the kit as upstream.
  const { clone: fresh } = cloneFixture(t);
  git(fresh, 'remote', 'add', 'upstream', ORG_URL);
  const foreign = cloneIo(fresh, { answers: [...COPY_ANSWERS] });
  await assert.rejects(repoCopy(foreign), (error) => !REMOVE_ADVICE.test(error.message));
  assert.deepEqual(writeCalls(foreign), []);
  assert.doesNotMatch(everything(foreign), REMOVE_ADVICE);
});

test('AC2 a pushed origin/main that is not the one setup commit over upstream refuses before any write', async (t) => {
  const { clone } = await landedFixture(t);
  git(clone, 'commit', '--allow-empty', '-q', '-m', 'chore: later change');
  git(clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const remotesBefore = remoteSnapshot(clone);
  const rerun = cloneIo(clone, { answers: [...COPY_ANSWERS] });
  await assert.rejects(repoCopy(rerun), (error) => /origin\/main exists but HEAD is not the one setup commit/.test(error.message) && !REMOVE_ADVICE.test(error.message));
  assert.deepEqual(writeCalls(rerun), []);
  assert.equal(remoteSnapshot(clone), remotesBefore);
  assert.doesNotMatch(everything(rerun), REMOVE_ADVICE);
});

test('AC2 an unpushed origin beside upstream that is not the org repository refuses with set-url advice and keeps upstream', async (t) => {
  const { clone } = cloneFixture(t);
  git(clone, 'remote', 'rename', 'origin', 'upstream');
  git(clone, 'remote', 'add', 'origin', 'https://github.com/other/groundwork.git');
  const remotesBefore = remoteSnapshot(clone);
  const rerun = cloneIo(clone, { answers: [...COPY_ANSWERS] });
  await assert.rejects(repoCopy(rerun), /^Error: remotes origin and upstream both exist and origin does not push to github\.com\/acme\/groundwork: create that repository if it does not exist \(gh repo create acme\/groundwork --public\), run git remote set-url origin https:\/\/github\.com\/acme\/groundwork\.git and keep upstream, then rerun$/);
  assert.deepEqual(writeCalls(rerun), []);
  assert.equal(remoteSnapshot(clone), remotesBefore);
});

// Refuses before any write, leaves the remotes alone and never advises removing one.
async function assertRefusedUntouched({ clone, answers = [], message }) {
  const remotesBefore = remoteSnapshot(clone);
  const rerun = cloneIo(clone, { answers });
  await assert.rejects(repoCopy(rerun), (error) => message.test(error.message) && !REMOVE_ADVICE.test(error.message));
  assert.deepEqual(writeCalls(rerun), []);
  assert.equal(remoteSnapshot(clone), remotesBefore);
  assert.doesNotMatch(everything(rerun), REMOVE_ADVICE);
  return rerun;
}

test('F1 a landed setup commit with a modified copy file refuses on the tree and prints the recovery commands', async (t) => {
  const { clone } = await landedFixture(t);
  write(clone, 'version.txt', '9.9.9\n');
  const rerun = await assertRefusedUntouched({ clone, message: /^version\.txt has local changes but the setup commit is already on origin\/main$/ });
  assert.match(rerun.output.join('\n'), RECOVERY);
});

test('F1 a non-org origin with an existing origin/main beside upstream gets the set-url advice, not the landed-mismatch text', async (t) => {
  const { clone } = await landedFixture(t);
  git(clone, 'commit', '--allow-empty', '-q', '-m', 'chore: later change');
  git(clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(clone, 'remote', 'set-url', 'origin', 'https://github.com/other/groundwork.git');
  await assertRefusedUntouched({ clone, answers: [...COPY_ANSWERS], message: /^remotes origin and upstream both exist and origin does not push to github\.com\/acme\/groundwork: create that repository if it does not exist \(gh repo create acme\/groundwork --public\), run git remote set-url origin https:\/\/github\.com\/acme\/groundwork\.git and keep upstream, then rerun$/ });
});

test('F2 a landed rerun still finishes after the kit moved and was fetched', async (t) => {
  const { clone, upstream } = await landedFixture(t);
  write(upstream, 'README.md', 'kit moved\n');
  git(upstream, '-c', 'user.name=Upstream', '-c', 'user.email=upstream@example.com', 'commit', '-q', '-am', 'kit change');
  git(clone, 'fetch', '-q', 'upstream');
  const remotesBefore = remoteSnapshot(clone);
  const rerun = cloneIo(clone, { answers: [] });
  assert.equal(await repoCopy(rerun), true);
  assert.deepEqual(writeCalls(rerun), []);
  assert.equal(remoteSnapshot(clone), remotesBefore);
  assert.doesNotMatch(everything(rerun), REMOVE_ADVICE);
});

test('F3 an origin that already pushes to the org repository with no upstream refuses, and adding the kit back with a fetch lets the rerun finish', async (t) => {
  const { clone, upstream } = await landedFixture(t);
  git(clone, 'remote', 'remove', 'upstream');
  const rerun = await assertRefusedUntouched({ clone, answers: ['y'], message: /^origin already pushes to github\.com\/acme\/groundwork and the upstream remote is missing: add the groundwork kit back with git remote add -f upstream <the upstream groundwork URL> \(see "upstream updates" in docs\/setup\.md\), then rerun$/ });
  assert.ok(!rerun.calls.includes('git remote rename origin upstream'));
  git(clone, 'remote', 'add', '-f', 'upstream', upstream);
  const headBefore = git(clone, 'rev-parse', 'HEAD');
  const followed = cloneIo(clone, { answers: [] });
  assert.equal(await repoCopy(followed), true);
  assert.deepEqual(writeCalls(followed), []);
  assert.equal(git(clone, 'rev-parse', 'HEAD'), headBefore);
});

test('G1 an upstream remote added without a fetch refuses with the fetch advice, and the rerun after the fetch finishes', async (t) => {
  const { clone, upstream } = await landedFixture(t);
  git(clone, 'remote', 'remove', 'upstream');
  git(clone, 'remote', 'add', 'upstream', upstream);
  await assertRefusedUntouched({ clone, answers: [...COPY_ANSWERS], message: /^remote upstream has no main yet: run git fetch upstream, then rerun$/ });
  git(clone, 'fetch', '-q', 'upstream');
  const followed = cloneIo(clone, { answers: [] });
  assert.equal(await repoCopy(followed), true);
  assert.deepEqual(writeCalls(followed), []);
});

test('G2 a kit clone with upstream beside a foreign origin refuses with set-url advice, and the rerun after it continues to the org push', async (t) => {
  const { clone, org, upstream } = cloneFixture(t);
  git(clone, 'remote', 'add', '-f', 'upstream', upstream);
  await assertRefusedUntouched({ clone, answers: [...COPY_ANSWERS], message: /^remotes origin and upstream both exist and origin does not push to github\.com\/acme\/groundwork: create that repository if it does not exist \(gh repo create acme\/groundwork --public\), run git remote set-url origin https:\/\/github\.com\/acme\/groundwork\.git and keep upstream, then rerun$/ });
  git(clone, 'remote', 'set-url', 'origin', ORG_URL);
  // Following only the set-url advice while the org repository does not exist: the push has nowhere to land.
  rmSync(org, { recursive: true, force: true });
  const failed = cloneIo(clone, { answers: COPY_ANSWERS.slice(1), org });
  await assert.rejects(repoCopy(failed));
  assert.notEqual(git(clone, 'rev-parse', 'refs/remotes/origin/main'), git(clone, 'rev-parse', 'HEAD'));
  // The owner runs the advised gh repo create, then reruns: the commit is already made, so only the push is left.
  git(path.dirname(org), 'init', '-q', '--bare', org);
  const followed = cloneIo(clone, { answers: ['y', 'y', 'y'], org });
  assert.equal(await repoCopy(followed), true);
  assert.ok(!followed.calls.includes('git remote rename origin upstream') && !followed.calls.includes(COMMIT));
  assert.notEqual(git(org, 'rev-parse', 'refs/heads/main'), '');
  assert.ok(followed.calls.includes(PUSH));
  assert.equal(git(clone, 'rev-parse', 'refs/remotes/origin/main'), git(clone, 'rev-parse', 'HEAD'));
  assert.equal(git(clone, 'rev-parse', 'refs/remotes/upstream/main'), git(clone, 'rev-parse', 'HEAD~1'));
});

test('G2 an origin/main the kit lacks beside an org origin still refuses before any write', async (t) => {
  const { clone, upstream } = cloneFixture(t);
  git(clone, 'remote', 'add', '-f', 'upstream', upstream);
  git(clone, 'remote', 'set-url', 'origin', ORG_URL);
  git(clone, 'commit', '--allow-empty', '-q', '-m', 'chore: landed on the org');
  git(clone, 'commit', '--allow-empty', '-q', '-m', 'chore: landed too');
  git(clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  await assertRefusedUntouched({ clone, answers: [...COPY_ANSWERS], message: /^origin\/main exists but HEAD is not the one setup commit/ });
});

test('AC3 the landed-push finish refuses an origin with more than one push URL or a push URL outside the org repository', async (t) => {
  const { clone } = await landedFixture(t);
  const withPushUrls = (urls) => {
    const io = cloneIo(clone, { answers: [] });
    const capture = io.capture;
    io.capture = (command, args) => (args.join(' ') === 'remote get-url --push --all origin'
      ? { ...OK, stdout: `${urls.join('\n')}\n` }
      : capture(command, args));
    return io;
  };
  const two = withPushUrls([ORG_URL, 'https://github.com/other/groundwork.git']);
  await assert.rejects(repoCopy(two), /origin pushes to 2 URLs/);
  const elsewhere = withPushUrls(['https://github.com/other/groundwork.git']);
  await assert.rejects(repoCopy(elsewhere), /origin pushes to https:\/\/github\.com\/other\/groundwork\.git, not github\.com\/acme\/groundwork/);
  for (const io of [two, elsewhere]) assert.deepEqual(writeCalls(io), []);
});

test('AC3 the landed-push finish asks before gh repo set-default when the gh default is not the org repository', async (t) => {
  const { clone } = await landedFixture(t);
  git(clone, 'config', '--unset', 'remote.origin.gh-resolved');
  const declined = cloneIo(clone, { answers: ['n'] });
  assert.equal(await repoCopy(declined), false);
  assert.ok(declined.output.some((line) => line.includes(SET_DEFAULT)));
  assert.ok(!declined.calls.includes(SET_DEFAULT));
  const accepted = cloneIo(clone, { answers: ['y'] });
  assert.equal(await repoCopy(accepted), true);
  assert.ok(accepted.calls.includes(SET_DEFAULT));
  assert.deepEqual(writeCalls(accepted), []);
});

const RECOVERY = /git restore \.\n {2}git reset --hard origin\/main/;

test('AC6 a modified path repo-copy does not write refuses and prints the recovery commands', async (t) => {
  const { clone } = cloneFixture(t);
  write(clone, 'scripts/x.mjs', 'x\n');
  const io = cloneIo(clone, { answers: [] });
  await assert.rejects(repoCopy(io), /scripts\/x\.mjs has local changes outside repo-copy/);
  assert.match(io.output.join('\n'), RECOVERY);
  assert.match(io.output.join('\n'), /\n {2}delete scripts\/x\.mjs$/);
});

test('AC6 a commit outside repo-copy, or a second commit, refuses and prints the recovery commands', async (t) => {
  const { clone } = cloneFixture(t);
  write(clone, 'README.md', 'local\n');
  git(clone, 'commit', '-q', '-am', 'local');
  const other = cloneIo(clone, { answers: [] });
  await assert.rejects(repoCopy(other), /the commit ahead of refs\/remotes\/origin\/main changes README\.md/);
  assert.match(other.output.join('\n'), RECOVERY);
  write(clone, 'version.txt', '9.9.9\n');
  git(clone, 'commit', '-q', '-am', 'second');
  const second = cloneIo(clone, { answers: [] });
  await assert.rejects(repoCopy(second), /HEAD is 2 commits ahead/);
  assert.match(second.output.join('\n'), RECOVERY);
});

test('consent A refuses repo-copy after the skip prompt, before any write', async () => {
  const io = fakeIo({ answers: [''], files: { [STATE_PATH]: JSON.stringify(stateWith({}, { answer: 'A', classes: [] })) } });
  assert.equal(await main(io, ['--step', 'repo-copy']), 1);
  assert.match(io.output.join('\n'), /consent A keeps repo-copy in the browser/);
  assert.ok(!io.calls.some((call) => /^git (remote rename|add|commit)|^gh repo/.test(call)));
});

test('every child gets the hook-free git config in its environment, so the git gh runs skips hooks too', () => {
  const hookFree = {
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/empty', GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false',
  };
  assert.deepEqual(gitConfigEnvironment({ PATH: '/bin' }, '/empty'), { PATH: '/bin', ...hookFree });
  // The wiring terminalIo uses for every spawn: gh keeps the git settings and loses forced colour.
  assert.deepEqual(childEnvironment({ command: 'gh', env: { PATH: '/bin', GH_FORCE_TTY: '1' }, hooksDir: '/empty' }), { PATH: '/bin', ...hookFree, NO_COLOR: '1' });
  for (const command of ['git', 'powershell.exe']) {
    assert.deepEqual(childEnvironment({ command, env: { PATH: '/bin' }, hooksDir: '/empty' }), { PATH: '/bin', ...hookFree });
  }
});

test('repo-copy refuses a clone whose .git/config sets a key outside the allowlist, naming it', async (t) => {
  const { clone } = cloneFixture(t);
  for (const [key, value] of [['gpg.program', 'evil'], ['credential.helper', '!evil'], ['core.sshCommand', 'evil'], ['filter.x.clean', 'evil'], ['remote.origin.pushurl', ORG_URL]]) {
    git(clone, 'config', '--local', key, value);
    const io = cloneIo(clone, { answers: [...COPY_ANSWERS] });
    await assert.rejects(repoCopy(io), new RegExp(`\\.git/config sets ${key.toLowerCase().replaceAll('.', '\\.')}`));
    assert.ok(!io.calls.some((call) => /^git (remote rename|add|commit|push)/.test(call)));
    git(clone, 'config', '--local', '--unset', key);
  }
  git(clone, 'config', '--local', 'branch.main.rebase', 'false');
  // A gh default set in the upstream clone moves to upstream on the rename, where gh would keep resolving to it.
  git(clone, 'config', '--local', 'remote.origin.gh-resolved', 'base');
  const upstreamDefault = cloneIo(clone, { answers: [...COPY_ANSWERS] });
  await assert.rejects(repoCopy(upstreamDefault), /remote upstream is gh's default: run git config --unset remote\.upstream\.gh-resolved, then rerun/);
  assert.ok(!upstreamDefault.calls.includes(REPO_CREATE));
  git(clone, 'config', '--unset', 'remote.upstream.gh-resolved');
  assert.equal(await repoCopy(cloneIo(clone, { answers: ['y', 'y', 'y'] })), true);
});

test('repo-copy refuses an origin with a second push URL', async (t) => {
  const { clone } = cloneFixture(t);
  const twoUrls = () => {
    git(clone, 'remote', 'add', 'origin', ORG_URL);
    git(clone, 'remote', 'set-url', '--add', '--push', 'origin', ORG_URL);
    git(clone, 'remote', 'set-url', '--add', '--push', 'origin', 'https://github.com/other/groundwork.git');
    return OK;
  };
  const io = cloneIo(clone, { answers: [...COPY_ANSWERS], gh: twoUrls });
  await assert.rejects(repoCopy(io), /origin pushes to 2 URLs/);
  assert.ok(!io.calls.includes(PUSH));
});

// Spec 2.2 to 2.4, copied here so a change to the step's list fails this test.
const SPEC_PERMISSIONS = {
  'app-agent': ['Contents RW', 'Pull requests RW', 'Issues RW', 'Workflows RW', 'Actions RW', 'Commit statuses R', 'Metadata R'],
  'app-admin': ['Administration RW', 'Contents RW', 'Environments RW', 'Secrets RW', 'Variables RW', 'Issues RW', 'Pull requests RW',
    'Workflows RW', 'Actions RW', 'Metadata R', 'Issue types RW', 'Members R'],
  'app-release': ['Contents RW', 'Pull requests RW', 'Issues RW', 'Metadata R'],
};

test('AC2 each App step opens the new-App page for the org, prints every spec permission, then the install page', async () => {
  for (const [id, permissions] of Object.entries(SPEC_PERMISSIONS)) {
    const io = fakeIo({ answers: ['y', 'y'] });
    assert.equal(await STEP_HANDLERS[id](io, context()), true);
    const slug = CONFIG.apps[id.slice('app-'.length)];
    assert.deepEqual(io.opened, ['https://github.com/organizations/acme/settings/apps/new', `https://github.com/organizations/acme/settings/apps/${slug}/installations`]);
    const text = io.output.join('\n');
    for (const permission of [...permissions, `GitHub App name: ${slug}`, 'Only on this account', 'All repositories']) assert.ok(text.includes(permission), `${id}: ${permission}`);
    if (id !== 'app-admin') assert.match(text, /Organization permissions: none/);
  }
  const declined = fakeIo({ answers: ['n'] });
  assert.equal(await STEP_HANDLERS['app-release'](declined, context()), false);
  assert.equal(declined.opened.length, 1);
});

test('AC3 admin-secrets sends each key only on stdin; argv, output and setup-state.json never hold it', async () => {
  const files = { '/keys/admin.pem': KEY('ADMIN-SECRET-MATERIAL'), '/keys/release.pem': KEY('RELEASE-SECRET-MATERIAL'), [STATE_PATH]: JSON.stringify(stateWith()) };
  const answers = ['', '/keys/admin.pem', 'y', 'Iv23liAdmin', 'y', '"/keys/release.pem"', 'y', '5796650', 'y', 'y', 'n'];
  const io = fakeIo({ answers, files });
  assert.equal(await main(io, ['--step', 'admin-secrets']), 0);
  assert.deepEqual(io.piped, [
    { call: 'gh secret set ADMIN_APP_KEY --env admin --repo acme/groundwork', input: files['/keys/admin.pem'] },
    { call: 'gh secret set RELEASE_APP_KEY --env admin --repo acme/groundwork', input: files['/keys/release.pem'] },
  ]);
  assert.ok(io.calls.includes('gh variable set ADMIN_APP_CLIENT_ID --env admin --repo acme/groundwork --body Iv23liAdmin'));
  assert.ok(io.calls.includes('gh variable set RELEASE_APP_CLIENT_ID --env admin --repo acme/groundwork --body 5796650'));
  assert.ok(io.output.includes('gh secret set ADMIN_APP_KEY --env admin --repo acme/groundwork < /keys/admin.pem'));
  assert.doesNotMatch(everything(io), /SECRET-MATERIAL/);
  assert.doesNotMatch(io.files.get(STATE_PATH), /SECRET-MATERIAL/);
  assert.equal(JSON.parse(io.files.get(STATE_PATH)).steps['admin-secrets'].status, 'done');
  assert.deepEqual(io.removed, ['/keys/admin.pem']);
  const notKey = fakeIo({ answers: ['/keys/x.pem'], files: { '/keys/x.pem': 'ADMIN-SECRET-MATERIAL' } });
  await assert.rejects(STEP_HANDLERS['admin-secrets'](notKey, context()), /\/keys\/x\.pem is not a PEM private key/);
  assert.doesNotMatch(everything(notKey), /SECRET-MATERIAL/);
  const failing = fakeIo({ answers: ['/keys/admin.pem', 'y'], files, replies: { 'gh secret set': { status: 1, stdout: '', stderr: 'HTTP 404' } } });
  await assert.rejects(STEP_HANDLERS['admin-secrets'](failing, context()),
    /gh secret set ADMIN_APP_KEY failed with exit 1; its output is hidden because it read a key; run it yourself to see why: gh secret set ADMIN_APP_KEY --env admin --repo acme\/groundwork < \/keys\/admin\.pem$/);
});

const SIGNED_IN = { 'gh api user': { ...OK, stdout: 'WianVDM 4242\n' } };
const POLICIES = 'gh api /repos/acme/groundwork/environments/admin/deployment-branch-policies';

test('AC4 admin-environment sends the signed-in owner as reviewer, a main branch policy and no admin bypass', async () => {
  const io = fakeIo({ answers: ['y', 'y'], replies: SIGNED_IN });
  assert.equal(await STEP_HANDLERS['admin-environment'](io, context()), true);
  assert.ok(io.output.indexOf('reviewer: WianVDM (id 4242)') < io.output.indexOf('gh api -X PUT /repos/acme/groundwork/environments/admin --input - < the body above'));
  assert.equal(io.piped[0].call, 'gh api -X PUT /repos/acme/groundwork/environments/admin --input -');
  assert.deepEqual(JSON.parse(io.piped[0].input), {
    reviewers: [{ type: 'User', id: 4242 }], prevent_self_review: false, can_admins_bypass: false,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  });
  assert.equal(io.calls.at(-1), 'gh api -X POST /repos/acme/groundwork/environments/admin/deployment-branch-policies -f name=main -f type=branch');
  const rerun = fakeIo({ answers: ['y'], replies: { ...SIGNED_IN, [POLICIES]: { ...OK, stdout: 'branch:main\n' } } });
  assert.equal(await STEP_HANDLERS['admin-environment'](rerun, context()), true);
  assert.ok(!rerun.calls.some((call) => call.includes('-X POST')));
});

test('admin-environment refuses another signed-in user, stops on extra policies and shows gh errors', async () => {
  const stranger = fakeIo({ answers: ['y'], replies: { 'gh api user': { ...OK, stdout: 'someone 7\n' } } });
  await assert.rejects(STEP_HANDLERS['admin-environment'](stranger, context()), /gh is signed in as someone, but .* accounts\.owner is wianvdm/);
  assert.deepEqual(stranger.piped, []);
  const wide = fakeIo({ answers: ['y'], replies: { ...SIGNED_IN, [POLICIES]: { ...OK, stdout: 'branch:main\ntag:v*\n' } } });
  assert.equal(await STEP_HANDLERS['admin-environment'](wide, context()), false);
  assert.match(wide.output.at(-1), /admin allows branch:main, tag:v\*; spec 10\.1 allows only branch:main/);
  const rejected = fakeIo({ answers: ['y'], replies: { ...SIGNED_IN, 'gh api -X PUT': { status: 1, stdout: '', stderr: 'HTTP 422: Validation Failed\n' } } });
  await assert.rejects(STEP_HANDLERS['admin-environment'](rejected, context()), /gh api -X PUT failed with exit 1: HTTP 422: Validation Failed$/);
});

test('AC5 elsewhere the key goes to a 0600 PEM and the wizard prints the variables to set', async () => {
  const files = { '/keys/agent.pem': KEY('AGENT-SECRET-MATERIAL') };
  const home = '/home/o w';
  const typed = path.join(home, 'keys', 'agent.pem');
  const io = fakeIo({ answers: ['Iv23liAgent', '~/keys/agent.pem', 'y'], files: { [typed]: files['/keys/agent.pem'] }, env: { HOME: home } });
  assert.equal(await STEP_HANDLERS['agent-key-store'](io, context()), true);
  const target = path.join(home, '.config', 'groundwork', 'acme-agent.pem');
  assert.deepEqual([...io.privateFiles], [[target, files['/keys/agent.pem']]]);
  assert.ok(io.output.join('\n').includes(`export GROUNDWORK_AGENT_KEY_FILE='${target}'\n  export GROUNDWORK_AGENT_CLIENT_ID=Iv23liAgent`));
  assert.equal(io.output.at(-1), `Then delete the downloaded key ${typed} once token.mjs works.`);
  assert.doesNotMatch(everything(io), /SECRET-MATERIAL/);
  const chosen = fakeIo({ answers: ['Iv23liAgent', '/keys/agent.pem', 'y'], files, env: { GROUNDWORK_AGENT_KEY_FILE: '/secure/agent.pem' } });
  await STEP_HANDLERS['agent-key-store'](chosen, context());
  assert.deepEqual([...chosen.privateFiles.keys()], ['/secure/agent.pem']);
});

// Windows has no POSIX modes and needs a privilege for symlinks, so those assertions run on Linux CI only.
const POSIX = process.platform !== 'win32';

test('AC5 writePrivateFile replaces an existing file with a fresh 0600 one, cleans up a failed rename, refuses a symlink', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'groundwork-key-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fresh = path.join(directory, 'nested', 'agent.pem');
  writePrivateFile(fresh, 'x');
  assert.equal(readFileSync(fresh, 'utf8'), 'x');
  const wide = path.join(directory, 'wide.pem');
  writeFileSync(wide, 'old', { mode: 0o644 });
  writePrivateFile(wide, 'key');
  assert.equal(readFileSync(wide, 'utf8'), 'key');
  const blocked = path.join(directory, 'blocked.pem');
  mkdirSync(path.join(blocked, 'inside'), { recursive: true });
  assert.throws(() => writePrivateFile(blocked, 'key'));
  assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith('.new')), []);
  if (POSIX) {
    assert.deepEqual([statSync(fresh).mode & 0o777, statSync(wide).mode & 0o777], [0o600, 0o600]);
    const link = path.join(directory, 'link.pem');
    symlinkSync(wide, link);
    assert.throws(() => writePrivateFile(link, 'other'), /link\.pem is a symlink/);
    assert.equal(readFileSync(wide, 'utf8'), 'key');
  }
});

test('AC5 on Windows the key goes through DPAPI to the files token.mjs reads, then the PEM may be deleted', async () => {
  const appData = 'C:\\Users\\owner\\AppData\\Roaming';
  const files = { '/keys/agent.pem': KEY('AGENT-SECRET-MATERIAL') };
  const replies = { 'powershell.exe': { ...OK, stdout: '01000000d08c9ddf\r\n' } };
  const io = fakeIo({ answers: ['Iv23liAgent', '/keys/agent.pem', '5853598', 'y', 'y'], files, platform: 'win32', env: { APPDATA: appData }, replies });
  assert.equal(await STEP_HANDLERS['agent-key-store'](io, context()), true);
  assert.equal(io.piped.length, 1);
  assert.match(io.piped[0].call, /^powershell\.exe -NoProfile -NonInteractive -Command ConvertTo-SecureString .*ConvertFrom-SecureString$/);
  assert.equal(io.piped[0].input, files['/keys/agent.pem']);
  assert.equal(io.files.get(`${appData}\\groundwork\\acme-agent.pem.dpapi`), '01000000d08c9ddf\n');
  assert.deepEqual(JSON.parse(io.files.get(`${appData}\\groundwork\\acme-agent.json`)), { appId: 5853598, slug: 'acme-agent', clientId: 'Iv23liAgent' });
  assert.deepEqual(io.removed, ['/keys/agent.pem']);
  assert.doesNotMatch(everything(io), /SECRET-MATERIAL/);
  const failed = fakeIo({ answers: ['Iv23liAgent', '/keys/agent.pem', '5853598', 'y'], files, platform: 'win32', env: { APPDATA: appData }, replies: { 'powershell.exe': { status: 1, stdout: '', stderr: 'AGENT-SECRET-MATERIAL' } } });
  await assert.rejects(STEP_HANDLERS['agent-key-store'](failed, context()), /DPAPI encryption failed with exit 1; .* nothing was written$/);
  assert.ok(![...failed.files.keys()].some((name) => name.startsWith(appData)));
  assert.doesNotMatch(everything(failed), /SECRET-MATERIAL/);
});

test('gh drops colour variables in any case; the start refusal names the manual removal command', async () => {
  assert.deepEqual(ghEnvironment({ clicolor_force: '1', Gh_Force_Tty: '1', no_color: '0', PATH: '/bin' }), { PATH: '/bin', NO_COLOR: '1' });
  const io = fakeIo({ files: { [STATE_PATH]: JSON.stringify(stateWith()) }, replies: { 'gh auth status': { ...OK, status: 1 } } });
  assert.equal(await main(io, []), 1);
  assert.match(io.output.at(-1), /cannot read the scopes .*run: gh auth refresh --remove-scopes admin:org$/);
});

const COPY_FILES = [CONFIG_PATH, '.github/CODEOWNERS'];
const snapshotCopyFiles = (clone) => COPY_FILES.map((file) => readFileSync(path.join(clone, file), 'utf8'));

test('#307 AC2 repo-copy refuses a typed owner login that starts with a hyphen, asks once and writes nothing', async (t) => {
  const { clone } = cloneFixture(t);
  const before = snapshotCopyFiles(clone);
  const io = cloneIo(clone, { answers: ['y', '-d', ...COPY_ANSWERS.slice(2)] });
  await assert.rejects(repoCopy(io), /Owner login/);
  assert.equal(io.output.filter((line) => line.startsWith('Owner login')).length, 1);
  assert.deepEqual(snapshotCopyFiles(clone), before);
  assert.deepEqual(io.calls.filter((call) => call.startsWith('gh repo')), []);
});

test('#307 AC3 repo-copy refuses a typed owner that differs from the signed-in gh user before writing files', async (t) => {
  const { clone } = cloneFixture(t);
  const before = snapshotCopyFiles(clone);
  const io = cloneIo(clone, { answers: [...COPY_ANSWERS], login: 'someone-else' });
  await assert.rejects(repoCopy(io), (error) => /someone-else/.test(error.message) && /owner-login/i.test(error.message));
  assert.deepEqual(snapshotCopyFiles(clone), before);
  assert.ok(!io.calls.includes(COMMIT) && !io.calls.includes(REPO_CREATE));
});

test('#307 AC3 repo-copy accepts a typed owner that differs from the signed-in gh user only by case', async (t) => {
  const { clone, org } = cloneFixture(t);
  const io = cloneIo(clone, { answers: [...COPY_ANSWERS], login: 'owner-login', org });
  assert.equal(await repoCopy(io), true);
});

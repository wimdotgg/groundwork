import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { STEP_HANDLERS } from './steps.mjs';
import { ghEnvironment, main, writePrivateFile } from './setup.mjs';

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
const COPY_ADD = `git add -- ${CONFIG_PATH} .github/CODEOWNERS .release-please-manifest.json version.txt CHANGELOG.md ${NOTE}`;
const REPO_CREATE = 'gh repo create acme/groundwork --public --source . --remote origin --push';
const COMMIT = 'git commit -m chore: set up acme from groundwork v1.2.3';
const stateWith = (steps = {}) => ({
  schemaVersion: 1, org: 'acme', consent: { answer: 'B', classes: ['wizard'], answeredAt: NOW, endedAt: null }, steps,
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
    [CONFIG_PATH, `${JSON.stringify(CONFIG, null, 2)}\n`], ['.github/CODEOWNERS', '# owners\n/.github/  @wianvdm\n/scripts/ @wianvdm @other # kit\n'],
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
  return { clone, org };
}

// Runs git for real in the clone; gh is the given fake.
function cloneIo(clone, { answers, gh = () => OK }) {
  const io = fakeIo({ answers });
  const run = (command, args) => {
    io.calls.push([command, ...args].join(' '));
    if (command === 'gh') return gh(args);
    const result = spawnSync('git', args, { cwd: clone, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  return Object.assign(io, {
    root: clone, capture: run, attach: run,
    readText: (file) => { try { return readFileSync(file, 'utf8'); } catch { return null; } },
    writeText: (file, text) => writeFileSync(file, text),
  });
}
// y to the rename, owner login, three default slugs, then y to the files, the release reset, the commit and the push.
const COPY_ANSWERS = ['y', 'Owner-Login', '', '', '', 'y', 'y', 'y', 'y'];
const repoCopy = (io) => STEP_HANDLERS['repo-copy'](io, context());

test('AC1 repo-copy renames, writes, resets, stages by name, shows diff and note, commits, then pushes last', async (t) => {
  const { clone } = cloneFixture(t);
  const io = cloneIo(clone, { answers: [...COPY_ANSWERS] });
  assert.equal(await repoCopy(io), true);
  const at = (call) => io.calls.indexOf(call);
  assert.ok(at('git remote rename origin upstream') < at(COPY_ADD) && at(COPY_ADD) < at(COMMIT));
  assert.equal(io.calls.at(-1), REPO_CREATE);
  assert.ok(!io.calls.some((call) => / add (-A|--all|\.)/.test(call) || call.includes('commit -a')));
  const shown = io.output.indexOf(COMMIT);
  assert.ok(io.output.findIndex((line) => line === '+0.0.0') < shown);
  assert.ok(io.output.indexOf('answer: B') < shown && io.output.indexOf('answer: B') > -1);
  const read = (file) => readFileSync(path.join(clone, file), 'utf8');
  assert.equal(read('.release-please-manifest.json'), '{}\n');
  assert.equal(read('version.txt'), '0.0.0\n');
  assert.equal(read('CHANGELOG.md'), '');
  assert.equal(read('.github/CODEOWNERS'), '# owners\n/.github/  @owner-login\n/scripts/ @owner-login # kit\n');
  const config = JSON.parse(read(CONFIG_PATH));
  assert.deepEqual([config.org, config.accounts, config.apps], ['acme', { owner: 'owner-login', agent: 'acme-agent[bot]' }, CONFIG.apps]);
  assert.equal(git(clone, 'log', '-1', '--format=%an %s'), 'Owner chore: set up acme from groundwork v1.2.3');
  assert.equal(git(clone, 'status', '--porcelain'), '');
  assert.equal(git(clone, 'remote'), 'upstream');
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

test('AC6 after a decline at the commit y/N a rerun passes the prechecks and completes', async (t) => {
  const { clone } = cloneFixture(t);
  const declined = cloneIo(clone, { answers: [...COPY_ANSWERS.slice(0, -2), 'n'] });
  assert.equal(await repoCopy(declined), false);
  assert.ok(!declined.calls.includes(REPO_CREATE));
  const rerun = cloneIo(clone, { answers: COPY_ANSWERS.slice(1) });
  assert.equal(await repoCopy(rerun), true);
  assert.ok(!rerun.calls.includes('git remote rename origin upstream'));
  assert.equal(rerun.calls.at(-1), REPO_CREATE);
  assert.equal(git(clone, 'rev-list', '--count', 'refs/remotes/upstream/main..HEAD'), '1');
});

test('AC6 after a failed push a rerun prints the commit and pushes it', async (t) => {
  const { clone, org } = cloneFixture(t);
  // gh adds the remote, then the push fails.
  const failing = cloneIo(clone, { answers: [...COPY_ANSWERS], gh: () => { git(clone, 'remote', 'add', 'origin', org); return { ...OK, status: 1 }; } });
  await assert.rejects(repoCopy(failing), /gh repo create acme\/groundwork failed with exit 1/);
  const rerun = cloneIo(clone, { answers: ['y'] });
  assert.equal(await repoCopy(rerun), true);
  assert.ok(rerun.output.includes('Commit ahead of refs/remotes/upstream/main, from an earlier run:'));
  assert.ok(rerun.output.indexOf('+0.0.0') < rerun.output.indexOf('git push --set-upstream origin main'));
  assert.equal(rerun.calls.at(-1), 'git push --set-upstream origin main');
  assert.equal(git(org, 'rev-parse', 'main'), git(clone, 'rev-parse', 'HEAD'));
});

const RECOVERY = /git restore \.\n {2}git reset --hard origin\/main/;

test('AC6 a modified path repo-copy does not write refuses and prints the recovery commands', async (t) => {
  const { clone } = cloneFixture(t);
  write(clone, 'scripts/x.mjs', 'x\n');
  const io = cloneIo(clone, { answers: [] });
  await assert.rejects(repoCopy(io), /scripts\/x\.mjs has local changes outside repo-copy/);
  assert.match(io.output.join('\n'), RECOVERY);
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
});

test('AC4 admin-environment sends the owner as reviewer, a main branch policy and no admin bypass', async () => {
  const io = fakeIo({ answers: ['y', 'y'], replies: { 'gh api /users/wianvdm': { ...OK, stdout: '4242\n' } } });
  assert.equal(await STEP_HANDLERS['admin-environment'](io, context()), true);
  assert.equal(io.piped[0].call, 'gh api -X PUT /repos/acme/groundwork/environments/admin --input -');
  assert.deepEqual(JSON.parse(io.piped[0].input), {
    reviewers: [{ type: 'User', id: 4242 }], prevent_self_review: false, can_admins_bypass: false,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  });
  assert.equal(io.calls.at(-1), 'gh api -X POST /repos/acme/groundwork/environments/admin/deployment-branch-policies -f name=main -f type=branch');
  const rerun = fakeIo({ answers: ['y'], replies: { 'gh api /users/': { ...OK, stdout: '4242\n' }, 'gh api /repos/acme/groundwork/environments/admin/deployment-branch-policies': { ...OK, stdout: 'branch:main\n' } } });
  assert.equal(await STEP_HANDLERS['admin-environment'](rerun, context()), true);
  assert.ok(!rerun.calls.some((call) => call.includes('-X POST')));
});

test('AC5 elsewhere the key goes to a 0600 PEM and the wizard prints the variables to set', async () => {
  const files = { '/keys/agent.pem': KEY('AGENT-SECRET-MATERIAL') };
  const io = fakeIo({ answers: ['Iv23liAgent', '/keys/agent.pem', 'y'], files, env: { HOME: '/home/owner' } });
  assert.equal(await STEP_HANDLERS['agent-key-store'](io, context()), true);
  const target = path.join('/home/owner', '.config', 'groundwork', 'acme-agent.pem');
  assert.deepEqual([...io.privateFiles], [[target, files['/keys/agent.pem']]]);
  assert.match(io.output.join('\n'), new RegExp(`export GROUNDWORK_AGENT_KEY_FILE=${target.replaceAll('\\', '\\\\')}\n {2}export GROUNDWORK_AGENT_CLIENT_ID=Iv23liAgent`));
  assert.doesNotMatch(everything(io), /SECRET-MATERIAL/);
  const chosen = fakeIo({ answers: ['Iv23liAgent', '/keys/agent.pem', 'y'], files, env: { GROUNDWORK_AGENT_KEY_FILE: '/secure/agent.pem' } });
  await STEP_HANDLERS['agent-key-store'](chosen, context());
  assert.deepEqual([...chosen.privateFiles.keys()], ['/secure/agent.pem']);
  const directory = mkdtempSync(path.join(tmpdir(), 'groundwork-key-'));
  const file = path.join(directory, 'nested', 'agent.pem');
  writePrivateFile(file, 'x');
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  rmSync(directory, { recursive: true, force: true });
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
});

test('gh drops colour variables in any case; the start refusal names the manual removal command', async () => {
  assert.deepEqual(ghEnvironment({ clicolor_force: '1', Gh_Force_Tty: '1', no_color: '0', PATH: '/bin' }), { PATH: '/bin', NO_COLOR: '1' });
  const io = fakeIo({ files: { [STATE_PATH]: JSON.stringify(stateWith()) }, replies: { 'gh auth status': { ...OK, status: 1 } } });
  assert.equal(await main(io, []), 1);
  assert.match(io.output.at(-1), /cannot read the scopes .*run: gh auth refresh --remove-scopes admin:org$/);
});

// Owner wizard (spec 14.3). The owner runs it in their own terminal under their own login; agents never do.
// Imports stay inside Node built-ins, scripts/owner/ and scripts/lib/ (all CODEOWNERS paths).
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STEP_HANDLERS, baselineRemote, clean } from './steps.mjs';

export { clean };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENT_GH_CONFIG = '.claude/gh-agent';
const STATE_ENV = 'GROUNDWORK_SETUP_STATE_FILE';
const SCHEMA_VERSION = 1;
const ORG_LOGIN = /^[A-Za-z0-9-]+$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const STATUSES = ['pending', 'done', 'skipped'];
const REVIEWED_PATHS = ['scripts/owner', 'scripts/lib'];
const ADMIN_ORG = 'admin:org';
const ADD_ADMIN_ORG = ['auth', 'refresh', '-s', ADMIN_ORG];
const REMOVE_ADMIN_ORG = ['auth', 'refresh', '--remove-scopes', ADMIN_ORG];
const AUTH_STATUS = ['auth', 'status', '--active', '--hostname', 'github.com'];
const SCOPES_LINE = /Token scopes:[ \t]*(.*)$/m;
const SGR_SEQUENCE = /\u001b\[[0-9;]*m/g;
const QUOTED_SCOPE = /'([^']+)'/g;
// Windows reports a console Ctrl+C as this exit code (STATUS_CONTROL_C_EXIT) instead of a signal.
const WINDOWS_CTRL_C_EXIT = 0xc000013a;
const INTERRUPTED = 'interrupted';
// gh colours the scope list when CLICOLOR_FORCE or GH_FORCE_TTY is set, even on a pipe.
const GH_COLOUR_VARIABLES = ['CLICOLOR_FORCE', 'GH_FORCE_TTY', 'NO_COLOR'];
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

export const STEPS = [
  ['org-create', 'browser'], ['org-2fa', 'browser'], ['org-base-permission', 'wizard'], ['org-pat-policy', 'browser'],
  ['org-actions', 'wizard'], ['org-team-agents', 'browser'], ['repo-copy', 'wizard'], ['app-agent', 'browser'],
  ['agent-key-store', 'wizard'], ['app-admin', 'browser'], ['app-release', 'browser'], ['admin-environment', 'wizard'],
  ['admin-secrets', 'wizard'], ['issue-types', 'app', 'request.mjs create-issue-types'],
  ['apply-settings', 'app', 'request.mjs apply-settings --repo groundwork --ref <main sha>, then probe'],
  ['release-dispatch', 'app', 'dispatch release-please.yml'], ['release-merge', 'browser'],
].map(([id, kind, request]) => ({ id, kind, request }));
const STEP_BY_ID = new Map(STEPS.map((step) => [step.id, step]));

// URLs and commands come from the validated org and these constants, never from the state file.
const BROWSER_PAGES = {
  'org-create': { url: () => 'https://github.com/account/organizations/new?plan=free', field: 'Plan', value: 'Free', verify: 'the new organization page opens' },
  'org-2fa': { url: (org) => `https://github.com/organizations/${org}/settings/security`, field: 'Two-factor authentication', value: 'Require two-factor authentication for everyone in the organization', verify: 'the box stays checked after Save' },
  'org-pat-policy': { url: (org) => `https://github.com/organizations/${org}/settings/personal-access-tokens`, field: 'Fine-grained personal access tokens', value: 'Require administrator approval', verify: 'the approval option stays selected after Save' },
};
// The REST endpoint requires enabled_repositories, so the step cannot leave it unchanged.
const ENABLED_REPOSITORIES_NOTE = 'Note: this sends enabled_repositories=all (the API requires it). If the org limits Actions to selected repositories or none, this turns Actions on for every repository.';
const WIZARD_COMMANDS = {
  'org-base-permission': (org) => [{ args: ['api', '-X', 'PATCH', `/orgs/${org}`, '-f', 'default_repository_permission=read', '-F', 'members_can_create_repositories=false'] }],
  'org-actions': (org) => [
    { args: ['api', '-X', 'PUT', `/orgs/${org}/actions/permissions`, '-f', 'enabled_repositories=all', '-F', 'sha_pinning_required=true'], note: ENABLED_REPOSITORIES_NOTE },
    { args: ['api', '-X', 'PUT', `/orgs/${org}/actions/permissions/fork-pr-contributor-approval`, '-f', 'approval_policy=all_external_contributors'] },
    { args: ['api', '-X', 'PUT', `/orgs/${org}/actions/permissions/workflow`, '-F', 'can_approve_pull_request_reviews=false'] },
  ],
};

const refuse = (reason) => { throw new Error(reason); };
const messageOf = (error) => clean(error?.message ?? error);

export function environmentRefusal({ env, stdinTTY, stdoutTTY }) {
  if (!stdinTTY || !stdoutTTY) return 'stdin and stdout must be a terminal: run the wizard yourself, not through a pipe or an agent';
  if (env.GH_TOKEN) return 'GH_TOKEN is set: the wizard uses your own gh login, not the agent token';
  const configDir = (env.GH_CONFIG_DIR ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
  if (configDir.endsWith(AGENT_GH_CONFIG)) return `GH_CONFIG_DIR points at ${AGENT_GH_CONFIG}: run the wizard outside an agent session`;
  if (env.CLAUDECODE) return 'CLAUDECODE is set: the wizard never runs inside an agent session';
  return null;
}

// Node on Windows looks for a bare command name in the working directory before PATH unless this is set,
// so a git.exe or gh.exe planted at the repository root would run under the owner login (spec 17).
export function hardenExecutableLookup(env) {
  env.NoDefaultCurrentDirectoryInExePath = '1';
}

export function stateFilePath({ env, platform }) {
  if (env[STATE_ENV]) return env[STATE_ENV];
  if (platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'groundwork', 'setup-state.json');
  return refuse(`set ${STATE_ENV} to the setup-state.json path`);
}

const requireObject = (object, where) => {
  if (!object || typeof object !== 'object' || Array.isArray(object)) refuse(`setup-state.json: ${where} is not an object`);
};
const exactKeys = (object, keys, where) => {
  requireObject(object, where);
  const unknown = Object.keys(object).find((key) => !keys.includes(key));
  if (unknown !== undefined) refuse(`setup-state.json: unknown key ${clean(unknown)} in ${where}`);
  const missing = keys.find((key) => !Object.hasOwn(object, key));
  if (missing !== undefined) refuse(`setup-state.json: missing key ${missing} in ${where}`);
};
const isText = (value, pattern) => typeof value === 'string' && pattern.test(value);
const timestamp = (value, where) => (isText(value, ISO_UTC) ? value : refuse(`setup-state.json: ${where} is not ISO 8601 UTC`));

export function validateState(state) {
  exactKeys(state, ['schemaVersion', 'org', 'consent', 'steps'], 'the file');
  if (state.schemaVersion !== SCHEMA_VERSION) refuse(`setup-state.json: schemaVersion must be ${SCHEMA_VERSION}`);
  exactKeys(state.consent, ['answer', 'classes', 'answeredAt', 'endedAt'], 'consent');
  const { answer, classes } = state.consent;
  const expected = typeof answer === 'string' ? { A: '[]', B: '["wizard"]' }[answer] : undefined;
  if (!expected || JSON.stringify(classes) !== expected) refuse('setup-state.json: consent answer and classes do not match A or B');
  timestamp(state.consent.answeredAt, 'consent.answeredAt');
  if (state.consent.endedAt !== null) timestamp(state.consent.endedAt, 'consent.endedAt');
  requireObject(state.steps, 'steps');
  for (const [id, entry] of Object.entries(state.steps)) validateStepEntry(id, entry);
  if (state.org === null && statusOf(state, 'org-create') !== 'pending') refuse('setup-state.json: org is null after org-create');
  if (state.org !== null && !isText(state.org, ORG_LOGIN)) refuse('setup-state.json: org is not a valid login');
  return state;
}

function validateStepEntry(id, entry) {
  if (!STEP_BY_ID.has(id)) refuse(`setup-state.json: unknown step ${clean(id)} in steps`);
  exactKeys(entry, ['status', 'updatedAt', 'note'], `steps.${id}`);
  if (!STATUSES.includes(entry.status)) refuse(`setup-state.json: unknown status in steps.${id}`);
  timestamp(entry.updatedAt, `steps.${id}.updatedAt`);
  if (typeof entry.note !== 'string') refuse(`setup-state.json: steps.${id}.note is not text`);
  if (entry.status === 'skipped' && !entry.note.trim()) refuse(`setup-state.json: steps.${id} is skipped without a note`);
}

const statusOf = (state, id) => state.steps[id]?.status ?? 'pending';
const finished = (state, id) => statusOf(state, id) !== 'pending';

export function stepsToRun(state, stepArgument) {
  const start = STEPS.findIndex((step) => !finished(state, step.id));
  if (stepArgument === undefined) return start === -1 ? [] : STEPS.slice(start);
  const step = STEP_BY_ID.get(stepArgument);
  if (!step) refuse(`unknown step ${clean(stepArgument)}`);
  if (step.kind === 'app') refuse(`${step.id} is an app step: the agent runs it`);
  return [step];
}

export const gitArguments = (hooksDir, args) => ['-c', `core.hooksPath=${hooksDir}`, '-c', 'core.fsmonitor=false', ...args];

export function checkReviewedCode(io) {
  const git = (...args) => {
    const result = io.capture('git', args);
    return result.status === 0 ? result.stdout.trim() : refuse(`git ${args[0]} failed with exit ${result.status}`);
  };
  const remote = baselineRemote(io);
  // The full ref, so a local branch or tag named origin/main cannot stand in for the remote-tracking ref.
  const baseline = `refs/remotes/${remote}/main`;
  const baseSha = git('rev-parse', '--verify', `${baseline}^{commit}`);
  io.print(`HEAD ${git('rev-parse', '--verify', 'HEAD^{commit}')}, baseline ${baseline} ${baseSha} (as last fetched)`);
  if (git('status', '--porcelain', '--', ...REVIEWED_PATHS)) refuse('scripts/owner or scripts/lib has local changes');
  const diff = io.capture('git', ['diff', '--quiet', baseSha, 'HEAD', '--', ...REVIEWED_PATHS]);
  if (diff.status === 1) refuse(`scripts/owner or scripts/lib differs from ${baseline}: run the wizard from reviewed main`);
  if (diff.status !== 0) refuse(`git diff failed with exit ${diff.status}`);
}

// Windows environment names ignore case, so a variant such as clicolor_force must go too.
export function ghEnvironment(env) {
  const kept = Object.entries(env).filter(([name]) => !GH_COLOUR_VARIABLES.includes(name.toUpperCase()));
  return { ...Object.fromEntries(kept), NO_COLOR: '1' };
}

export function parseScopes(text) {
  const line = SCOPES_LINE.exec(text.replace(SGR_SEQUENCE, ''));
  if (!line) return null;
  const quoted = [...line[1].matchAll(QUOTED_SCOPE)].map((match) => match[1]);
  if (quoted.length) return quoted;
  return line[1].split(',').map((scope) => scope.trim()).filter(Boolean);
}

// granted is null when gh cannot tell; every caller treats that as possibly granted.
function readAdminOrg(io) {
  const result = io.capture('gh', AUTH_STATUS);
  const scopes = result.status === 0 ? parseScopes(`${result.stdout}\n${result.stderr}`) : null;
  return { status: result.status, granted: scopes === null ? null : scopes.includes(ADMIN_ORG) };
}
const unreadableScopes = (read) => `cannot read the scopes from gh auth status (exit ${read.status})`;

// Never throws: it runs on every exit path, interrupt included. Returns false when the scope may remain.
function dropAdminOrg(io) {
  try {
    io.clearInterrupt();
    const removal = io.attach('gh', REMOVE_ADMIN_ORG);
    const after = readAdminOrg(io);
    if (removal.status !== 0) io.print(`gh ${REMOVE_ADMIN_ORG.join(' ')} exited ${removal.status}`);
    else if (after.granted === null) io.print(unreadableScopes(after));
    else if (!after.granted) {
      io.print('admin:org is gone');
      return true;
    }
  } catch (error) {
    io.print(`admin:org removal failed: ${messageOf(error)}`);
  }
  io.print(`admin:org may still be granted; run: gh ${REMOVE_ADMIN_ORG.join(' ')}`);
  return false;
}

function mark(io, context, { id, status, note }) {
  context.state.steps[id] = { status, updatedAt: io.now(), note };
  io.writeText(context.statePath, `${JSON.stringify(context.state, null, 2)}\n`);
  return true;
}

function stop(io, message) {
  io.print(`Stop: ${message}`);
  return false;
}

async function askOrg(io) {
  const org = await io.ask('Organization login: ');
  return ORG_LOGIN.test(org) ? org : refuse('organization login must match ^[A-Za-z0-9-]+$');
}

async function browserStep(io, context, step) {
  const page = BROWSER_PAGES[step.id];
  const url = page.url(context.state.org);
  io.print(`Open ${url}\n  ${page.field}: ${page.value}\n  Verify: ${page.verify}`);
  io.openUrl(url);
  if ((await io.ask('Verified? y/N ')) !== 'y') return false;
  if (step.id === 'org-create') context.state.org = await askOrg(io);
  return true;
}

async function wizardStep(io, context, step) {
  const { org } = context.state;
  if (!context.scopeAdded) {
    context.scopeAdded = true;
    const added = io.attach('gh', ADD_ADMIN_ORG);
    if (added.status !== 0) refuse(`gh auth refresh -s admin:org failed with exit ${added.status}`);
  }
  for (const { args, note } of WIZARD_COMMANDS[step.id](org)) {
    await io.checkInterrupt();
    if (note) io.print(note);
    io.print(`gh ${args.join(' ')}`);
    if ((await io.ask('Run it? y/N ')) !== 'y') return false;
    const result = io.attach('gh', args);
    if (result.status !== 0) refuse(`gh ${args.slice(0, 4).join(' ')} failed with exit ${result.status}`);
  }
  return true;
}

// The owner says the step is done and gives a note; without a note it stays pending.
async function skipStep(io, context, step) {
  const note = clean(await io.ask('Note (what was done, and when): ')).trim();
  if (!note) return stop(io, `${step.id} stays pending: skipping needs a note`);
  if (step.id === 'org-create') context.state.org = await askOrg(io);
  return mark(io, context, { id: step.id, status: 'skipped', note });
}

const handlerFor = (id) => STEP_HANDLERS[id] ?? (BROWSER_PAGES[id] && browserStep) ?? (WIZARD_COMMANDS[id] && wizardStep);

function requireWizardConsent({ consent }, step) {
  if (step.kind === 'wizard' && !consent.classes.includes('wizard')) refuse(`consent ${consent.answer} keeps ${step.id} in the browser; do it there, rerun and skip it with a note`);
}

// Returns true to continue the walk, false to end it with the step pending.
async function runStep(io, context, step) {
  if (step.kind === 'app') return stop(io, `${step.id} is the agent's: ${step.request}`);
  const handler = handlerFor(step.id);
  if (!handler) return stop(io, `${step.id} is not in this wizard version; see docs/setup.md`);
  if (step.id !== 'org-create' && context.state.org === null) refuse(`${step.id} needs the org: finish org-create first`);
  io.print(`\n${step.id} (${step.kind})`);
  if ((await io.ask('Already done before setup? y/N ')) === 'y') return skipStep(io, context, step);
  requireWizardConsent(context.state, step);
  if (!(await handler(io, context, step))) return stop(io, `${step.id} stays pending; rerun to resume here`);
  return mark(io, context, { id: step.id, status: 'done', note: '' });
}

async function walk(io, context, steps) {
  for (const step of steps) {
    await io.checkInterrupt();
    const due = steps.length === 1 || !finished(context.state, step.id);
    if (due && !(await runStep(io, context, step))) return;
  }
}

function parseStep(argv) {
  if (argv.length === 2 && argv[0] === '--step') return argv[1];
  return argv.length === 0 ? undefined : refuse('usage: node scripts/owner/setup.mjs [--step <id>]');
}

function loadState(io, statePath) {
  const text = io.readText(statePath);
  if (text === null) refuse(`${clean(statePath)} not found: the setup skill records consent there first`);
  const state = validateState(JSON.parse(text));
  if (state.consent.endedAt !== null) refuse('setup has ended (release-merge done): tier 3 work goes back to the browser');
  return state;
}

async function run(io, argv, context) {
  const reason = environmentRefusal(io);
  if (reason) refuse(reason);
  const stepArgument = parseStep(argv);
  checkReviewedCode(io);
  context.statePath = stateFilePath(io);
  context.state = loadState(io, context.statePath);
  const steps = stepsToRun(context.state, stepArgument);
  const leftover = readAdminOrg(io);
  if (leftover.granted === null) refuse(`${unreadableScopes(leftover)}: check gh auth status --active --hostname github.com; if admin:org may be granted, run: gh ${REMOVE_ADMIN_ORG.join(' ')}`);
  if (leftover.granted && !dropAdminOrg(io)) return 1;
  await walk(io, context, steps);
  return 0;
}

export async function main(io, argv) {
  const context = { scopeAdded: false };
  let exitCode = 1;
  try {
    exitCode = await run(io, argv, context);
  } catch (error) {
    io.print(`refused: ${messageOf(error)}`);
  }
  if (context.scopeAdded && !dropAdminOrg(io)) exitCode = 1;
  return exitCode;
}

/** Reads one line; rejects when the input closes (Ctrl+D, Ctrl+Z) or on Ctrl+C, so cleanup still runs. */
export function askLine({ input, output }, question) {
  return new Promise((resolve, reject) => {
    const prompt = createInterface({ input, output, terminal: Boolean(output.isTTY) });
    let answered = false;
    prompt.on('SIGINT', () => prompt.close());
    prompt.on('close', () => { if (!answered) reject(new Error('input closed or interrupted at a prompt')); });
    prompt.question(question, (answer) => {
      answered = true;
      prompt.close();
      resolve(answer.trim());
    });
  });
}

/** Reads a value without echoing it; the value goes only to the caller. */
export function askHidden({ input, output }, question) {
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      return error ? reject(error) : resolve(value);
    };
    const onEnd = () => finish(new Error('input closed at a prompt'));
    function onData(chunk) {
      for (const character of String(chunk)) {
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u0003' || character === '\u0004') return finish(new Error('input closed or interrupted at a prompt'));
        value = character === '\u007f' || character === '\b' ? value.slice(0, -1) : value + character;
      }
    }
    output.write(question);
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.on('end', onEnd);
    input.on('data', onData).resume();
  });
}

/** Writes a key only the owner can read; chmod covers a file that already existed with wider modes. */
export function writePrivateFile(file, text) {
  mkdirSync(path.dirname(file), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  writeFileSync(file, text, { mode: PRIVATE_FILE_MODE });
  chmodSync(file, PRIVATE_FILE_MODE);
}

const OPENERS = { win32: ['rundll32', 'url.dll,FileProtocolHandler'], darwin: ['open'] };
export const openCommand = (platform, url) => { const [command, ...args] = OPENERS[platform] ?? ['xdg-open']; return [command, [...args, url]]; };

export const wasInterrupted = (result) => Boolean(result.signal) || result.status === WINDOWS_CTRL_C_EXIT;

function terminalIo() {
  let hooksDir;
  let interrupted = false;
  let watching = false;
  const noHooksDir = () => {
    hooksDir ??= mkdtempSync(path.join(tmpdir(), 'groundwork-no-hooks-'));
    return hooksDir;
  };
  const run = (command, args, { stdio, input }) => {
    if (!watching) {
      watching = true;
      process.on('SIGINT', () => { interrupted = true; });
      process.once('exit', () => { if (hooksDir) rmSync(hooksDir, { recursive: true, force: true }); });
    }
    const fullArgs = command === 'git' ? gitArguments(noHooksDir(), args) : args;
    const env = command === 'gh' ? ghEnvironment(process.env) : process.env;
    const result = spawnSync(command, fullArgs, { cwd: ROOT, encoding: 'utf8', stdio, env, input });
    if (interrupted || wasInterrupted(result)) throw new Error(INTERRUPTED);
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return {
    env: process.env, platform: process.platform, root: ROOT,
    stdinTTY: Boolean(process.stdin.isTTY), stdoutTTY: Boolean(process.stdout.isTTY),
    print: (line) => console.log(line), now: () => new Date().toISOString(),
    capture: (command, args) => run(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }),
    attach: (command, args) => run(command, args, { stdio: 'inherit' }),
    // A secret reaches the child on stdin only; its output is captured, never printed.
    pipe: (command, args, input) => run(command, args, { stdio: ['pipe', 'pipe', 'pipe'], input }),
    // A blocked event loop cannot run the SIGINT handler; one turn of the loop lets a pending Ctrl+C land.
    checkInterrupt: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      if (interrupted) throw new Error(INTERRUPTED);
    },
    clearInterrupt: () => { interrupted = false; },
    openUrl: (url) => {
      const [command, args] = openCommand(process.platform, url);
      const opener = spawn(command, args, { cwd: ROOT, detached: true, stdio: 'ignore' });
      opener.on('error', () => console.log(`Could not start ${command}; open the URL above yourself.`));
      opener.unref();
    },
    readText: (file) => { try { return readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
    writeText: (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); },
    writePrivateFile, removeFile: (file) => rmSync(file),
    ask: (question) => askLine({ input: process.stdin, output: process.stdout }, question),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  hardenExecutableLookup(process.env);
  process.exitCode = await main(terminalIo(), process.argv.slice(2));
}

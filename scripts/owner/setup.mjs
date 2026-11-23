// Owner wizard (spec 14.3). The owner runs it in their own terminal under their own login; agents never do.
// Imports stay inside Node built-ins, scripts/owner/ and scripts/lib/ (all CODEOWNERS paths).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENT_GH_CONFIG = '.claude/gh-agent';
const STATE_ENV = 'GROUNDWORK_SETUP_STATE_FILE';
const SCHEMA_VERSION = 1;
const ORG_LOGIN = /^[A-Za-z0-9-]+$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const CONTROL_CHARACTERS = /\p{Cc}/gu;
const STATUSES = ['pending', 'done', 'skipped'];
const REVIEWED_PATHS = ['scripts/owner', 'scripts/lib'];
const ADMIN_ORG = 'admin:org';
const ADD_ADMIN_ORG = ['auth', 'refresh', '-s', ADMIN_ORG];
const REMOVE_ADMIN_ORG = ['auth', 'refresh', '--remove-scopes', ADMIN_ORG];

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
const WIZARD_COMMANDS = {
  'org-base-permission': (org) => [['api', '-X', 'PATCH', `/orgs/${org}`, '-f', 'default_repository_permission=read', '-F', 'members_can_create_repositories=false']],
  'org-actions': (org) => [
    ['api', '-X', 'PUT', `/orgs/${org}/actions/permissions`, '-f', 'enabled_repositories=all', '-F', 'sha_pinning_required=true'],
    ['api', '-X', 'PUT', `/orgs/${org}/actions/permissions/fork-pr-contributor-approval`, '-f', 'approval_policy=all_external_contributors'],
    ['api', '-X', 'PUT', `/orgs/${org}/actions/permissions/workflow`, '-F', 'can_approve_pull_request_reviews=false'],
  ],
};
const refuse = (reason) => { throw new Error(reason); };
export const clean = (text) => String(text).replace(CONTROL_CHARACTERS, '');

export function environmentRefusal({ env, stdinTTY, stdoutTTY }) {
  if (!stdinTTY || !stdoutTTY) return 'stdin and stdout must be a terminal: run the wizard yourself, not through a pipe or an agent';
  if (env.GH_TOKEN) return 'GH_TOKEN is set: the wizard uses your own gh login, not the agent token';
  const configDir = (env.GH_CONFIG_DIR ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
  if (configDir.endsWith(AGENT_GH_CONFIG)) return `GH_CONFIG_DIR points at ${AGENT_GH_CONFIG}: run the wizard outside an agent session`;
  if (env.CLAUDECODE) return 'CLAUDECODE is set: the wizard never runs inside an agent session';
  return null;
}

export function stateFilePath({ env, platform }) {
  if (env[STATE_ENV]) return env[STATE_ENV];
  if (platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'groundwork', 'setup-state.json');
  return refuse(`set ${STATE_ENV} to the setup-state.json path`);
}

const onlyKeys = (object, keys, where) => {
  if (!object || typeof object !== 'object' || Array.isArray(object)) refuse(`setup-state.json: ${where} is not an object`);
  const unknown = Object.keys(object).filter((key) => !keys.includes(key));
  if (unknown.length) refuse(`setup-state.json: unknown key ${clean(unknown[0])} in ${where}`);
};
const timestamp = (value, where) => (ISO_UTC.test(value ?? '') ? value : refuse(`setup-state.json: ${where} is not ISO 8601 UTC`));

export function validateState(state) {
  onlyKeys(state, ['schemaVersion', 'org', 'consent', 'steps'], 'the file');
  if (state.schemaVersion !== SCHEMA_VERSION) refuse(`setup-state.json: schemaVersion must be ${SCHEMA_VERSION}`);
  onlyKeys(state.consent, ['answer', 'classes', 'answeredAt', 'endedAt'], 'consent');
  const { answer, classes } = state.consent;
  const expected = { A: '[]', B: '["wizard"]' }[answer];
  if (!expected || JSON.stringify(classes) !== expected) refuse('setup-state.json: consent answer and classes do not match A or B');
  timestamp(state.consent.answeredAt, 'consent.answeredAt');
  if (state.consent.endedAt !== null) timestamp(state.consent.endedAt, 'consent.endedAt');
  onlyKeys(state.steps, [...STEP_BY_ID.keys()], 'steps');
  for (const [id, entry] of Object.entries(state.steps)) validateStepEntry(id, entry);
  if (state.org === null && statusOf(state, 'org-create') !== 'pending') refuse('setup-state.json: org is null after org-create');
  if (state.org !== null && !ORG_LOGIN.test(String(state.org))) refuse('setup-state.json: org is not a valid login');
  return state;
}

function validateStepEntry(id, entry) {
  onlyKeys(entry, ['status', 'updatedAt', 'note'], `steps.${id}`);
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
  const git = (...args) => io.capture('git', args);
  const baseline = git('remote').stdout.split(/\r?\n/).includes('origin') ? 'origin/main' : 'upstream/main';
  const base = git('rev-parse', '--verify', `${baseline}^{commit}`);
  if (base.status !== 0) refuse(`baseline ${baseline} not found`);
  const baseSha = base.stdout.trim();
  io.print(`HEAD ${git('rev-parse', 'HEAD').stdout.trim()}, baseline ${baseline} ${baseSha} (as last fetched)`);
  if (git('status', '--porcelain', '--', ...REVIEWED_PATHS).stdout.trim()) refuse('scripts/owner or scripts/lib has local changes');
  const diff = git('diff', '--quiet', baseSha, 'HEAD', '--', ...REVIEWED_PATHS);
  if (diff.status !== 0) refuse(`scripts/owner or scripts/lib differs from ${baseline}: run the wizard from reviewed main`);
}

// gh prints the token scopes on stdout or stderr depending on its version.
const hasAdminOrg = ({ capture }) => Object.values(capture('gh', ['auth', 'status'])).join('\n').includes(ADMIN_ORG);
// Returns false when the scope survives the removal; the caller exits non-zero.
function dropAdminOrg(io) {
  io.attach('gh', REMOVE_ADMIN_ORG);
  if (!hasAdminOrg(io)) return true;
  io.print(`admin:org is still granted; run: gh ${REMOVE_ADMIN_ORG.join(' ')}`);
  return false;
}

function mark(io, context, { id, status, note }) {
  context.state.steps[id] = { status, updatedAt: io.now(), note };
  io.writeText(context.statePath, `${JSON.stringify(context.state, null, 2)}\n`);
  return true;
}
function stop(io, message) { io.print(`Stop: ${message}`); return false; }

async function askOrg(io) {
  const org = await io.ask('Organization login: ');
  return ORG_LOGIN.test(org) ? org : refuse('organization login must match ^[A-Za-z0-9-]+$');
}

async function browserStep(io, context, step) {
  const page = BROWSER_PAGES[step.id];
  const url = page.url(context.state.org);
  io.openUrl(url);
  io.print(`Opened ${url}\n  ${page.field}: ${page.value}\n  Verify: ${page.verify}`);
  if ((await io.ask('Verified? y/N ')) !== 'y') return false;
  if (step.id === 'org-create') context.state.org = await askOrg(io);
  return true;
}

async function wizardStep(io, context, step) {
  const { consent, org } = context.state;
  if (!consent.classes.includes('wizard')) refuse(`consent ${consent.answer} keeps ${step.id} in the browser; do it there, rerun and skip it with a note`);
  if (!context.scopeAdded) io.attach('gh', ADD_ADMIN_ORG);
  context.scopeAdded = true;
  for (const args of WIZARD_COMMANDS[step.id](org)) {
    io.print(`gh ${args.join(' ')}`);
    if ((await io.ask('Run it? y/N ')) !== 'y') return false;
    const result = io.attach('gh', args);
    if (result.status !== 0) refuse(`gh ${args.slice(0, 4).join(' ')} failed with exit ${result.status}`);
  }
  return true;
}

const HANDLERS = { browser: [BROWSER_PAGES, browserStep], wizard: [WIZARD_COMMANDS, wizardStep] };

// Returns true to continue the walk, false to end it with the step pending.
async function runStep(io, context, step) {
  if (step.kind === 'app') return stop(io, `${step.id} is the agent's: ${step.request}`);
  const [built, handler] = HANDLERS[step.kind];
  if (!built[step.id]) return stop(io, `${step.id} is not in this wizard version; see docs/setup.md`);
  if (step.id !== 'org-create' && context.state.org === null) refuse(`${step.id} needs the org: finish org-create first`);
  io.print(`\n${step.id} (${step.kind})`);
  const note = clean(await io.ask('Already done before setup? Type a note to skip it, or press Enter to run it: ')).trim();
  if (note && step.id === 'org-create') context.state.org = await askOrg(io);
  if (note) return mark(io, context, { id: step.id, status: 'skipped', note });
  if (!(await handler(io, context, step))) return stop(io, `${step.id} stays pending; rerun to resume here`);
  return mark(io, context, { id: step.id, status: 'done', note: '' });
}

async function walk(io, context, steps) {
  for (const step of steps) {
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

export async function main(io, argv) {
  const context = { scopeAdded: false };
  try {
    const reason = environmentRefusal(io);
    if (reason) refuse(reason);
    const stepArgument = parseStep(argv);
    checkReviewedCode(io);
    context.statePath = stateFilePath(io);
    context.state = loadState(io, context.statePath);
    const steps = stepsToRun(context.state, stepArgument);
    if (hasAdminOrg(io) && !dropAdminOrg(io)) return 1;
    await walk(io, context, steps);
    return context.scopeAdded && !dropAdminOrg(io) ? 1 : 0;
  } catch (error) {
    io.print(`refused: ${clean(error?.message ?? error)}`);
    if (context.scopeAdded) dropAdminOrg(io);
    return 1;
  }
}

/** Reads a value without echoing it; the value goes only to the caller. */
export function askHidden({ input, output }, question) {
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      return error ? reject(error) : resolve(value);
    };
    function onData(chunk) {
      for (const character of String(chunk)) {
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u0003') return finish(new Error('interrupted'));
        value = character === '\u007f' || character === '\b' ? value.slice(0, -1) : value + character;
      }
    }
    output.write(question);
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.on('data', onData).resume();
  });
}

const OPENERS = { win32: ['rundll32', 'url.dll,FileProtocolHandler'], darwin: ['open'] };
export const openCommand = (platform, url) => { const [command, ...args] = OPENERS[platform] ?? ['xdg-open']; return [command, [...args, url]]; };

function terminalIo() {
  const hooksDir = mkdtempSync(path.join(tmpdir(), 'groundwork-no-hooks-'));
  let interrupted = false;
  process.on('SIGINT', () => { interrupted = true; });
  const spawn = (command, args, stdio) => {
    const fullArgs = command === 'git' ? gitArguments(hooksDir, args) : args;
    const result = spawnSync(command, fullArgs, { cwd: ROOT, encoding: 'utf8', stdio });
    if (interrupted) throw new Error('interrupted');
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return {
    env: process.env, platform: process.platform,
    stdinTTY: Boolean(process.stdin.isTTY), stdoutTTY: Boolean(process.stdout.isTTY),
    print: (line) => console.log(line), now: () => new Date().toISOString(),
    capture: (command, args) => spawn(command, args, ['ignore', 'pipe', 'pipe']),
    attach: (command, args) => spawn(command, args, 'inherit'),
    openUrl: (url) => { const [command, args] = openCommand(process.platform, url); spawn(command, args, 'ignore'); },
    readText: (file) => { try { return readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
    writeText: (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); },
    ask: async (question) => {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      const controller = new AbortController();
      prompt.on('SIGINT', () => controller.abort());
      try { return (await prompt.question(question, { signal: controller.signal })).trim(); } finally { prompt.close(); }
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(terminalIo(), process.argv.slice(2));
}

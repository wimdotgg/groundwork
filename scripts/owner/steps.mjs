// Owner wizard steps from repo-copy on (spec 14.3): the clone copy, the App pages, the agent key and the admin environment.
// Same rules as setup.mjs: Node built-ins only, every write shown and behind its own y/N, no value taken from setup-state.json.
import path from 'node:path';

const CONTROL_CHARACTERS = /\p{Cc}/gu;
const CONFIG_PATH = '.github/groundwork/config.json';
const CODEOWNERS_PATH = '.github/CODEOWNERS';
const CONTROL_REPO = 'groundwork';
const RELEASE_FILES = { '.release-please-manifest.json': '{}\n', 'version.txt': '0.0.0\n', 'CHANGELOG.md': '' };
const COPY_PATHS = [CONFIG_PATH, CODEOWNERS_PATH, ...Object.keys(RELEASE_FILES)];
const LOGIN = /^[A-Za-z0-9-]+$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const CLIENT_ID = /^[A-Za-z0-9.]+$/;
const APP_ID = /^\d+$/;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/;
const SURROUNDING_QUOTES = /^["']|["']$/g;
// Same rule shape as bootstrap's CODEOWNERS fill: pattern, owners, optional trailing comment.
const CODEOWNERS_RULE = /^(\s*[^\s#]+\s+)([^#]*?)(\s*(?:#[^\n]*)?)$/;
// Reads the PEM from stdin and prints the DPAPI string token.mjs decrypts with ConvertTo-SecureString.
const DPAPI_ENCRYPT = 'ConvertTo-SecureString -String ([Console]::In.ReadToEnd()) -AsPlainText -Force | ConvertFrom-SecureString';
const AGENT_KEY_FILE = 'GROUNDWORK_AGENT_KEY_FILE';
const AGENT_CLIENT_ID = 'GROUNDWORK_AGENT_CLIENT_ID';

// Spec 2.2 to 2.4. No App subscribes to events: the webhook stays off.
export const APP_PAGES = {
  'app-agent': {
    role: 'agent',
    repository: ['Contents RW', 'Pull requests RW', 'Issues RW', 'Workflows RW', 'Actions RW', 'Commit statuses R', 'Metadata R'],
    organization: [],
    key: 'agent-key-store stores it',
  },
  'app-admin': {
    role: 'admin',
    repository: ['Administration RW', 'Contents RW', 'Environments RW', 'Secrets RW', 'Variables RW', 'Issues RW', 'Pull requests RW', 'Workflows RW', 'Actions RW', 'Metadata R'],
    organization: ['Issue types RW', 'Members R'],
    key: 'admin-secrets sends it to the admin environment',
  },
  'app-release': {
    role: 'release',
    repository: ['Contents RW', 'Pull requests RW', 'Issues RW', 'Metadata R'],
    organization: [],
    key: 'admin-secrets sends it to the admin environment',
  },
};
const ADMIN_SECRETS = [
  { role: 'admin', secret: 'ADMIN_APP_KEY', variable: 'ADMIN_APP_CLIENT_ID' },
  { role: 'release', secret: 'RELEASE_APP_KEY', variable: 'RELEASE_APP_CLIENT_ID' },
];

const refuse = (reason) => { throw new Error(reason); };
export const clean = (text) => String(text).replace(CONTROL_CHARACTERS, '');
const printBlock = (io, text) => { for (const line of String(text).split(/\r?\n/)) io.print(clean(line)); };
const lines = (text) => text.split(/\r?\n/).filter(Boolean);
const fromRoot = (io, file) => path.join(io.root, file);

async function confirm(io, question) {
  await io.checkInterrupt();
  return (await io.ask(question)) === 'y';
}

function git(io, ...args) {
  const result = io.capture('git', args);
  return result.status === 0 ? result.stdout.trimEnd() : refuse(`git ${args[0]} failed with exit ${result.status}`);
}

// Shows the exact command, asks y/N and runs it; input goes on stdin and is named, never shown.
async function confirmRun(io, { command, args, input, inputLabel }) {
  io.print(`${command} ${args.join(' ')}${inputLabel ? ` < ${inputLabel}` : ''}`);
  if (!(await confirm(io, 'Run it? y/N '))) return false;
  const result = input === undefined ? io.attach(command, args) : io.pipe(command, args, input);
  if (result.status !== 0) refuse(`${command} ${args.slice(0, 3).join(' ')} failed with exit ${result.status}`);
  return true;
}

/** origin once it holds main (upstream before repo-copy, the org's repository after it), else upstream. */
export function baselineRemote(io) {
  if (!lines(git(io, 'remote')).includes('origin')) return 'upstream';
  // gh repo create adds origin before it pushes, so after a failed push origin has no main yet.
  const originMain = io.capture('git', ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}']);
  return originMain.status === 0 ? 'origin' : 'upstream';
}

function readConfig(io) {
  const text = io.readText(fromRoot(io, CONFIG_PATH));
  return text === null ? refuse(`${CONFIG_PATH} not found`) : JSON.parse(text);
}

function appSlug(config, role) {
  const slug = config.apps?.[role];
  return typeof slug === 'string' && SLUG.test(slug) ? slug : refuse(`${CONFIG_PATH}: apps.${role} is not an App slug; finish repo-copy first`);
}

function ownerLogin(config) {
  const owner = config.accounts?.owner;
  return typeof owner === 'string' && LOGIN.test(owner) ? owner : refuse(`${CONFIG_PATH}: accounts.owner is not a login`);
}

async function askMatching(io, { question, pattern, fallback = '' }) {
  const answer = (await io.ask(question)).trim() || fallback;
  return pattern.test(answer) ? answer : refuse(`${question.trim()} must match ${pattern.source}`);
}

async function readKey(io, label) {
  const file = (await io.ask(`Path to the ${label} private key (.pem): `)).trim().replace(SURROUNDING_QUOTES, '');
  if (!file) refuse(`no key path given for ${label}`);
  const pem = io.readText(file);
  if (pem === null) refuse(`${clean(file)} not found`);
  if (!PRIVATE_KEY.test(pem)) refuse(`${clean(file)} is not a PEM private key`);
  return { file, pem };
}

async function offerDelete(io, file) {
  io.print(`delete ${clean(file)}`);
  if (await confirm(io, 'Delete the downloaded key? y/N ')) io.removeFile(file);
}

// repo-copy

const consentNote = (state) => `docs/runs/${state.consent.answeredAt.slice(0, 10)}-setup-consent.md`;

function refuseWithRecovery(io, { reason, remote, note }) {
  io.print(`Recover with (keep a copy of ${note} first):\n  git restore .\n  git reset --hard ${remote}/main`);
  refuse(reason);
}

// Accepts a fresh clone plus the consent note, or the state a declined y/N or a failed push left behind.
function inspectClone(io, note) {
  if (io.readText(fromRoot(io, note)) === null) refuse(`consent note ${note} is missing: copy it from docs/setup.md, then rerun`);
  const branch = git(io, 'branch', '--show-current');
  if (branch !== 'main') refuse(`repo-copy runs on branch main, not ${clean(branch) || 'a detached HEAD'}`);
  const remote = baselineRemote(io);
  const baseline = `refs/remotes/${remote}/main`;
  const allowed = new Set([...COPY_PATHS, note]);
  const outside = (paths) => paths.find((file) => !allowed.has(file));
  const ahead = lines(git(io, 'rev-list', `${baseline}..HEAD`)).length;
  if (ahead > 1) refuseWithRecovery(io, { reason: `HEAD is ${ahead} commits ahead of ${baseline}; repo-copy adds one`, remote, note });
  const committed = ahead ? outside(lines(git(io, 'diff', '--name-only', baseline, 'HEAD'))) : undefined;
  if (committed !== undefined) refuseWithRecovery(io, { reason: `the commit ahead of ${baseline} changes ${clean(committed)}`, remote, note });
  const dirty = outside(lines(git(io, 'status', '--porcelain', '--untracked-files=all')).map((line) => line.slice(3)));
  if (dirty !== undefined) refuseWithRecovery(io, { reason: `${clean(dirty)} has local changes outside repo-copy`, remote, note });
  return { ahead: ahead === 1, remote, baseline };
}

async function renameOrigin(io) {
  const remotes = lines(git(io, 'remote'));
  if (!remotes.includes('origin')) return true;
  if (remotes.includes('upstream')) refuse('remotes origin and upstream both exist: run git remote remove upstream, then rerun');
  return confirmRun(io, { command: 'git', args: ['remote', 'rename', 'origin', 'upstream'] });
}

function fillCodeowners(text, owner) {
  return text.split('\n').map((line) => {
    const rule = CODEOWNERS_RULE.exec(line);
    return rule && rule[2] !== '' ? `${rule[1]}@${owner}${rule[3]}` : line;
  }).join('\n');
}

async function writeSetupFiles(io, org) {
  const owner = (await askMatching(io, { question: 'Owner login (your GitHub user): ', pattern: LOGIN })).toLowerCase();
  const apps = {};
  for (const role of ['admin', 'agent', 'release']) {
    const fallback = `${org.toLowerCase()}-${role}`;
    apps[role] = await askMatching(io, { question: `${role} App slug [${fallback}]: `, pattern: SLUG, fallback });
  }
  const config = readConfig(io);
  const accounts = { ...config.accounts, owner, agent: `${apps.agent}[bot]` };
  io.print(`write ${CONFIG_PATH}:`);
  printBlock(io, JSON.stringify({ org, accounts, apps }, null, 2));
  io.print(`write ${CODEOWNERS_PATH}: every owner becomes @${owner}`);
  if (!(await confirm(io, 'Write them? y/N '))) return false;
  io.writeText(fromRoot(io, CONFIG_PATH), `${JSON.stringify({ ...config, org, accounts, apps }, null, 2)}\n`);
  const codeowners = io.readText(fromRoot(io, CODEOWNERS_PATH)) ?? refuse(`${CODEOWNERS_PATH} not found`);
  io.writeText(fromRoot(io, CODEOWNERS_PATH), fillCodeowners(codeowners, owner));
  return true;
}

async function resetReleaseFiles(io) {
  for (const [file, text] of Object.entries(RELEASE_FILES)) io.print(`write ${file}: ${text ? JSON.stringify(text) : 'empty'}`);
  if (!(await confirm(io, 'Reset the release files so the first release is v0.1.0? y/N '))) return false;
  for (const [file, text] of Object.entries(RELEASE_FILES)) io.writeText(fromRoot(io, file), text);
  return true;
}

function upstreamVersion(io) {
  const tag = io.capture('git', ['describe', '--tags', '--abbrev=0', 'refs/remotes/upstream/main']);
  return clean(tag.status === 0 ? tag.stdout.trim() : git(io, 'rev-parse', '--short', 'refs/remotes/upstream/main'));
}

async function commitSetup(io, { org, note }) {
  const paths = [...COPY_PATHS, note];
  io.print(`git add -- ${paths.join(' ')}`);
  git(io, 'add', '--', ...paths);
  printBlock(io, git(io, 'diff', '--cached', '--no-color', '--no-ext-diff'));
  io.print(`Consent note ${note}:`);
  printBlock(io, io.readText(fromRoot(io, note)));
  const message = `chore: set up ${org} from groundwork ${upstreamVersion(io)}`;
  return confirmRun(io, { command: 'git', args: ['commit', '-m', message] });
}

async function pushCopy(io, org) {
  // After a push that failed past gh's remote add, origin exists and only the push is left.
  const pushed = lines(git(io, 'remote')).includes('origin')
    ? ['git', ['push', '--set-upstream', 'origin', 'main']]
    : ['gh', ['repo', 'create', `${org}/${CONTROL_REPO}`, '--public', '--source', '.', '--remote', 'origin', '--push']];
  return confirmRun(io, { command: pushed[0], args: pushed[1] });
}

async function repoCopy(io, context) {
  const { org } = context.state;
  const note = consentNote(context.state);
  const clone = inspectClone(io, note);
  if (clone.ahead) {
    io.print(`Commit ahead of ${clone.baseline}, from an earlier run:`);
    printBlock(io, git(io, 'show', '--no-color', '--no-ext-diff', 'HEAD'));
    return pushCopy(io, org);
  }
  if (!(await renameOrigin(io))) return false;
  if (!(await writeSetupFiles(io, org))) return false;
  if (!(await resetReleaseFiles(io))) return false;
  if (!(await commitSetup(io, { org, note }))) return false;
  return pushCopy(io, org);
}

// App pages (Q5 A: the owner fills the form)

function appStep(stepId) {
  return async (io, context) => {
    const { org } = context.state;
    const page = APP_PAGES[stepId];
    const slug = appSlug(readConfig(io), page.role);
    const newUrl = `https://github.com/organizations/${org}/settings/apps/new`;
    io.print(`Open ${newUrl}`);
    for (const line of [
      `GitHub App name: ${slug}`, `Homepage URL: https://github.com/${org}`, 'Webhook: Active off (no events)',
      `Repository permissions: ${page.repository.join(', ')}`, `Organization permissions: ${page.organization.join(', ') || 'none'}`,
      'Where can this GitHub App be installed: Only on this account',
      `Then generate a private key and note the App ID and client ID; ${page.key}.`,
    ]) io.print(`  ${line}`);
    io.openUrl(newUrl);
    if (!(await confirm(io, `Created ${slug}? y/N `))) return false;
    const installUrl = `https://github.com/organizations/${org}/settings/apps/${slug}/installations`;
    io.print(`Open ${installUrl}\n  Install on: ${org}, All repositories`);
    io.openUrl(installUrl);
    return confirm(io, 'Installed? y/N ');
  };
}

// agent-key-store (spec 2.2: DPAPI on Windows, a PEM file elsewhere)

async function storeWithDpapi(io, { slug, clientId, key }) {
  if (!io.env.APPDATA) refuse('APPDATA is not set');
  const appId = await askMatching(io, { question: `${slug} App ID: `, pattern: APP_ID });
  const directory = path.win32.join(io.env.APPDATA, 'groundwork');
  const dpapiFile = path.win32.join(directory, `${slug}.pem.dpapi`);
  const metadataFile = path.win32.join(directory, `${slug}.json`);
  io.print(`encrypt ${clean(key.file)} for your Windows user (DPAPI) into ${clean(dpapiFile)}`);
  io.print(`write ${clean(metadataFile)}: appId ${appId}, slug ${slug}, clientId ${clientId}`);
  if (!(await confirm(io, 'Store the key? y/N '))) return false;
  const encrypted = io.pipe('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_ENCRYPT], key.pem);
  if (encrypted.status !== 0 || !encrypted.stdout.trim()) refuse(`DPAPI encryption failed with exit ${encrypted.status}`);
  io.writeText(dpapiFile, `${encrypted.stdout.trim()}\n`);
  io.writeText(metadataFile, `${JSON.stringify({ appId: Number(appId), slug, clientId })}\n`);
  await offerDelete(io, key.file);
  return true;
}

async function storePemFile(io, { slug, clientId, key }) {
  const home = io.env.HOME;
  const target = io.env[AGENT_KEY_FILE] || (home ? path.join(home, '.config', 'groundwork', `${slug}.pem`) : refuse(`set ${AGENT_KEY_FILE} to the path the key goes to`));
  io.print(`write ${clean(target)} (mode 0600) from ${clean(key.file)}`);
  if (!(await confirm(io, 'Store the key? y/N '))) return false;
  io.writePrivateFile(target, key.pem);
  io.print(`Add to your shell profile:\n  export ${AGENT_KEY_FILE}=${clean(target)}\n  export ${AGENT_CLIENT_ID}=${clientId}`);
  return true;
}

async function agentKeyStore(io) {
  const slug = appSlug(readConfig(io), 'agent');
  const clientId = await askMatching(io, { question: `${slug} client ID: `, pattern: CLIENT_ID });
  const key = await readKey(io, slug);
  const store = io.platform === 'win32' ? storeWithDpapi : storePemFile;
  return store(io, { slug, clientId, key });
}

// admin environment and its secrets (spec 10.1)

function ownerId(io, owner) {
  const result = io.capture('gh', ['api', `/users/${owner}`, '--jq', '.id']);
  const id = Number(result.stdout.trim());
  return result.status === 0 && Number.isSafeInteger(id) && id > 0 ? id : refuse(`cannot read the user id of ${owner} (exit ${result.status})`);
}

async function adminEnvironment(io, context) {
  const repo = `${context.state.org}/${CONTROL_REPO}`;
  const environment = `/repos/${repo}/environments/admin`;
  const body = {
    reviewers: [{ type: 'User', id: ownerId(io, ownerLogin(readConfig(io))) }], prevent_self_review: false, can_admins_bypass: false,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  };
  printBlock(io, JSON.stringify(body, null, 2));
  const put = { command: 'gh', args: ['api', '-X', 'PUT', environment, '--input', '-'], input: JSON.stringify(body), inputLabel: 'the body above' };
  if (!(await confirmRun(io, put))) return false;
  const policies = io.capture('gh', ['api', `${environment}/deployment-branch-policies`, '--jq', '.branch_policies[] | .type + ":" + .name']);
  if (policies.status !== 0) refuse(`cannot read the admin deployment branch policies (exit ${policies.status})`);
  if (lines(policies.stdout).includes('branch:main')) return true;
  return confirmRun(io, { command: 'gh', args: ['api', '-X', 'POST', `${environment}/deployment-branch-policies`, '-f', 'name=main', '-f', 'type=branch'] });
}

async function adminSecrets(io, context) {
  const repo = `${context.state.org}/${CONTROL_REPO}`;
  const config = readConfig(io);
  const keyFiles = [];
  for (const { role, secret, variable } of ADMIN_SECRETS) {
    const slug = appSlug(config, role);
    const key = await readKey(io, slug);
    const setSecret = { command: 'gh', args: ['secret', 'set', secret, '--env', 'admin', '--repo', repo], input: key.pem, inputLabel: clean(key.file) };
    if (!(await confirmRun(io, setSecret))) return false;
    const id = await askMatching(io, { question: `${slug} client ID or App ID: `, pattern: CLIENT_ID });
    if (!(await confirmRun(io, { command: 'gh', args: ['variable', 'set', variable, '--env', 'admin', '--repo', repo, '--body', id] }))) return false;
    keyFiles.push(key.file);
  }
  for (const file of keyFiles) await offerDelete(io, file);
  return true;
}

export const STEP_HANDLERS = {
  'repo-copy': repoCopy,
  'app-agent': appStep('app-agent'),
  'agent-key-store': agentKeyStore,
  'app-admin': appStep('app-admin'),
  'app-release': appStep('app-release'),
  'admin-environment': adminEnvironment,
  'admin-secrets': adminSecrets,
};

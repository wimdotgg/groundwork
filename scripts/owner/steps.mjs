// Owner wizard steps from repo-copy on (spec 14.3): the clone copy, the App pages, the agent key and the admin environment.
// Same rules as setup.mjs: Node built-ins only, every write shown and behind its own y/N.
// From setup-state.json the steps read only org and consent.answeredAt, which setup.mjs validates before any step runs.
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const CONTROL_CHARACTERS = /\p{Cc}/gu;
const CONFIG_PATH = '.github/groundwork/config.json';
const CODEOWNERS_PATH = '.github/CODEOWNERS';
const CONTROL_REPO = 'groundwork';
const RELEASE_FILES = { '.release-please-manifest.json': '{}\n', 'version.txt': '0.0.0\n', 'CHANGELOG.md': '' };
const COPY_PATHS = [CONFIG_PATH, CODEOWNERS_PATH, ...Object.keys(RELEASE_FILES)];
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const CLIENT_ID = /^[A-Za-z0-9.]+$/;
const APP_ID = /^\d+$/;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/;
const SURROUNDING_QUOTES = /^["']|["']$/g;
const HOME_PREFIX = /^~(?=$|[\\/])/;
const IDENT_TIMESTAMP = /\s+\d+\s+[+-]\d{4}$/;
const BOT_IDENTITY = /\[bot\]/i;
const UNTRACKED = '??';
const MAIN_ONLY = 'branch:main';
// gh repo set-default marks the remote gh and every agent script resolve the repository by (spec 14.3).
const GH_DEFAULT_KEY = 'remote.origin.gh-resolved';
const UPSTREAM_DEFAULT_KEY = 'remote.upstream.gh-resolved';
const GH_DEFAULT_VALUE = 'base';
// .git/config is agent-writable and Git runs programs it names (gpg.program, credential helpers, core.sshCommand,
// filters, diff.external, includes), so the wizard accepts only keys that run nothing. Listing every executable key to override cannot be complete.
const SAFE_LOCAL_CONFIG = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|symlinks|ignorecase|autocrlf|precomposeunicode)$/,
  /^remote\.[^.]+\.(url|fetch|gh-resolved)$/, /^branch\..+\.(remote|merge|rebase)$/, /^user\.(name|email)$/,
];
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

const errorText = (result) => result.stderr.trim().split(/\r?\n/).map(clean).filter(Boolean).join(' | ');

/**
 * Shows the exact command, asks y/N and runs it. input goes on stdin and is named by inputLabel, never shown.
 * A secret's run names its key file instead and keeps the child's output hidden, also on failure.
 */
async function confirmRun(io, { command, args, input, inputLabel, secretFile }) {
  const shown = `${command} ${args.join(' ')}`;
  const stdinName = secretFile === undefined ? inputLabel : clean(secretFile);
  io.print(`${shown}${stdinName ? ` < ${stdinName}` : ''}`);
  if (!(await confirm(io, 'Run it? y/N '))) return false;
  const result = input === undefined ? io.attach(command, args) : io.pipe(command, args, input);
  if (result.status === 0) return true;
  const failed = `${command} ${args.slice(0, 3).join(' ')} failed with exit ${result.status}`;
  if (secretFile !== undefined) refuse(`${failed}; its output is hidden because it read a key; run it yourself to see why: ${shown} < ${stdinName}`);
  const cause = errorText(result);
  return refuse(cause ? `${failed}: ${cause}` : failed);
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

// A shell expands ~ before a program sees it; a path typed at a prompt needs it done here.
function expandHome(io, file) {
  const home = io.env.HOME || io.env.USERPROFILE;
  return HOME_PREFIX.test(file) && home ? path.join(home, file.slice(1)) : file;
}

async function readKey(io, label) {
  const typed = (await io.ask(`Path to the ${label} private key (.pem, ~ allowed): `)).trim().replace(SURROUNDING_QUOTES, '');
  if (!typed) refuse(`no key path given for ${label}`);
  const file = expandHome(io, typed);
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

// git restore and git reset leave untracked files, so each one outside repo-copy is named for deletion.
function refuseWithRecovery(io, { reason, remote, note, untracked = [] }) {
  const deletions = untracked.map((file) => `\n  delete ${clean(file)}`).join('');
  io.print(`Recover with (keep a copy of ${note} first):\n  git restore .\n  git reset --hard ${remote}/main${deletions}`);
  refuse(reason);
}

/** Reading the config runs nothing it names, so the wizard runs this before any other git command. */
export function requireSafeLocalConfig(io) {
  const unsafe = lines(git(io, 'config', '--local', '--name-only', '--list')).find((key) => !SAFE_LOCAL_CONFIG.some((safe) => safe.test(key)));
  if (unsafe !== undefined) refuse(`.git/config sets ${clean(unsafe)}, which the wizard does not run with: remove it (git config --local --unset-all "${clean(unsafe)}"), then rerun`);
}

const localChanges = (io) => lines(git(io, 'status', '--porcelain', '--untracked-files=all')).map((line) => ({ code: line.slice(0, 2), file: line.slice(3) }));

// Accepts a fresh clone plus the consent note, or the state a declined y/N or a failed push left behind.
function inspectClone(io, note) {
  if (io.readText(fromRoot(io, note)) === null) refuse(`consent note ${note} is missing: copy it from docs/setup.md, then rerun`);
  requireSafeLocalConfig(io);
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
  const changes = localChanges(io);
  const foreign = changes.filter(({ file }) => !allowed.has(file));
  if (foreign.length) {
    const untracked = foreign.filter(({ code }) => code === UNTRACKED).map(({ file }) => file);
    refuseWithRecovery(io, { reason: `${clean(foreign[0].file)} has local changes outside repo-copy`, remote, note, untracked });
  }
  return { ahead: ahead === 1, remote, baseline };
}

const originPushUrls = (io) => lines(git(io, 'remote', 'get-url', '--push', '--all', 'origin')).map(clean);

const originPushesToOrg = (io, org) => {
  const urls = originPushUrls(io);
  return urls.length === 1 && isOrgRepositoryUrl(urls[0], org);
};

const refExists = (io, ref) => io.capture('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0;

// An origin/main the kit already holds is a stale kit ref: nothing of the org's landed beyond it.
const originMainIsKitRef = (io) => io.capture('git', ['merge-base', '--is-ancestor', 'refs/remotes/origin/main', 'refs/remotes/upstream/main']).status === 0;

// With upstream beside origin, only a copy that already points origin at the org repository continues, and only while origin/main holds nothing the kit lacks.
// An unrecognised origin/main refuses: writing again could overwrite what landed. Origin is checked first so a foreign origin always gets the set-url advice.
async function renameOrigin(io, { org, remote }) {
  const remotes = lines(git(io, 'remote'));
  if (!remotes.includes('origin')) return true;
  if (!remotes.includes('upstream')) {
    if (isOrgRepositoryUrl(clean(git(io, 'remote', 'get-url', '--push', 'origin')), org)) refuse(`origin already pushes to github.com/${org}/${CONTROL_REPO} and the upstream remote is missing: add the groundwork kit back with git remote add -f upstream <the upstream groundwork URL> (see "upstream updates" in docs/setup.md), then rerun`);
    return confirmRun(io, { command: 'git', args: ['remote', 'rename', 'origin', 'upstream'] });
  }
  if (!originPushesToOrg(io, org)) refuse(`remotes origin and upstream both exist and origin does not push to github.com/${org}/${CONTROL_REPO}: create that repository if it does not exist (gh repo create ${org}/${CONTROL_REPO} --public), run git remote set-url origin https://github.com/${org}/${CONTROL_REPO}.git and keep upstream, then rerun`);
  if (!refExists(io, 'refs/remotes/upstream/main')) refuse('remote upstream has no main yet: run git fetch upstream, then rerun');
  if (remote === 'origin' && !originMainIsKitRef(io)) refuse('origin/main exists but HEAD is not the one setup commit on it over upstream/main, so repo-copy cannot tell what landed: keep upstream, make HEAD match that commit or origin/main, then rerun');
  return true;
}

function fillCodeowners(text, owner) {
  return text.split('\n').map((line) => {
    const rule = CODEOWNERS_RULE.exec(line);
    return rule && rule[2] !== '' ? `${rule[1]}@${owner}${rule[3]}` : line;
  }).join('\n');
}

const nestedJson = (value) => JSON.stringify(value, null, 2).replaceAll('\n', '\n  ');

// Rewrites only org, accounts and apps, so the rest of the file keeps its layout and upstream merges stay clean.
function updateConfigText(text, { org, accounts, apps }) {
  const updated = text
    .replace(/("org":\s*)"[^"]*"/, (_, key) => `${key}${JSON.stringify(org)}`)
    .replace(/("accounts":\s*)\{[^{}]*\}/, (_, key) => `${key}${nestedJson(accounts)}`)
    .replace(/("apps":\s*)\{[^{}]*\}/, (_, key) => `${key}${nestedJson(apps)}`);
  const expected = { ...JSON.parse(text), org, accounts, apps };
  return isDeepStrictEqual(JSON.parse(updated), expected) ? updated : refuse(`cannot update org, accounts and apps in ${CONFIG_PATH} in place`);
}

async function writeSetupFiles(io, org) {
  const owner = (await askMatching(io, { question: 'Owner login (your GitHub user): ', pattern: LOGIN })).toLowerCase();
  const signedIn = signedInUser(io).login;
  if (signedIn.toLowerCase() !== owner) refuse(`gh is signed in as ${signedIn}, but you typed owner ${owner}: sign gh in as the owner or type the signed-in login`);
  const apps = {};
  for (const role of ['admin', 'agent', 'release']) {
    const fallback = `${org.toLowerCase()}-${role}`;
    apps[role] = await askMatching(io, { question: `${role} App slug [${fallback}]: `, pattern: SLUG, fallback });
  }
  const configText = io.readText(fromRoot(io, CONFIG_PATH)) ?? refuse(`${CONFIG_PATH} not found`);
  const accounts = { ...JSON.parse(configText).accounts, owner, agent: `${apps.agent}[bot]` };
  const updated = updateConfigText(configText, { org, accounts, apps });
  io.print(`write ${CONFIG_PATH}:`);
  printBlock(io, JSON.stringify({ org, accounts, apps }, null, 2));
  io.print(`write ${CODEOWNERS_PATH}: every owner becomes @${owner}`);
  if (!(await confirm(io, 'Write them? y/N '))) return false;
  io.writeText(fromRoot(io, CONFIG_PATH), updated);
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
  const ident = io.capture('git', ['var', 'GIT_AUTHOR_IDENT']);
  if (ident.status !== 0) refuse(`git var failed with exit ${ident.status}: ${errorText(ident)}: set user.name and user.email (git config user.name "Your Name", git config user.email "you@example.com"), then rerun`);
  const author = clean(ident.stdout.trimEnd().replace(IDENT_TIMESTAMP, ''));
  if (BOT_IDENTITY.test(author)) refuse(`git would commit as ${author}: set your own user.name and user.email in this clone, then rerun`);
  io.print(`author: ${author}`);
  const message = `chore: set up ${org} from groundwork ${upstreamVersion(io)}`;
  return confirmRun(io, { command: 'git', args: ['commit', '-m', message] });
}

const isOrgRepositoryUrl = (url, org) => new RegExp(`^(https://github\\.com/|git@github\\.com:|ssh://git@github\\.com/)${org}/${CONTROL_REPO}(\\.git)?$`, 'i').test(url);

function requireUpstream(io, remotes) {
  if (!remotes.includes('upstream')) refuse('remote upstream is missing: repo-copy renames origin to upstream before it pushes');
  if (io.capture('git', ['config', '--get', UPSTREAM_DEFAULT_KEY]).status === 0) refuse(`remote upstream is gh's default: run git config --unset ${UPSTREAM_DEFAULT_KEY}, then rerun`);
}

/** Origin's push URL once it is the org's repository and gh defaults to it; null when the gh default prompt is declined. */
async function confirmOriginTarget(io, org) {
  const urls = originPushUrls(io);
  if (urls.length !== 1) refuse(`origin pushes to ${urls.length} URLs (${urls.join(', ')}): keep only github.com/${org}/${CONTROL_REPO}, then rerun`);
  const [url] = urls;
  if (!isOrgRepositoryUrl(url, org)) refuse(`origin pushes to ${url}, not github.com/${org}/${CONTROL_REPO}: fix it with git remote set-url origin, then rerun`);
  const ghDefault = io.capture('git', ['config', '--get', GH_DEFAULT_KEY]).stdout.trim();
  const setDefault = { command: 'gh', args: ['repo', 'set-default', `${org}/${CONTROL_REPO}`] };
  return ghDefault === GH_DEFAULT_VALUE || await confirmRun(io, setDefault) ? url : null;
}

// gh only creates the repository and adds origin; the push runs through the wizard's own git, with hooks off.
async function pushCopy(io, org) {
  const remotes = lines(git(io, 'remote'));
  requireUpstream(io, remotes);
  const create = { command: 'gh', args: ['repo', 'create', `${org}/${CONTROL_REPO}`, '--public', '--source', '.', '--remote', 'origin'] };
  if (!remotes.includes('origin') && !(await confirmRun(io, create))) return false;
  const url = await confirmOriginTarget(io, org);
  if (url === null) return false;
  io.print(`push to ${url}`);
  return confirmRun(io, { command: 'git', args: ['push', '--set-upstream', 'origin', 'main'] });
}

// True when HEAD is the one setup commit and origin/main already has it; the tree is checked separately.
function holdsSetupCommit(io, note) {
  if (git(io, 'rev-parse', 'HEAD') !== git(io, 'rev-parse', 'refs/remotes/origin/main')) return false;
  const sinceUpstream = io.capture('git', ['rev-list', 'refs/remotes/upstream/main..HEAD']);
  if (sinceUpstream.status !== 0 || lines(sinceUpstream.stdout).length !== 1) return false;
  const allowed = new Set([...COPY_PATHS, note]);
  // Three dots: from the merge base, so kit commits fetched since the setup do not count as changes.
  const changed = lines(git(io, 'diff', '--name-only', 'refs/remotes/upstream/main...HEAD'));
  return changed.every((file) => allowed.has(file));
}

async function finishLandedCopy(io, { org, note }) {
  const changes = localChanges(io);
  if (changes.length) {
    const untracked = changes.filter(({ code }) => code === UNTRACKED).map(({ file }) => file);
    refuseWithRecovery(io, { reason: `${clean(changes[0].file)} has local changes but the setup commit is already on origin/main`, remote: 'origin', note, untracked });
  }
  requireUpstream(io, lines(git(io, 'remote')));
  io.print('The setup commit is already on origin/main: no rename, commit or push left.');
  return (await confirmOriginTarget(io, org)) !== null;
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
  if (clone.remote === 'origin' && holdsSetupCommit(io, note)) return finishLandedCopy(io, { org, note });
  if (!(await renameOrigin(io, { org, remote: clone.remote }))) return false;
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
  if (encrypted.status !== 0 || !encrypted.stdout.trim()) refuse(`DPAPI encryption failed with exit ${encrypted.status}; PowerShell's output is hidden because it read the key; nothing was written`);
  io.writeText(dpapiFile, `${encrypted.stdout.trim()}\n`);
  io.writeText(metadataFile, `${JSON.stringify({ appId: Number(appId), slug, clientId })}\n`);
  await offerDelete(io, key.file);
  return true;
}

const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

async function storePemFile(io, { slug, clientId, key }) {
  const home = io.env.HOME;
  const target = io.env[AGENT_KEY_FILE] || (home ? path.join(home, '.config', 'groundwork', `${slug}.pem`) : refuse(`set ${AGENT_KEY_FILE} to the path the key goes to`));
  io.print(`write ${clean(target)} (mode 0600) from ${clean(key.file)}`);
  if (!(await confirm(io, 'Store the key? y/N '))) return false;
  io.writePrivateFile(target, key.pem);
  io.print(`Add to your shell profile:\n  export ${AGENT_KEY_FILE}=${shellQuote(clean(target))}\n  export ${AGENT_CLIENT_ID}=${clientId}`);
  io.print(`Then delete the downloaded key ${clean(key.file)} once token.mjs works.`);
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

function ghRead(io, { args, what }) {
  const result = io.capture('gh', args);
  if (result.status === 0) return result.stdout;
  const cause = errorText(result);
  return refuse(`cannot read ${what} (exit ${result.status})${cause ? `: ${cause}` : ''}`);
}

function signedInUser(io) {
  const [login, idText] = ghRead(io, { args: ['api', 'user', '--jq', '.login + " " + (.id | tostring)'], what: 'your GitHub user' }).trim().split(' ');
  const id = Number(idText);
  if (!LOGIN.test(login ?? '') || !Number.isSafeInteger(id) || id <= 0) refuse('gh api user returned no login and id');
  return { login, id };
}

// The reviewer is the signed-in owner, checked against config.json, never taken from the file alone.
function signedInOwner(io, config) {
  const { login, id } = signedInUser(io);
  const configured = ownerLogin(config);
  if (login.toLowerCase() !== configured.toLowerCase()) refuse(`gh is signed in as ${login}, but ${CONFIG_PATH} accounts.owner is ${configured}: sign in as the owner or fix the file`);
  return { login, id };
}

async function adminEnvironment(io, context) {
  const repo = `${context.state.org}/${CONTROL_REPO}`;
  const environment = `/repos/${repo}/environments/admin`;
  const reviewer = signedInOwner(io, readConfig(io));
  const body = {
    reviewers: [{ type: 'User', id: reviewer.id }], prevent_self_review: false, can_admins_bypass: false,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  };
  io.print(`reviewer: ${reviewer.login} (id ${reviewer.id})`);
  printBlock(io, JSON.stringify(body, null, 2));
  const put = { command: 'gh', args: ['api', '-X', 'PUT', environment, '--input', '-'], input: JSON.stringify(body), inputLabel: 'the body above' };
  if (!(await confirmRun(io, put))) return false;
  const policyArgs = ['api', `${environment}/deployment-branch-policies`, '--jq', '.branch_policies[] | .type + ":" + .name'];
  const policies = lines(ghRead(io, { args: policyArgs, what: 'the admin deployment branch policies' }));
  if (policies.length === 1 && policies[0] === MAIN_ONLY) return true;
  if (policies.length) {
    io.print(`admin allows ${policies.map(clean).join(', ')}; spec 10.1 allows only ${MAIN_ONLY}. Remove the others in the environment settings, then rerun.`);
    return false;
  }
  return confirmRun(io, { command: 'gh', args: ['api', '-X', 'POST', `${environment}/deployment-branch-policies`, '-f', 'name=main', '-f', 'type=branch'] });
}

async function adminSecrets(io, context) {
  const repo = `${context.state.org}/${CONTROL_REPO}`;
  const config = readConfig(io);
  const keyFiles = [];
  for (const { role, secret, variable } of ADMIN_SECRETS) {
    const slug = appSlug(config, role);
    const key = await readKey(io, slug);
    const setSecret = { command: 'gh', args: ['secret', 'set', secret, '--env', 'admin', '--repo', repo], input: key.pem, secretFile: key.file };
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

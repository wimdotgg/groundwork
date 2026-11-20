import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, repoRoot } from '../lib/config.mjs';
import { GitHubError, apiPath, createClient } from '../lib/github.mjs';
import { createAppJwt, mintInstallationToken, revokeInstallationToken } from './app-token.mjs';
import * as applySettings from './apply-settings.mjs';
import * as check from './check.mjs';
import * as createIssueTypes from './create-issue-types.mjs';

/** @typedef {import('../lib/github.mjs').GitHubClient} GitHubClient */
/** @typedef {import('../lib/github.mjs').CallRecord} CallRecord */
/** @typedef {{ OP: string, TOKEN_SCOPE: 'target'|'org', PERMISSIONS: Record<string, string>,
 *   validateArgs: (args: any) => string[],
 *   run: (ctx: object) => Promise<{ ok: boolean, summary: string }> }} OpModule */
/** @typedef {{ exitCode: number, summary: string, reason?: string }} Result */

/** Op name to module. The workflow's `op` choice list must equal these keys. */
export const REGISTRY = {
  'apply-settings': applySettings,
  check,
  'create-issue-types': createIssueTypes,
};

const MAIN_REF = 'refs/heads/main';
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+$/;
const DOT_SEGMENTS = new Set(['.', '..']);
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const OP_WITH_REF = 'apply-settings';
const OP_THEN_CHECK = 'apply-settings';
const OP_CHECK = 'check';
const SETTINGS_SEGMENTS = ['.github', 'groundwork'];
const SECRET_ENV_NAMES = ['ADMIN_APP_KEY', 'RELEASE_APP_KEY'];
const MIN_SCRUBBED_LINE_LENGTH = 17;
const BLOB_MODE_PREFIX = '100';
const TEXT_MAX_LENGTH = 200;
const TEMP_DIR_PREFIX = 'admin-run-';
const MASKED = '***';

/**
 * Untrusted text becomes one printable-ASCII line that cannot open a code span, table cell or HTML tag.
 * @param {unknown} text
 * @returns {string}
 */
function safeText(text) {
  return String(text ?? '')
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/[`<>|]/g, "'")
    .trim()
    .slice(0, TEXT_MAX_LENGTH);
}

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {Record<string, string|undefined>} env
 * @returns {{ op: string, targetRepo: string, ref: string, argsText: string }}
 */
export function readInputs(env) {
  return {
    op: env.INPUT_OP ?? '',
    targetRepo: env.INPUT_TARGET_REPO ?? '',
    ref: env.INPUT_REF ?? '',
    argsText: env.INPUT_ARGS ?? '',
  };
}

function targetProblems(module, targetRepo) {
  if (module.TOKEN_SCOPE === 'org') return targetRepo === '' ? [] : ['target_repo must be empty for this op'];
  if (targetRepo === '') return ['target_repo is required for this op'];
  if (!REPOSITORY_PATTERN.test(targetRepo) || DOT_SEGMENTS.has(targetRepo)) {
    return ['target_repo must match [A-Za-z0-9._-]+ and not be . or ..'];
  }
  return [];
}

function refProblems(op, ref) {
  if (op !== OP_WITH_REF) return ref === '' ? [] : ['ref must be empty for this op'];
  return SHA_PATTERN.test(ref) ? [] : ['ref must be a 40-character lowercase hex SHA'];
}

/** @returns {{ args?: object, problems: string[] }} */
function parseArgs(module, argsText) {
  let parsed;
  try {
    parsed = JSON.parse(argsText);
  } catch {
    return { problems: ['args is not valid JSON'] };
  }
  if (!isPlainObject(parsed)) return { problems: ['args must be a JSON object'] };
  const problems = module.validateArgs(parsed).map((problem) => `args: ${safeText(problem)}`);
  return { args: parsed, problems };
}

/**
 * Pure input validation, run by both jobs. Never echoes raw input: reasons name the rule, not the value.
 * @param {{ op: string, targetRepo: string, ref: string, argsText: string }} inputs
 * @param {Record<string, OpModule>} registry
 * @returns {{ problems: string[], request?: { op: string, module: OpModule, targetRepo: string, ref: string, args: object } }}
 */
export function validateRequest(inputs, registry) {
  if (!Object.hasOwn(registry, inputs.op)) {
    return { problems: [`op must be one of ${Object.keys(registry).join(', ')}`] };
  }
  const module = registry[inputs.op];
  const { args, problems: argsProblems } = parseArgs(module, inputs.argsText);
  const problems = [
    ...targetProblems(module, inputs.targetRepo),
    ...refProblems(inputs.op, inputs.ref),
    ...argsProblems,
  ];
  if (problems.length > 0) return { problems };
  return { problems, request: { op: inputs.op, module, targetRepo: inputs.targetRepo, ref: inputs.ref, args } };
}

/**
 * Resolves main to a SHA first: a bare `main` in a compare path can match a tag of that name.
 * Problem text is unsanitised; callers clean it.
 * @param {GitHubClient} client
 * @param {{ org: string, repo: string, ref: string }} target
 * @returns {Promise<{ problem?: string, aheadBy?: number }>} `aheadBy` is how many commits main has beyond `ref`
 */
export async function checkAncestry(client, { org, repo, ref }) {
  try {
    const mainSha = await readMainSha(client, { org, repo });
    const comparePath = apiPath('/repos/{org}/{repo}/compare/{ref}...{mainSha}', { org, repo, ref, mainSha });
    return interpretCompare((await client.request('GET', comparePath)).data);
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    return { problem: `ref ancestry check failed: ${error.message}` };
  }
}

async function readMainSha(client, { org, repo }) {
  const refPath = apiPath('/repos/{org}/{repo}/git/ref/heads/main', { org, repo });
  const sha = (await client.request('GET', refPath)).data?.object?.sha;
  if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) throw new GitHubError(`GET ${refPath}: response has no commit SHA`);
  return sha;
}

function interpretCompare(compare) {
  if (compare?.status === 'identical') return { aheadBy: 0 };
  if (compare?.status === 'ahead' && Number.isInteger(compare.ahead_by) && compare.ahead_by > 0) {
    return { aheadBy: compare.ahead_by };
  }
  return { problem: `ref is not main or an ancestor of main (compare status ${compare?.status ?? 'missing'})` };
}

function describeAncestry(aheadBy) {
  if (aheadBy === 0) return 'ref is main head';
  return `ref is ${aheadBy} ${aheadBy === 1 ? 'commit' : 'commits'} behind main`;
}

/** Fence longer than any backtick run inside, so rendered content cannot close the block early. */
function fencedBlock(text, language = '') {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return [`${fence}${language}`, text, fence].join('\n');
}

function describeScope(module, targetRepo) {
  return module.TOKEN_SCOPE === 'org'
    ? 'installation-wide (organisation operation, no repository)'
    : `restricted to \`${targetRepo}\``;
}

function renderPermissions(permissions) {
  return [
    '| Permission | Level |',
    '|---|---|',
    ...Object.entries(permissions).map(([name, level]) => `| ${safeText(name)} | ${safeText(level)} |`),
  ];
}

function renderFacts({ org, request, ancestry }) {
  const { op, module, targetRepo, ref } = request;
  return [
    `- Op: \`${op}\``,
    `- Target: ${module.TOKEN_SCOPE === 'org' ? `organisation \`${org}\`` : `\`${org}/${targetRepo}\``}`,
    `- Ref: ${ref === '' ? 'none' : `\`${ref}\``}`,
    ...(ancestry === undefined ? [] : [`- Ancestry: ${ancestry}`]),
    `- Token: ${describeScope(module, targetRepo)}`,
  ];
}

function renderRequest({ org, request, ancestry }) {
  return [
    ...renderFacts({ org, request, ancestry }),
    '',
    'Args:',
    '',
    fencedBlock(JSON.stringify(request.args, null, 2), 'json'),
  ];
}

/** Untrusted text in a code span: safeText removed the backticks, so links and images stay inert. */
const inCodeSpan = (text) => `\`${safeText(text)}\``;

function failure(heading, reason) {
  return { exitCode: 1, summary: [`## ${heading}`, '', `Result: **fail**: ${inCodeSpan(reason)}`].join('\n'), reason: safeText(reason) };
}

/**
 * Validates the dispatch and reports what `apply` will do. Holds no secret.
 * @param {Record<string, string|undefined>} env
 * @param {object} [overrides] test seams: registry, createClient, loadConfig, controlRoot
 * @returns {Promise<Result>}
 */
export async function plan(env, overrides = {}) {
  const deps = { ...DEFAULTS, ...overrides };
  const heading = 'admin-run plan';
  if (env.GITHUB_REF !== MAIN_REF) return failure(heading, `runs only from ${MAIN_REF}`);
  const { problems, request } = validateRequest(readInputs(env), deps.registry);
  if (problems.length > 0) return failure(heading, problems.join('; '));
  const { org } = await deps.loadConfig({ root: deps.controlRoot });
  let ancestry;
  if (request.op === OP_WITH_REF) {
    const checked = await checkAncestry(deps.createClient({ env }), { org, repo: request.targetRepo, ref: request.ref });
    if (checked.problem !== undefined) return failure(heading, checked.problem);
    ancestry = describeAncestry(checked.aheadBy);
  }
  const summary = [
    `## ${heading}`,
    '',
    'Result: **pass**. Approve the `admin` environment to apply.',
    '',
    ...renderRequest({ org, request, ancestry }),
    '',
    'Requested token permissions:',
    '',
    ...renderPermissions(request.module.PERMISSIONS),
  ].join('\n');
  return { exitCode: 0, summary };
}

/**
 * @param {GitHubClient} client minted token
 * @param {{ org: string, repo: string }} target
 * @returns {Promise<string>} head SHA of the default branch
 */
async function readDefaultBranchHead(client, { org, repo }) {
  const repoPath = apiPath('/repos/{org}/{repo}', { org, repo });
  const branch = (await client.request('GET', repoPath)).data?.default_branch;
  if (typeof branch !== 'string' || branch === '') throw new GitHubError(`GET ${repoPath}: response has no default_branch`);
  const branchPath = apiPath('/repos/{org}/{repo}/branches/{branch}', { org, repo, branch });
  const sha = (await client.request('GET', branchPath)).data?.commit?.sha;
  if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) throw new GitHubError(`GET ${branchPath}: response has no commit SHA`);
  return sha;
}

/** Only plain `.json` blobs with no traversal, backslash or colon in any segment. Paths are relative to the settings subtree. */
function isSettingsFile(entry) {
  const filePath = entry?.path;
  if (entry?.type !== 'blob' || typeof filePath !== 'string' || !filePath.endsWith('.json')) return false;
  if (!String(entry.mode ?? '').startsWith(BLOB_MODE_PREFIX)) return false;
  return filePath.split('/').every((segment) => segment !== '' && !DOT_SEGMENTS.has(segment) && !/[\\:]/.test(segment));
}

/** @returns {Promise<object[]>} the entries of one tree; a truncated or malformed response throws */
async function readTree(client, { org, repo, sha }, query) {
  const treePath = apiPath('/repos/{org}/{repo}/git/trees/{sha}', { org, repo, sha });
  const tree = (await client.request('GET', treePath, query === undefined ? {} : { query })).data;
  if (tree?.truncated === true || !Array.isArray(tree?.tree)) {
    throw new GitHubError(`GET ${treePath}: tree is truncated or malformed`);
  }
  return tree.tree;
}

/** Walks one directory level at a time so only the settings subtree is ever listed recursively. */
async function findSettingsTreeSha(client, { org, repo, sha }) {
  let treeSha = sha;
  for (const name of SETTINGS_SEGMENTS) {
    const entries = await readTree(client, { org, repo, sha: treeSha });
    const child = entries.find((entry) => entry?.path === name && entry.type === 'tree');
    if (typeof child?.sha !== 'string' || child.sha === '') {
      throw new GitHubError(`commit ${sha} has no ${SETTINGS_SEGMENTS.join('/')} directory`);
    }
    treeSha = child.sha;
  }
  return treeSha;
}

/**
 * Writes the target repo's `.github/groundwork/**.json` at `sha` into `directory`.
 * @param {GitHubClient} client
 * @param {{ org: string, repo: string, sha: string, directory: string }} source
 */
export async function materialiseSettings(client, { org, repo, sha, directory }) {
  const settingsSha = await findSettingsTreeSha(client, { org, repo, sha });
  const entries = await readTree(client, { org, repo, sha: settingsSha }, { recursive: 1 });
  for (const entry of entries.filter(isSettingsFile)) {
    const blobPath = apiPath('/repos/{org}/{repo}/git/blobs/{sha}', { org, repo, sha: entry.sha });
    const blob = (await client.request('GET', blobPath)).data;
    if (blob?.encoding !== 'base64' || typeof blob.content !== 'string') {
      throw new GitHubError(`GET ${blobPath}: blob is not base64`);
    }
    const destination = path.join(directory, ...SETTINGS_SEGMENTS, ...entry.path.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(blob.content, 'base64'));
  }
}

/** Resolves where the op reads settings from and the commit they were read at. */
async function prepareSettings({ deps, request, client, org, directory }) {
  if (request.module.TOKEN_SCOPE === 'org') return { settingsRoot: deps.controlRoot };
  const target = { org, repo: request.targetRepo };
  const sha = request.op === OP_CHECK ? await readDefaultBranchHead(client, target) : request.ref;
  await materialiseSettings(client, { ...target, sha, directory });
  return { settingsRoot: directory };
}

/** @returns {Promise<{ ancestry?: string, error?: string }>} an error means the ref must not be applied */
async function verifyRefAncestry({ request, client, org, clean }) {
  if (request.op !== OP_WITH_REF) return {};
  const checked = await checkAncestry(client, { org, repo: request.targetRepo, ref: request.ref });
  if (checked.problem !== undefined) return { error: clean(checked.problem) };
  return { ancestry: describeAncestry(checked.aheadBy) };
}

async function runOp(context) {
  const { deps, request, client, directory, token, org, env, logs, clean, recordCall } = context;
  const { ancestry, error } = await verifyRefAncestry(context);
  if (error !== undefined) return { ok: false, parts: [], error };
  const { settingsRoot } = await prepareSettings({ deps, request, client, org, directory });
  const config = await deps.loadConfig({ root: settingsRoot });
  const repo = request.module.TOKEN_SCOPE === 'org' ? null : request.targetRepo;
  const ctx = { client, token, org, repo, settingsRoot, config, env, log: (line) => logs.push(clean(line)), recordCall };
  const parts = [await request.module.run(ctx)];
  if (request.op === OP_THEN_CHECK && parts[0].ok) parts.push(await deps.registry[OP_CHECK].run(ctx));
  return { ok: parts.every((part) => part.ok), parts, ancestry };
}

/** Runs the op (and `check` after apply-settings) with the minted client, then removes the temp directory. */
async function executeOp(context) {
  const directory = await context.deps.makeTempDir();
  try {
    return await runOp({ ...context, directory });
  } finally {
    await context.deps.removeDir(directory);
  }
}

async function revokeQuietly(deps, { env, token, onCall, clean }) {
  try {
    await deps.revokeInstallationToken(deps.createClient({ env, token, onCall }));
    return undefined;
  } catch (error) {
    return `token revocation failed, valid until expiry: ${clean(error?.message)}`;
  }
}

function renderCalls(calls) {
  return [
    '| Method | Path | Status |',
    '|---|---|---|',
    ...calls.map(({ method, path: callPath, status }) => `| ${safeText(method)} | \`${safeText(callPath)}\` | ${safeText(status)} |`),
  ];
}

function renderApplySummary({ org, request, outcome, calls, logs }) {
  const lines = [
    '## admin-run apply',
    '',
    outcome.ok ? 'Result: **pass**' : `Result: **fail**${outcome.error ? `: ${inCodeSpan(outcome.error)}` : ''}`,
    '',
    ...renderFacts({ org, request, ancestry: outcome.ancestry }),
    '',
  ];
  for (const part of outcome.parts ?? []) lines.push(part.summary, '');
  lines.push('### API calls', '', ...renderCalls(calls), '');
  if (logs.length > 0) lines.push('### Log', '', ...logs.map((line) => `- ${inCodeSpan(line)}`), '');
  return lines.join('\n').trimEnd();
}

/** Each secret whole, plus every long line of a multi-line one (a reflowed PEM never survives), longest first. */
function scrubFragments(secrets) {
  const present = secrets.filter((secret) => typeof secret === 'string' && secret !== '');
  const longLines = present
    .flatMap((secret) => secret.split(/\r?\n/).map((line) => line.trim()))
    .filter((line) => line.length >= MIN_SCRUBBED_LINE_LENGTH);
  return [...present, ...longLines].sort((first, second) => second.length - first.length);
}

/** Runs on raw text, before safeText flattens or truncates it. */
function scrub(text, secrets) {
  return scrubFragments(secrets).reduce((clean, fragment) => clean.replaceAll(fragment, MASKED), String(text ?? ''));
}

/**
 * Validates again, mints a scoped token, runs the op and revokes the token even when the op throws.
 * @param {Record<string, string|undefined>} env
 * @param {object} [overrides] test seams: registry, createClient, createAppJwt, mintInstallationToken,
 *   revokeInstallationToken, loadConfig, controlRoot, makeTempDir, removeDir, stdout
 * @returns {Promise<Result>}
 */
export async function apply(env, overrides = {}) {
  const deps = { ...DEFAULTS, ...overrides };
  const heading = 'admin-run apply';
  if (env.GITHUB_REF !== MAIN_REF) return failure(heading, `runs only from ${MAIN_REF}`);
  const { problems, request } = validateRequest(readInputs(env), deps.registry);
  if (problems.length > 0) return failure(heading, problems.join('; '));
  if (!env.ADMIN_APP_CLIENT_ID || !env.ADMIN_APP_KEY) return failure(heading, 'ADMIN_APP_CLIENT_ID and ADMIN_APP_KEY must be set');

  const { org } = await deps.loadConfig({ root: deps.controlRoot });
  const calls = [];
  const logs = [];
  const secrets = SECRET_ENV_NAMES.map((name) => env[name]);
  const record = (call) => calls.push({ method: call.method, path: call.path, status: call.status });
  const clean = (text) => safeText(scrub(text, secrets));
  const mask = (value) => {
    secrets.push(value);
    deps.stdout(`::add-mask::${value}\n`);
  };
  // Ops never see the key that mints their token.
  const opEnv = { ...env };
  delete opEnv.ADMIN_APP_KEY;

  let outcome;
  let token;
  try {
    const jwt = deps.createAppJwt({ clientId: env.ADMIN_APP_CLIENT_ID, privateKey: env.ADMIN_APP_KEY });
    mask(jwt);
    const repositories = request.module.TOKEN_SCOPE === 'org' ? 'all' : [request.targetRepo];
    const minted = await deps.mintInstallationToken({
      client: deps.createClient({ env, token: jwt, onCall: record }),
      org,
      repositories,
      permissions: request.module.PERMISSIONS,
      env,
      makeClient: (installationToken) => deps.createClient({ env, token: installationToken, onCall: record }),
    });
    token = minted.token;
    mask(token);
    const client = deps.createClient({ env: opEnv, token, onCall: record });
    outcome = await executeOp({ deps, request, client, token, org, env: opEnv, logs, clean, recordCall: record });
  } catch (error) {
    outcome = { ok: false, parts: [], error: clean(error?.message) };
  } finally {
    const revokeProblem = token === undefined ? undefined : await revokeQuietly(deps, { env: opEnv, token, onCall: record, clean });
    if (revokeProblem !== undefined) outcome = { ...outcome, ok: false, error: [outcome?.error, revokeProblem].filter(Boolean).join('; ') };
  }
  const summary = scrub(renderApplySummary({ org, request, outcome, calls, logs }), secrets);
  const reason = outcome.ok ? undefined : scrub(outcome.error ?? 'an op reported failure', secrets);
  return { exitCode: outcome.ok ? 0 : 1, summary, reason };
}

async function writeSummary(env, text) {
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, `${text}\n`);
    return;
  }
  process.stdout.write(`${text}\n`);
}

const DEFAULTS = {
  registry: REGISTRY,
  createClient,
  createAppJwt,
  mintInstallationToken,
  revokeInstallationToken,
  loadConfig,
  controlRoot: repoRoot(import.meta.url),
  makeTempDir: () => mkdtemp(path.join(os.tmpdir(), TEMP_DIR_PREFIX)),
  removeDir: (directory) => rm(directory, { recursive: true, force: true }),
  stdout: (text) => process.stdout.write(text),
};

const COMMANDS = { plan, apply };

async function runCli() {
  const command = process.argv[2];
  try {
    if (!Object.hasOwn(COMMANDS, command)) throw new GitHubError('usage: admin-run.mjs <plan|apply>');
    const { exitCode, summary, reason } = await COMMANDS[command](process.env);
    await writeSummary(process.env, summary);
    if (reason !== undefined) process.stderr.write(`admin-run: ${reason}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`admin-run: ${safeText(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await runCli();

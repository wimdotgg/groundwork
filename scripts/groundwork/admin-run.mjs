import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, repoRoot } from '../lib/config.mjs';
import { GitHubError, apiPath, createClient } from '../lib/github.mjs';
import { createAppJwt, mintInstallationToken, revokeInstallationToken } from './app-token.mjs';
import * as applySettings from './apply-settings.mjs';
import * as check from './check.mjs';
import * as bootstrap from './bootstrap.mjs';
import * as bootstrapPass2 from './bootstrap-pass2.mjs';
import * as createIssueTypes from './create-issue-types.mjs';

/** @typedef {import('../lib/github.mjs').GitHubClient} GitHubClient */
/** @typedef {import('../lib/github.mjs').CallRecord} CallRecord */
/** @typedef {{ OP: string, TOKEN_SCOPE: 'target'|'org'|'deferred', PERMISSIONS: Record<string, string>,
 *   CREATE_PERMISSIONS?: Record<string, string>, CONTROL_READ_PERMISSIONS?: Record<string, string>,
 *   validateArgs: (args: any) => string[],
 *   run: (ctx: object) => Promise<{ ok: boolean, summary: string }> }} OpModule */
/** @typedef {{ exitCode: number, summary: string, reason?: string }} Result */

/** Op name to module. The workflow's `op` choice list must equal these keys. */
export const REGISTRY = {
  'apply-settings': applySettings,
  bootstrap,
  'bootstrap-pass2': bootstrapPass2,
  check,
  'create-issue-types': createIssueTypes,
};

const MAIN_REF = 'refs/heads/main';
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+$/;
const DOT_SEGMENTS = new Set(['.', '..']);
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const OP_WITH_REF = 'apply-settings';
const OPS_THEN_CHECK = new Set(['apply-settings', 'bootstrap', 'bootstrap-pass2']);
const OP_CHECK = 'check';
const SCOPE_DEFERRED = 'deferred';
const ALL_REPOSITORIES = 'all';
const LEVEL_RANK = { read: 1, write: 2 };
const SETTINGS_SEGMENTS = ['.github', 'groundwork'];
const CHECK_SETTINGS_DIR = 'check';
const BOOTSTRAP_OPS = new Set(['bootstrap', 'bootstrap-pass2']);
const CONTROL_TARGET_REASON = 'target_repo must not be the control repository for this op';
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

/** Bootstrap ops hold a write grant on the target: aimed at `groundwork` it would be write access to the control repo. */
const targetsControlRepo = (request, controlRepo) => BOOTSTRAP_OPS.has(request.op)
  && request.targetRepo.toLowerCase() === String(controlRepo).toLowerCase();

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
  if (module.TOKEN_SCOPE === SCOPE_DEFERRED) return 'none up front; minted per declared grant while the op runs';
  return module.TOKEN_SCOPE === 'org'
    ? 'installation-wide (organisation operation, no repository)'
    : `restricted to \`${targetRepo}\``;
}

/** A deferred op lists every grant `withToken` can mint, the create fallback included, so the owner approves all of them. */
function renderRequestedPermissions(module, { controlRepo, targetRepo }) {
  if (module.TOKEN_SCOPE !== SCOPE_DEFERRED) return ['Requested token permissions:', '', ...renderPermissions(module.PERMISSIONS)];
  const grants = [
    [`target repository \`${targetRepo}\`, any subset of`, module.PERMISSIONS],
    [`create call on \`${controlRepo}\`, or installation-wide when GitHub refuses that`, module.CREATE_PERMISSIONS],
    [`control repository \`${controlRepo}\` read`, module.CONTROL_READ_PERMISSIONS],
  ];
  return grants.flatMap(([label, permissions]) => [`Token grant, ${label}:`, '', ...renderPermissions(permissions), '']);
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
  const { org, controlRepo } = await deps.loadConfig({ root: deps.controlRoot });
  if (targetsControlRepo(request, controlRepo)) return failure(heading, CONTROL_TARGET_REASON);
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
    ...renderRequestedPermissions(request.module, { controlRepo, targetRepo: request.targetRepo }),
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

/** Bootstrap ops read the target's `main` head (12.1); standalone `check` keeps the default branch head. */
const readSettingsHead = (client, target, op) => (BOOTSTRAP_OPS.has(op) ? readMainSha(client, target) : readDefaultBranchHead(client, target));

/** Resolves where the op reads settings from and the commit they were read at. */
async function prepareSettings({ deps, request, client, org, directory }) {
  if (request.module.TOKEN_SCOPE !== 'target') return { settingsRoot: deps.controlRoot };
  const target = { org, repo: request.targetRepo };
  const sha = request.op === OP_WITH_REF ? request.ref : await readSettingsHead(client, target, request.op);
  await materialiseSettings(client, { ...target, sha, directory });
  return { settingsRoot: directory };
}

/** A settings file key is a repo path under `.github/groundwork/` with no traversal, backslash or colon. */
function isSettingsKey(key) {
  const prefix = `${SETTINGS_SEGMENTS.join('/')}/`;
  return key.startsWith(prefix) && key.slice(prefix.length).split('/').every((segment) => segment !== '' && !DOT_SEGMENTS.has(segment) && !/[\\:]/.test(segment));
}

/** `ctx.writeSettings`: the settings source of `bootstrap`, written under the run's temp directory. */
async function writeSettingsFiles({ deps, directory }, files) {
  for (const [key, text] of Object.entries(files ?? {})) {
    if (!isSettingsKey(key) || typeof text !== 'string') throw new GitHubError('writeSettings: files must map .github/groundwork/ paths to text');
    const destination = path.join(directory, ...key.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, text);
  }
  return { settingsRoot: directory, config: await deps.loadConfig({ root: directory }) };
}

const samePermissionSets = (first, second) => Object.keys(first).length === Object.keys(second).length
  && Object.keys(first).every((key) => Object.hasOwn(second, key) && first[key] === second[key]);

const isRepositoryList = (repositories, expected) => Array.isArray(repositories) && repositories.length === 1 && repositories[0] === expected;

/** Same or lower level than the op's own permissions, and at least one. */
function isPermissionSubset(requested, allowed) {
  const entries = Object.entries(requested);
  return entries.length > 0 && entries.every(([name, level]) => Object.hasOwn(allowed, name) && Object.hasOwn(LEVEL_RANK, level) && LEVEL_RANK[level] <= LEVEL_RANK[allowed[name]]);
}

/** Why a request is not one of the op's three declared grants (12.1), or undefined. Runs before any mint. */
function grantProblem(requested, { module, targetRepo, controlRepo }) {
  const { repositories, permissions } = requested ?? {};
  if (module.TOKEN_SCOPE !== SCOPE_DEFERRED) return 'this op already has its token';
  if (!isPlainObject(permissions)) return 'permissions must be an object';
  if (isRepositoryList(repositories, targetRepo)) {
    return isPermissionSubset(permissions, module.PERMISSIONS) ? undefined : 'permissions exceed the op permissions for the target';
  }
  if (isRepositoryList(repositories, controlRepo) && samePermissionSets(permissions, module.CONTROL_READ_PERMISSIONS)) return undefined;
  const createRepositories = isRepositoryList(repositories, controlRepo) || repositories === ALL_REPOSITORIES;
  if (createRepositories && samePermissionSets(permissions, module.CREATE_PERMISSIONS)) return undefined;
  return 'request is not one of the declared grants';
}

/** Signs a fresh JWT (one lasts minutes) and mints; the JWT never leaves this function. */
async function mintScopedToken({ deps, env, org, repositories, permissions, record, mask }) {
  const jwt = deps.createAppJwt({ clientId: env.ADMIN_APP_CLIENT_ID, privateKey: env.ADMIN_APP_KEY });
  mask(jwt);
  const minted = await deps.mintInstallationToken({
    client: deps.createClient({ env, token: jwt, onCall: record }),
    org,
    repositories,
    permissions,
    env,
    makeClient: (installationToken) => deps.createClient({ env, token: installationToken, onCall: record }),
  });
  mask(minted.token);
  return minted.token;
}

function snapshotRequest(requested) {
  const { repositories, permissions } = requested ?? {};
  return {
    repositories: Array.isArray(repositories) ? Object.freeze([...repositories]) : repositories,
    permissions: isPlainObject(permissions) ? Object.freeze({ ...permissions }) : permissions,
  };
}

/** `ctx.withToken`: one grant at a time, revoked in a `finally`. A failed revoke is collected, so it fails the run even if the op swallows the error. */
function createWithToken({ deps, env, opEnv, org, record, mask, clean, grants }) {
  const revokeProblems = [];
  let active = false;
  const withToken = async (requested, callback) => {
    if (active) throw new GitHubError('withToken calls do not nest');
    // Validate and mint the same frozen copy: the caller's objects can change while the mint awaits.
    const { repositories, permissions } = snapshotRequest(requested);
    const problem = grantProblem({ repositories, permissions }, grants);
    if (problem !== undefined) throw new GitHubError(`withToken refused: ${problem}`);
    active = true;
    try {
      const token = await mintScopedToken({ deps, env, org, repositories, permissions, record, mask });
      try {
        return await callback({ client: deps.createClient({ env: opEnv, token, onCall: record }), token });
      } finally {
        const revokeProblem = await revokeQuietly(deps, { env: opEnv, token, onCall: record, clean });
        if (revokeProblem !== undefined) revokeProblems.push(revokeProblem);
      }
    } finally {
      active = false;
    }
  };
  return { withToken, revokeProblems };
}

/** `check` for a `deferred` op: its own token and the target's `main` head as the settings source. */
async function checkAfterDeferred({ deps, request, org, directory, withToken }, ctx) {
  const checkModule = deps.registry[OP_CHECK];
  const target = { org, repo: request.targetRepo };
  return withToken({ repositories: [request.targetRepo], permissions: checkModule.PERMISSIONS }, async ({ client, token }) => {
    const settingsRoot = path.join(directory, CHECK_SETTINGS_DIR);
    await materialiseSettings(client, { ...target, sha: await readMainSha(client, target), directory: settingsRoot });
    const config = await deps.loadConfig({ root: settingsRoot });
    return checkModule.run({ ...ctx, client, token, settingsRoot, config });
  });
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
  const ctx = {
    client, token, org, repo, settingsRoot, config, env, log: (line) => logs.push(clean(line)), recordCall,
    withToken: context.withToken, writeSettings: (files) => writeSettingsFiles({ deps, directory }, files),
  };
  const parts = [await request.module.run(ctx)];
  if (OPS_THEN_CHECK.has(request.op) && parts[0].ok) {
    parts.push(await (request.module.TOKEN_SCOPE === SCOPE_DEFERRED ? checkAfterDeferred(context, ctx) : deps.registry[OP_CHECK].run(ctx)));
  }
  return { ok: parts.every((part) => part.ok), parts, ancestry };
}

/** Runs the op (and its trailing `check`) with the minted client, then removes the temp directory. */
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

  const { org, controlRepo } = await deps.loadConfig({ root: deps.controlRoot });
  if (targetsControlRepo(request, controlRepo)) return failure(heading, CONTROL_TARGET_REASON);
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

  const deferred = request.module.TOKEN_SCOPE === SCOPE_DEFERRED;
  const grants = { module: request.module, targetRepo: request.targetRepo, controlRepo };
  const tokens = createWithToken({ deps, env, opEnv, org, record, mask, clean, grants });
  const context = { deps, request, client: null, token: null, org, env: opEnv, logs, clean, recordCall: record, withToken: tokens.withToken };

  let outcome;
  let token;
  try {
    if (deferred) {
      outcome = await executeOp(context);
    } else {
      token = await mintScopedToken({
        deps, env, org, record, mask,
        repositories: request.module.TOKEN_SCOPE === 'org' ? ALL_REPOSITORIES : [request.targetRepo],
        permissions: request.module.PERMISSIONS,
      });
      const client = deps.createClient({ env: opEnv, token, onCall: record });
      outcome = await executeOp({ ...context, client, token });
    }
  } catch (error) {
    outcome = { ok: false, parts: [], error: clean(error?.message) };
  } finally {
    const revokeProblem = token === undefined ? undefined : await revokeQuietly(deps, { env: opEnv, token, onCall: record, clean });
    const problems = [revokeProblem, ...tokens.revokeProblems].filter((problem) => problem !== undefined);
    if (problems.length > 0) outcome = { ...outcome, ok: false, error: [outcome?.error, ...problems].filter(Boolean).join('; ') };
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

import { spawn } from 'node:child_process';
import { ConfigError } from '../lib/config.mjs';
import { GitHubError, apiPath } from '../lib/github.mjs';
import { SettingsError, loadDesiredState, readSignals, repoKind, resolvePlaceholders } from '../lib/settings.mjs';
import { normalizeLabel, resolveActor } from '../lib/trust.mjs';

/** @typedef {import('../lib/github.mjs').GitHubClient} GitHubClient */
/** @typedef {import('../lib/settings.mjs').DesiredState} DesiredState */
/** @typedef {import('../lib/settings.mjs').Signals} Signals */
/** @typedef {{ client: GitHubClient, token: string, org: string, repo: string|null, settingsRoot: string,
 *   config: import('../lib/config.mjs').Config, env: Record<string, string|undefined>, log: (line: string) => void }} OpContext */
/** @typedef {{ args: string[], stdin: string, env: Record<string, string|undefined> }} GhInvocation */
/** @typedef {{ spawnGh: (invocation: GhInvocation) => Promise<{ code: number|null, stderr: string }> }} Dependencies */

export const OP = 'apply-settings';
export const TOKEN_SCOPE = 'target';
export const PERMISSIONS = {
  administration: 'write',
  environments: 'write',
  variables: 'write',
  issues: 'write',
  contents: 'read',
  members: 'read',
  actions: 'read',
};

const REPO_TEMPLATE = '/repos/{owner}/{repo}';
const TEAM_REPO_PATH = '/orgs/{org}/teams/{team}/repos/{org}/{repo}';
const ENVIRONMENT_PATH = '/environments/{name}';
const BRANCH_POLICIES_PATH = `${ENVIRONMENT_PATH}/deployment-branch-policies`;
const CODE_SCANNING_SETUP_KEY = 'code_scanning_default_setup';
const CODE_SCANNING_RULE = 'code_scanning';
const MAIN_RULESET = 'main';
const RELEASE_ENVIRONMENT = 'release';
const SECURITY_ENDPOINTS = {
  private_vulnerability_reporting: '/private-vulnerability-reporting',
  vulnerability_alerts: '/vulnerability-alerts',
  automated_security_fixes: '/automated-security-fixes',
};
const ACTIONS_ENDPOINTS = {
  permissions: '/actions/permissions',
  workflow: '/actions/permissions/workflow',
  fork_pr_contributor_approval: '/actions/permissions/fork-pr-contributor-approval',
};
const RELEASE_WRITES = [
  { command: 'secret', name: 'RELEASE_APP_KEY' },
  { command: 'variable', name: 'RELEASE_APP_CLIENT_ID' },
];
const DEPLOYMENT_BRANCH_POLICY = { protected_branches: false, custom_branch_policies: true };

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const firstLine = (text) => String(text ?? '').trim().split(/\r?\n/)[0] || 'no output';
const refKey = (ref) => `${ref.type}:${ref.name}`;

/**
 * @param {unknown} args parsed JSON object from admin-run
 * @returns {string[]} problems; empty when valid
 */
export function validateArgs(args) {
  if (!isPlainObject(args)) return ['args must be a JSON object'];
  return Object.keys(args).map((key) => `unknown key "${key}"`);
}

/** @returns {Promise<{ code: number|null, stderr: string }>} */
function spawnGh({ args, stdin, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { env, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new GitHubError(`cannot run gh: ${firstLine(error.message)}`)));
    child.on('close', (code) => resolve({ code, stderr }));
    // EPIPE when gh exits before reading stdin; the failure surfaces through the exit code.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

const DEFAULT_DEPENDENCIES = { spawnGh };

function repoRequest(context, { method, suffix = '', params = {}, body }) {
  const path = apiPath(`${REPO_TEMPLATE}${suffix}`, { ...params, ...context.repoRef });
  return context.client.request(method, path, body === undefined ? {} : { body });
}

function repoList(context, { suffix, itemsKey, params = {}, query }) {
  const path = apiPath(`${REPO_TEMPLATE}${suffix}`, { ...params, ...context.repoRef });
  return context.client.paginate(path, { itemsKey, query });
}

function describeCounts(counts) {
  const parts = Object.entries(counts).filter(([, count]) => count > 0).map(([name, count]) => `${count} ${name}`);
  return parts.length > 0 ? parts.join(', ') : 'nothing to change';
}

async function applyRepository(context) {
  const { settings } = context.desired;
  const body = { ...settings.repository, ...(context.kind === 'control' ? settings.controlRepository : {}) };
  if (Object.keys(body).length === 0) return 'nothing to send';
  await repoRequest(context, { method: 'PATCH', body });
  return 'settings patched';
}

async function applyTeamAccess(context) {
  const teams = context.desired.settings.teamAccess ?? [];
  for (const { team, permission } of teams) {
    const path = apiPath(TEAM_REPO_PATH, { org: context.org, team, repo: context.repoRef.repo });
    await context.client.request('PUT', path, { body: { permission } });
  }
  return `${teams.length} team(s) granted`;
}

function assertKnownKeys(section, values, known) {
  const unknown = Object.keys(values).find((key) => !known.includes(key));
  if (unknown !== undefined) throw new SettingsError(`settings.json: unknown ${section} key "${unknown}"`);
}

/** Code scanning default setup is never sent: it needs a pass 2 decision (spec 10). */
async function applySecurity(context) {
  const security = context.desired.settings.security ?? {};
  assertKnownKeys('security', security, [...Object.keys(SECURITY_ENDPOINTS), CODE_SCANNING_SETUP_KEY]);
  let applied = 0;
  for (const [key, suffix] of Object.entries(SECURITY_ENDPOINTS)) {
    if (security[key] === undefined) continue;
    if (typeof security[key] !== 'boolean') throw new SettingsError(`settings.json: security.${key} must be a boolean`);
    await repoRequest(context, { method: security[key] ? 'PUT' : 'DELETE', suffix });
    applied += 1;
  }
  return `${applied} switch(es) applied`;
}

async function applyActions(context) {
  const actions = context.desired.settings.actions ?? {};
  assertKnownKeys('actions', actions, Object.keys(ACTIONS_ENDPOINTS));
  let applied = 0;
  for (const [key, suffix] of Object.entries(ACTIONS_ENDPOINTS)) {
    if (actions[key] === undefined) continue;
    await repoRequest(context, { method: 'PUT', suffix, body: actions[key] });
    applied += 1;
  }
  return `${applied} endpoint(s) applied`;
}

/** Mirrors the assertWhen rules of settings.mjs; an unreadable signal never holds. */
function assertionHolds(assertWhen, { signals, config }) {
  if (assertWhen === 'kitInstalled') return signals.kitInstalled === true;
  if (config.deploy === 'none') return false;
  return signals.codeScanningConfigured === true || signals.pass2Ran === true;
}

async function applyVariables(context) {
  const wanted = Object.entries(context.desired.settings.variables ?? {})
    .filter(([, spec]) => assertionHolds(spec.assertWhen, context));
  const counts = { created: 0, updated: 0 };
  if (wanted.length === 0) return describeCounts(counts);
  const live = await repoList(context, { suffix: '/actions/variables', itemsKey: 'variables' });
  for (const [name, spec] of wanted) {
    const entry = live.find((candidate) => candidate.name === name);
    if (!entry) {
      await repoRequest(context, { method: 'POST', suffix: '/actions/variables', body: { name, value: spec.value } });
      counts.created += 1;
    } else if (entry.value !== spec.value) {
      await repoRequest(context, {
        method: 'PATCH', suffix: '/actions/variables/{name}', params: { name }, body: { name, value: spec.value },
      });
      counts.updated += 1;
    }
  }
  return describeCounts(counts);
}

const appliesToKind = (repos, kind) => repos === 'all' || (repos === 'projects' && kind === 'project') || (repos === 'control' && kind === 'control');

async function lookupUserId(context, login) {
  const response = await context.client.request('GET', apiPath('/users/{login}', { login }));
  if (!Number.isInteger(response.data?.id)) throw new SettingsError(`user ${login} returned no integer id`);
  return response.data.id;
}

async function resolveReviewers(context, reviewers) {
  const resolved = [];
  for (const reviewer of reviewers) {
    resolved.push({ type: 'User', id: await lookupUserId(context, resolveActor(reviewer, context.config)) });
  }
  return resolved;
}

async function syncDeploymentRefs(context, name, desiredRefs) {
  const live = await repoList(context, { suffix: BRANCH_POLICIES_PATH, itemsKey: 'branch_policies', params: { name } });
  const liveKeys = new Set(live.map(refKey));
  const desiredKeys = new Set(desiredRefs.map(refKey));
  const missing = desiredRefs.filter((ref) => !liveKeys.has(refKey(ref)));
  const extras = live.filter((ref) => !desiredKeys.has(refKey(ref)));
  // Add before removing so the environment is never left without a policy that admits main.
  for (const ref of missing) {
    await repoRequest(context, { method: 'POST', suffix: BRANCH_POLICIES_PATH, params: { name }, body: { name: ref.name, type: ref.type } });
  }
  for (const ref of extras) {
    await repoRequest(context, {
      method: 'DELETE', suffix: `${BRANCH_POLICIES_PATH}/{id}`, params: { name, id: ref.id },
    });
  }
  return { added: missing.length, removed: extras.length };
}

async function applyEnvironments(context) {
  const selected = Object.entries(context.desired.settings.environments ?? {})
    .filter(([, spec]) => appliesToKind(spec.repos, context.kind));
  const counts = { environments: selected.length, 'refs added': 0, 'refs removed': 0 };
  for (const [name, spec] of selected) {
    const body = {
      reviewers: await resolveReviewers(context, spec.reviewers ?? []),
      prevent_self_review: spec.prevent_self_review,
      can_admins_bypass: spec.can_admins_bypass,
      deployment_branch_policy: DEPLOYMENT_BRANCH_POLICY,
    };
    await repoRequest(context, { method: 'PUT', suffix: ENVIRONMENT_PATH, params: { name }, body });
    const refs = await syncDeploymentRefs(context, name, spec.deployment_refs ?? []);
    counts['refs added'] += refs.added;
    counts['refs removed'] += refs.removed;
  }
  return describeCounts(counts);
}

/** The child gets the caller's environment minus the release values, so only stdin carries them. */
function ghEnvironment({ env, token }) {
  const childEnv = { ...env, GH_TOKEN: token };
  for (const { name } of RELEASE_WRITES) delete childEnv[name];
  return childEnv;
}

async function applyReleaseEnvironment(context) {
  const missing = RELEASE_WRITES.find(({ name }) => !context.env[name]);
  if (missing) throw new SettingsError(`${missing.name} is not set in the environment`);
  const target = `${context.org}/${context.repoRef.repo}`;
  for (const { command, name } of RELEASE_WRITES) {
    const args = [command, 'set', name, '--env', RELEASE_ENVIRONMENT, '--repo', target];
    const { code, stderr } = await context.dependencies.spawnGh({
      args, stdin: context.env[name], env: ghEnvironment(context),
    });
    if (code !== 0) throw new GitHubError(`gh ${command} set ${name} failed: ${firstLine(stderr)}`);
  }
  return `${RELEASE_WRITES.map(({ name }) => name).join(', ')} written to ${RELEASE_ENVIRONMENT}`;
}

async function applyLabels(context) {
  const desired = context.desired.labels;
  const live = await repoList(context, { suffix: '/labels' });
  const liveByName = new Map(live.map((label) => [normalizeLabel(label.name), label]));
  const wanted = new Set(desired.map((label) => normalizeLabel(label.name)));
  const counts = { created: 0, updated: 0, deleted: 0 };
  for (const label of desired) {
    const entry = liveByName.get(normalizeLabel(label.name));
    const body = { color: label.color, description: label.description };
    if (!entry) {
      await repoRequest(context, { method: 'POST', suffix: '/labels', body: { name: label.name, ...body } });
      counts.created += 1;
    } else if (normalizeLabel(entry.color) !== normalizeLabel(label.color) || (entry.description ?? '') !== label.description) {
      await repoRequest(context, { method: 'PATCH', suffix: '/labels/{name}', params: { name: entry.name }, body });
      counts.updated += 1;
    }
  }
  for (const entry of live.filter((label) => !wanted.has(normalizeLabel(label.name)))) {
    await repoRequest(context, { method: 'DELETE', suffix: '/labels/{name}', params: { name: entry.name } });
    counts.deleted += 1;
  }
  return describeCounts(counts);
}

/** Spec 9.1: `main` goes out without code_scanning until CodeQL is configured or pass 2 has run. */
function withoutDeferredRules(ruleset, signals) {
  const deferred = ruleset.name === MAIN_RULESET && signals.pass2Ran === false && signals.codeScanningConfigured === false;
  if (!deferred) return ruleset;
  return { ...ruleset, rules: ruleset.rules.filter((rule) => rule.type !== CODE_SCANNING_RULE) };
}

async function applyRulesets(context) {
  const bodies = [];
  for (const ruleset of context.desired.rulesets) {
    const resolved = await resolvePlaceholders(ruleset, context);
    bodies.push(withoutDeferredRules(resolved, context.signals));
  }
  const live = await repoList(context, { suffix: '/rulesets', query: { includes_parents: false } });
  const counts = { created: 0, updated: 0 };
  for (const body of bodies) {
    const existing = live.find((candidate) => candidate.name === body.name);
    if (existing) {
      await repoRequest(context, { method: 'PUT', suffix: '/rulesets/{id}', params: { id: existing.id }, body });
      counts.updated += 1;
    } else {
      await repoRequest(context, { method: 'POST', suffix: '/rulesets', body });
      counts.created += 1;
    }
  }
  return describeCounts(counts);
}

const STEPS = [
  { name: 'repository', apply: applyRepository },
  { name: 'teamAccess', apply: applyTeamAccess },
  { name: 'security', apply: applySecurity },
  { name: 'actions', apply: applyActions },
  { name: 'variables', apply: applyVariables },
  { name: 'environments', apply: applyEnvironments },
  { name: 'release environment', apply: applyReleaseEnvironment },
  { name: 'labels', apply: applyLabels },
  { name: 'rulesets', apply: applyRulesets },
];

function nameStep(label, error) {
  if (error instanceof GitHubError) return new GitHubError(`${label}: ${error.message}`, error);
  if (error instanceof SettingsError || error instanceof ConfigError) return new SettingsError(`${label}: ${error.message}`, error.file);
  return error;
}

async function runStep(log, label, action) {
  log(label);
  try {
    return await action();
  } catch (error) {
    throw nameStep(label, error);
  }
}

/**
 * Syncs the target repository to the settings files in `settingsRoot`. Stops at the first failed call; every
 * completed step was logged before its calls, so re-running is the recovery path.
 * @param {OpContext} ctx
 * @param {Dependencies} [dependencies] test seam for the `gh` subprocess
 * @returns {Promise<{ ok: boolean, summary: string }>}
 */
export async function run(ctx, dependencies = DEFAULT_DEPENDENCIES) {
  if (typeof ctx.repo !== 'string' || ctx.repo === '') throw new SettingsError(`${OP} needs a target repository`);
  const repoRef = { owner: ctx.org, repo: ctx.repo };
  const kind = repoKind(ctx.repo, ctx.config);
  const desired = await loadDesiredState({ root: ctx.settingsRoot });
  const signals = await runStep(ctx.log, 'reading live signals', () => readSignals(ctx.client, repoRef, { repoKind: kind }));
  const context = { ...ctx, desired, kind, repoRef, dependencies, signals };
  const outcomes = [];
  for (const [index, step] of STEPS.entries()) {
    const label = `step ${index + 1}/${STEPS.length} ${step.name}`;
    outcomes.push(`- ${step.name}: ${await runStep(ctx.log, label, () => step.apply(context))}`);
  }
  return { ok: true, summary: [`### ${OP} ${ctx.org}/${ctx.repo}`, '', ...outcomes].join('\n') };
}

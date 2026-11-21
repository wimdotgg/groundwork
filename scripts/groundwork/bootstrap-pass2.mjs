import { setTimeout as delay } from 'node:timers/promises';
import { GitHubError, apiPath } from '../lib/github.mjs';
import { SettingsError, loadDesiredState } from '../lib/settings.mjs';

/** @typedef {import('../lib/github.mjs').GitHubClient} GitHubClient */

/** Op identity, read by admin-run (12.1). */
export const OP = 'bootstrap-pass2';

/** The repository exists by pass 2: the token is scoped to it like `apply-settings`. */
export const TOKEN_SCOPE = 'target';

/** Keys are the snake_case names of 12.1. */
export const PERMISSIONS = {
  administration: 'write',
  actions_variables: 'write',
  contents: 'read',
  environments: 'read',
  actions: 'read',
  issues: 'read',
  members: 'read',
};

export const STUB_MARKER = 'GROUNDWORK_STUB';

const REPO_PATH = '/repos/{owner}/{repo}';
const MAIN_RULESET = 'main';
const MAIN_BRANCH = 'main';
const NOT_FOUND = 404;
const CODE_SCANNING_RULE = 'code_scanning';
const CODEQL_WORKFLOW_NAME = 'CodeQL';
const DEFAULT_CODEQL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS = 15 * 1000;
const SETUP_READBACK_ATTEMPTS = 10;
const DEPLOY_VARIABLE = 'DEPLOY_ENABLED';
const DEPLOY_VARIABLE_VALUE = 'true';
const DEPLOY_NONE = 'none';
const RULESET_BODY_KEYS = ['name', 'target', 'enforcement', 'conditions', 'bypass_actors', 'rules'];

/** Test seam: tests inject an instant `sleep` and a short bound. */
const DEFAULT_DEPENDENCIES = { sleep: delay, timeoutMs: DEFAULT_CODEQL_TIMEOUT_MS, pollMs: DEFAULT_POLL_MS };

const get = (client, template, params, options) => client.request('GET', apiPath(template, params), options);

/**
 * @param {object} args parsed JSON object from the dispatch input
 * @returns {string[]} one error per key; empty when valid
 */
export function validateArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return ['args must be a JSON object'];
  return Object.keys(args).map((key) => `unknown argument "${key}"`);
}

/**
 * @param {{ client: GitHubClient, org: string, repo: string }} options
 * @returns {Promise<'stub'|'real'|'missing'>} state of `scripts/verify` on `main`
 */
export async function readVerifyState({ client, org, repo }) {
  const response = await get(client, `${REPO_PATH}/contents/scripts/verify`, { owner: org, repo }, {
    query: { ref: MAIN_BRANCH }, okStatuses: [NOT_FOUND],
  });
  if (response.status === NOT_FOUND) return 'missing';
  const text = Buffer.from(response.data?.content ?? '', 'base64').toString('utf8');
  return text.includes(STUB_MARKER) ? 'stub' : 'real';
}

/**
 * Writes nothing when default setup is already `configured`.
 * @param {{ client: GitHubClient, org: string, repo: string, sleep?: (ms: number) => Promise<unknown> }} options
 * @returns {Promise<void>}
 */
export async function enableDefaultSetup({ client, org, repo, sleep = DEFAULT_DEPENDENCIES.sleep }) {
  const path = apiPath(`${REPO_PATH}/code-scanning/default-setup`, { owner: org, repo });
  const isConfigured = async () => (await client.request('GET', path)).data?.state === 'configured';
  if (await isConfigured()) return;
  await client.request('PATCH', path, { body: { state: 'configured' } });
  for (let attempt = 1; attempt < SETUP_READBACK_ATTEMPTS; attempt += 1) {
    await sleep(DEFAULT_POLL_MS);
    if (await isConfigured()) return;
  }
  throw new GitHubError(`code scanning default setup on ${org}/${repo} is not configured after the PATCH`);
}

/**
 * The bound counts the sleeps, so tests need no clock.
 * @param {{ client: GitHubClient, org: string, repo: string, timeoutMs?: number, pollMs?: number,
 *   sleep?: (ms: number) => Promise<unknown> }} options
 * @returns {Promise<{ runId: number, conclusion: string }>}
 */
export async function waitForFirstCodeqlRun({
  client, org, repo, timeoutMs = DEFAULT_CODEQL_TIMEOUT_MS, pollMs = DEFAULT_POLL_MS, sleep = DEFAULT_DEPENDENCIES.sleep,
}) {
  for (let waited = 0; ; waited += pollMs) {
    const response = await get(client, `${REPO_PATH}/actions/runs`, { owner: org, repo }, {
      query: { branch: MAIN_BRANCH, status: 'completed' },
    });
    const found = (response.data?.workflow_runs ?? []).find((candidate) => candidate.name === CODEQL_WORKFLOW_NAME);
    if (found) return { runId: found.id, conclusion: found.conclusion };
    if (waited + pollMs > timeoutMs) {
      throw new GitHubError(`no completed ${CODEQL_WORKFLOW_NAME} run on main in ${org}/${repo} within ${timeoutMs} ms`);
    }
    await sleep(pollMs);
  }
}

const findCodeScanningRule = (ruleset) => (ruleset.rules ?? []).find((rule) => rule.type === CODE_SCANNING_RULE);

/**
 * @param {{ live: { rules: object[] }, desired: { rules: object[] } }} options `desired` is the target's rulesets/main.json
 * @returns {object} `live` with desired's code_scanning rule added or replaced and every other rule kept
 */
export function withCodeScanningRule({ live, desired }) {
  const rule = findCodeScanningRule(desired);
  if (!rule) {
    throw new SettingsError(`the desired ${MAIN_RULESET} ruleset has no ${CODE_SCANNING_RULE} rule; commit it to rulesets/main.json first`);
  }
  const others = live.rules.filter((candidate) => candidate.type !== CODE_SCANNING_RULE);
  return { ...live, rules: [...others, rule] };
}

async function readLiveMainRuleset(client, repoRef) {
  const summaries = await client.paginate(apiPath(`${REPO_PATH}/rulesets`, repoRef), { query: { includes_parents: false } });
  const summary = summaries.find((candidate) => candidate.name === MAIN_RULESET && candidate.target === 'branch');
  if (!summary) throw new SettingsError(`no live ${MAIN_RULESET} ruleset on ${repoRef.owner}/${repoRef.repo}; run apply-settings first`);
  return (await get(client, `${REPO_PATH}/rulesets/{id}`, { ...repoRef, id: summary.id })).data;
}

/**
 * @param {{ client: GitHubClient, org: string, repo: string, desired: { rules: object[] } }} options
 * @returns {Promise<'added'|'present'>} `present` when live already carries the identical rule
 */
export async function addCodeScanningRule({ client, org, repo, desired }) {
  const repoRef = { owner: org, repo };
  const live = await readLiveMainRuleset(client, repoRef);
  const updated = withCodeScanningRule({ live, desired });
  if (JSON.stringify(findCodeScanningRule(live)) === JSON.stringify(findCodeScanningRule(updated))) return 'present';
  const body = Object.fromEntries(RULESET_BODY_KEYS.map((key) => [key, updated[key]]));
  await client.request('PUT', apiPath(`${REPO_PATH}/rulesets/{id}`, { ...repoRef, id: live.id }), { body });
  return 'added';
}

/**
 * @param {{ org: string, repo: string, secrets: string[] }} options
 * @returns {string[]} summary lines for the deploy secrets the owner enters by hand
 */
export function deployChecklist({ org, repo, secrets }) {
  const page = `https://github.com/${org}/${repo}/settings/environments`;
  return [
    `Enter these secrets in the production environment (${page}):`,
    ...secrets.map((name) => `- ${name}`),
  ];
}

async function setDeployEnabled(client, repoRef) {
  const variablePath = apiPath(`${REPO_PATH}/actions/variables/{name}`, { ...repoRef, name: DEPLOY_VARIABLE });
  const body = { name: DEPLOY_VARIABLE, value: DEPLOY_VARIABLE_VALUE };
  const live = await client.request('GET', variablePath, { okStatuses: [NOT_FOUND] });
  if (live.status === NOT_FOUND) {
    await client.request('POST', apiPath(`${REPO_PATH}/actions/variables`, repoRef), { body });
    return `${DEPLOY_VARIABLE} set`;
  }
  if (live.data?.value === DEPLOY_VARIABLE_VALUE) return `${DEPLOY_VARIABLE} already set`;
  await client.request('PATCH', variablePath, { body });
  return `${DEPLOY_VARIABLE} set`;
}

async function readDesiredMain(settingsRoot) {
  const desired = await loadDesiredState({ root: settingsRoot });
  const main = desired.rulesets.find((ruleset) => ruleset.name === MAIN_RULESET);
  if (!main || !findCodeScanningRule(main)) {
    throw new SettingsError(`the project's rulesets/main.json has no ${CODE_SCANNING_RULE} rule; merge that PR before pass 2`);
  }
  return { main, settings: desired.settings };
}

/**
 * Spec 14.2 step 4. Every check that can fail runs before the first write except the CodeQL run, which needs
 * default setup; its failure leaves the ruleset untouched. Reruns write nothing.
 * @param {object} ctx op context (13.1)
 * @param {{ sleep: Function, timeoutMs: number, pollMs: number }} [dependencies] test seam
 * @returns {Promise<{ ok: boolean, summary: string }>}
 */
export async function run(ctx, dependencies = DEFAULT_DEPENDENCIES) {
  const { client, org, repo } = ctx;
  const verify = await readVerifyState({ client, org, repo });
  if (verify !== 'real') {
    const reason = verify === 'stub' ? `still the ${STUB_MARKER} stub` : 'missing';
    return { ok: false, summary: `scripts/verify is ${reason} on main; replace it before pass 2` };
  }
  const { main, settings } = await readDesiredMain(ctx.settingsRoot);
  await enableDefaultSetup({ client, org, repo, sleep: dependencies.sleep });
  const codeql = await waitForFirstCodeqlRun({ client, org, repo, ...dependencies });
  if (codeql.conclusion !== 'success') {
    return { ok: false, summary: `first ${CODEQL_WORKFLOW_NAME} run ${codeql.runId} on main concluded ${codeql.conclusion}; fix it and re-run` };
  }
  const ruleset = await addCodeScanningRule({ client, org, repo, desired: main });
  const lines = [
    `### ${OP} ${org}/${repo}`,
    '',
    '- default setup: configured',
    `- ${CODEQL_WORKFLOW_NAME} run ${codeql.runId}: success`,
    `- ${CODE_SCANNING_RULE} rule: ${ruleset}`,
  ];
  if (ctx.config.deploy !== DEPLOY_NONE) {
    lines.push(`- ${await setDeployEnabled(client, { owner: org, repo })}`, '');
    lines.push(...deployChecklist({ org, repo, secrets: settings.environments?.production?.secrets ?? [] }));
  }
  return { ok: true, summary: lines.join('\n') };
}

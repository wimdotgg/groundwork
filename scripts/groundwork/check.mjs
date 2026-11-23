import { GitHubError } from '../lib/github.mjs';
import { sameLogin } from '../lib/trust.mjs';
import {
  appliesToKind, compareStates, loadDesiredState, readLiveState, readSignals, repoKind, resolvePlaceholders, SettingsError,
} from '../lib/settings.mjs';

/** @typedef {import('../lib/github.mjs').GitHubClient} GitHubClient */
/** @typedef {import('../lib/config.mjs').Config} Config */
/** @typedef {{ client: GitHubClient, token: string, org: string, repo: string|null, settingsRoot: string,
 *   config: Config, env: Record<string, string|undefined>, log: (line: string) => void }} OpContext */

export const OP = 'check';
export const TOKEN_SCOPE = 'target';
// GitHub returns ruleset bypass_actors and the merge-related repository fields only with write access.
export const PERMISSIONS = {
  administration: 'write',
  contents: 'read',
  environments: 'read',
  actions_variables: 'read',
  actions: 'read',
  issues: 'read',
  members: 'read',
};

const RESULT_ORDER = ['match', 'differ', 'missing', 'extra', 'unreadable', 'deferred'];
const VALUE_MAX_LENGTH = 120;
const TABLE_HEADER = '| Section | Key | Result | Desired | Live |';
const TABLE_DIVIDER = '|---|---|---|---|---|';

const CODEOWNERS_SECTION = 'codeowners';
const CODEOWNERS_PATH = '.github/CODEOWNERS';
const UNREADABLE_STATUS = 403;
const NOT_FOUND_STATUS = 404;

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const isPassing = (row) => row.result === 'match' || row.result === 'deferred';

/**
 * @param {any} args parsed JSON object from the dispatch
 * @returns {string[]} one line per invalid argument; empty when valid
 */
export function validateArgs(args) {
  if (args === null || args === undefined) return [];
  if (!isPlainObject(args)) return ['args must be a JSON object'];
  return Object.keys(args).map((key) => `unknown argument "${key}"`);
}

/** Environment names whose repos filter selects them for the repo kind; only those are read in full. */
function applicableEnvironmentNames(settings, kind) {
  return Object.entries(settings.environments ?? {})
    .filter(([, spec]) => appliesToKind(spec?.repos, kind))
    .map(([name]) => name);
}

/** Table cells hold untrusted text: strip backticks and line breaks so the code span and row cannot break, truncate. */
function renderCell(text) {
  const stripped = String(text).replaceAll('`', '').replace(/[\r\n]/g, '');
  const truncated = stripped.length > VALUE_MAX_LENGTH ? `${stripped.slice(0, VALUE_MAX_LENGTH)}...` : stripped;
  return `\`${truncated.replaceAll('|', '\\|')}\``;
}

const valueText = (value) => JSON.stringify(value) ?? 'null';

/**
 * @param {{ org: string, repo: string }} target
 * @param {import('../lib/settings.mjs').ComparisonRow[]} rows
 * @param {boolean} ok
 * @returns {string} Markdown job summary
 */
function renderSummary({ org, repo }, rows, ok) {
  const mismatches = rows.filter((row) => !isPassing(row));
  const failing = mismatches.length;
  const lines = [
    `## check ${org}/${repo}`,
    '',
    ok
      ? `Result: **pass** (${rows.length} rows, all match or deferred).`
      : `Result: **fail** (${failing} of ${rows.length} rows mismatch).`,
    '',
  ];
  if (mismatches.length > 0) {
    lines.push(TABLE_HEADER, TABLE_DIVIDER);
    for (const row of mismatches) {
      lines.push(`| ${renderCell(row.section)} | ${renderCell(row.key)} | ${row.result} | ${renderCell(valueText(row.desired))} | ${renderCell(valueText(row.live))} |`);
    }
    lines.push('');
  }
  const counts = Object.fromEntries(RESULT_ORDER.map((result) => [result, 0]));
  for (const row of rows) counts[row.result] += 1;
  lines.push('Counts:', '', ...RESULT_ORDER.map((result) => `- ${result}: ${counts[result]}`));
  return lines.join('\n');
}

/** @returns {string[]} the distinct owner tokens of every rule line, sorted */
function codeownersOwners(text) {
  const owners = new Set();
  for (const line of text.split('\n')) {
    const code = line.split('#')[0].trim();
    for (const token of code.split(/\s+/).slice(1)) owners.add(token);
  }
  return [...owners].sort();
}

/**
 * A CODEOWNERS owner that is not the configured one leaves protected paths without a valid reviewer, and `main`
 * needs no other approval, so the gate fails open (spec 9.4). Read from the default branch, like GitHub does.
 * @returns {Promise<import('../lib/settings.mjs').ComparisonRow>}
 */
async function compareCodeowners(client, { owner, repo }, accountOwner) {
  const desired = `@${accountOwner}`;
  const row = (live, result) => ({ section: CODEOWNERS_SECTION, key: CODEOWNERS_PATH, desired, live, result });
  let response;
  try {
    response = await client.request('GET', `/repos/${owner}/${repo}/contents/${CODEOWNERS_PATH}`, { okStatuses: [NOT_FOUND_STATUS] });
  } catch (error) {
    if (error instanceof GitHubError && error.status === UNREADABLE_STATUS) return row(null, 'unreadable');
    throw error;
  }
  if (response.status === NOT_FOUND_STATUS) return row(null, 'missing');
  const text = Buffer.from(String(response.data?.content ?? ''), 'base64').toString('utf8');
  const owners = codeownersOwners(text);
  const matches = owners.length > 0 && owners.every((token) => sameLogin(token, desired));
  return row(owners, matches ? 'match' : 'differ');
}

/**
 * Read-only comparison of the target repo against the desired state in settingsRoot.
 * Content mismatches come back as ok:false; API failures throw GitHubError from the client.
 * @param {OpContext} ctx
 * @returns {Promise<{ ok: boolean, rows: import('../lib/settings.mjs').ComparisonRow[] }>}
 */
export async function runCheck({ client, org, repo, settingsRoot, config }) {
  if (repo === null) throw new SettingsError('check: repo is required');
  const desired = await loadDesiredState({ root: settingsRoot });
  desired.rulesets = await Promise.all(
    desired.rulesets.map((ruleset) => resolvePlaceholders(ruleset, { client, config })),
  );
  const kind = repoKind(repo, config);
  const repoRef = { owner: org, repo };
  const live = await readLiveState(client, repoRef, { environmentNames: applicableEnvironmentNames(desired.settings, kind) });
  const signals = await readSignals(client, repoRef, { repoKind: kind });
  const rows = compareStates(desired, live, { repoKind: kind, config, signals });
  for (const [name, section] of Object.entries(live)) {
    if (section?.readable === true || rows.some((row) => row.section === name)) continue;
    rows.push({ section: name, key: '(section)', desired: null, live: null, result: 'unreadable' });
  }
  // The vacuity guard counts the settings rows only: the CODEOWNERS row always exists.
  const settingsRows = rows.length;
  rows.push(await compareCodeowners(client, repoRef, config.accounts.owner));
  return { ok: settingsRows > 0 && rows.every(isPassing), rows };
}

/**
 * @param {OpContext} ctx
 * @returns {Promise<{ ok: boolean, summary: string }>}
 */
export async function run(ctx) {
  const { ok, rows } = await runCheck(ctx);
  const failing = rows.filter((row) => !isPassing(row)).length;
  ctx.log(`check ${ctx.org}/${ctx.repo}: ${rows.length} rows, ${failing === 0 ? 'all match or deferred' : `${failing} mismatching`}`);
  return { ok, summary: renderSummary({ org: ctx.org, repo: ctx.repo }, rows, ok) };
}

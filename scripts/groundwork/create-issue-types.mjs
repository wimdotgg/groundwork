import { GitHubError, apiPath } from '../lib/github.mjs';
import { ISSUE_TYPES } from '../lib/issue-model.mjs';

/** @typedef {import('../lib/github.mjs').GitHubClient} GitHubClient */

// Org-level endpoints per the issue types REST API (docs.github.com/en/rest/orgs/issue-types):
// the update endpoint is PUT, not PATCH.
const ORG_TYPES_PATH = '/orgs/{org}/issue-types';
const TYPE_PATH = '/orgs/{org}/issue-types/{id}';

/** @type {Record<string, string>} one-line description per type, sent on create */
export const TYPE_DESCRIPTIONS = {
  Epic: 'Large body of work that breaks down into smaller tasks',
  Feature: 'New functionality or enhancement',
  Bug: 'An unexpected problem or behavior',
  Chore: 'Routine work, maintenance and tooling',
  Spike: 'Time-boxed research or investigation',
};

/** Op identity, read by admin-run (12.1). */
export const OP = 'create-issue-types';

/** Org scope: the minted installation token carries no repository restriction. */
export const TOKEN_SCOPE = 'org';

// The published OpenAPI app-permissions schema has not caught up with the "Issue types"
// organization permission, so this key follows the snake_case pattern of the other
// organization permission keys and is flagged as unverified in the PR notes.
/** @type {Record<string, string>} GitHub App permission key -> level */
export const PERMISSIONS = { issue_types: 'write' };

// GitHub pre-creates this default org type; only defaults may be deleted (12.1).
// Matching is case-insensitive because orgs carry variants like "task".
const DEFAULT_TYPES_TO_REMOVE = ['Task'];

const lower = (name) => String(name).toLowerCase();
const WANTED = new Set(ISSUE_TYPES.map(lower));

/**
 * @param {Array<{ name: string }>} types live list from the API
 * @param {string} name wanted name, matched case-insensitively
 */
const findByName = (types, name) => types.find((type) => lower(type.name) === lower(name));

const isDefault = (name) => DEFAULT_TYPES_TO_REMOVE.some((candidate) => lower(candidate) === lower(name));

/**
 * @param {object} args parsed JSON object from the dispatch input
 * @returns {string[]} one error per unknown key; empty when valid
 */
export function validateArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return ['args must be a JSON object'];
  }
  return Object.keys(args).map((key) => `unknown argument "${key}"`);
}

/**
 * @param {Array<{ id: number, name: string, is_enabled: boolean }>} types
 * @returns {{ missing: string[], extra: string[], exact: boolean }} wanted types absent,
 * disabled or misnamed; unwanted names; whether the count matches ISSUE_TYPES
 */
function diffTypes(types) {
  // Exact-name match: other tooling (pr-metadata) compares names case-sensitively,
  // so a case variant like "bug" must count as divergence, not as "Bug".
  const missing = ISSUE_TYPES.filter((name) => {
    const type = types.find((candidate) => candidate.name === name);
    return type === undefined || type.is_enabled !== true;
  });
  const extra = types.filter((type) => !WANTED.has(lower(type.name))).map((type) => type.name);
  return { missing, extra, exact: types.length === ISSUE_TYPES.length };
}

/**
 * Makes the org's issue types exactly ISSUE_TYPES, enabled: deletes GitHub's default
 * types, creates missing types, renames case variants and enables disabled wanted types.
 * Types outside the five that are not defaults are left alone and make the run report
 * ok:false so the owner can review them. A follow-up read verifies convergence;
 * API failures throw GitHubError.
 *
 * @param {{ client: GitHubClient, org: string, log(line: string): void }} deps
 * @returns {Promise<{ ok: boolean, summary: string }>}
 */
export async function syncIssueTypes({ client, org, log }) {
  const listPath = apiPath(ORG_TYPES_PATH, { org });
  const existing = await client.paginate(listPath);
  const foreign = existing.filter((type) => !WANTED.has(lower(type.name)) && !isDefault(type.name));
  const writes = [];

  // Delete before create: a default name collision would otherwise fail the POST.
  for (const type of existing) {
    if (WANTED.has(lower(type.name)) || !isDefault(type.name)) continue;
    await client.request('DELETE', apiPath(TYPE_PATH, { org, id: type.id }));
    writes.push(`deleted ${type.name}`);
    log(`deleted issue type ${type.name}`);
  }

  for (const name of ISSUE_TYPES) {
    const current = findByName(existing, name);
    if (current === undefined) {
      await client.request('POST', listPath, {
        body: { name, is_enabled: true, description: TYPE_DESCRIPTIONS[name] },
      });
      writes.push(`created ${name}`);
      log(`created issue type ${name}`);
      continue;
    }
    if (current.is_enabled === true && current.name === name) continue;
    const body = {
      name,
      is_enabled: true,
      description: current.description ?? TYPE_DESCRIPTIONS[name],
    };
    if (current.color != null) body.color = current.color;
    await client.request('PUT', apiPath(TYPE_PATH, { org, id: current.id }), { body });
    const verb = current.name === name ? 'enabled' : 'renamed';
    const label = current.name === name ? name : `${current.name} to ${name}`;
    writes.push(`${verb} ${label}`);
    log(`${verb} issue type ${label}`);
  }

  const final = await client.paginate(listPath);
  const { missing, extra, exact } = diffTypes(final);
  if (missing.length > 0 || extra.length > 0 || !exact) {
    const parts = [
      `missing or disabled ${missing.join(', ') || 'none'}`,
      `extra ${extra.join(', ') || 'none'}`,
    ];
    if (foreign.length > 0) parts.push(`left for the owner: ${foreign.map((type) => type.name).join(', ')}`);
    return { ok: false, summary: `issue types diverged after sync: ${parts.join('; ')}` };
  }
  const summary = writes.length === 0 ? 'issue types already in place' : `synced issue types: ${writes.join('; ')}`;
  return { ok: true, summary };
}

/**
 * Built-in admin op (12.1). Uses only client, org and log; the token is minted by
 * admin-run, and org-level types need no repo, settings files or config.
 *
 * @param {{ client: GitHubClient, token: string, org: string, repo: string|null,
 *   settingsRoot: string, config: object, env: Record<string, string|undefined>, log(line: string): void }} ctx
 * @returns {Promise<{ ok: boolean, summary: string }>}
 */
export async function run(ctx) {
  return syncIssueTypes({ client: ctx.client, org: ctx.org, log: ctx.log });
}

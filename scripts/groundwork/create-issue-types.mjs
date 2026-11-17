import { GitHubError, apiPath } from '../lib/github.mjs';
import { ISSUE_TYPES } from '../lib/issue-model.mjs';

/** @typedef {import('../lib/github.mjs').GitHubClient} GitHubClient */

// Org-level endpoints per the issue types REST API (docs.github.com/en/rest/orgs/issue-types):
// the update endpoint is PUT, not PATCH.
const ORG_TYPES_PATH = '/orgs/{org}/issue-types';
const TYPE_PATH = '/orgs/{org}/issue-types/{id}';

/** @type {Record<string, string>} one-line description per type, sent on create and enable */
export const TYPE_DESCRIPTIONS = {
  Epic: 'Large body of work that breaks down into smaller tasks',
  Feature: 'New functionality or enhancement',
  Bug: 'An unexpected problem or behavior',
  Chore: 'Routine work, maintenance and tooling',
  Spike: 'Time-boxed research or investigation',
};

/** Op identity, read by admin-run (12.1). */
export const OP = 'create-issue-types';

/** Token restricted to no repositories: this op writes org-level types, not repo state. */
export const TOKEN_SCOPE = 'org';

// The published OpenAPI app-permissions schema has not caught up with the "Issue types"
// organization permission, so this key follows the snake_case pattern of the other
// organization permission keys and is flagged as unverified in the PR notes.
/** @type {Record<string, string>} GitHub App permission key -> level */
export const PERMISSIONS = { issue_types: 'write' };

const lower = (name) => String(name).toLowerCase();
const WANTED = new Set(ISSUE_TYPES.map(lower));

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
 * @returns {{ missing: string[], extra: string[] }} wanted types absent or disabled, and unwanted names
 */
function diffTypes(types) {
  const byName = new Map(types.map((type) => [lower(type.name), type]));
  const missing = ISSUE_TYPES.filter((name) => byName.get(lower(name))?.is_enabled !== true);
  const extra = types.filter((type) => !WANTED.has(lower(type.name))).map((type) => type.name);
  return { missing, extra };
}

/**
 * Makes the org's issue types exactly ISSUE_TYPES, enabled: creates missing types,
 * enables disabled wanted types, deletes everything else (GitHub's default Task).
 * A follow-up read verifies convergence; API failures throw GitHubError.
 *
 * @param {{ client: GitHubClient, org: string, log(line: string): void }} deps
 * @returns {Promise<{ ok: boolean, summary: string }>}
 */
export async function syncIssueTypes({ client, org, log }) {
  if (typeof org !== 'string' || org === '') throw new GitHubError('org is required');
  const listPath = apiPath(ORG_TYPES_PATH, { org });
  const existing = await client.paginate(listPath);
  const byName = new Map(existing.map((type) => [lower(type.name), type]));
  const writes = [];

  for (const name of ISSUE_TYPES) {
    const current = byName.get(lower(name));
    if (current === undefined) {
      await client.request('POST', listPath, {
        body: { name, is_enabled: true, description: TYPE_DESCRIPTIONS[name] },
      });
      writes.push(`created ${name}`);
      log(`created issue type ${name}`);
      continue;
    }
    if (current.is_enabled !== true) {
      await client.request('PUT', apiPath(TYPE_PATH, { org, id: current.id }), {
        body: { name, is_enabled: true, description: TYPE_DESCRIPTIONS[name] },
      });
      writes.push(`enabled ${name}`);
      log(`enabled issue type ${name}`);
    }
  }
  for (const [key, type] of byName) {
    if (WANTED.has(key)) continue;
    await client.request('DELETE', apiPath(TYPE_PATH, { org, id: type.id }));
    writes.push(`deleted ${type.name}`);
    log(`deleted issue type ${type.name}`);
  }

  const final = await client.paginate(listPath);
  const { missing, extra } = diffTypes(final);
  if (missing.length > 0 || extra.length > 0) {
    return {
      ok: false,
      summary: `issue types diverged after sync: missing or disabled ${missing.join(', ') || 'none'}; extra ${extra.join(', ') || 'none'}`,
    };
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

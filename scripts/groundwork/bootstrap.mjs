/** Op identity, read by admin-run (12.1). */
export const OP = 'bootstrap';

/** The repository does not exist when the run starts, so the op mints through `ctx.withToken` (12.1). */
export const TOKEN_SCOPE = 'deferred';

/** Token for everything after the repository exists; shown in `plan`. Keys are the snake_case names of 12.1. */
export const PERMISSIONS = {
  administration: 'write',
  contents: 'write',
  workflows: 'write',
  environments: 'write',
  actions_variables: 'write',
  issues: 'write',
  members: 'read',
  actions: 'read',
};

/** Token for the `POST /orgs/{org}/repos` call alone (2.4). */
export const CREATE_PERMISSIONS = { administration: 'write' };

export const DESCRIPTION_MAX_LENGTH = 350;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const ALLOWED_KEYS = new Set(['description']);

/**
 * @param {object} args parsed JSON object from the dispatch input
 * @returns {string[]} one error per problem; empty when valid
 */
export function validateArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return ['args must be a JSON object'];
  const unknown = Object.keys(args).filter((key) => !ALLOWED_KEYS.has(key)).map((key) => `unknown argument "${key}"`);
  const { description } = args;
  if (typeof description !== 'string' || description === '') return [...unknown, 'description is required: a non-empty string'];
  if (description.length > DESCRIPTION_MAX_LENGTH) return [...unknown, `description must be at most ${DESCRIPTION_MAX_LENGTH} characters`];
  if (!PRINTABLE_ASCII.test(description)) return [...unknown, 'description must be printable ASCII'];
  return unknown;
}

/** Skeleton: the pass 1 behaviour arrives with the lane tasks (#140). */
export async function run() {
  return { ok: false, summary: 'not implemented' };
}

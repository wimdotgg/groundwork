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

/**
 * @param {object} args parsed JSON object from the dispatch input
 * @returns {string[]} one error per key; empty when valid
 */
export function validateArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return ['args must be a JSON object'];
  return Object.keys(args).map((key) => `unknown argument "${key}"`);
}

/** Skeleton: the pass 2 behaviour arrives with the lane tasks (#140). */
export async function run() {
  return { ok: false, summary: 'not implemented' };
}

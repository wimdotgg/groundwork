import { GitHubError } from '../lib/github.mjs';

/** Op identity, read by admin-run (12.1). */
export const OP = 'script';

/** No token up front: the grants are the control-repository read and the target with the script's own `permissions` (12.1). */
export const TOKEN_SCOPE = 'deferred';

/** Empty: the target grant is the exact `permissions` export of the reviewed script, not a fixed set. */
export const PERMISSIONS = {};

export const CONTROL_READ_PERMISSIONS = { contents: 'read' };

const NOT_IMPLEMENTED = 'not implemented';

/** @returns {string[]} problems with the `args` object the script receives */
export function validateArgs() {
  return [NOT_IMPLEMENTED];
}

/**
 * @param {string} source text of `admin-ops/<name>.mjs`
 * @returns {{ permissions?: Record<string, 'read'|'write'>, problem?: string }}
 */
export function parsePermissions() {
  throw new GitHubError(NOT_IMPLEMENTED);
}

/** @returns {Promise<{ ok: boolean, summary: string }>} */
export async function run() {
  throw new GitHubError(NOT_IMPLEMENTED);
}

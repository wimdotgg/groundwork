import { GitHubError } from '../lib/github.mjs';
import * as bootstrap from './bootstrap.mjs';

/** Op identity, read by admin-run (12.1). */
export const OP = 'selftest';

/** The throwaway repository does not exist at dispatch, so the op mints through `ctx.withToken` like `bootstrap`. */
export const TOKEN_SCOPE = 'deferred';

/** The op names its own repository; `target_repo` must be empty. */
export const TAKES_TARGET_REPO = false;

export const SELFTEST_REPO_PREFIX = 'selftest-';

/** The three grants are `bootstrap`'s (12.1). */
export const PERMISSIONS = bootstrap.PERMISSIONS;
export const CREATE_PERMISSIONS = bootstrap.CREATE_PERMISSIONS;
export const CONTROL_READ_PERMISSIONS = bootstrap.CONTROL_READ_PERMISSIONS;

const NOT_IMPLEMENTED = 'not implemented';
const RUN_ID_PATTERN = /^[0-9]+$/;

/**
 * @param {Record<string, string|undefined>} env
 * @returns {string} `selftest-<GITHUB_RUN_ID>`
 */
export function targetRepo(env) {
  const runId = env.GITHUB_RUN_ID ?? '';
  if (!RUN_ID_PATTERN.test(runId)) throw new GitHubError('GITHUB_RUN_ID must be digits');
  return `${SELFTEST_REPO_PREFIX}${runId}`;
}

/** Empty until the lane lands, so nothing can mint (12.1 grant shape). */
export function grants() {
  return [];
}

/** @returns {string[]} problems; the real op accepts only `{}` */
export function validateArgs() {
  return [NOT_IMPLEMENTED];
}

/** @returns {Promise<{ ok: boolean, summary: string }>} */
export async function run() {
  throw new GitHubError(NOT_IMPLEMENTED);
}

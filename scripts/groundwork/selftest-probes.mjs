import { GitHubError } from '../lib/github.mjs';

/** @typedef {{ id: string, name: string, ok: boolean, detail: string }} ProbeRow */

/** Probe ids in run order (12.1): V3, V11, V16 and the section 13 push probe. */
export const PROBE_IDS = ['V3', 'V11', 'V16', 'push-main'];

/**
 * One row per `PROBE_IDS` entry, in that order; a probe that throws becomes a failed row, so one failing probe never throws.
 * @param {{ client: import('../lib/github.mjs').GitHubClient, org: string, repo: string, log: (line: string) => void }} options
 * @returns {Promise<ProbeRow[]>}
 */
export async function runProbes() {
  throw new GitHubError('not implemented');
}

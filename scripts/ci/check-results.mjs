import { pathToFileURL } from 'node:url';
import { runValidator } from '../lib/ci.mjs';

/** @typedef {import('../lib/ci.mjs').ValidatorContext} ValidatorContext */
/** @typedef {import('../lib/ci.mjs').ValidatorResult} ValidatorResult */
/** @typedef {{ eventName: string, needs: Record<string, { result: string }>|null }} CheckResultsFacts   null when NEEDS_JSON is absent or invalid */

export const name = 'check-results';
export const needsClient = false;

const SUCCESS = 'success';

function parseNeeds(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {ValidatorContext} ctx
 * @returns {Promise<CheckResultsFacts>}
 */
export async function collect(ctx) {
  return { eventName: ctx.eventName, needs: parseNeeds(ctx.env.NEEDS_JSON) };
}

function fail(errors) {
  return { conclusion: 'fail', errors, warnings: [], details: '', actions: [] };
}

/**
 * @param {CheckResultsFacts} facts
 * @returns {ValidatorResult}
 */
export function evaluate(facts) {
  if (facts.needs === null) return fail(['NEEDS_JSON is missing or not a JSON object']);
  const jobs = Object.entries(facts.needs);
  if (jobs.length === 0) return fail(['no needed jobs reported']);
  const errors = jobs
    .filter(([, job]) => job?.result !== SUCCESS)
    .map(([jobName, job]) => `job ${jobName} result: ${job?.result ?? 'missing'}`);
  if (errors.length > 0) return fail(errors);
  return { conclusion: 'pass', errors: [], warnings: [], details: `${jobs.length} needed jobs succeeded.`, actions: [] };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runValidator({ name, needsClient, collect, evaluate }, { argv: process.argv, env: process.env, scriptUrl: import.meta.url });
}

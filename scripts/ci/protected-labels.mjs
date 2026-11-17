import { pathToFileURL } from 'node:url';
import { runValidator } from '../lib/ci.mjs';
import { requiredLabelActor, sameLogin } from '../lib/trust.mjs';

/** @typedef {import('../lib/ci.mjs').ValidatorContext} ValidatorContext */
/** @typedef {import('../lib/ci.mjs').ValidatorResult} ValidatorResult */
/** @typedef {{ eventName: string, number: number|null, label: string|null, sender: string|null }} ProtectedLabelsFacts   number, label and sender are null for skipped events */

export const name = 'protected-labels';

const LABELED_ACTION = 'labeled';
const SUBJECT_KEY_BY_EVENT = { issues: 'issue', pull_request_target: 'pull_request' };

/**
 * @param {ValidatorContext} ctx
 * @returns {Promise<ProtectedLabelsFacts>}
 */
export async function collect(ctx) {
  const skipped = { eventName: ctx.eventName, number: null, label: null, sender: null };
  const subjectKey = SUBJECT_KEY_BY_EVENT[ctx.eventName];
  if (subjectKey === undefined || ctx.payload?.action !== LABELED_ACTION) return skipped;
  const number = ctx.payload[subjectKey]?.number ?? null;
  const label = ctx.payload.label?.name ?? null;
  const sender = ctx.payload.sender?.login ?? null;
  if (number === null || label === null || sender === null) return skipped;
  return { eventName: ctx.eventName, number, label, sender };
}

function result(conclusion, details, actions = []) {
  return { conclusion, errors: [], warnings: [], details, actions };
}

/**
 * @param {ProtectedLabelsFacts} facts
 * @param {import('../lib/config.mjs').Config} config
 * @returns {ValidatorResult}
 */
export function evaluate(facts, config) {
  if (facts.number === null || facts.label === null || facts.sender === null) {
    return result('skip', `Nothing to check for ${facts.eventName}.`);
  }
  const requiredActor = requiredLabelActor(facts.label, config);
  if (requiredActor === null) return result('pass', `Label ${facts.label} is not protected.`);
  if (sameLogin(facts.sender, requiredActor)) return result('pass', `Label ${facts.label} applied by its required actor.`);
  const body = `Label \`${facts.label}\` was removed: only ${requiredActor} may apply it.`;
  return result('pass', `Removed ${facts.label} applied by ${facts.sender}; required actor is ${requiredActor}.`, [
    { kind: 'remove-label', number: facts.number, label: facts.label },
    { kind: 'comment', number: facts.number, body },
  ]);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runValidator({ name, collect, evaluate }, { argv: process.argv, env: process.env, scriptUrl: import.meta.url });
}

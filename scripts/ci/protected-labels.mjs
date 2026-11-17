import { pathToFileURL } from 'node:url';
import { runValidator } from '../lib/ci.mjs';
import { normalizeLabel, requiredLabelActor, sameLogin } from '../lib/trust.mjs';

/** @typedef {import('../lib/ci.mjs').ValidatorContext} ValidatorContext */
/** @typedef {import('../lib/ci.mjs').ValidatorResult} ValidatorResult */
/** @typedef {{ eventName: string, action: string|null, number: number|null, label: string|null, sender: string|null, labels: string[] }} ProtectedLabelsFacts
 *   action is the payload action for handled events, else null; label and sender are null for skipped, synchronize and reopened events;
 *   labels: names on the pull request, read only for synchronize and reopened */

export const name = 'protected-labels';

const LABELED_ACTION = 'labeled';
const SYNCHRONIZE_ACTION = 'synchronize';
const REOPENED_ACTION = 'reopened';
const NO_ISSUE_VOIDING_ACTIONS = new Set([SYNCHRONIZE_ACTION, REOPENED_ACTION]);
const PULL_REQUEST_TARGET_EVENT = 'pull_request_target';
const NO_ISSUE_LABEL = 'no-issue';
const NO_ISSUE_RESET_COMMENT = '`no-issue` was removed because new commits arrived or the PR was reopened; the owner re-applies it after reviewing.';
const SUBJECT_KEY_BY_EVENT = { issues: 'issue', pull_request_target: 'pull_request' };

/**
 * @param {ValidatorContext} ctx
 * @returns {Promise<ProtectedLabelsFacts>}
 */
export async function collect(ctx) {
  const skipped = { eventName: ctx.eventName, action: null, number: null, label: null, sender: null, labels: [] };
  if (ctx.eventName === PULL_REQUEST_TARGET_EVENT && NO_ISSUE_VOIDING_ACTIONS.has(ctx.payload?.action)) return collectVoiding(ctx);
  const subjectKey = SUBJECT_KEY_BY_EVENT[ctx.eventName];
  if (subjectKey === undefined || ctx.payload?.action !== LABELED_ACTION) return skipped;
  const number = ctx.payload[subjectKey]?.number;
  const label = ctx.payload.label?.name;
  const sender = ctx.payload.sender?.login;
  if (!Number.isInteger(number)) throw new Error(`${ctx.eventName} labeled payload has no ${subjectKey}.number`);
  if (typeof label !== 'string' || label === '') throw new Error(`${ctx.eventName} labeled payload has no label.name`);
  if (typeof sender !== 'string' || sender === '') throw new Error(`${ctx.eventName} labeled payload has no sender.login`);
  return { eventName: ctx.eventName, action: LABELED_ACTION, number, label, sender, labels: [] };
}

function collectVoiding(ctx) {
  const { action, pull_request: pull } = ctx.payload;
  if (!Number.isInteger(pull?.number)) throw new Error(`pull_request_target ${action} payload has no pull_request.number`);
  const labels = (pull.labels ?? []).map((label) => label?.name).filter((name) => typeof name === 'string');
  return { eventName: ctx.eventName, action, number: pull.number, label: null, sender: null, labels };
}

function result(conclusion, details, actions = []) {
  return { conclusion, errors: [], warnings: [], details, actions };
}

// New commits or a reopen void an earlier review, so the owner has to label again. Hygiene only: pr-metadata's
// freshness rule is the gate.
function evaluateVoiding(facts) {
  if (!facts.labels.some((label) => normalizeLabel(label) === NO_ISSUE_LABEL)) return result('pass', 'New commits or reopen and no no-issue label to reset.');
  return result('pass', `${facts.action}; removing no-issue.`, [
    { kind: 'remove-label', number: facts.number, label: NO_ISSUE_LABEL },
    { kind: 'comment', number: facts.number, body: NO_ISSUE_RESET_COMMENT },
  ]);
}

/**
 * @param {ProtectedLabelsFacts} facts
 * @param {import('../lib/config.mjs').Config} config
 * @returns {ValidatorResult}
 */
export function evaluate(facts, config) {
  if (NO_ISSUE_VOIDING_ACTIONS.has(facts.action)) return evaluateVoiding(facts);
  if (facts.label === null) {
    return result('skip', `Nothing to check for ${facts.eventName}.`);
  }
  const requiredActor = requiredLabelActor(facts.label, config);
  if (requiredActor === null) return result('pass', `Label ${facts.label} is not protected.`);
  if (sameLogin(facts.sender, requiredActor)) return result('pass', `Label ${facts.label} applied by its required actor.`);
  const body = `Label \`${facts.label.replaceAll('`', '')}\` was removed: only ${requiredActor} may apply it.`;
  return result('pass', `Label ${facts.label} applied by ${facts.sender}; required actor is ${requiredActor}; removing.`, [
    { kind: 'remove-label', number: facts.number, label: facts.label },
    { kind: 'comment', number: facts.number, body },
  ]);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runValidator({ name, collect, evaluate }, { argv: process.argv, env: process.env, scriptUrl: import.meta.url });
}

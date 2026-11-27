import { pathToFileURL } from 'node:url';
import { runValidator } from '../lib/ci.mjs';
import { apiPath } from '../lib/github.mjs';
import { addMarker, hasMarker } from '../lib/markdown.mjs';
import { sameLogin } from '../lib/trust.mjs';

/** @typedef {import('../lib/ci.mjs').ValidatorContext} ValidatorContext */
/** @typedef {import('../lib/ci.mjs').ValidatorResult} ValidatorResult */
/** @typedef {{ eventName: string, workflowPath: string, workflowName: string, conclusion: string, runUrl: string,
 *   runEvent: string|null, openAlert: { number: number }|null }} FailureAlertFacts
 *   the run fields are empty strings only for skipped events; runEvent: workflow_run.event, null when the payload lacks it */

export const name = 'failure-alert';

const WORKFLOW_RUN_EVENT = 'workflow_run';
const COMPLETED_ACTION = 'completed';
const BOT_LOGIN = 'github-actions[bot]';
const ISSUES_PATH = '/repos/{owner}/{repo}/issues';
const FAILING_CONCLUSIONS = ['failure', 'timed_out', 'startup_failure'];
const SUCCESS_CONCLUSION = 'success';
const REQUIRED_RUN_FIELDS = ['path', 'name', 'conclusion', 'html_url'];
const RELEASE_WORKFLOW_PATH = '.github/workflows/release-please.yml';
const NOTIFIER_RUN_EVENT = 'pull_request';

function markerName(workflowPath) {
  return `alert:${workflowPath}`;
}

function requireRunField(run, field) {
  if (typeof run?.[field] !== 'string' || run[field] === '') throw new Error(`workflow_run payload has no workflow_run.${field}`);
  return run[field];
}

async function findOpenAlert(ctx, workflowPath) {
  const issues = await ctx.client.paginate(apiPath(ISSUES_PATH, ctx.repo), { query: { state: 'open', creator: BOT_LOGIN } });
  // The creator query filter is not trusted alone: the author is checked again, so a lookalike marker from anyone else is ignored.
  const alerts = issues.filter((issue) => issue.pull_request === undefined
    && sameLogin(issue.user?.login, BOT_LOGIN)
    && hasMarker(issue.body ?? '', markerName(workflowPath)));
  if (alerts.length === 0) return null;
  return { number: Math.min(...alerts.map((issue) => issue.number)) };
}

function skipFacts(eventName) {
  return { eventName, workflowPath: '', workflowName: '', conclusion: '', runUrl: '', runEvent: null, openAlert: null };
}

/**
 * @param {ValidatorContext} ctx
 * @returns {Promise<FailureAlertFacts>}
 */
export async function collect(ctx) {
  if (ctx.eventName !== WORKFLOW_RUN_EVENT) {
    return skipFacts(ctx.eventName);
  }
  if (ctx.payload?.action !== COMPLETED_ACTION) return skipFacts(`${ctx.eventName} (${ctx.payload?.action})`);
  const run = ctx.payload?.workflow_run;
  for (const field of REQUIRED_RUN_FIELDS) requireRunField(run, field);
  const facts = { eventName: ctx.eventName, workflowPath: run.path, workflowName: run.name, conclusion: run.conclusion, runUrl: run.html_url,
    runEvent: typeof run.event === 'string' ? run.event : null, openAlert: null };
  facts.openAlert = await findOpenAlert(ctx, run.path);
  return facts;
}

function result(conclusion, details, actions = []) {
  return { conclusion, errors: [], warnings: [], details, actions };
}

// Workflow names are author-controlled text, so they go in a code span: mentions and links stay inert.
function plainName(facts) {
  const cleaned = facts.workflowName.replaceAll('`', '').replace(/\s+/g, ' ').trim();
  return cleaned === '' ? facts.workflowPath : cleaned;
}

function codeSpan(facts) {
  return `\`${plainName(facts)}\``;
}

function createAlert(facts) {
  const body = addMarker(`Workflow ${codeSpan(facts)} ended with \`${facts.conclusion}\`: ${facts.runUrl}`, markerName(facts.workflowPath));
  const title = `Workflow failure: ${plainName(facts)}`;
  return result('pass', `Workflow ${facts.workflowPath} failed; opening an alert.`, [{ kind: 'create-issue', title, body }]);
}

function repeatAlert(facts) {
  const body = `Workflow ${codeSpan(facts)} ended with \`${facts.conclusion}\` again: ${facts.runUrl}`;
  return result('pass', `Workflow ${facts.workflowPath} failed again; commenting on alert ${facts.openAlert.number}.`, [
    { kind: 'comment', number: facts.openAlert.number, body },
  ]);
}

// The closed pull_request run holds only the notifier job dispatch-on-main, so its success says nothing about the release job.
function isNotifierRun(facts) {
  return facts.workflowPath === RELEASE_WORKFLOW_PATH && facts.runEvent === NOTIFIER_RUN_EVENT;
}

function keepAlert(facts) {
  return result('pass', `Workflow ${facts.workflowPath} notifier run succeeded; alert ${facts.openAlert.number} stays open.`);
}

function closeAlert(facts) {
  const comment = `Workflow ${codeSpan(facts)} succeeded: ${facts.runUrl}. Closing.`;
  return result('pass', `Workflow ${facts.workflowPath} succeeded; closing alert ${facts.openAlert.number}.`, [
    { kind: 'close-issue', number: facts.openAlert.number, comment },
  ]);
}

/**
 * @param {FailureAlertFacts} facts
 * @returns {ValidatorResult}
 */
export function evaluate(facts) {
  if (facts.eventName !== WORKFLOW_RUN_EVENT) return result('skip', `Nothing to check for ${facts.eventName}.`);
  if (FAILING_CONCLUSIONS.includes(facts.conclusion)) return facts.openAlert === null ? createAlert(facts) : repeatAlert(facts);
  if (facts.conclusion === SUCCESS_CONCLUSION && facts.openAlert !== null) return isNotifierRun(facts) ? keepAlert(facts) : closeAlert(facts);
  return result('pass', `Workflow ${facts.workflowPath} ended with ${facts.conclusion}; no alert change.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runValidator({ name, collect, evaluate }, { argv: process.argv, env: process.env, scriptUrl: import.meta.url });
}

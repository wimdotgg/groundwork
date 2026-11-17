import { pathToFileURL } from 'node:url';
import { runValidator } from '../lib/ci.mjs';
import { apiPath } from '../lib/github.mjs';
import { addMarker, hasMarker } from '../lib/markdown.mjs';

/** @typedef {import('../lib/ci.mjs').ValidatorContext} ValidatorContext */
/** @typedef {import('../lib/ci.mjs').ValidatorResult} ValidatorResult */
/** @typedef {{ eventName: string, workflowPath: string, workflowName: string, conclusion: string, runUrl: string,
 *   openAlert: { number: number }|null }} FailureAlertFacts   the run fields are empty strings only for skipped events */

export const name = 'failure-alert';

const WORKFLOW_RUN_EVENT = 'workflow_run';
const BOT_LOGIN = 'github-actions[bot]';
const ISSUES_PATH = '/repos/{owner}/{repo}/issues';
const FAILING_CONCLUSIONS = ['failure', 'timed_out', 'startup_failure'];
const SUCCESS_CONCLUSION = 'success';
const REQUIRED_RUN_FIELDS = ['path', 'name', 'conclusion', 'html_url'];

function markerName(workflowPath) {
  return `alert:${workflowPath}`;
}

function requireRunField(run, field) {
  if (typeof run?.[field] !== 'string' || run[field] === '') throw new Error(`workflow_run payload has no workflow_run.${field}`);
  return run[field];
}

async function findOpenAlert(ctx, workflowPath) {
  const issues = await ctx.client.paginate(apiPath(ISSUES_PATH, ctx.repo), { query: { state: 'open', creator: BOT_LOGIN } });
  const alert = issues.find((issue) => issue.pull_request === undefined && hasMarker(issue.body ?? '', markerName(workflowPath)));
  return alert === undefined ? null : { number: alert.number };
}

/**
 * @param {ValidatorContext} ctx
 * @returns {Promise<FailureAlertFacts>}
 */
export async function collect(ctx) {
  if (ctx.eventName !== WORKFLOW_RUN_EVENT) {
    return { eventName: ctx.eventName, workflowPath: '', workflowName: '', conclusion: '', runUrl: '', openAlert: null };
  }
  const run = ctx.payload?.workflow_run;
  for (const field of REQUIRED_RUN_FIELDS) requireRunField(run, field);
  const facts = { eventName: ctx.eventName, workflowPath: run.path, workflowName: run.name, conclusion: run.conclusion, runUrl: run.html_url, openAlert: null };
  facts.openAlert = await findOpenAlert(ctx, run.path);
  return facts;
}

function result(conclusion, details, actions = []) {
  return { conclusion, errors: [], warnings: [], details, actions };
}

// Workflow names are author-controlled text, so they go in a code span: mentions and links stay inert.
function codeSpan(text) {
  return `\`${text.replaceAll('`', '').replace(/\s+/g, ' ')}\``;
}

function createAlert(facts) {
  const label = codeSpan(facts.workflowName);
  const body = addMarker(`Workflow ${label} ended with \`${facts.conclusion}\`: ${facts.runUrl}`, markerName(facts.workflowPath));
  const title = `Workflow failure: ${facts.workflowName.replaceAll('`', '').replace(/\s+/g, ' ')}`;
  return result('pass', `Workflow ${facts.workflowPath} failed; opening an alert.`, [{ kind: 'create-issue', title, body }]);
}

function repeatAlert(facts) {
  const body = `Workflow ${codeSpan(facts.workflowName)} ended with \`${facts.conclusion}\` again: ${facts.runUrl}`;
  return result('pass', `Workflow ${facts.workflowPath} failed again; commenting on alert ${facts.openAlert.number}.`, [
    { kind: 'comment', number: facts.openAlert.number, body },
  ]);
}

function closeAlert(facts) {
  const comment = `Workflow ${codeSpan(facts.workflowName)} succeeded: ${facts.runUrl}. Closing.`;
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
  if (facts.conclusion === SUCCESS_CONCLUSION && facts.openAlert !== null) return closeAlert(facts);
  return result('pass', `Workflow ${facts.workflowPath} ended with ${facts.conclusion}; no alert change.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runValidator({ name, collect, evaluate }, { argv: process.argv, env: process.env, scriptUrl: import.meta.url });
}

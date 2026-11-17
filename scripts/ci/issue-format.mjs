import { pathToFileURL } from 'node:url';
import { runValidator } from '../lib/ci.mjs';
import { apiPath } from '../lib/github.mjs';
import { validateIssueBody } from '../lib/issue-model.mjs';
import { hasMarker } from '../lib/markdown.mjs';
import { sameLogin } from '../lib/trust.mjs';

/** @typedef {import('../lib/ci.mjs').ValidatorContext} ValidatorContext */
/** @typedef {import('../lib/ci.mjs').ValidatorResult} ValidatorResult */
/** @typedef {{ eventName: string, action: string, issue: { number: number|null, author: string, type: string|null, body: string, labels: string[] },
 *   markerCommentExists: boolean }} IssueFormatFacts   markerCommentExists is false without a read for skipped events */

export const name = 'issue-format';

const ISSUES_EVENT = 'issues';
const HANDLED_ACTIONS = ['opened', 'edited', 'reopened', 'typed', 'untyped'];
const BOT_LOGIN = 'github-actions[bot]';
const MARKER = 'issue-format';
const NEEDS_FORMAT_LABEL = 'needs-format';
const COMMENTS_PATH = '/repos/{owner}/{repo}/issues/{number}/comments';
const NO_ERRORS_BODY = 'No format errors.';
const MAX_RENDERED_ERRORS = 20;
const MAX_ERROR_LENGTH = 200;

function isSkipped(eventName, action, author) {
  return eventName !== ISSUES_EVENT || !HANDLED_ACTIONS.includes(action) || sameLogin(author, BOT_LOGIN);
}

/**
 * @param {ValidatorContext} ctx
 * @returns {Promise<IssueFormatFacts>}
 */
export async function collect(ctx) {
  const action = ctx.payload?.action ?? '';
  const raw = ctx.payload?.issue ?? {};
  const issue = {
    number: raw.number ?? null,
    author: raw.user?.login ?? '',
    type: raw.type?.name ?? null,
    body: raw.body ?? '',
    labels: (raw.labels ?? []).map((label) => label.name),
  };
  const facts = { eventName: ctx.eventName, action, issue, markerCommentExists: false };
  if (isSkipped(ctx.eventName, action, issue.author)) return facts;
  if (!Number.isInteger(issue.number)) throw new Error('issues payload has no issue.number');
  const comments = await ctx.client.paginate(apiPath(COMMENTS_PATH, { ...ctx.repo, number: issue.number }));
  facts.markerCommentExists = comments.some((comment) => sameLogin(comment.user?.login, BOT_LOGIN) && hasMarker(comment.body ?? '', MARKER));
  return facts;
}

function result(conclusion, details, actions = []) {
  return { conclusion, errors: [], warnings: [], details, actions };
}

// Errors quote issue text, so each goes in a code span: mentions, links, HTML and cross-references stay inert.
function renderError(error) {
  const flat = error.replace(/\s+/g, ' ').replaceAll('`', "'");
  const capped = flat.length > MAX_ERROR_LENGTH ? `${flat.slice(0, MAX_ERROR_LENGTH)}...` : flat;
  return `- \`${capped}\``;
}

function renderErrors(errors) {
  const lines = errors.slice(0, MAX_RENDERED_ERRORS).map(renderError);
  if (errors.length > MAX_RENDERED_ERRORS) lines.push(`... and ${errors.length - MAX_RENDERED_ERRORS} more`);
  return lines.join('\n');
}

function invalidResult(number, errors) {
  const body = `Issue format errors:\n\n${renderErrors(errors)}`;
  return result('pass', `Issue ${number} has ${errors.length} format error(s); marking ${NEEDS_FORMAT_LABEL}.`, [
    { kind: 'add-label', number, label: NEEDS_FORMAT_LABEL },
    { kind: 'upsert-comment', number, marker: MARKER, body },
  ]);
}

/**
 * @param {IssueFormatFacts} facts
 * @returns {ValidatorResult}
 */
export function evaluate(facts) {
  const { issue } = facts;
  if (isSkipped(facts.eventName, facts.action, issue.author)) {
    return result('skip', `Nothing to check for ${facts.eventName} ${facts.action}.`);
  }
  const validation = validateIssueBody({ type: issue.type, body: issue.body });
  if (!validation.ok) return invalidResult(issue.number, validation.errors);
  // Always clear: the payload labels can be stale, and applyActions tolerates a missing label (404).
  const actions = [{ kind: 'remove-label', number: issue.number, label: NEEDS_FORMAT_LABEL }];
  if (facts.markerCommentExists) actions.push({ kind: 'upsert-comment', number: issue.number, marker: MARKER, body: NO_ERRORS_BODY });
  return result('pass', `Issue ${issue.number} format is valid.`, actions);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runValidator({ name, collect, evaluate }, { argv: process.argv, env: process.env, scriptUrl: import.meta.url });
}

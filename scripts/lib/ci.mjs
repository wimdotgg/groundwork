import { appendFile as appendFileDefault, readFile as readFileDefault } from 'node:fs/promises';
import { loadConfig, repoRoot } from './config.mjs';
import { apiPath, createClient as createClientDefault, repoFromEnv } from './github.mjs';
import { addMarker, hasMarker } from './markdown.mjs';
import { sameLogin } from './trust.mjs';

/** @typedef {import('./github.mjs').GitHubClient} GitHubClient */
/** @typedef {import('./github.mjs').RepoRef} RepoRef */
/** @typedef {import('./config.mjs').Config} Config */
/** @typedef {{ eventName: string, payload: object, env: Record<string, string|undefined>, repo: RepoRef,
 *   client: GitHubClient|undefined, config: Config, root: string }} ValidatorContext   client undefined when the validator exports needsClient = false */
/** @typedef {{ kind: 'add-label'|'remove-label', number: number, label: string }
 *   | { kind: 'comment', number: number, body: string }
 *   | { kind: 'upsert-comment', number: number, marker: string, body: string }
 *   | { kind: 'create-issue', title: string, body: string }
 *   | { kind: 'close-issue', number: number, comment: string }} Action */
/** @typedef {{ conclusion: 'pass'|'fail'|'skip', errors: string[], warnings: string[], details: string, actions: Action[] }} ValidatorResult */

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_ERROR = 2;
const BOT_LOGIN = 'github-actions[bot]';
const NOT_FOUND = 404;
const ISSUES_PATH = '/repos/{owner}/{repo}/issues';

function issuePath(repo, number, suffix = '') {
  return apiPath(`${ISSUES_PATH}/{number}${suffix}`, { ...repo, number });
}

async function postComment(client, repo, number, body) {
  await client.request('POST', issuePath(repo, number, '/comments'), { body: { body } });
}

async function upsertComment(client, repo, { number, marker, body }) {
  const comments = await client.paginate(issuePath(repo, number, '/comments'));
  const existing = comments.findLast((comment) => sameLogin(comment.user?.login, BOT_LOGIN) && hasMarker(comment.body ?? '', marker));
  const markedBody = addMarker(body, marker);
  if (!existing) return postComment(client, repo, number, markedBody);
  const path = apiPath('/repos/{owner}/{repo}/issues/comments/{id}', { ...repo, id: existing.id });
  await client.request('PATCH', path, { body: { body: markedBody } });
}

async function applyAction(action, { client, repo }) {
  switch (action.kind) {
    case 'add-label':
      await client.request('POST', issuePath(repo, action.number, '/labels'), { body: { labels: [action.label] } });
      return;
    case 'remove-label':
      await client.request('DELETE', apiPath(`${ISSUES_PATH}/{number}/labels/{label}`, { ...repo, number: action.number, label: action.label }), {
        okStatuses: [NOT_FOUND],
      });
      return;
    case 'comment':
      return postComment(client, repo, action.number, action.body);
    case 'upsert-comment':
      return upsertComment(client, repo, action);
    case 'create-issue':
      await client.request('POST', apiPath(ISSUES_PATH, repo), { body: { title: action.title, body: action.body } });
      return;
    case 'close-issue':
      await postComment(client, repo, action.number, action.comment);
      await client.request('PATCH', issuePath(repo, action.number), { body: { state: 'closed' } });
      return;
    default:
      throw new Error(`unknown action kind: ${action.kind}`);
  }
}

/**
 * Executes actions in order. Throws GitHubError on the first failure.
 * @param {Action[]} actions
 * @param {ValidatorContext} ctx
 * @returns {Promise<void>}
 */
export async function applyActions(actions, ctx) {
  if (actions.length > 0 && !ctx.client) throw new Error('actions returned but the validator exports needsClient = false');
  for (const action of actions) await applyAction(action, ctx);
}

function bulletList(heading, items) {
  if (items.length === 0) return '';
  return `### ${heading}\n\n${items.map((item) => `- ${item}`).join('\n')}\n\n`;
}

/**
 * @param {string} validatorName
 * @param {ValidatorResult} result
 * @returns {string}
 */
export function renderSummary(validatorName, result) {
  const details = result.details ? `${result.details.trimEnd()}\n` : '';
  return `## ${validatorName}\n\nConclusion: **${result.conclusion}**\n\n${bulletList('Errors', result.errors)}${bulletList('Warnings', result.warnings)}${details}`;
}

function oneLine(error) {
  return String(error?.message ?? error).replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

async function buildContext(validator, { argv, env, scriptUrl, createClient, readFile }) {
  const payloadPath = argv[2] ?? env.GITHUB_EVENT_PATH;
  if (!payloadPath) throw new Error('no event payload: pass a path as the first argument or set GITHUB_EVENT_PATH');
  if (!env.GITHUB_EVENT_NAME) throw new Error('GITHUB_EVENT_NAME is not set');
  const payload = JSON.parse(await readFile(payloadPath, 'utf8'));
  const root = repoRoot(scriptUrl);
  const client = validator.needsClient === false ? undefined : createClient({ env });
  return { eventName: env.GITHUB_EVENT_NAME, payload, env, repo: repoFromEnv(env), client, config: await loadConfig({ root }), root };
}

const EXIT_CODES = { pass: EXIT_OK, skip: EXIT_OK, fail: EXIT_FAIL };

function exitCodeFor(conclusion) {
  if (!Object.hasOwn(EXIT_CODES, conclusion ?? '')) throw new Error(`unknown conclusion: ${conclusion}`);
  return EXIT_CODES[conclusion];
}

/**
 * Runs the validator and records progress in `outcome`. `outcome.result` is set once
 * the conclusion is valid, so a later action failure still renders the result.
 */
async function execute(validator, options, outcome) {
  const ctx = await buildContext(validator, options);
  const facts = await validator.collect(ctx);
  const result = validator.evaluate(facts, ctx.config);
  outcome.exitCode = exitCodeFor(result?.conclusion);
  outcome.result = result;
  if (result.actions?.length) await applyActions(result.actions, ctx);
}

function errorSummary(validatorName, result, error) {
  if (!result) return `## ${validatorName}\n\nConclusion: **error**\n\n${oneLine(error)}\n`;
  return `${renderSummary(validatorName, result)}\n### Error\n\n${oneLine(error)}\n`;
}

/**
 * The one place allowed to set process.exitCode and write to stdout.
 * `GITHUB_REPOSITORY` and `GITHUB_EVENT_NAME` are required even when the validator
 * exports `needsClient = false`. An unknown conclusion, a failed action or a failed
 * summary write all exit 2.
 * Test seams (all optional): `createClient` replaces github.createClient; `readFile`
 * and `appendFile` replace the fs/promises functions; `stdout` replaces process.stdout.write;
 * `setExitCode: false` skips process.exitCode. The exit code is also returned.
 * @param {{ name: string, needsClient?: boolean, collect: Function, evaluate: Function }} validator
 * @param {{ argv: string[], env: Record<string, string|undefined>, scriptUrl: string,
 *   createClient?: Function, readFile?: Function, appendFile?: Function,
 *   stdout?: (text: string) => void, setExitCode?: boolean }} options
 * @returns {Promise<number>}
 */
export async function runValidator(validator, options) {
  const { env = {}, appendFile = appendFileDefault, setExitCode = true } = options;
  const stdout = options.stdout ?? ((text) => process.stdout.write(text));
  const outcome = { exitCode: EXIT_ERROR, result: undefined };
  let summary;
  try {
    await execute(validator, {
      argv: options.argv ?? [],
      env,
      scriptUrl: options.scriptUrl,
      createClient: options.createClient ?? createClientDefault,
      readFile: options.readFile ?? readFileDefault,
    }, outcome);
    summary = renderSummary(validator.name, outcome.result);
  } catch (error) {
    summary = errorSummary(validator.name, outcome.result, error);
    outcome.exitCode = EXIT_ERROR;
  }
  if (setExitCode) process.exitCode = outcome.exitCode;
  try {
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    else stdout(`${summary}\n`);
  } catch (error) {
    stdout(`${summary}\nsummary write failed: ${oneLine(error)}\n`);
    outcome.exitCode = EXIT_ERROR;
  }
  if (setExitCode) process.exitCode = outcome.exitCode;
  return outcome.exitCode;
}

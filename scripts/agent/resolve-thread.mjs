import { parseArgs } from 'node:util';
import { GitHubError, createClient, currentRepo, repoFromEnv } from '../lib/github.mjs';
import { isValidSessionId, parseFooter } from '../lib/issue-model.mjs';
import './token.mjs'; // exits on an unsupported Node before the script runs

const EXIT_ERROR = 1;
const EXIT_OTHER_SESSION = 3;
const MAX_REVIEW_THREADS = 100;
const ISSUE_BRANCH = /^issue\/\d+$/;
const USAGE = 'usage: resolve-thread.mjs <PR number> (<thread id> | --list) [--session <id>] [--json]';
const PULL_QUERY = 'query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) '
  + '{ pullRequest(number: $number) { state headRefName isCrossRepository headRepository { nameWithOwner } body '
  + `reviewThreads(first: ${MAX_REVIEW_THREADS}) { pageInfo { hasNextPage } nodes { id isResolved path line originalLine `
  + 'comments(first: 1) { nodes { body } } } } } } }';
const RESOLVE_MUTATION = 'mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }';

const refusal = (exitCode, reason) => ({ exitCode, result: { ok: false, reason } });
const firstLine = (text) => String(text ?? '').split(/\r?\n/)[0].replace(/\p{Cc}+/gu, ' ').trim();

/** Refusal for a PR this session may not touch, or null when it holds the PR (the footer rule `resume` uses). */
function holdRefusal(pull, { owner, repo, number, session }) {
  if (!pull) return refusal(EXIT_ERROR, `pull request #${number} not found`);
  if (pull.state !== 'OPEN') return refusal(EXIT_ERROR, `PR #${number} is not open (${pull.state})`);
  if (pull.isCrossRepository || pull.headRepository?.nameWithOwner !== `${owner}/${repo}`) {
    return refusal(EXIT_ERROR, `PR #${number} head is not in ${owner}/${repo}`);
  }
  if (!ISSUE_BRANCH.test(pull.headRefName)) return refusal(EXIT_ERROR, `PR #${number} head ${pull.headRefName} is not issue/N`);
  const heldBy = parseFooter(pull.body)?.session ?? null;
  if (heldBy === null) return refusal(EXIT_ERROR, `PR #${number} has no Agent footer, so session ${session} cannot be checked`);
  if (heldBy !== session) return refusal(EXIT_OTHER_SESSION, `PR #${number} footer names session ${heldBy}, not ${session}`);
  return null;
}

async function loadHeldPull(client, target) {
  const data = await client.graphql(PULL_QUERY, { owner: target.owner, repo: target.repo, number: target.number });
  const pull = data.repository?.pullRequest ?? null;
  return { pull, refused: holdRefusal(pull, target) };
}

/**
 * @param {import('../lib/github.mjs').GitHubClient} client
 * @param {{ owner: string, repo: string, number: number, session: string }} target
 * @returns {Promise<{ exitCode: number, result: object }>}   lines: `<thread id> <path>:<line> <first comment line>`
 */
export async function listThreads(client, target) {
  const { pull, refused } = await loadHeldPull(client, target);
  if (refused) return refused;
  const lines = pull.reviewThreads.nodes.filter((thread) => !thread.isResolved).map((thread) => {
    const location = `${thread.path}:${thread.line ?? thread.originalLine ?? '?'}`;
    return `${thread.id} ${location} ${firstLine(thread.comments.nodes[0]?.body)}`;
  });
  if (pull.reviewThreads.pageInfo?.hasNextPage) lines.push(`more than ${MAX_REVIEW_THREADS} review threads: the rest are not shown`);
  return { exitCode: 0, result: { ok: true, number: target.number, lines } };
}

/**
 * Resolves one review thread on a PR the session holds; the thread must belong to that PR.
 * @param {import('../lib/github.mjs').GitHubClient} client
 * @param {{ owner: string, repo: string, number: number, session: string, threadId: string }} target
 * @returns {Promise<{ exitCode: number, result: object }>}   exit 3 when the PR footer names another session
 */
export async function resolveThread(client, target) {
  const { number, threadId } = target;
  const { pull, refused } = await loadHeldPull(client, target);
  if (refused) return refused;
  const thread = pull.reviewThreads.nodes.find((node) => node.id === threadId);
  if (!thread && pull.reviewThreads.pageInfo?.hasNextPage) {
    return refusal(EXIT_ERROR, `PR #${number} has more than ${MAX_REVIEW_THREADS} review threads and ${threadId} is not among the first`);
  }
  if (!thread) return refusal(EXIT_ERROR, `${threadId} is not a review thread of PR #${number}`);
  if (thread.isResolved) return { exitCode: 0, result: { ok: true, number, threadId, alreadyResolved: true } };
  const data = await client.graphql(RESOLVE_MUTATION, { threadId });
  if (data.resolveReviewThread?.thread?.isResolved !== true) throw new GitHubError(`resolveReviewThread did not resolve ${threadId}`);
  return { exitCode: 0, result: { ok: true, number, threadId } };
}

export function parseCliArguments(argv, env) {
  const { values, positionals } = parseArgs({ args: argv, options: { session: { type: 'string' }, list: { type: 'boolean' }, json: { type: 'boolean' } }, allowPositionals: true });
  const list = values.list === true;
  if (positionals.length !== (list ? 1 : 2) || !/^\d+$/.test(positionals[0])) throw new GitHubError(USAGE);
  const session = values.session || env.GROUNDWORK_SESSION || '';
  if (!session) throw new GitHubError('no session: pass --session <id> or set GROUNDWORK_SESSION');
  if (!isValidSessionId(session)) throw new GitHubError(`invalid session id: ${session}`);
  return { number: Number(positionals[0]), threadId: list ? null : positionals[1], session, list, json: values.json === true };
}

function report({ exitCode, result }, json) {
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else if (!result.ok) console.error(result.reason);
  else if (result.lines) process.stdout.write(result.lines.map((line) => `${line}\n`).join(''));
  else if (result.alreadyResolved) process.stdout.write(`${result.threadId} already resolved\n`);
  else process.stdout.write(`${result.threadId}\n`);
  return exitCode;
}

async function main(argv) {
  const target = parseCliArguments(argv, process.env);
  const client = createClient({ env: process.env });
  const repoRef = process.env.GITHUB_REPOSITORY ? repoFromEnv(process.env) : await currentRepo();
  const run = target.list ? listThreads : resolveThread;
  return report(await run(client, { ...repoRef, ...target }), target.json);
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    const reason = error instanceof Error ? error.message.split(/\r?\n/)[0] : 'resolve-thread: failed';
    process.exitCode = report({ exitCode: EXIT_ERROR, result: { ok: false, reason } }, process.argv.includes('--json'));
  }
}

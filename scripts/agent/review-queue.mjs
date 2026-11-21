import { parseArgs } from 'node:util';
import { GitHubError, apiPath, createClient, currentRepo, repoFromEnv } from '../lib/github.mjs';
import { loadConfig, repoRoot } from '../lib/config.mjs';
import { parseFooter } from '../lib/issue-model.mjs';
import { sameLogin } from '../lib/trust.mjs';
import './token.mjs'; // exits on an unsupported Node before the script runs

/** @typedef {{ number: number, title: string, session: string|null }} ReviewEntry   session: the PR footer's, null without a footer */
/** @typedef {{ number: number, title: string }} DependabotEntry */

const REPO_PATH = '/repos/{owner}/{repo}';
const USAGE = 'usage: review-queue.mjs [--json]';
const DEPENDABOT_LOGIN = 'dependabot[bot]';
const PASSING_CONCLUSIONS = ['success', 'skipped', 'neutral'];
const IGNORED_REVIEW_STATES = ['PENDING', 'DISMISSED'];
const REVIEWER_LINE = /^Reviewer: \S+ · session ([A-Za-z0-9._-]+)$/;
const VERSION_BUMP = /\bfrom v?(\d+)\S* to v?(\d+)/i;
const GROUPED_BUMP = /\bthe .+ group\b/i;

function lastLine(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').trimEnd().split('\n').at(-1).trim();
}

/** The session named by a review's closing `Reviewer:` line, only when the agent account wrote the review. */
function reviewerSession(review, config) {
  if (IGNORED_REVIEW_STATES.includes(review.state)) return null;
  if (!sameLogin(review.user?.login, config.accounts.agent)) return null;
  return REVIEWER_LINE.exec(lastLine(review.body))?.[1] ?? null;
}

/**
 * Minor and patch bumps only: a major, or a title this cannot read, is left for a Chore issue (10.2).
 * @param {string} title
 * @returns {boolean}
 */
export function isMinorOrPatchBump(title) {
  const bump = VERSION_BUMP.exec(title);
  if (bump) return bump[1] === bump[2];
  return GROUPED_BUMP.test(title);
}

function latestPerName(runs) {
  const newest = new Map();
  for (const run of runs) {
    if (!newest.has(run.name) || run.id > newest.get(run.name).id) newest.set(run.name, run);
  }
  return [...newest.values()];
}

async function checksAreGreen(client, repoRef, sha) {
  const runs = await client.paginate(apiPath(`${REPO_PATH}/commits/{sha}/check-runs`, { ...repoRef, sha }), { itemsKey: 'check_runs' });
  const latest = latestPerName(runs);
  return latest.length > 0 && latest.every((run) => run.status === 'completed' && PASSING_CONCLUSIONS.includes(run.conclusion));
}

async function awaitsReview(client, repoRef, pull, config) {
  const session = parseFooter(pull.body)?.session ?? null;
  const reviews = await client.paginate(apiPath(`${REPO_PATH}/pulls/{number}/reviews`, { ...repoRef, number: pull.number }));
  const reviewedElsewhere = reviews.some((review) => {
    const reviewer = reviewerSession(review, config);
    return reviewer !== null && reviewer !== session;
  });
  return reviewedElsewhere ? null : { number: pull.number, title: pull.title, session };
}

async function readyDependabotPull(client, repoRef, pull) {
  if (pull.auto_merge || !isMinorOrPatchBump(pull.title)) return null;
  if (!await checksAreGreen(client, repoRef, pull.head.sha)) return null;
  return { number: pull.number, title: pull.title };
}

/**
 * Ready PRs without a review from another session, and Dependabot minor or patch PRs with green checks that are
 * not queued yet. Draft PRs are in neither list.
 * @param {import('../lib/github.mjs').GitHubClient} client
 * @param {{ owner: string, repo: string }} repoRef
 * @param {{ config: object }} context
 * @returns {Promise<{ review: ReviewEntry[], dependabot: DependabotEntry[] }>}
 */
export async function reviewQueue(client, repoRef, { config }) {
  const pulls = await client.paginate(apiPath(`${REPO_PATH}/pulls`, repoRef), { query: { state: 'open' } });
  const ready = pulls.filter((pull) => !pull.draft);
  const isDependabot = (pull) => sameLogin(pull.user?.login, DEPENDABOT_LOGIN);
  const [review, dependabot] = await Promise.all([
    Promise.all(ready.filter((pull) => !isDependabot(pull)).map((pull) => awaitsReview(client, repoRef, pull, config))),
    Promise.all(ready.filter(isDependabot).map((pull) => readyDependabotPull(client, repoRef, pull))),
  ]);
  return { review: review.filter(Boolean), dependabot: dependabot.filter(Boolean) };
}

/**
 * @param {{ review: ReviewEntry[], dependabot: DependabotEntry[] }} queue
 * @param {{ json: boolean }} options
 * @returns {string}
 */
export function formatOutput({ review, dependabot }, { json }) {
  if (json) return JSON.stringify({ ok: true, review, dependabot });
  const lines = [
    ...review.map((entry) => `review #${entry.number}: ${entry.title}${entry.session ? ` [session ${entry.session}]` : ''}`),
    ...dependabot.map((entry) => `enqueue #${entry.number}: ${entry.title}`),
  ];
  return lines.length > 0 ? lines.join('\n') : 'nothing to review';
}

export function parseCliArguments(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: { json: { type: 'boolean' } }, allowPositionals: true });
  if (positionals.length > 0) throw new GitHubError(USAGE);
  return { json: values.json === true };
}

async function main(argv) {
  const { json } = parseCliArguments(argv);
  const config = await loadConfig({ root: repoRoot(import.meta.url) });
  const repoRef = process.env.GITHUB_REPOSITORY ? repoFromEnv(process.env) : await currentRepo();
  const queue = await reviewQueue(createClient({ env: process.env }), repoRef, { config });
  console.log(formatOutput(queue, { json }));
}

if (import.meta.main) {
  const json = process.argv.slice(2).includes('--json');
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const reason = error instanceof Error ? error.message.split(/\r?\n/)[0] : 'review-queue: failed';
    if (json) console.log(JSON.stringify({ ok: false, reason }));
    console.error(reason);
    process.exitCode = 1;
  }
}

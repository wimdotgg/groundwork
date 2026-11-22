import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { GitHubError, apiPath, createClient, currentRepo, repoFromEnv } from '../lib/github.mjs';
import { loadConfig, repoRoot } from '../lib/config.mjs';
import { sameLogin } from '../lib/trust.mjs';
import {
  TITLE_TYPES, claimCommitMessage, isValidAgent, isValidSessionId, leaseState, loadIssueFacts, parseClaimCommit,
  parseConventionalTitle, parseFooter,
} from '../lib/issue-model.mjs';
import { unmetReadiness } from './next.mjs';
import { fillTemplate, findClosingRefs, hasMarker, removeMarker, templateSection } from '../lib/markdown.mjs';
import './token.mjs'; // exits on an unsupported Node before the script runs

/** @typedef {import('../lib/github.mjs').GitHubClient} GitHubClient */
/** @typedef {{ claimComment: string, pullRequest: string }} Templates */
/** @typedef {{ client: GitHubClient, repo: { owner: string, repo: string }, config: any, number: number,
 *   session: string, agent: string, templates: Templates, now: Date,
 *   findUnmetReadiness: (number: number) => Promise<{ code: string, reason: string }|null> }} ClaimContext */
/** @typedef {{ exitCode: number, reason?: string, pr?: number, mode?: 'claim'|'takeover' }} ClaimOutcome */

export const EXIT_CLAIMED = 0;
export const EXIT_ERROR = 1;
export const EXIT_HELD = 3;
const BASE_BRANCH = 'main';
const NOT_FOUND = 404;
const UNPROCESSABLE = 422;
const CREATED = 201;
const OK = 200;
const NEEDS_DECISION_LABEL = 'needs-decision';
const UNKNOWN_SESSION = 'unknown';
const MS_PER_MINUTE = 60_000;
const REPO_PATH = '/repos/{owner}/{repo}';
const OWNED_PLACEHOLDERS = [
  'issue', 'checkpoint', 'time', 'agent', 'session',
  'done', 'in progress', 'next', 'proven', 'unproven', 'rejected', 'gotchas', 'open',
].map((name) => `<${name}>`);
const INITIAL_STATE = {
  checkpoint: 0,
  done: 'none',
  'in progress': 'claimed, nothing built yet',
  next: 'start the first acceptance criterion',
  proven: 'none',
  unproven: 'all',
  rejected: 'none',
  gotchas: 'none',
  open: 'none',
};
const USAGE = 'usage: claim.mjs <issue number> --session <id> --agent <model>/<harness> [--json]';

const repoParams = (repo, extra = {}) => ({ ...repo, ...extra });
const issueBranch = (number) => `issue/${number}`;
const formatTime = (now) => now.toISOString().slice(0, 16).replace('T', ' ');

const footerSession = (body) => parseFooter(body)?.session ?? null;

function titlePrefix(issueType) {
  const mapping = TITLE_TYPES[issueType];
  if (!mapping || mapping.types.length === 0) return null;
  const type = mapping.types.includes('chore') ? 'chore' : mapping.types[0];
  return mapping.scope ? `${type}(${mapping.scope})` : type;
}

function fillOwned(template, values) {
  const { text, unfilled } = fillTemplate(template, values);
  const missing = unfilled.filter((token) => OWNED_PLACEHOLDERS.includes(token));
  if (missing.length > 0) throw new GitHubError(`claim: template placeholders without a value: ${missing.join(' ')}`);
  return text;
}

function renderComment(templates, sectionName, values) {
  const section = templateSection(templates.claimComment, sectionName);
  if (section === null) throw new GitHubError(`claim: claim-comment.md has no "${sectionName}" section`);
  const { text, unfilled } = fillTemplate(section, values);
  if (unfilled.length > 0) throw new GitHubError(`claim: comment placeholders without a value: ${unfilled.join(' ')}`);
  return text;
}

const isOurPull = ({ repo, config }, pull) => sameLogin(pull.user?.login, config.accounts.agent)
  && sameLogin(pull.head?.repo?.full_name, `${repo.owner}/${repo.repo}`);

/** The PR title gets its type from the issue type, so a type the issue title already carries is dropped, not doubled. */
const withoutTypePrefix = (title) => parseConventionalTitle(title)?.summary ?? title;

/** A closing reference in the title would close another issue when the PR merges, so such a title is replaced. */
const summaryFor = (issue) => (findClosingRefs(issue.title).length > 0 ? `work on #${issue.number}` : withoutTypePrefix(issue.title));

/** @returns {Promise<number[]>} the draft PRs on other issues that this session holds; a released draft is not held */
async function findHeldDrafts(context) {
  const { client, repo, number, session } = context;
  const pulls = await client.paginate(apiPath(`${REPO_PATH}/pulls`, repoParams(repo)), { query: { state: 'open' } });
  return pulls
    .filter((pull) => pull.draft === true
      && pull.head?.ref?.startsWith('issue/')
      && pull.head.ref !== issueBranch(number)
      && isOurPull(context, pull)
      && !hasMarker(pull.body ?? '', 'released')
      && footerSession(pull.body) === session)
    .map((pull) => pull.number);
}

async function findOpenPull(context) {
  const { client, repo, number } = context;
  const pulls = await client.paginate(apiPath(`${REPO_PATH}/pulls`, repoParams(repo)), {
    query: { head: `${repo.owner}:${issueBranch(number)}`, state: 'open' },
  });
  return pulls.find((pull) => pull.head?.ref === issueBranch(number) && isOurPull(context, pull)) ?? null;
}

async function hasAgentComment({ client, repo, config }, issueNumber, expectedBody) {
  const comments = await client.paginate(apiPath(`${REPO_PATH}/issues/{issueNumber}/comments`, repoParams(repo, { issueNumber })));
  return comments.some((comment) => sameLogin(comment.user?.login, config.accounts.agent) && (comment.body ?? '').trim() === expectedBody.trim());
}

/** @returns {Promise<{ exists: boolean, sha: string|null }>} */
async function readBranch({ client, repo, number }) {
  const response = await client.request('GET', apiPath(`${REPO_PATH}/git/ref/heads/issue/{number}`, repoParams(repo, { number })), {
    okStatuses: [NOT_FOUND],
  });
  return response.status === NOT_FOUND ? { exists: false, sha: null } : { exists: true, sha: response.data.object.sha };
}

async function headIsOwnClaimCommit(context, sha) {
  const { client, repo, number, session } = context;
  const response = await client.request('GET', apiPath(`${REPO_PATH}/git/commits/{sha}`, repoParams(repo, { sha })));
  const claim = parseClaimCommit(response.data.message);
  return claim?.kind === 'claim' && claim.number === number && claim.session === session;
}

async function branchBelongsToSession(context, sha, openPull) {
  if (openPull) return !hasMarker(openPull.body ?? '', 'released') && footerSession(openPull.body) === context.session;
  return headIsOwnClaimCommit(context, sha);
}

/**
 * The lock: one commit from main's tree and parent, no author or committer (GitHub stamps the dates),
 * then a ref create. Only 201 claims.
 * @returns {Promise<boolean>} true when this call created the ref
 */
async function createClaimRef({ client, repo, number, session }) {
  const mainSha = (await client.request('GET', apiPath(`${REPO_PATH}/git/ref/heads/{base}`, repoParams(repo, { base: BASE_BRANCH })))).data.object.sha;
  const tree = (await client.request('GET', apiPath(`${REPO_PATH}/git/commits/{mainSha}`, repoParams(repo, { mainSha })))).data.tree.sha;
  const commit = await client.request('POST', apiPath(`${REPO_PATH}/git/commits`, repoParams(repo)), {
    body: { message: claimCommitMessage({ number, session }), tree, parents: [mainSha] },
  });
  try {
    const ref = await client.request('POST', apiPath(`${REPO_PATH}/git/refs`, repoParams(repo)), {
      body: { ref: `refs/heads/${issueBranch(number)}`, sha: commit.data.sha },
      okStatuses: [UNPROCESSABLE],
    });
    return ref.status === CREATED;
  } catch (error) {
    if (error instanceof GitHubError && error.status > 0) return false;
    throw error;
  }
}

async function postComment({ client, repo }, issueNumber, body) {
  await client.request('POST', apiPath(`${REPO_PATH}/issues/{issueNumber}/comments`, repoParams(repo, { issueNumber })), { body: { body } });
}

const formatFooter = (agent, session) => `Agent: ${agent} · session ${session}`;
const labelNames = (pull) => (pull.labels ?? []).map((label) => (typeof label === 'string' ? label : label?.name));

/** Puts the new footer last, under a `---` break, which the footer parsers need; a body without a footer gets both appended. */
function rewriteFooter(body, agent, session) {
  const lines = String(body ?? '').trimEnd().split(/\r?\n/);
  if (footerSession(body) !== null) lines.pop();
  while (lines.length > 0 && lines.at(-1).trim() === '') lines.pop();
  if (lines.at(-1)?.trim() !== '---') lines.push('', '---');
  return `${[...lines, formatFooter(agent, session)].join('\n')}\n`;
}

/** A takeover candidate is a draft with an expired lease or the released marker, and no needs-decision label (6.4). */
async function isTakeoverCandidate({ client, repo, config, now }, pull, issue) {
  if (pull.draft !== true || [pull, issue].some((item) => labelNames(item).includes(NEEDS_DECISION_LABEL))) return false;
  const comments = await client.paginate(apiPath(`${REPO_PATH}/issues/{issueNumber}/comments`, repoParams(repo, { issueNumber: pull.number })));
  const agentTimes = comments
    .filter((comment) => sameLogin(comment.user?.login, config.accounts.agent))
    .map((comment) => comment.created_at)
    .sort();
  const lease = leaseState({
    draft: true, released: hasMarker(pull.body ?? '', 'released'), createdAt: pull.created_at, lastAgentCommentAt: agentTimes.at(-1) ?? null,
  }, { config, now, claimCommentAt: null, claimCommitAt: null });
  return lease.expired || lease.released;
}

/**
 * Another session's takeover commit still inside the claim window means its winner has not posted the takeover
 * comment yet, so the lease is not restarted and a second takeover would stack on the first. The commit date is
 * stamped by GitHub; a missing date counts as recent.
 */
function isRecentForeignTakeover({ config, now, number, session }, headCommit) {
  const claim = parseClaimCommit(headCommit.message ?? '');
  if (claim?.kind !== 'takeover' || claim.number !== number || claim.session === session) return false;
  const ageMinutes = (new Date(now).getTime() - new Date(headCommit.committer?.date).getTime()) / MS_PER_MINUTE;
  return !Number.isFinite(ageMinutes) || ageMinutes < config.limits.claimWithoutPrMinutes;
}

/**
 * The compare-and-swap: a takeover commit on the observed head, then a plain fast-forward ref update.
 * A moved head makes the update non-fast-forward, which GitHub rejects; the loser moves on.
 * @returns {Promise<boolean>} true when this call moved the ref
 */
async function moveRefToTakeover({ client, repo, number, session }, headSha, treeSha) {
  const commit = await client.request('POST', apiPath(`${REPO_PATH}/git/commits`, repoParams(repo)), {
    body: { message: claimCommitMessage({ number, session, kind: 'takeover' }), tree: treeSha, parents: [headSha] },
  });
  try {
    const ref = await client.request('PATCH', apiPath(`${REPO_PATH}/git/refs/heads/issue/{number}`, repoParams(repo, { number })), {
      body: { sha: commit.data.sha, force: false },
      okStatuses: [UNPROCESSABLE],
    });
    return ref.status === OK;
  } catch (error) {
    if (error instanceof GitHubError && error.status > 0) return false;
    throw error;
  }
}

/**
 * Takeover per 6.4. The PR body is rewritten before the comment: the comment restarts the lease, so a comment
 * first and then a crash would leave the PR under the old footer for 4 hours, owned by nobody.
 * @returns {Promise<ClaimOutcome>}
 */
async function takeOver(context, branchSha, pull, issue) {
  const { client, repo, number, session, agent, templates } = context;
  const held = { exitCode: EXIT_HELD, reason: `${issueBranch(number)} is held by another session` };
  if (!await isTakeoverCandidate(context, pull, issue)) return held;
  const headCommit = (await client.request('GET', apiPath(`${REPO_PATH}/git/commits/{branchSha}`, repoParams(repo, { branchSha })))).data;
  if (isRecentForeignTakeover(context, headCommit)) return held;
  const strippedBody = removeMarker(pull.body ?? '', 'released');
  const takeoverComment = renderComment(templates, 'PR takeover', {
    issue: number, session, 'previous session': footerSession(strippedBody) ?? UNKNOWN_SESSION,
  });
  if (!await moveRefToTakeover(context, branchSha, headCommit.tree.sha)) return held;
  const body = rewriteFooter(strippedBody, agent, session);
  await client.request('PATCH', apiPath(`${REPO_PATH}/pulls/{pullNumber}`, repoParams(repo, { pullNumber: pull.number })), { body: { body } });
  await postComment(context, pull.number, takeoverComment);
  return { exitCode: EXIT_CLAIMED, pr: pull.number, mode: 'takeover' };
}

/** Renders every text the claim posts, so a template problem refuses before the lock is taken. */
function renderPosts(context, issue, prefix) {
  const { number, session, agent, templates, now } = context;
  const values = { issue: number, session };
  return {
    pointer: renderComment(templates, 'Issue pointer', values),
    prClaim: renderComment(templates, 'PR claim', values),
    prTitle: `${prefix}: ${summaryFor(issue)}`,
    prBody: fillOwned(templates.pullRequest, { issue: number, ...INITIAL_STATE, time: formatTime(now), agent, session }),
  };
}

async function createDraftPull({ client, repo, number }, { prTitle, prBody }) {
  const response = await client.request('POST', apiPath(`${REPO_PATH}/pulls`, repoParams(repo)), {
    body: { title: prTitle, head: issueBranch(number), base: BASE_BRANCH, body: prBody, draft: true },
  });
  return response.data.number;
}

/**
 * Posts the pointer comment, the draft PR and the PR claim comment, in that order. A fresh claim
 * (`resume` null) posts everything, so the pointer's created_at is the new claim time. A rerun skips
 * only what this session already posted.
 * @param {{ pull: { number: number }|null }|null} resume
 * @returns {Promise<number>} the PR number
 */
async function completeClaim(context, posts, resume) {
  const { pointer, prClaim } = posts;
  const { number } = context;
  if (!resume || !await hasAgentComment(context, number, pointer)) await postComment(context, number, pointer);
  const prNumber = resume?.pull?.number ?? await createDraftPull(context, posts);
  if (resume?.pull && await hasAgentComment(context, prNumber, prClaim)) return prNumber;
  await postComment(context, prNumber, prClaim);
  return prNumber;
}

/**
 * Claim per 6.3. An existing `issue/N` that this session owns resumes; any other existing branch is taken
 * over when its draft PR is a takeover candidate (6.4) and held otherwise.
 * @param {ClaimContext} context
 * @returns {Promise<ClaimOutcome>}
 */
export async function runClaim(context) {
  const { client, repo, config, number, session } = context;
  const held = await findHeldDrafts(context);
  if (held.length >= config.limits.tasksPerWorker) {
    return { exitCode: EXIT_ERROR, reason: `session ${session} already holds draft PR #${held[0]}; finish or release it first` };
  }
  const issue = (await client.request('GET', apiPath(`${REPO_PATH}/issues/{number}`, repoParams(repo, { number })))).data;
  const prefix = titlePrefix(issue.type?.name);
  if (issue.pull_request || issue.state === 'closed' || !prefix) {
    return { exitCode: EXIT_HELD, reason: `#${number} is not a claimable issue (a PR, closed, or without a claimable type)` };
  }
  const posts = renderPosts(context, issue, prefix);
  const branch = await readBranch(context);
  const openPull = branch.exists ? await findOpenPull(context) : null;
  if (branch.exists && !await branchBelongsToSession(context, branch.sha, openPull)) {
    if (openPull) return takeOver(context, branch.sha, openPull, issue);
    return { exitCode: EXIT_HELD, reason: `${issueBranch(number)} is held by another session` };
  }
  if (!branch.exists) {
    const unmet = await context.findUnmetReadiness(number);
    if (unmet) return { exitCode: EXIT_HELD, reason: `#${number} is not ready (${unmet.code}): ${unmet.reason}` };
    if (!await createClaimRef(context)) return { exitCode: EXIT_HELD, reason: `${issueBranch(number)} is already claimed` };
  }
  const resume = branch.exists ? { pull: openPull } : null;
  return { exitCode: EXIT_CLAIMED, pr: await completeClaim(context, posts, resume) };
}

function parseCli(argv, env) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { session: { type: 'string' }, agent: { type: 'string' }, json: { type: 'boolean' } },
  });
  const number = Number(positionals[0]);
  if (positionals.length !== 1 || !Number.isInteger(number) || number < 1) throw new GitHubError(USAGE);
  const session = values.session ?? env.GROUNDWORK_SESSION;
  if (!session) throw new GitHubError('session id required');
  if (!isValidSessionId(session)) throw new GitHubError(`invalid session id: ${session}`);
  const agent = values.agent ?? env.GROUNDWORK_AGENT;
  if (!agent) throw new GitHubError('agent required: --agent <model>/<harness> or GROUNDWORK_AGENT');
  if (!isValidAgent(agent)) throw new GitHubError(`invalid agent: ${agent}`);
  return { number, session, agent, json: values.json === true };
}

function report({ number, json }, outcome) {
  const ok = outcome.exitCode === EXIT_CLAIMED;
  if (json) {
    const payload = ok ? { ok, number, mode: outcome.mode ?? 'claim', branch: issueBranch(number), pr: outcome.pr } : { ok, reason: outcome.reason, number };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else if (ok) {
    const verb = outcome.mode === 'takeover' ? 'took over' : 'claimed';
    process.stdout.write(`${verb} #${number} on ${issueBranch(number)}, PR #${outcome.pr}\n`);
  }
  if (!ok) process.stderr.write(`${outcome.reason}\n`);
}

async function main(argv, env) {
  const cli = parseCli(argv, env);
  const root = repoRoot(import.meta.url);
  const templatesDir = path.join(root, '.github');
  const client = createClient({ env });
  const repo = env.GITHUB_REPOSITORY ? repoFromEnv(env) : await currentRepo();
  const config = await loadConfig({ root });
  const now = new Date();
  const context = {
    client,
    repo,
    config,
    number: cli.number,
    session: cli.session,
    agent: cli.agent,
    templates: {
      claimComment: await readFile(path.join(templatesDir, 'groundwork', 'templates', 'claim-comment.md'), 'utf8'),
      pullRequest: await readFile(path.join(templatesDir, 'pull_request_template.md'), 'utf8'),
    },
    now,
    findUnmetReadiness: async (number) => unmetReadiness(await loadIssueFacts(client, { ...repo, number }, { config }), { config, now }),
  };
  const outcome = await runClaim(context);
  report(cli, outcome);
  return outcome.exitCode;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2), process.env);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split(/\r?\n/)[0] : 'claim: failed';
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ ok: false, reason })}\n`);
    console.error(reason);
    process.exitCode = EXIT_ERROR;
  }
}

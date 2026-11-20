import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { GitHubError, apiPath, createClient, currentRepo, repoFromEnv } from '../lib/github.mjs';
import { loadConfig, repoRoot } from '../lib/config.mjs';
import { sameLogin } from '../lib/trust.mjs';
import { TITLE_TYPES, claimCommitMessage, isValidAgent, isValidSessionId, parseClaimCommit } from '../lib/issue-model.mjs';
import { fillTemplate, hasMarker, templateSection } from '../lib/markdown.mjs';

/** @typedef {import('../lib/github.mjs').GitHubClient} GitHubClient */
/** @typedef {{ claimComment: string, pullRequest: string }} Templates */
/** @typedef {{ client: GitHubClient, repo: { owner: string, repo: string }, config: any, number: number,
 *   session: string, agent: string, templates: Templates, now: Date }} ClaimContext */
/** @typedef {{ exitCode: number, reason?: string, pr?: number }} ClaimOutcome */

export const EXIT_CLAIMED = 0;
export const EXIT_ERROR = 1;
export const EXIT_HELD = 3;
const BASE_BRANCH = 'main';
const NOT_FOUND = 404;
const UNPROCESSABLE = 422;
const CREATED = 201;
const REPO_PATH = '/repos/{owner}/{repo}';
const FOOTER_SESSION = /^Agent: \S+ · session (\S+)$/;
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

function footerSession(body) {
  const lastLine = String(body ?? '').trimEnd().split(/\r?\n/).at(-1);
  return FOOTER_SESSION.exec(lastLine)?.[1] ?? null;
}

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

/** @returns {Promise<{ number: number, session: string }|null>} the draft PR on another issue that this session holds */
async function findHeldDraft(context) {
  const { client, repo, config, number, session } = context;
  const pulls = await client.paginate(apiPath(`${REPO_PATH}/pulls`, repoParams(repo)), { query: { state: 'open' } });
  const held = pulls.find((pull) => pull.draft === true
    && pull.head?.ref?.startsWith('issue/')
    && pull.head.ref !== issueBranch(number)
    && sameLogin(pull.user?.login, config.accounts.agent)
    && footerSession(pull.body) === session);
  return held ? { number: held.number, session } : null;
}

async function findOpenPull({ client, repo, number }) {
  const pulls = await client.paginate(apiPath(`${REPO_PATH}/pulls`, repoParams(repo)), {
    query: { head: `${repo.owner}:${issueBranch(number)}`, state: 'open' },
  });
  return pulls.find((pull) => pull.head?.ref === issueBranch(number)) ?? null;
}

async function hasAgentMarkerComment({ client, repo, config }, issueNumber) {
  const comments = await client.paginate(apiPath(`${REPO_PATH}/issues/{issueNumber}/comments`, repoParams(repo, { issueNumber })));
  return comments.some((comment) => sameLogin(comment.user?.login, config.accounts.agent) && hasMarker(comment.body ?? '', 'claim'));
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
  if (openPull && footerSession(openPull.body) === context.session) return true;
  return headIsOwnClaimCommit(context, sha);
}

/**
 * The lock: one commit from main's tree and parent, no author or committer (GitHub stamps the dates),
 * then a ref create. Only 201 claims.
 * @returns {Promise<boolean>} true when this call created the ref
 */
async function createClaimRef({ client, repo, number, session }) {
  const main = (await client.request('GET', apiPath(`${REPO_PATH}/git/ref/heads/{base}`, repoParams(repo, { base: BASE_BRANCH })))).data.object.sha;
  const tree = (await client.request('GET', apiPath(`${REPO_PATH}/git/commits/{main}`, repoParams(repo, { main })))).data.tree.sha;
  const commit = await client.request('POST', apiPath(`${REPO_PATH}/git/commits`, repoParams(repo)), {
    body: { message: claimCommitMessage({ number, session }), tree, parents: [main] },
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

async function createDraftPull(context) {
  const { client, repo, number, session, agent, templates, now } = context;
  const issue = (await client.request('GET', apiPath(`${REPO_PATH}/issues/{number}`, repoParams(repo, { number })))).data;
  const prefix = titlePrefix(issue.type?.name);
  if (!prefix) throw new GitHubError(`claim: #${number} is not a claimable issue type`);
  const body = fillOwned(templates.pullRequest, { issue: number, ...INITIAL_STATE, time: formatTime(now), agent, session });
  const response = await client.request('POST', apiPath(`${REPO_PATH}/pulls`, repoParams(repo)), {
    body: { title: `${prefix}: ${issue.title}`, head: issueBranch(number), base: BASE_BRANCH, body, draft: true },
  });
  return response.data.number;
}

/**
 * Completes whichever of pointer comment, draft PR and PR claim comment is missing, in that order.
 * @returns {Promise<number>} the PR number
 */
async function completeClaim(context, existingPull) {
  const { number, session, templates } = context;
  const values = { issue: number, session };
  if (!await hasAgentMarkerComment(context, number)) {
    await postComment(context, number, fillOwned(templateSection(templates.claimComment, 'Issue pointer'), values));
  }
  const prNumber = existingPull?.number ?? await createDraftPull(context);
  if (existingPull && await hasAgentMarkerComment(context, prNumber)) return prNumber;
  await postComment(context, prNumber, fillOwned(templateSection(templates.claimComment, 'PR claim'), values));
  return prNumber;
}

/**
 * Claim per 6.3. An existing `issue/N` that this session owns resumes; any other existing branch is held
 * (takeover, 6.4, plugs in at that branch).
 * @param {ClaimContext} context
 * @returns {Promise<ClaimOutcome>}
 */
export async function runClaim(context) {
  const { number, session } = context;
  if (await findHeldDraft(context)) {
    return { exitCode: EXIT_ERROR, reason: `session ${session} already holds a draft PR; finish or release it first` };
  }
  const branch = await readBranch(context);
  const openPull = branch.exists ? await findOpenPull(context) : null;
  if (branch.exists && !await branchBelongsToSession(context, branch.sha, openPull)) {
    return { exitCode: EXIT_HELD, reason: `${issueBranch(number)} is held by another session` };
  }
  if (!branch.exists && !await createClaimRef(context)) {
    return { exitCode: EXIT_HELD, reason: `${issueBranch(number)} is already claimed` };
  }
  return { exitCode: EXIT_CLAIMED, pr: await completeClaim(context, openPull) };
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
    const payload = ok ? { ok, number, mode: 'claim', branch: issueBranch(number), pr: outcome.pr } : { ok, reason: outcome.reason, number };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else if (ok) {
    process.stdout.write(`claimed #${number} on ${issueBranch(number)}, PR #${outcome.pr}\n`);
  }
  if (!ok) process.stderr.write(`${outcome.reason}\n`);
}

async function main(argv, env) {
  const cli = parseCli(argv, env);
  const root = repoRoot(import.meta.url);
  const templatesDir = path.join(root, '.github');
  const context = {
    client: createClient({ env }),
    repo: env.GITHUB_REPOSITORY ? repoFromEnv(env) : await currentRepo(),
    config: await loadConfig({ root }),
    number: cli.number,
    session: cli.session,
    agent: cli.agent,
    templates: {
      claimComment: await readFile(path.join(templatesDir, 'groundwork', 'templates', 'claim-comment.md'), 'utf8'),
      pullRequest: await readFile(path.join(templatesDir, 'pull_request_template.md'), 'utf8'),
    },
    now: new Date(),
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

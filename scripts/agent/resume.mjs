import { parseArgs } from 'node:util';
import { GitHubError, apiPath, createClient, currentRepo, repoFromEnv } from '../lib/github.mjs';
import { loadConfig, repoRoot } from '../lib/config.mjs';
import { deriveStatus, isValidSessionId, loadIssueFacts } from '../lib/issue-model.mjs';
import { hasMarker, parseSections, parseStateSection, removeMarker } from '../lib/markdown.mjs';
import { isTrustedAuthor, sameLogin, untrustedBlock } from '../lib/trust.mjs';

/** @typedef {{ title: string, blocks: Array<{ text: string, author: string|null }> }} Section   author is set when the text is fenced as untrusted */

const REPO_PATH = '/repos/{owner}/{repo}';
const JOURNAL_ENTRIES = 3;
const MAX_REVIEW_THREADS = 100;
const NOT_FOUND = 404;
const EXIT_OTHER_SESSION = 3;
const FOOTER = /^Agent: \S+ · session ([A-Za-z0-9._-]+)$/;
const PASSING_CONCLUSIONS = ['success', 'skipped', 'neutral'];
const TRUNCATION_MARKER = '[truncated to fit the resumeLines limit]';
const USAGE = 'usage: resume.mjs <issue number> [--session <id>] [--json]';
const REVIEW_THREADS_QUERY = 'query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) '
  + '{ pullRequest(number: $number) { reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { isResolved path line '
  + 'comments(first: 1) { nodes { author { login } body } } } } } } }';

/**
 * @param {string|null|undefined} body PR body
 * @returns {string|null} the session named by the footer, the last line of the body
 */
export function footerSession(body) {
  const lastLine = String(body ?? '').trimEnd().split(/\r?\n/).at(-1);
  return FOOTER.exec(lastLine)?.[1] ?? null;
}

function textBlock(text, login, kind, config) {
  const trusted = isTrustedAuthor({ login, kind }, config);
  return { text, author: trusted ? null : login || 'unknown' };
}

const plain = (text) => ({ text, author: null });
const section = (title, ...blocks) => ({ title, blocks: blocks.length > 0 ? blocks : [plain('none')] });
const noPullRequest = (title) => section(title, plain('no PR yet'));

function issueSection({ facts }, config) {
  const heading = `#${facts.number} ${facts.title} (${facts.type ?? 'untyped'}, ${facts.state})`;
  return section('Issue spec', textBlock(`${heading}\n\n${facts.body}`, facts.author, 'issue', config));
}

function epicSection({ epic }, config) {
  if (!epic) return section('Epic');
  const { byName } = parseSections(epic.body);
  const parts = ['Goal', 'Decisions'].map((name) => `## ${name}\n${byName[name]?.trim() ?? '(missing)'}`);
  return section('Epic', textBlock(`Epic #${epic.number} ${epic.title}\n\n${parts.join('\n\n')}`, epic.author, 'issue', config));
}

function stateSection({ pull }, config) {
  if (!pull) return noPullRequest('PR state');
  const state = parseSections(pull.body ?? '').sections.find((entry) => entry.name === 'State');
  if (!state) return section('PR state', plain('the PR body has no ## State section'));
  const { fields } = parseStateSection(state);
  const text = [state.line, ...Object.entries(fields).map(([name, value]) => `${name}: ${value}`)].join('\n');
  return section('PR state', textBlock(text, pull.user?.login, 'pull-request', config));
}

function journalSection({ comments }, config) {
  const entries = comments
    .filter((comment) => sameLogin(comment.user?.login, config.accounts.agent) && hasMarker(comment.body ?? '', 'checkpoint'))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(-JOURNAL_ENTRIES);
  return section('Journal', ...entries.map((comment) => textBlock(removeMarker(comment.body, 'checkpoint').trim(), comment.user.login, 'comment', config)));
}

function diffSection({ pull, files }, config) {
  if (!pull) return noPullRequest('Diff against main');
  const added = files.reduce((sum, file) => sum + file.additions, 0);
  const deleted = files.reduce((sum, file) => sum + file.deletions, 0);
  const rows = files.map((file) => `${file.filename} +${file.additions} -${file.deletions}`);
  return section('Diff against main', textBlock([`${files.length} files, +${added} -${deleted}`, ...rows].join('\n'), pull.user?.login, 'pull-request', config));
}

function ciSection({ checks }) {
  if (!checks) return noPullRequest('CI');
  const lines = checks.map((check) => {
    const failedStep = check.failedStep ? ` (failed step: ${check.failedStep})` : '';
    return `${check.name}: ${check.conclusion ?? check.status}${failedStep}`;
  });
  return section('CI', plain(lines.join('\n') || 'no check runs on the head commit'));
}

function threadsSection({ threads }, config) {
  if (!threads) return noPullRequest('Unresolved review threads');
  const blocks = threads.nodes.filter((thread) => !thread.isResolved).flatMap((thread) => {
    const comment = thread.comments.nodes[0];
    const login = comment?.author?.login ?? '';
    return [plain(`${thread.path}:${thread.line ?? '?'} by ${login || 'unknown'}`), textBlock(comment?.body ?? '', login, 'comment', config)];
  });
  if (threads.pageInfo?.hasNextPage) blocks.push(plain(`more than ${MAX_REVIEW_THREADS} threads: the rest are not shown`));
  return section('Unresolved review threads', ...blocks);
}

function blockerSection({ facts }, { config, now }) {
  const { status, reason } = deriveStatus(facts, { config, now });
  const blockers = facts.blockedBy.map((blocker) => `#${blocker.number} (${blocker.state})`);
  return section('Blockers', plain(`Status: ${status} (${reason})\nBlocked by: ${blockers.length > 0 ? blockers.join(', ') : 'none'}`));
}

function renderBlock({ text, author }, maxLines) {
  const lines = author === null ? text.split('\n') : untrustedBlock(text, author).split('\n');
  if (lines.length <= maxLines) return lines;
  // Cut the text before fencing, so a truncated untrusted block still closes its fence.
  const keep = author === null ? maxLines : maxLines - 2;
  if (keep < 1) return [];
  const kept = text.split('\n').slice(0, keep);
  return author === null ? kept : untrustedBlock(kept.join('\n'), author).split('\n');
}

function renderSection({ title, blocks }, maxLines) {
  const header = `## ${title}`;
  const full = blocks.flatMap((block) => renderBlock(block, Infinity));
  if (full.length + 1 <= maxLines) return { lines: [header, ...full], truncated: false };
  const lines = [header];
  let room = maxLines - 2;
  for (const block of blocks) {
    const part = renderBlock(block, room);
    lines.push(...part);
    room -= part.length;
  }
  return { lines: [...lines, TRUNCATION_MARKER], truncated: true };
}

/** Smallest sections keep their size; the rest split what is left evenly. */
function allocate(sizes, budget) {
  const shares = [];
  let remaining = budget;
  const ascending = sizes.map((size, index) => ({ size, index })).sort((a, b) => a.size - b.size);
  ascending.forEach(({ size, index }, rank) => {
    shares[index] = Math.min(size, Math.floor(remaining / (ascending.length - rank)));
    remaining -= shares[index];
  });
  return shares;
}

/**
 * @param {Section[]} sections
 * @param {number} maxLines
 * @returns {{ text: string, truncated: boolean }}
 */
export function renderBriefing(sections, maxLines) {
  const sizes = sections.map((entry) => renderSection(entry, Infinity).lines.length);
  const shares = allocate(sizes, maxLines - (sections.length - 1));
  const rendered = sections.map((entry, index) => renderSection(entry, shares[index]));
  return { text: rendered.map((part) => part.lines.join('\n')).join('\n\n'), truncated: rendered.some((part) => part.truncated) };
}

function latestPerName(runs) {
  const newest = new Map();
  for (const run of runs) {
    if (!newest.has(run.name) || run.started_at > newest.get(run.name).started_at) newest.set(run.name, run);
  }
  return [...newest.values()];
}

async function failedStepName(client, repoRef, jobId) {
  const response = await client.request('GET', apiPath(`${REPO_PATH}/actions/jobs/{jobId}`, { ...repoRef, jobId }), { okStatuses: [NOT_FOUND] });
  return response.status === NOT_FOUND ? null : response.data.steps?.find((step) => step.conclusion === 'failure')?.name ?? null;
}

async function loadChecks(client, repoRef, sha) {
  const runs = await client.paginate(apiPath(`${REPO_PATH}/commits/{sha}/check-runs`, { ...repoRef, sha }), { itemsKey: 'check_runs' });
  return Promise.all(latestPerName(runs).map(async (run) => {
    const failed = run.conclusion !== null && !PASSING_CONCLUSIONS.includes(run.conclusion);
    return { name: run.name, status: run.status, conclusion: run.conclusion, failedStep: failed ? await failedStepName(client, repoRef, run.id) : null };
  }));
}

async function loadEpic(client, repoRef, facts) {
  const epicRef = facts.type === 'Epic' ? { number: facts.number } : facts.ancestors.find((ancestor) => ancestor.type === 'Epic');
  if (!epicRef) return null;
  if (epicRef.number === facts.number) return { number: facts.number, title: facts.title, author: facts.author, body: facts.body };
  const { data } = await client.request('GET', apiPath(`${REPO_PATH}/issues/{number}`, { ...repoRef, number: epicRef.number }));
  return { number: data.number, title: data.title ?? '', author: data.user?.login ?? '', body: data.body ?? '' };
}

async function loadThreads(client, repoRef, number) {
  const data = await client.graphql(REVIEW_THREADS_QUERY, { ...repoRef, number });
  const threads = data.repository?.pullRequest?.reviewThreads;
  if (!threads) throw new GitHubError(`pull request #${number} not found for the review thread read`);
  return threads;
}

async function loadPullData(client, repoRef, pull) {
  const pullRef = { ...repoRef, number: pull.number };
  return {
    comments: await client.paginate(apiPath(`${REPO_PATH}/issues/{number}/comments`, pullRef)),
    files: await client.paginate(apiPath(`${REPO_PATH}/pulls/{number}/files`, pullRef)),
    checks: await loadChecks(client, repoRef, pull.head.sha),
    threads: await loadThreads(client, repoRef, pull.number),
  };
}

/**
 * @param {import('../lib/github.mjs').GitHubClient} client
 * @param {{ owner: string, repo: string, number: number, session: string|null }} target
 * @param {{ config: object, now?: Date }} context
 * @returns {Promise<{ exitCode: number, result: object }>}   exit 3 when the PR footer names another session
 */
export async function resume(client, { owner, repo, number, session }, { config, now = new Date() }) {
  const repoRef = { owner, repo };
  const facts = await loadIssueFacts(client, { ...repoRef, number }, { config });
  const pullPath = facts.pr ? apiPath(`${REPO_PATH}/pulls/{number}`, { ...repoRef, number: facts.pr.number }) : null;
  const pull = pullPath ? (await client.request('GET', pullPath)).data : null;
  const heldBy = pull ? footerSession(pull.body) : null;
  if (session !== null && heldBy !== null && heldBy !== session) {
    return { exitCode: EXIT_OTHER_SESSION, result: { ok: false, reason: `PR #${pull.number} footer names session ${heldBy}, not ${session}`, number, session: heldBy } };
  }
  const data = { facts, pull, epic: await loadEpic(client, repoRef, facts), ...(pull ? await loadPullData(client, repoRef, pull) : {}) };
  const sections = [
    issueSection(data, config), epicSection(data, config), stateSection(data, config), journalSection({ comments: data.comments ?? [] }, config),
    diffSection({ pull, files: data.files }, config), ciSection(data), threadsSection(data, config), blockerSection(data, { config, now }),
  ];
  const { text, truncated } = renderBriefing(sections, config.limits.resumeLines);
  return { exitCode: 0, result: { ok: true, number, pr: facts.pr?.number ?? null, session: heldBy, truncated, briefing: text } };
}

function parseCliArguments(argv, env) {
  const { values, positionals } = parseArgs({ args: argv, options: { session: { type: 'string' }, json: { type: 'boolean' } }, allowPositionals: true });
  if (positionals.length !== 1 || !/^\d+$/.test(positionals[0])) throw new GitHubError(USAGE);
  const session = values.session ?? env.GROUNDWORK_SESSION ?? null;
  if (session !== null && !isValidSessionId(session)) throw new GitHubError(`invalid session id: ${session}`);
  return { number: Number(positionals[0]), session, json: values.json === true };
}

function report({ exitCode, result }, json) {
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else if (result.ok) process.stdout.write(`${result.briefing}\n`);
  else console.error(result.reason);
  return exitCode;
}

async function main(argv) {
  const { number, session, json } = parseCliArguments(argv, process.env);
  const config = await loadConfig({ root: repoRoot(import.meta.url) });
  const repoRef = process.env.GITHUB_REPOSITORY ? repoFromEnv(process.env) : await currentRepo();
  const outcome = await resume(createClient({ env: process.env }), { ...repoRef, number, session }, { config });
  return report(outcome, json);
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    const reason = error instanceof Error ? error.message.split(/\r?\n/)[0] : 'resume: failed';
    process.exitCode = report({ exitCode: 1, result: { ok: false, reason } }, process.argv.includes('--json'));
  }
}

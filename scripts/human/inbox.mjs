import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GitHubError, apiPath, createClient, currentRepo } from '../lib/github.mjs';
import { loadConfig, repoRoot } from '../lib/config.mjs';
import { deriveStatus, loadIssueFacts } from '../lib/issue-model.mjs';
import { parseSections, stripCommentsAndFences } from '../lib/markdown.mjs';
import { isTrustedAuthor, normalizeLabel, sameLogin, untrustedBlock, validLabels } from '../lib/trust.mjs';
import '../agent/token.mjs'; // exits on an unsupported Node before the script runs

/** @typedef {{ title: string, url: string, detail?: string }} InboxItem */
/** @typedef {{ key: string, heading: string, items: InboxItem[], unreadable?: string }} Section */

const REPO_PATH = '/repos/{owner}/{repo}';
const UNREADABLE_STATUSES = [403, 404];
const APPROVED = 'APPROVED';
const USAGE = 'usage: inbox.mjs [--json]';
const CODEOWNERS_PATH = '.github/CODEOWNERS';
const ALERT_AUTHOR = 'github-actions[bot]';
const RELEASE_LABEL_PREFIX = 'autorelease:';
const APPROVAL_ENVIRONMENTS = ['production', 'admin'];
const ISSUE_BRANCH = /^refs\/heads\/issue\/(\d+)$/;
const CROSS_REFERENCED = 'cross-referenced';
const FORM_CONTEXT_HEADING = /^###[ \t]+Context[ \t]*$/;
const ANY_HEADING = /^#{1,3}[ \t]/;
const EMPTY_INBOX = 'inbox empty: nothing waits on you';

const labelName = (label) => (typeof label === 'string' ? label : label?.name);
const labelNames = (item) => (item.labels ?? []).map(labelName).filter(Boolean);
const hasLabel = (labels, name) => labels.some((label) => normalizeLabel(label) === name);
const sameRepository = (fullName, { owner, repo }) => String(fullName ?? '').toLowerCase() === `${owner}/${repo}`.toLowerCase();

// Titles come from whoever opened the item: an untrusted author's text is fenced, never shown as plain text.
function itemFor(item, { kind, config }) {
  const heading = `#${item.number} ${String(item.title).replace(/\s+/g, ' ')}`;
  const login = item.user?.login ?? '';
  const title = isTrustedAuthor({ login, kind }, config) ? heading : untrustedBlock(heading, login);
  return { title, url: item.html_url };
}
const isReleasePull = (pull) => labelNames(pull).some((label) => normalizeLabel(label).startsWith(RELEASE_LABEL_PREFIX));

/**
 * CODEOWNERS patterns as written (a leading slash anchors, a trailing slash marks a directory).
 * @param {string} codeowners
 * @returns {string[]}
 */
export function parseProtectedPatterns(codeowners) {
  return codeowners.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.split(/\s+/)[0]);
}

// Gitignore-style: a pattern with a slash before its last character is anchored to the root, otherwise it
// matches a path segment at any depth. A match on a directory covers every file below it.
function matchesPattern(parts, pattern) {
  const directoryOnly = pattern.endsWith('/');
  const glob = pattern.replace(/^\//, '').replace(/\/$/, '');
  const anchored = pattern.replace(/\/$/, '').includes('/');
  return parts.some((_, index) => {
    const isDirectory = index < parts.length - 1;
    if (directoryOnly && !isDirectory) return false;
    return path.posix.matchesGlob(anchored ? parts.slice(0, index + 1).join('/') : parts[index], glob);
  });
}

export function isProtectedPath(file, patterns) {
  const parts = file.split('/');
  return patterns.some((pattern) => matchesPattern(parts, pattern));
}

async function proposedEpics({ openIssues, client, repoRef, config }) {
  const items = [];
  for (const epic of (await openIssues()).filter((issue) => issue.type?.name === 'Epic')) {
    const timeline = await client.paginate(apiPath(`${REPO_PATH}/issues/{number}/timeline`, { ...repoRef, number: epic.number }));
    if (!hasLabel(validLabels({ labels: labelNames(epic), timeline }, config), 'accepted')) items.push(itemFor(epic, { kind: 'issue', config }));
  }
  return items;
}

async function needsDecision({ openIssues, openPulls, config }) {
  const issues = (await openIssues()).filter((issue) => hasLabel(labelNames(issue), 'needs-decision'));
  const pulls = (await openPulls()).filter((pull) => hasLabel(labelNames(pull), 'needs-decision'));
  const pullItems = pulls.map((pull) => ({ ...itemFor(pull, { kind: 'pull-request', config }), detail: 'PR' }));
  return [...issues.map((issue) => itemFor(issue, { kind: 'issue', config })), ...pullItems];
}

async function isApprovedOnHead(pull, { client, repoRef, config }) {
  const reviews = await client.paginate(apiPath(`${REPO_PATH}/pulls/{number}/reviews`, { ...repoRef, number: pull.number }));
  return reviews.some((review) => review.state === APPROVED && review.commit_id === pull.head?.sha
    && sameLogin(review.user?.login, config.accounts.owner));
}

async function touchesProtectedPath(pull, { client, repoRef }, patterns) {
  const files = await client.paginate(apiPath(`${REPO_PATH}/pulls/{number}/files`, { ...repoRef, number: pull.number }));
  return files.some(({ filename }) => isProtectedPath(filename, patterns));
}

// GitHub reads CODEOWNERS from the base branch; this reads the working copy.
async function protectedPulls(context) {
  const { openPulls, repoRef, root, config } = context;
  const patterns = parseProtectedPatterns(await readFile(path.join(root, CODEOWNERS_PATH), 'utf8'));
  const items = [];
  for (const pull of await openPulls()) {
    if (pull.draft || isReleasePull(pull) || !sameRepository(pull.head?.repo?.full_name, repoRef)) continue;
    if (!await touchesProtectedPath(pull, context, patterns)) continue;
    if (!await isApprovedOnHead(pull, context)) items.push(itemFor(pull, { kind: 'pull-request', config }));
  }
  return items;
}

async function releasePulls({ openPulls, config }) {
  return (await openPulls()).filter(isReleasePull).map((pull) => itemFor(pull, { kind: 'pull-request', config }));
}

async function pendingApprovals({ client, repoRef }) {
  const query = { status: 'waiting' };
  const runs = await client.paginate(apiPath(`${REPO_PATH}/actions/runs`, repoRef), { query, itemsKey: 'workflow_runs' });
  const items = [];
  for (const run of runs) {
    const pending = await client.paginate(apiPath(`${REPO_PATH}/actions/runs/{id}/pending_deployments`, { ...repoRef, id: run.id }));
    const environments = pending.map((entry) => entry.environment?.name).filter((name) => APPROVAL_ENVIRONMENTS.includes(name));
    if (environments.length > 0) items.push({ title: `${run.name} #${run.id}`, url: run.html_url, detail: environments.join(', ') });
  }
  return items;
}

async function alertIssues({ openIssues, config }) {
  const alerts = (await openIssues()).filter((issue) => sameLogin(issue.user?.login, ALERT_AUTHOR));
  return alerts.map((issue) => itemFor(issue, { kind: 'issue', config }));
}

async function orphanedClaims({ openIssues, openPulls, client, repoRef, config }) {
  const refs = await client.paginate(apiPath(`${REPO_PATH}/git/matching-refs/heads/issue/`, repoRef));
  const issuesByNumber = new Map((await openIssues()).map((issue) => [issue.number, issue]));
  const withOpenPull = new Set((await openPulls()).map((pull) => pull.head?.ref));
  const claimed = refs.map(({ ref }) => ISSUE_BRANCH.exec(ref)?.[1]).filter(Boolean).map(Number)
    .filter((number) => issuesByNumber.has(number) && !withOpenPull.has(`issue/${number}`));
  const items = [];
  for (const number of claimed) {
    const facts = await loadIssueFacts(client, { ...repoRef, number }, { config });
    if (deriveStatus(facts, { config, now: new Date() }).status !== 'orphaned') continue;
    const claim = itemFor(issuesByNumber.get(number), { kind: 'issue', config });
    items.push({ ...claim, detail: `delete branch issue/${number}` });
  }
  return items;
}

// Web-form bodies (4.3) use `### Context`; parseSections only reads `##`, so that fallback scans the stripped text itself.
function contextSection(body) {
  const { byName } = parseSections(body);
  if (byName.Context !== undefined) return byName.Context;
  const lines = stripCommentsAndFences(body).split('\n');
  const start = lines.findIndex((line) => FORM_CONTEXT_HEADING.test(line));
  if (start === -1) return '';
  const length = lines.slice(start + 1).findIndex((line) => ANY_HEADING.test(line));
  return lines.slice(start + 1, length === -1 ? undefined : start + 1 + length).join('\n');
}

const namesReport = (body, number) => new RegExp(`Reported in #${number}(?!\\d)`).test(contextSection(String(body ?? '')));

function isLinkedTask(source, { number, repoRef, config }) {
  if (source.pull_request || !sameRepository(source.repository?.full_name, repoRef)) return false;
  if (!isTrustedAuthor({ login: source.user?.login ?? '', kind: 'issue' }, config)) return false;
  return namesReport(source.body, number);
}

async function hasLinkedTask(report, { client, repoRef, config }) {
  const timeline = await client.paginate(apiPath(`${REPO_PATH}/issues/{number}/timeline`, { ...repoRef, number: report.number }));
  return timeline.some((event) => event.event === CROSS_REFERENCED && event.source?.issue
    && isLinkedTask(event.source.issue, { number: report.number, repoRef, config }));
}

async function untrustedReports({ openIssues, client, repoRef, config }) {
  const reports = (await openIssues()).filter((issue) => !isTrustedAuthor({ login: issue.user?.login ?? '', kind: 'issue' }, config)
    && !sameLogin(issue.user?.login, ALERT_AUTHOR));
  const items = [];
  for (const report of reports) {
    if (await hasLinkedTask(report, { client, repoRef, config })) continue;
    items.push({ ...itemFor(report, { kind: 'issue', config }), detail: `opened ${String(report.created_at).slice(0, 10)}` });
  }
  return items;
}

const SECTIONS = [
  { key: 'proposed-epics', heading: 'Epics to accept', load: proposedEpics },
  { key: 'needs-decision', heading: 'Needs decision', load: needsDecision },
  { key: 'protected-pulls', heading: 'Protected-path PRs awaiting you', load: protectedPulls },
  { key: 'release-pull', heading: 'Release PR', load: releasePulls },
  { key: 'pending-approvals', heading: 'Pending production and admin approvals', load: pendingApprovals },
  { key: 'alert-issues', heading: 'Alert issues', load: alertIssues },
  { key: 'orphaned-claims', heading: 'Orphaned claims', load: orphanedClaims },
  { key: 'untrusted-reports', heading: 'Untrusted reports to triage', load: untrustedReports },
];

function memoize(load) {
  let pending = null;
  return () => {
    pending ??= load();
    return pending;
  };
}

// Only 403 and 404 mean "this token cannot read it"; any other failure is a real error and stops the run.
async function loadSection({ key, heading, load }, context) {
  try {
    return { key, heading, items: await load(context) };
  } catch (error) {
    if (!(error instanceof GitHubError) || !UNREADABLE_STATUSES.includes(error.status)) throw error;
    return { key, heading, items: [], unreadable: error.message.split(/\r?\n/)[0] };
  }
}

/**
 * Each section loads on its own: a read the token cannot make marks that section unreadable and never drops it.
 * @param {{ client: import('../lib/github.mjs').GitHubClient, repoRef: { owner: string, repo: string }, config: object, root: string }} context
 * @returns {Promise<Section[]>}
 */
export async function collectInbox({ client, repoRef, config, root }) {
  const listOpen = (resource) => client.paginate(apiPath(`${REPO_PATH}/${resource}`, repoRef), { query: { state: 'open' } });
  const openIssues = memoize(async () => (await listOpen('issues')).filter((issue) => !issue.pull_request));
  const openPulls = memoize(() => listOpen('pulls'));
  const context = { client, repoRef, config, root, openIssues, openPulls };
  const sections = [];
  for (const section of SECTIONS) sections.push(await loadSection(section, context));
  return sections;
}

const isEmpty = (sections) => sections.every((section) => section.items.length === 0 && !section.unreadable);

const formatItem = ({ title, url, detail }) => `  ${title}${detail ? ` [${detail}]` : ''}\n    ${url}`;

function formatSection({ heading, items, unreadable }) {
  if (unreadable) return [`${heading}: unreadable (${unreadable})`];
  return [`${heading} (${items.length})`, ...items.map(formatItem)];
}

/**
 * @param {Section[]} sections
 * @param {{ json: boolean }} options
 * @returns {string}
 */
export function formatOutput(sections, { json }) {
  if (json) return JSON.stringify({ ok: true, empty: isEmpty(sections), sections });
  if (isEmpty(sections)) return EMPTY_INBOX;
  return sections.filter((section) => section.items.length > 0 || section.unreadable).flatMap(formatSection).join('\n');
}

export function parseArgs(argv) {
  if (argv.some((arg) => arg !== '--json')) throw new GitHubError(USAGE);
  return { json: argv.includes('--json') };
}

async function main(argv) {
  const { json } = parseArgs(argv);
  const root = repoRoot(import.meta.url);
  const config = await loadConfig({ root });
  const client = createClient({ env: process.env });
  const sections = await collectInbox({ client, repoRef: await currentRepo(), config, root });
  console.log(formatOutput(sections, { json }));
}

if (import.meta.main) {
  const json = process.argv.slice(2).includes('--json');
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const reason = error instanceof Error ? error.message.split(/\r?\n/)[0] : 'inbox: failed';
    if (json) console.log(JSON.stringify({ ok: false, reason }));
    console.error(reason);
    process.exitCode = 1;
  }
}

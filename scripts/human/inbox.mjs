import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GitHubError, apiPath, createClient, currentRepo } from '../lib/github.mjs';
import { loadConfig, repoRoot } from '../lib/config.mjs';
import { deriveStatus, loadIssueFacts } from '../lib/issue-model.mjs';
import { normalizeLabel, sameLogin, validLabels } from '../lib/trust.mjs';
import '../agent/token.mjs'; // exits on an unsupported Node before the script runs

/** @typedef {{ title: string, url: string, detail?: string }} InboxItem */
/** @typedef {{ key: string, heading: string, items: InboxItem[], unreadable?: string }} Section */

const REPO_PATH = '/repos/{owner}/{repo}';
const USAGE = 'usage: inbox.mjs [--json]';
const CODEOWNERS_PATH = '.github/CODEOWNERS';
const ALERT_AUTHOR = 'github-actions[bot]';
const RELEASE_LABEL_PREFIX = 'autorelease:';
const APPROVAL_ENVIRONMENTS = ['production', 'admin'];
const ISSUE_BRANCH = /^refs\/heads\/issue\/(\d+)$/;
const EMPTY_INBOX = 'inbox empty: nothing waits on you';

const labelName = (label) => (typeof label === 'string' ? label : label?.name);
const labelNames = (item) => (item.labels ?? []).map(labelName).filter(Boolean);
const hasLabel = (labels, name) => labels.some((label) => normalizeLabel(label) === name);
const issueItem = (issue) => ({ title: `#${issue.number} ${issue.title}`, url: issue.html_url });
const isReleasePull = (pull) => labelNames(pull).some((label) => normalizeLabel(label).startsWith(RELEASE_LABEL_PREFIX));

/**
 * Protected path patterns from CODEOWNERS, without the leading slash. A trailing slash marks a directory prefix.
 * @param {string} codeowners
 * @returns {string[]}
 */
export function parseProtectedPatterns(codeowners) {
  return codeowners.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.split(/\s+/)[0].replace(/^\//, ''));
}

export function isProtectedPath(file, patterns) {
  return patterns.some((pattern) => (pattern.endsWith('/') ? file.startsWith(pattern) : path.posix.matchesGlob(file, pattern)));
}

async function proposedEpics({ openIssues, client, repoRef, config }) {
  const items = [];
  for (const epic of (await openIssues()).filter((issue) => issue.type?.name === 'Epic')) {
    const timeline = await client.paginate(apiPath(`${REPO_PATH}/issues/{number}/timeline`, { ...repoRef, number: epic.number }));
    if (!hasLabel(validLabels({ labels: labelNames(epic), timeline }, config), 'accepted')) items.push(issueItem(epic));
  }
  return items;
}

async function needsDecision({ openIssues, openPulls }) {
  const issues = (await openIssues()).filter((issue) => hasLabel(labelNames(issue), 'needs-decision'));
  const pulls = (await openPulls()).filter((pull) => hasLabel(labelNames(pull), 'needs-decision'));
  return [...issues.map(issueItem), ...pulls.map((pull) => ({ ...issueItem(pull), detail: 'PR' }))];
}

async function protectedPulls({ openPulls, client, repoRef, root }) {
  const patterns = parseProtectedPatterns(await readFile(path.join(root, CODEOWNERS_PATH), 'utf8'));
  const items = [];
  for (const pull of (await openPulls()).filter((candidate) => !candidate.draft && !isReleasePull(candidate))) {
    const files = await client.paginate(apiPath(`${REPO_PATH}/pulls/{number}/files`, { ...repoRef, number: pull.number }));
    if (files.some(({ filename }) => isProtectedPath(filename, patterns))) items.push(issueItem(pull));
  }
  return items;
}

async function releasePulls({ openPulls }) {
  return (await openPulls()).filter(isReleasePull).map(issueItem);
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

async function alertIssues({ openIssues }) {
  return (await openIssues()).filter((issue) => sameLogin(issue.user?.login, ALERT_AUTHOR)).map(issueItem);
}

async function orphanedClaims({ openIssues, client, repoRef, config }) {
  const refs = await client.paginate(apiPath(`${REPO_PATH}/git/matching-refs/heads/issue/`, repoRef));
  const openNumbers = new Set((await openIssues()).map((issue) => issue.number));
  const claimed = refs.map(({ ref }) => ISSUE_BRANCH.exec(ref)?.[1]).filter(Boolean).map(Number).filter((number) => openNumbers.has(number));
  const items = [];
  for (const number of claimed) {
    const facts = await loadIssueFacts(client, { ...repoRef, number }, { config });
    if (deriveStatus(facts, { config, now: new Date() }).status !== 'orphaned') continue;
    const url = `https://github.com/${repoRef.owner}/${repoRef.repo}/issues/${number}`;
    items.push({ title: `#${number} ${facts.title}`, url, detail: `delete branch issue/${number}` });
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
];

function memoize(load) {
  let pending = null;
  return () => {
    pending ??= load();
    return pending;
  };
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
  const sections = [];
  for (const { key, heading, load } of SECTIONS) {
    try {
      sections.push({ key, heading, items: await load({ client, repoRef, config, root, openIssues, openPulls }) });
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      sections.push({ key, heading, items: [], unreadable: error.message.split(/\r?\n/)[0] });
    }
  }
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

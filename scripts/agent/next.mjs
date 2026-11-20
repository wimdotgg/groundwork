import { GitHubError, apiPath, createClient, currentRepo } from '../lib/github.mjs';
import { loadConfig, repoRoot } from '../lib/config.mjs';
import { deriveStatus, isHotfixLane, leaseState, loadIssueFacts, validateIssueBody } from '../lib/issue-model.mjs';
import { isTrustedAuthor, normalizeLabel } from '../lib/trust.mjs';

/** @typedef {import('../lib/issue-model.mjs').IssueFacts} IssueFacts */
/** @typedef {{ kind: 'takeover'|'fresh', number: number, pr: number|null, epic: number|null, title: string, reason: string }} Pick */
/** @typedef {{ number: number, code: string, reason: string }} Skip */
/** @typedef {{ pick: Pick, key: number[] }} Ranked */

const REPO_PATH = '/repos/{owner}/{repo}';
const USAGE = 'usage: next.mjs [--json]';
const NO_PRIORITY = 4;
const PRIORITY_LABEL = /^priority:p([0-3])$/;
const TASK_SIZES = ['size:s', 'size:m'];

const hasLabel = (labels, name) => labels.some((label) => normalizeLabel(label) === name);

function priorityRank(validLabels) {
  const ranks = validLabels.map((label) => PRIORITY_LABEL.exec(normalizeLabel(label))).filter(Boolean).map((match) => Number(match[1]));
  return ranks.length === 0 ? NO_PRIORITY : Math.min(...ranks);
}

async function listIssues(client, repoRef, query) {
  const issues = await client.paginate(apiPath(`${REPO_PATH}/issues`, repoRef), { query: { state: 'open', ...query } });
  return issues.filter((issue) => !issue.pull_request);
}

// Depth-first, so the counter follows the order of sub-issues under the parent (6.2). A child that has
// sub-issues of its own is a grouping issue: it is walked, never offered as a task.
async function collectChildren({ client, repoRef, config }, parent, depth, state) {
  const children = await client.paginate(apiPath(`${REPO_PATH}/issues/{number}/sub_issues`, { ...repoRef, number: parent }));
  for (const child of children) {
    if (child.state === 'closed') continue;
    const isGrouping = child.sub_issues_summary?.total > 0 && child.type?.name !== 'Epic';
    if (isGrouping && depth + 1 < config.limits.hierarchyDepthWithIntermediate) {
      await collectChildren({ client, repoRef, config }, child.number, depth + 1, state);
      continue;
    }
    state.position += 1;
    state.found.push({ number: child.number, epic: state.epic, position: state.position });
  }
}

/** Open sub-issues of every open Epic, then open Bugs labelled `priority:p0` that no epic walk reached. */
async function findCandidates(context) {
  const { client, repoRef, config } = context;
  const candidates = [];
  const epicRanks = new Map();
  for (const epic of await listIssues(client, repoRef, { type: 'Epic' })) {
    const epicFacts = await loadIssueFacts(client, { ...repoRef, number: epic.number }, { config });
    epicRanks.set(epic.number, priorityRank(epicFacts.validLabels));
    const state = { epic: epic.number, position: 0, found: candidates };
    await collectChildren(context, epic.number, 1, state);
  }
  const seen = new Set(candidates.map((candidate) => candidate.number));
  for (const bug of await listIssues(client, repoRef, { type: 'Bug', labels: 'priority:p0' })) {
    if (!seen.has(bug.number)) candidates.push({ number: bug.number, epic: null, position: bug.number });
  }
  return { candidates, epicRanks };
}

function skipReasonForFresh(facts) {
  const body = validateIssueBody({ type: facts.type, body: facts.body });
  if (hasLabel(facts.validLabels, 'needs-format')) return { code: 'needs-format', reason: 'needs-format label' };
  if (!body.ok) return { code: 'needs-format', reason: body.errors[0] };
  const sized = TASK_SIZES.some((size) => hasLabel(facts.validLabels, size)) && !hasLabel(facts.validLabels, 'size:l');
  if (!sized) return { code: 'size', reason: 'needs exactly size:S or size:M' };
  return null;
}

function takeoverReason(facts, { config, now }) {
  const { pr } = facts;
  if (!pr || pr.state !== 'open' || !pr.draft) return null;
  const lease = leaseState(pr, { config, now, claimCommentAt: facts.claimCommentAt, claimCommitAt: facts.claimCommitAt });
  if (lease.released) return `PR #${pr.number} carries the released marker`;
  return lease.expired ? `lease on PR #${pr.number} expired` : null;
}

/**
 * @param {{ facts: IssueFacts, epic: number|null, position: number, epicRank: number }} candidate
 * @param {{ config: object, now: Date }} context
 * @returns {{ ranked: Ranked }|{ skipEntry: Skip }}
 */
export function classify({ facts, epic, position, epicRank }, context) {
  const skip = (code, reason) => ({ skipEntry: { number: facts.number, code, reason } });
  if (facts.type === 'Epic') return skip('epic', 'epics are planned, never claimed');
  if (!isTrustedAuthor({ login: facts.author, kind: 'issue' }, context.config)) {
    return skip('untrusted-author', `${facts.author} is not a trusted author`);
  }
  const { status, reason } = deriveStatus(facts, context);
  const takeover = status === 'claimed' ? takeoverReason(facts, context) : null;
  const hotfix = isHotfixLane(facts, context.config);
  const pick = { number: facts.number, pr: facts.pr?.number ?? null, epic, title: facts.title };
  const key = [takeover ? 0 : 1, hotfix ? 0 : 1, hotfix ? 0 : epicRank, epic ?? 0, position];
  if (takeover) return { ranked: { pick: { ...pick, kind: 'takeover', reason: takeover }, key } };
  if (status !== 'ready') return skip(status, reason);
  const unready = skipReasonForFresh(facts);
  if (unready) return skip(unready.code, unready.reason);
  return { ranked: { pick: { ...pick, kind: 'fresh', reason }, key } };
}

function compareKeys(a, b) {
  const index = a.key.findIndex((part, position) => part !== b.key[position]);
  return index === -1 ? 0 : a.key[index] - b.key[index];
}

/**
 * Seam for hotspot exclusion (#84): filter `ranked` here and add `hotspot` skips before the first entry is taken.
 * @param {Ranked[]} ranked
 * @param {Skip[]} skipped
 * @returns {{ next: Pick|null, skipped: Skip[] }}
 */
export function chooseNext(ranked, skipped) {
  return { next: ranked[0]?.pick ?? null, skipped };
}

/**
 * @param {{ client: import('../lib/github.mjs').GitHubClient, repoRef: { owner: string, repo: string },
 *   config: object, now: Date }} context
 * @returns {Promise<{ ranked: Ranked[], skipped: Skip[] }>}
 */
export async function rankCandidates(context) {
  const { candidates, epicRanks } = await findCandidates(context);
  const ranked = [];
  const skipped = [];
  for (const candidate of candidates) {
    const facts = await loadIssueFacts(context.client, { ...context.repoRef, number: candidate.number }, { config: context.config });
    const epicRank = candidate.epic === null ? NO_PRIORITY : epicRanks.get(candidate.epic);
    const result = classify({ facts, epic: candidate.epic, position: candidate.position, epicRank }, context);
    if (result.ranked) ranked.push(result.ranked);
    else skipped.push(result.skipEntry);
  }
  return { ranked: ranked.sort(compareKeys), skipped };
}

/**
 * @param {{ next: Pick|null, skipped: Skip[] }} result
 * @param {{ json: boolean }} options
 * @returns {string}
 */
export function formatOutput({ next, skipped }, { json }) {
  if (json) return JSON.stringify({ ok: true, next, skipped });
  const lines = next
    ? [`${next.kind} #${next.number}${next.pr ? ` (PR #${next.pr})` : ''}: ${next.title} [${next.reason}]`]
    : ['nothing ready'];
  return [...lines, ...skipped.map((entry) => `skipped #${entry.number} ${entry.code}: ${entry.reason}`)].join('\n');
}

export function parseArgs(argv) {
  if (argv.some((arg) => arg !== '--json')) throw new GitHubError(USAGE);
  return { json: argv.includes('--json') };
}

async function main(argv) {
  const { json } = parseArgs(argv);
  const config = await loadConfig({ root: repoRoot(import.meta.url) });
  const client = createClient({ env: process.env });
  const { ranked, skipped } = await rankCandidates({ client, repoRef: await currentRepo(), config, now: new Date() });
  console.log(formatOutput(chooseNext(ranked, skipped), { json }));
}

if (import.meta.main) {
  const json = process.argv.slice(2).includes('--json');
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const reason = error instanceof Error ? error.message.split(/\r?\n/)[0] : 'next: failed';
    if (json) console.log(JSON.stringify({ ok: false, reason }));
    console.error(reason);
    process.exitCode = 1;
  }
}

import { GitHubError, apiPath, createClient, currentRepo } from '../lib/github.mjs';
import { loadConfig, repoRoot } from '../lib/config.mjs';
import {
  deriveStatus, isHotfixLane, leaseState, loadIssueFacts, normalizeIssueBody, validateIssueBody,
} from '../lib/issue-model.mjs';
import { parseSections } from '../lib/markdown.mjs';
import { isTrustedAuthor, normalizeLabel, validLabels } from '../lib/trust.mjs';

/** @typedef {import('../lib/issue-model.mjs').IssueFacts} IssueFacts */
/** @typedef {{ kind: 'takeover'|'fresh', number: number, pr: number|null, epic: number|null, title: string, reason: string }} Pick */
/** @typedef {{ number: number, code: string, reason: string }} Skip */
/** @typedef {{ pick: Pick, key: number[], touches: string }} Ranked   touches: the `## Touches` text, for hotspot exclusion */
/** @typedef {{ number: number, epic: number|null, position: number, skipEntry?: Skip }} Candidate */

const REPO_PATH = '/repos/{owner}/{repo}';
const USAGE = 'usage: next.mjs [--json]';
const NO_PRIORITY = 4;
const PRIORITY_LABEL = /^priority:p([0-3])$/;
const TASK_SIZES = ['size:s', 'size:m'];
const LOAD_CONCURRENCY = 4;

const hasLabel = (labels, name) => labels.some((label) => normalizeLabel(label) === name);
const labelName = (label) => (typeof label === 'string' ? label : label?.name);

function priorityRank(labels) {
  const ranks = labels.map((label) => PRIORITY_LABEL.exec(normalizeLabel(label))).filter(Boolean).map((match) => Number(match[1]));
  return ranks.length === 0 ? NO_PRIORITY : Math.min(...ranks);
}

function ineligibleReason({ type, author }, config) {
  if (type === 'Epic') return { code: 'epic', reason: 'epics are planned, never claimed' };
  if (isTrustedAuthor({ login: author, kind: 'issue' }, config)) return null;
  return { code: 'untrusted-author', reason: `${author} is not a trusted author` };
}

async function listIssues(client, repoRef, query) {
  const issues = await client.paginate(apiPath(`${REPO_PATH}/issues`, repoRef), { query: { state: 'open', ...query } });
  return issues.filter((issue) => !issue.pull_request);
}

// Epics and untrusted authors are skipped from the list payload, so their facts are never loaded.
function candidateFrom(issue, { epic, position }, config) {
  const ineligible = ineligibleReason({ type: issue.type?.name, author: issue.user?.login }, config);
  const candidate = { number: issue.number, epic, position };
  return ineligible ? { ...candidate, skipEntry: { number: issue.number, ...ineligible } } : candidate;
}

// Depth-first, so the counter follows the order of sub-issues under the parent (6.2). An issue that has
// sub-issues is a grouping issue: it is walked while the depth limit allows, never offered as a task.
async function collectChildren({ client, repoRef, config }, { parent, depth }, state) {
  const children = await client.paginate(apiPath(`${REPO_PATH}/issues/{number}/sub_issues`, { ...repoRef, number: parent }));
  for (const child of children) {
    if (child.state === 'closed') continue;
    const isGrouping = child.sub_issues_summary?.total > 0 && child.type?.name !== 'Epic';
    if (isGrouping && depth + 1 < config.limits.hierarchyDepthWithIntermediate) {
      await collectChildren({ client, repoRef, config }, { parent: child.number, depth: depth + 1 }, state);
      continue;
    }
    state.position += 1;
    if (isGrouping) {
      const skipEntry = { number: child.number, code: 'needs-format', reason: 'sub-issues below the depth limit' };
      state.found.push({ number: child.number, epic: state.epic, position: state.position, skipEntry });
      continue;
    }
    state.found.push(candidateFrom(child, { epic: state.epic, position: state.position }, config));
  }
}

async function epicPriority({ client, repoRef, config }, epic) {
  const timeline = await client.paginate(apiPath(`${REPO_PATH}/issues/{number}/timeline`, { ...repoRef, number: epic.number }));
  const labels = (epic.labels ?? []).map(labelName).filter(Boolean);
  return priorityRank(validLabels({ labels, timeline }, config));
}

/** Open sub-issues of every open Epic, then open Bugs labelled `priority:p0` that no epic walk reached. */
async function findCandidates(context) {
  const { client, repoRef, config } = context;
  const candidates = [];
  const epicRanks = new Map();
  for (const epic of await listIssues(client, repoRef, { type: 'Epic' })) {
    epicRanks.set(epic.number, await epicPriority(context, epic));
    await collectChildren(context, { parent: epic.number, depth: 1 }, { epic: epic.number, position: 0, found: candidates });
  }
  const seen = new Set(candidates.map((candidate) => candidate.number));
  for (const bug of await listIssues(client, repoRef, { type: 'Bug', labels: 'priority:p0' })) {
    if (!seen.has(bug.number)) candidates.push(candidateFrom(bug, { epic: null, position: bug.number }, config));
  }
  return { candidates, epicRanks };
}

function skipReasonForFresh(facts) {
  const body = validateIssueBody({ type: facts.type, body: facts.body });
  if (hasLabel(facts.labels, 'needs-format')) return { code: 'needs-format', reason: 'needs-format label' };
  if (!body.ok) return { code: 'needs-format', reason: body.errors[0] };
  const sizeCount = TASK_SIZES.filter((size) => hasLabel(facts.validLabels, size)).length;
  if (sizeCount !== 1 || hasLabel(facts.validLabels, 'size:l')) return { code: 'size', reason: 'needs exactly one of size:S or size:M' };
  return null;
}

function takeoverReason(facts, { config, now }) {
  const { pr } = facts;
  if (!pr || pr.state !== 'open' || !pr.draft) return null;
  const lease = leaseState(pr, { config, now, claimCommentAt: facts.claimCommentAt, claimCommitAt: facts.claimCommitAt });
  if (lease.released) return `PR #${pr.number} carries the released marker`;
  return lease.expired ? `lease on PR #${pr.number} expired` : null;
}

const withoutClaim = (facts) => ({ ...facts, branch: { exists: false, sha: null }, pr: null });

/**
 * @param {{ facts: IssueFacts, epic: number|null, position: number, epicRank: number }} candidate
 * @param {{ config: object, now: Date }} context
 * @returns {{ ranked: Ranked }|{ skipEntry: Skip }}
 */
export function classify({ facts, epic, position, epicRank }, context) {
  const skip = (code, reason) => ({ skipEntry: { number: facts.number, code, reason } });
  const ineligible = ineligibleReason({ type: facts.type, author: facts.author }, context.config);
  if (ineligible) return skip(ineligible.code, ineligible.reason);
  const hotfix = isHotfixLane(facts, context.config);
  if (epic === null && !hotfix) return skip('proposed', 'p0 Bug with a parent outside an open epic');
  const { status, reason } = deriveStatus(facts, context);
  const takeover = status === 'claimed' ? takeoverReason(facts, context) : null;
  if (status !== 'ready' && !takeover) return skip(status, reason);
  // A takeover must still meet everything except the claim itself.
  const unclaimed = takeover ? deriveStatus(withoutClaim(facts), context) : { status: 'ready' };
  if (unclaimed.status !== 'ready') return skip(unclaimed.status, unclaimed.reason);
  const unready = takeover ? null : skipReasonForFresh(facts);
  if (unready) return skip(unready.code, unready.reason);
  const pick = {
    kind: takeover ? 'takeover' : 'fresh', number: facts.number, pr: facts.pr?.number ?? null, epic, title: facts.title,
    reason: takeover ?? reason,
  };
  const key = [takeover ? 0 : 1, hotfix ? 0 : 1, hotfix ? 0 : epicRank, epic ?? 0, position];
  const touches = parseSections(normalizeIssueBody(facts.type, facts.body)).byName.Touches ?? '';
  return { ranked: { pick, key, touches } };
}

function compareKeys(a, b) {
  const index = a.key.findIndex((part, position) => part !== b.key[position]);
  return index === -1 ? 0 : a.key[index] - b.key[index];
}

/**
 * Seam for hotspot exclusion (#84): filter `ranked` here and add `hotspot` skips before the first entry is taken;
 * each entry carries its `## Touches` text.
 * @param {Ranked[]} ranked
 * @param {Skip[]} skipped
 * @returns {{ next: Pick|null, skipped: Skip[] }}
 */
export function chooseNext(ranked, skipped) {
  return { next: ranked[0]?.pick ?? null, skipped };
}

async function classifyCandidate(context, epicRanks, candidate) {
  if (candidate.skipEntry) return { skipEntry: candidate.skipEntry };
  const { client, repoRef, config } = context;
  const facts = await loadIssueFacts(client, { ...repoRef, number: candidate.number }, { config });
  const epicRank = candidate.epic === null ? NO_PRIORITY : epicRanks.get(candidate.epic);
  return classify({ facts, epic: candidate.epic, position: candidate.position, epicRank }, context);
}

/**
 * @param {{ client: import('../lib/github.mjs').GitHubClient, repoRef: { owner: string, repo: string },
 *   config: object, now: Date }} context
 * @returns {Promise<{ ranked: Ranked[], skipped: Skip[] }>}
 */
export async function rankCandidates(context) {
  const { candidates, epicRanks } = await findCandidates(context);
  const results = [];
  for (let start = 0; start < candidates.length; start += LOAD_CONCURRENCY) {
    const chunk = candidates.slice(start, start + LOAD_CONCURRENCY);
    results.push(...await Promise.all(chunk.map((candidate) => classifyCandidate(context, epicRanks, candidate))));
  }
  return {
    ranked: results.filter((result) => result.ranked).map((result) => result.ranked).sort(compareKeys),
    skipped: results.filter((result) => result.skipEntry).map((result) => result.skipEntry),
  };
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

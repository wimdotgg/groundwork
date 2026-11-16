import { criterionIds, parseSections, stripCommentsAndFences } from './markdown.mjs';
import { normalizeLabel } from './trust.mjs';

/** @typedef {'Epic'|'Feature'|'Bug'|'Chore'|'Spike'} IssueType */
/** @typedef {'done'|'needs-decision'|'queued'|'in-review'|'claimed'|'orphaned'|'proposed'|'blocked'|'ready'} Status */
/** @typedef {{ number: number, state: 'open'|'closed', merged: boolean, draft: boolean, inMergeQueue: boolean,
 *   released: boolean, headRepo: string, createdAt: string, lastAgentCommentAt: string|null }} PullFacts */
/** @typedef {{ number: number, title: string, type: IssueType|null, state: 'open'|'closed', stateReason: string|null,
 *   author: string, body: string, labels: string[], validLabels: string[],
 *   ancestors: Array<{ number: number, type: IssueType|null, validLabels: string[] }>,
 *   blockedBy: Array<{ number: number, state: 'open'|'closed' }>,
 *   branch: { exists: boolean, sha: string|null }, claimCommentAt: string|null, claimCommitAt: string|null, pr: PullFacts|null }} IssueFacts
 *   ancestors are nearest first.
 *   claimCommentAt: server created_at of the newest issue comment by the agent account carrying marker `claim` (6.3)
 *   claimCommitAt: committer date of the ref head when its message matches the claim commit format `chore(claim): #N [session <id>]`, else null */

export const ISSUE_TYPES = ['Epic', 'Feature', 'Bug', 'Chore', 'Spike'];

const TASK_HEADINGS = [
  'Outcome', 'Serves', 'Scope', 'Touches', 'Acceptance criteria', 'Verification plan', 'Risk', 'Context',
];

/** @type {Record<IssueType, string[]>} */
export const REQUIRED_HEADINGS = {
  Epic: ['Goal', 'Success criteria', 'Constraints', 'Plan', 'Decisions', 'Open questions'],
  Feature: TASK_HEADINGS,
  Bug: [...TASK_HEADINGS, 'Reproduction', 'Expected vs actual'],
  Chore: TASK_HEADINGS,
  Spike: ['Question', 'Serves', 'Timebox', 'Output'],
};

/** @type {Record<IssueType, { types: string[], scope: string|null }>} */
export const TITLE_TYPES = {
  Epic: { types: [], scope: null },
  Feature: { types: ['feat'], scope: null },
  Bug: { types: ['fix'], scope: null },
  Chore: { types: ['build', 'chore', 'ci', 'docs', 'refactor', 'style', 'test', 'perf', 'revert'], scope: null },
  Spike: { types: ['docs'], scope: 'spike' },
};

const COMMIT_TYPES = ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test'];
const TITLE_PATTERN = new RegExp(`^(${COMMIT_TYPES.join('|')})(?:\\(([^()\\s][^()]*)\\))?(!)?:[ \\t]+(\\S.*)$`);
const NO_RESPONSE = '_No response_';
const CRITERION_PREFIX = { Epic: 'E', Feature: 'AC', Bug: 'AC', Chore: 'AC' };
const CRITERIA_HEADING = {
  Epic: 'Success criteria', Feature: 'Acceptance criteria', Bug: 'Acceptance criteria', Chore: 'Acceptance criteria',
};
const EPIC_ID = /^E\d+$/;
const MS_PER_MINUTE = 60_000;

/**
 * @param {string} title
 * @returns {{ type: string, scope: string|null, breaking: boolean, summary: string }|null}
 */
export function parseConventionalTitle(title) {
  const match = TITLE_PATTERN.exec(String(title ?? '').trim());
  if (!match) return null;
  return { type: match[1], scope: match[2] ?? null, breaking: match[3] === '!', summary: match[4].trim() };
}

// Web forms render answers as `### <label>`; treat them as level-2 when the body has no level-2 heading.
function normalizeHeadingLevel(body) {
  const text = stripCommentsAndFences(body);
  const hasLevelTwo = text.split('\n').some((line) => /^##[ \t]+\S/.test(line));
  if (hasLevelTwo) return body;
  return text.replace(/^###[ \t]+/gm, '## ');
}

function sectionContent(byName, name) {
  const content = byName[name] ?? '';
  return content === NO_RESPONSE ? '' : content;
}

function checkCriteria(type, byName) {
  const prefix = CRITERION_PREFIX[type];
  if (!prefix) return [];
  const heading = CRITERIA_HEADING[type];
  const ids = criterionIds(sectionContent(byName, heading), prefix);
  if (ids.length === 0) return [`${heading} needs at least one ${prefix} criterion`];
  const duplicated = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  return duplicated.map((id) => `${heading}: duplicate criterion ${id}`);
}

function checkServes(type, byName) {
  const serves = sectionContent(byName, 'Serves');
  if (serves === '') return type === 'Bug' ? [] : ['Serves must name at least one epic criterion (E<n>)'];
  const invalid = serves.split(/[\s,]+/).filter((token) => token !== '' && !EPIC_ID.test(token));
  return invalid.length === 0 ? [] : [`Serves lists only E<n> IDs; found ${invalid.join(', ')}`];
}

/**
 * @param {{ type: IssueType|null, body: string }} issue
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateIssueBody({ type, body }) {
  if (!type) return { ok: false, errors: ['Issue type is missing'] };
  if (!ISSUE_TYPES.includes(type)) return { ok: false, errors: [`Unknown issue type ${type}`] };
  const { sections, byName, duplicates } = parseSections(normalizeHeadingLevel(String(body ?? '')));
  const present = new Set(sections.map((section) => section.name));
  const errors = [];
  for (const heading of REQUIRED_HEADINGS[type]) {
    if (!present.has(heading)) errors.push(`Missing section ## ${heading}`);
    if (duplicates.includes(heading)) errors.push(`Section ## ${heading} appears more than once`);
  }
  if (errors.length > 0) return { ok: false, errors };
  errors.push(...checkCriteria(type, byName));
  if (type !== 'Epic') errors.push(...checkServes(type, byName));
  return { ok: errors.length === 0, errors };
}

const hasLabel = (labels, name) => labels.some((label) => normalizeLabel(label) === normalizeLabel(name));

/**
 * Bug, no parent, valid `priority:p0`.
 * @param {IssueFacts} facts
 * @param {object} _config part of the 13.1 signature; the rule needs no config value
 * @returns {boolean}
 */
export function isHotfixLane(facts, _config) {
  return facts.type === 'Bug' && facts.ancestors.length === 0 && hasLabel(facts.validLabels, 'priority:p0');
}

function minutesSince(since, now) {
  return (new Date(now).getTime() - new Date(since).getTime()) / MS_PER_MINUTE;
}

/**
 * @param {PullFacts|null} pr
 * @param {{ config: { limits: { draftLeaseMinutes: number, claimWithoutPrMinutes: number } }, now: Date|string,
 *   claimCommentAt: string|null, claimCommitAt: string|null }} context
 * @returns {{ expired: boolean, released: boolean, since: string|null }}
 */
export function leaseState(pr, { config, now, claimCommentAt, claimCommitAt }) {
  if (!pr) {
    const claimedAt = claimCommentAt ?? claimCommitAt ?? null;
    if (claimedAt === null) return { expired: true, released: false, since: null };
    return { expired: minutesSince(claimedAt, now) > config.limits.claimWithoutPrMinutes, released: false, since: claimedAt };
  }
  if (!pr.draft) return { expired: false, released: pr.released, since: null };
  const since = pr.lastAgentCommentAt ?? pr.createdAt;
  return { expired: minutesSince(since, now) > config.limits.draftLeaseMinutes, released: pr.released, since };
}

function claimStatus(facts, { config, now }) {
  const { pr } = facts;
  if (pr && pr.state === 'closed' && !pr.merged) {
    return { status: 'orphaned', reason: `PR #${pr.number} was closed unmerged; delete issue/${facts.number}` };
  }
  if (pr) return { status: 'claimed', reason: `issue/${facts.number} has PR #${pr.number}` };
  const lease = leaseState(null, { config, now, claimCommentAt: facts.claimCommentAt, claimCommitAt: facts.claimCommitAt });
  if (lease.expired) return { status: 'orphaned', reason: `issue/${facts.number} has no PR and its claim window passed` };
  return { status: 'claimed', reason: `issue/${facts.number} has no PR yet, within the claim window` };
}

function acceptance(facts, config) {
  if (facts.ancestors.some((ancestor) => hasLabel(ancestor.validLabels, 'accepted'))) {
    return { accepted: true, reason: 'accepted ancestor' };
  }
  if (isHotfixLane(facts, config)) return { accepted: true, reason: 'hotfix lane' };
  return { accepted: false, reason: 'no accepted ancestor' };
}

/**
 * First matching row of the 4.4 table.
 * @param {IssueFacts} facts
 * @param {{ config: object, now: Date|string }} context
 * @returns {{ status: Status, reason: string }}
 */
export function deriveStatus(facts, { config, now }) {
  if (facts.state === 'closed') return { status: 'done', reason: 'issue is closed' };
  if (hasLabel(facts.validLabels, 'needs-decision')) return { status: 'needs-decision', reason: 'needs-decision label' };
  if (facts.pr?.inMergeQueue) return { status: 'queued', reason: `PR #${facts.pr.number} is in the merge queue` };
  if (facts.pr && facts.pr.state === 'open' && !facts.pr.draft) {
    return { status: 'in-review', reason: `PR #${facts.pr.number} is ready for review` };
  }
  if (facts.branch.exists) return claimStatus(facts, { config, now });
  const result = acceptance(facts, config);
  if (!result.accepted) return { status: 'proposed', reason: result.reason };
  const openBlockers = facts.blockedBy.filter((blocker) => blocker.state === 'open');
  if (openBlockers.length > 0) {
    return { status: 'blocked', reason: `blocked by ${openBlockers.map((blocker) => `#${blocker.number}`).join(', ')}` };
  }
  return { status: 'ready', reason: result.reason };
}

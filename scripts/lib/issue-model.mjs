import { GitHubError, apiPath } from './github.mjs';
import { criterionIds, hasMarker, parseSections } from './markdown.mjs';
import { normalizeLabel, sameLogin, validLabels } from './trust.mjs';

/** @typedef {'Epic'|'Feature'|'Bug'|'Chore'|'Spike'} IssueType */
/** @typedef {'done'|'needs-decision'|'queued'|'in-review'|'claimed'|'orphaned'|'proposed'|'blocked'|'ready'} Status */
/** @typedef {{ number: number, state: 'open'|'closed', merged: boolean, draft: boolean, inMergeQueue: boolean,
 *   released: boolean, headRepo: string, createdAt: string, lastAgentCommentAt: string|null }} PullFacts */
/** @typedef {{ number: number, title: string, type: string|null, state: 'open'|'closed', stateReason: string|null,
 *   author: string, body: string, labels: string[], validLabels: string[],
 *   ancestors: Array<{ number: number, type: string|null, validLabels: string[] }>,
 *   blockedBy: Array<{ number: number, state: 'open'|'closed' }>,
 *   branch: { exists: boolean, sha: string|null }, claimCommentAt: string|null, claimCommitAt: string|null, pr: PullFacts|null }} IssueFacts
 *   ancestors are nearest first.
 *   claimCommentAt: server created_at of the newest issue comment by the agent account carrying marker `claim` (6.3)
 *   claimCommitAt: committer date of the ref head when `parseClaimCommit` accepts its message for this issue (claim or takeover commit), else null */

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
const TITLE_PATTERN = new RegExp(`^(${COMMIT_TYPES.join('|')})(?:\\(([^()\\s]+)\\))?(!)?:[ \\t]+(\\S.*)$`);
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

// Web forms render answers as `### <label>`. A body with no `## <required heading>` is form output:
// promote only the required `###` headings, so answer text keeps its own headings.
export function normalizeIssueBody(type, body) {
  const required = REQUIRED_HEADINGS[type];
  const text = String(body ?? '');
  const hasLevelTwo = required.some((heading) => new RegExp(`^##[ \\t]+${heading}[ \\t]*$`, 'm').test(text));
  if (hasLevelTwo) return text;
  return text.replace(/^###([ \t]+)(.+?)[ \t]*$/gm, (line, space, name) => (required.includes(name) ? `##${space}${name}` : line));
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
  const { sections, byName, duplicates } = parseSections(normalizeIssueBody(type, body));
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

const SESSION_ID = /^[A-Za-z0-9._-]+$/;
const AGENT_ID = /^[A-Za-z0-9._/-]+$/;
const CLAIM_COMMIT = /^chore\(claim\): #(\d+)( takeover)? \[session ([A-Za-z0-9._-]+)\]$/;

/**
 * Session ids appear in commit subjects, State headers (split on `·`, parenthesised) and PR footers.
 * @param {string} session
 * @returns {boolean}
 */
export function isValidSessionId(session) {
  return SESSION_ID.test(String(session ?? ''));
}

/**
 * `<model>/<harness>`, as written in the State header and the PR footer: the session id characters plus `/`,
 * so it cannot break the header's parenthesised, `·` separated group.
 * @param {string} agent
 * @returns {boolean}
 */
export function isValidAgent(agent) {
  return AGENT_ID.test(String(agent ?? ''));
}

/**
 * Subject of the empty commit that claims a task (6.3) or takes it over (6.4). `session` must
 * pass `isValidSessionId`; the message is the whole commit message, with no body.
 * @param {{ number: number, session: string, kind?: 'claim'|'takeover' }} claim
 * @returns {string}
 */
export function claimCommitMessage({ number, session, kind = 'claim' }) {
  const takeover = kind === 'takeover' ? ' takeover' : '';
  return `chore(claim): #${number}${takeover} [session ${session}]`;
}

/**
 * Inverse of `claimCommitMessage`. Only the first line is read, so a body is allowed.
 * @param {string} message
 * @returns {{ number: number, session: string, kind: 'claim'|'takeover' }|null}
 */
export function parseClaimCommit(message) {
  const subject = String(message ?? '').split(/\r?\n/)[0];
  const match = CLAIM_COMMIT.exec(subject);
  if (!match) return null;
  return { number: Number(match[1]), session: match[3], kind: match[2] ? 'takeover' : 'claim' };
}

/**
 * Bug, no parent, valid `priority:p0`.
 * @param {IssueFacts} facts
 * @param {object} _config part of the 13.1 signature; the rule needs no config value
 * @returns {boolean}
 */
export function isHotfixLane(facts, _config) {
  return facts.type === 'Bug' && facts.ancestors.length === 0 && hasLabel(facts.validLabels, 'priority:p0');
}

// An unparseable timestamp gives NaN; treat it as expired so a bad value never holds a claim.
function isExpired(since, now, limitMinutes) {
  const minutes = (new Date(now).getTime() - new Date(since).getTime()) / MS_PER_MINUTE;
  return !Number.isFinite(minutes) || minutes > limitMinutes;
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
    return { expired: isExpired(claimedAt, now, config.limits.claimWithoutPrMinutes), released: false, since: claimedAt };
  }
  if (!pr.draft) return { expired: false, released: pr.released, since: null };
  const since = pr.lastAgentCommentAt ?? pr.createdAt;
  return { expired: isExpired(since, now, config.limits.draftLeaseMinutes), released: pr.released, since };
}

function claimStatus(facts, { config, now }) {
  const { pr } = facts;
  if (pr && pr.state !== 'open') {
    const outcome = pr.merged ? 'merged' : 'closed unmerged';
    return { status: 'orphaned', reason: `PR #${pr.number} was ${outcome}; delete issue/${facts.number}` };
  }
  if (pr) return { status: 'claimed', reason: `issue/${facts.number} has PR #${pr.number}` };
  const lease = leaseState(null, { config, now, claimCommentAt: facts.claimCommentAt, claimCommitAt: facts.claimCommitAt });
  if (lease.expired) return { status: 'orphaned', reason: `issue/${facts.number} has no PR and its claim window passed` };
  return { status: 'claimed', reason: `issue/${facts.number} has no PR yet, within the claim window` };
}

function acceptance(facts, config) {
  if (facts.type === 'Epic') {
    return hasLabel(facts.validLabels, 'accepted')
      ? { accepted: true, reason: 'accepted epic' }
      : { accepted: false, reason: 'epic without accepted' };
  }
  const acceptedEpic = facts.ancestors.some((ancestor) => ancestor.type === 'Epic' && hasLabel(ancestor.validLabels, 'accepted'));
  if (acceptedEpic) return { accepted: true, reason: 'accepted ancestor' };
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

const NOT_FOUND = 404;
const REPO_PATH = '/repos/{owner}/{repo}';
const MERGE_QUEUE_QUERY = 'query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) '
  + '{ pullRequest(number: $number) { isInMergeQueue } } }';

const newestFirst = (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
const labelName = (label) => (typeof label === 'string' ? label : label?.name);
const openOrClosed = (state) => (state === 'closed' ? 'closed' : 'open');

function newestCreatedAt(comments, predicate) {
  const matching = comments.filter(predicate).sort(newestFirst);
  return matching.length === 0 ? null : matching[0].created_at;
}

async function loadLabels(client, repoRef, issue, config) {
  const timelinePath = apiPath(`${REPO_PATH}/issues/{number}/timeline`, { ...repoRef, number: issue.number });
  const timeline = await client.paginate(timelinePath);
  const labels = (issue.labels ?? []).map(labelName).filter(Boolean);
  return { labels, valid: validLabels({ labels, timeline }, config) };
}

function assertSameRepository(parent, { owner, repo }) {
  const expectedSuffix = `/repos/${owner}/${repo}`.toLowerCase();
  if (!String(parent.repository_url ?? '').toLowerCase().endsWith(expectedSuffix)) {
    throw new GitHubError(`parent #${parent.number} is not in ${owner}/${repo}`);
  }
}

async function loadAncestors(client, repoRef, issue, config) {
  const ancestors = [];
  const seen = new Set([issue.number]);
  let child = issue;
  for (;;) {
    const parentPath = apiPath(`${REPO_PATH}/issues/{number}/parent`, { ...repoRef, number: child.number });
    const response = await client.request('GET', parentPath, { okStatuses: [NOT_FOUND] });
    if (response.status === NOT_FOUND) {
      if (child.parent_issue_url != null) throw new GitHubError(`parent of #${child.number} exists but cannot be read`);
      return ancestors;
    }
    const parent = response.data;
    assertSameRepository(parent, repoRef);
    if (seen.has(parent.number)) throw new GitHubError(`issue #${issue.number} has a parent cycle at #${parent.number}`);
    seen.add(parent.number);
    const { valid } = await loadLabels(client, repoRef, parent, config);
    ancestors.push({ number: parent.number, type: parent.type?.name ?? null, validLabels: valid });
    child = parent;
  }
}

async function loadBranch(client, repoRef, number) {
  const refPath = apiPath(`${REPO_PATH}/git/ref/heads/issue/{number}`, { ...repoRef, number });
  const response = await client.request('GET', refPath, { okStatuses: [NOT_FOUND] });
  if (response.status === NOT_FOUND) return { exists: false, sha: null };
  return { exists: true, sha: response.data.object.sha };
}

async function loadClaimCommitAt(client, repoRef, number, sha) {
  const response = await client.request('GET', apiPath(`${REPO_PATH}/git/commits/{sha}`, { ...repoRef, sha }));
  const claim = parseClaimCommit(response.data.message);
  return claim?.number === number ? response.data.committer?.date ?? null : null;
}

async function isInMergeQueue(client, { owner, repo }, number) {
  const data = await client.graphql(MERGE_QUEUE_QUERY, { owner, repo, number });
  const pullRequest = data.repository?.pullRequest;
  if (!pullRequest) throw new GitHubError(`pull request #${number} not found for the merge queue read`);
  return pullRequest.isInMergeQueue === true;
}

async function loadPullFacts(client, repoRef, number, config) {
  const pulls = await client.paginate(apiPath(`${REPO_PATH}/pulls`, repoRef), {
    query: { head: `${repoRef.owner}:issue/${number}`, state: 'all' },
  });
  const candidates = pulls.filter((pull) => pull.head?.ref === `issue/${number}`).sort(newestFirst);
  const newest = candidates.find((pull) => pull.state === 'open') ?? candidates[0];
  if (!newest) return null;
  const commentsPath = apiPath(`${REPO_PATH}/issues/{number}/comments`, { ...repoRef, number: newest.number });
  const comments = await client.paginate(commentsPath);
  const state = openOrClosed(newest.state);
  return {
    number: newest.number,
    state,
    merged: Boolean(newest.merged_at) || newest.merged === true,
    draft: newest.draft === true,
    inMergeQueue: state === 'open' && await isInMergeQueue(client, repoRef, newest.number),
    released: hasMarker(newest.body ?? '', 'released'),
    headRepo: newest.head?.repo?.full_name ?? '',
    createdAt: newest.created_at,
    lastAgentCommentAt: newestCreatedAt(comments, (comment) => sameLogin(comment.user?.login, config.accounts.agent)),
  };
}

/**
 * @param {import('./github.mjs').GitHubClient} client
 * @param {{ owner: string, repo: string, number: number }} target
 * @param {{ config: { accounts: { agent: string } } }} context
 * @returns {Promise<IssueFacts>}
 * @throws {GitHubError}
 */
export async function loadIssueFacts(client, { owner, repo, number }, { config }) {
  const repoRef = { owner, repo };
  const issue = (await client.request('GET', apiPath(`${REPO_PATH}/issues/{number}`, { ...repoRef, number }))).data;
  const { labels, valid } = await loadLabels(client, repoRef, issue, config);
  const ancestors = await loadAncestors(client, repoRef, issue, config);
  const blockers = await client.paginate(apiPath(`${REPO_PATH}/issues/{number}/dependencies/blocked_by`, { ...repoRef, number }));
  const branch = await loadBranch(client, repoRef, number);
  const issueComments = await client.paginate(apiPath(`${REPO_PATH}/issues/{number}/comments`, { ...repoRef, number }));
  const claimCommentAt = newestCreatedAt(
    issueComments,
    (comment) => sameLogin(comment.user?.login, config.accounts.agent) && hasMarker(comment.body ?? '', 'claim'),
  );
  return {
    number: issue.number,
    title: issue.title ?? '',
    type: issue.type?.name ?? null,
    state: openOrClosed(issue.state),
    stateReason: issue.state_reason ?? null,
    author: issue.user?.login ?? '',
    body: issue.body ?? '',
    labels,
    validLabels: valid,
    ancestors,
    blockedBy: blockers.map((blocker) => ({ number: blocker.number, state: openOrClosed(blocker.state) })),
    branch,
    claimCommentAt,
    claimCommitAt: branch.exists ? await loadClaimCommitAt(client, repoRef, number, branch.sha) : null,
    pr: await loadPullFacts(client, repoRef, number, config),
  };
}

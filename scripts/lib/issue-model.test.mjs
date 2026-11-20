import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubError, createFixtureClient } from './github.mjs';
import * as model from './issue-model.mjs';
import {
  ISSUE_TYPES,
  REQUIRED_HEADINGS,
  TITLE_TYPES,
  claimCommitMessage,
  deriveStatus,
  isValidAgent,
  isValidSessionId,
  isHotfixLane,
  leaseState,
  loadIssueFacts,
  parseClaimCommit,
  parseConventionalTitle,
  parseFooter,
  validateIssueBody,
} from './issue-model.mjs';

const config = { limits: { draftLeaseMinutes: 240, claimWithoutPrMinutes: 30 } };
const NOW = new Date('2026-01-01T12:00:00Z');
const minutesAgo = (minutes) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

function pr(overrides = {}) {
  return {
    number: 7, state: 'open', merged: false, draft: true, inMergeQueue: false, released: false,
    headRepo: 'acme/app', createdAt: minutesAgo(10), lastAgentCommentAt: null, ...overrides,
  };
}

function facts(overrides = {}) {
  return {
    number: 5, title: 't', type: 'Feature', state: 'open', stateReason: null, author: 'owner', body: '',
    labels: [], validLabels: [],
    ancestors: [{ number: 1, type: 'Epic', validLabels: ['accepted'] }],
    blockedBy: [], branch: { exists: false, sha: null }, claimCommentAt: null, claimCommitAt: null, pr: null,
    ...overrides,
  };
}

const status = (overrides) => deriveStatus(facts(overrides), { config, now: NOW }).status;

const criteria = (prefix) => `- [ ] ${prefix}1 first\n- [x] ${prefix}2 second`;

function bodyFor(type, { level = '##', omit = [], overrides = {} } = {}) {
  const content = {
    Goal: 'g', 'Success criteria': criteria('E'), Constraints: 'c', Plan: 'p', Decisions: 'd', 'Open questions': 'q',
    Outcome: 'o', Serves: 'E1', Scope: 's', Touches: 't', 'Acceptance criteria': criteria('AC'),
    'Verification plan': 'v', Risk: 'low', Context: 'x', Reproduction: 'r', 'Expected vs actual': 'e',
    Question: 'q?', Timebox: '2h', Output: 'o', ...overrides,
  };
  return REQUIRED_HEADINGS[type]
    .filter((heading) => !omit.includes(heading))
    .map((heading) => `${level} ${heading}\n\n${content[heading]}\n`)
    .join('\n');
}

test('exports loadIssueFacts and the issue types', () => {
  assert.equal(typeof model.loadIssueFacts, 'function');
  assert.deepEqual(ISSUE_TYPES, ['Epic', 'Feature', 'Bug', 'Chore', 'Spike']);
});

test('REQUIRED_HEADINGS follow 4.3', () => {
  assert.deepEqual(REQUIRED_HEADINGS.Epic, ['Goal', 'Success criteria', 'Constraints', 'Plan', 'Decisions', 'Open questions']);
  assert.deepEqual(REQUIRED_HEADINGS.Chore, REQUIRED_HEADINGS.Feature);
  assert.deepEqual(REQUIRED_HEADINGS.Bug, [...REQUIRED_HEADINGS.Feature, 'Reproduction', 'Expected vs actual']);
  assert.deepEqual(REQUIRED_HEADINGS.Spike, ['Question', 'Serves', 'Timebox', 'Output']);
});

test('TITLE_TYPES maps issue types to commit types', () => {
  assert.deepEqual(TITLE_TYPES.Spike, { types: ['docs'], scope: 'spike' });
  assert.deepEqual(TITLE_TYPES.Epic.types, []);
  assert.deepEqual(TITLE_TYPES.Feature.types, ['feat']);
  assert.deepEqual(TITLE_TYPES.Bug.types, ['fix']);
  assert.deepEqual(TITLE_TYPES.Chore.types, ['build', 'chore', 'ci', 'docs', 'refactor', 'style', 'test', 'perf', 'revert']);
});

test('parseConventionalTitle accepts valid titles', () => {
  assert.deepEqual(parseConventionalTitle('feat: add thing'), { type: 'feat', scope: null, breaking: false, summary: 'add thing' });
  assert.deepEqual(parseConventionalTitle('fix(api): handle null'), { type: 'fix', scope: 'api', breaking: false, summary: 'handle null' });
  assert.deepEqual(parseConventionalTitle('refactor(core)!: drop old'), { type: 'refactor', scope: 'core', breaking: true, summary: 'drop old' });
  assert.equal(parseConventionalTitle('feat!: x').breaking, true);
  assert.equal(parseConventionalTitle('docs(spike): decide').scope, 'spike');
});

test('parseConventionalTitle rejects invalid titles', () => {
  for (const title of ['add thing', 'feature: x', 'feat:x', 'feat: ', 'feat(): x', 'Feat: x', 'feat(a)(b): x', '', null]) {
    assert.equal(parseConventionalTitle(title), null, String(title));
  }
});

test('validateIssueBody passes for each type', () => {
  for (const type of ISSUE_TYPES) {
    assert.deepEqual(validateIssueBody({ type, body: bodyFor(type) }), { ok: true, errors: [] }, type);
  }
});

test('normalizeIssueBody promotes only required ### headings, and only when no ## required heading exists', () => {
  const form = '### Outcome\n\nDone.\n\n### Notes\n\ntext\n';
  assert.equal(model.normalizeIssueBody('Feature', form), '## Outcome\n\nDone.\n\n### Notes\n\ntext\n');
  const mixed = '## Outcome\n\nDone.\n\n### Scope\n\ntext\n';
  assert.equal(model.normalizeIssueBody('Feature', mixed), mixed);
  assert.equal(model.normalizeIssueBody('Feature', null), '');
});

test('validateIssueBody rejects missing or unknown type', () => {
  assert.equal(validateIssueBody({ type: null, body: bodyFor('Feature') }).ok, false);
  assert.equal(validateIssueBody({ type: 'Story', body: '' }).ok, false);
});

test('validateIssueBody reports missing and duplicated headings', () => {
  const missing = validateIssueBody({ type: 'Bug', body: bodyFor('Bug', { omit: ['Reproduction'] }) });
  assert.deepEqual(missing.errors, ['Missing section ## Reproduction']);
  const duplicated = validateIssueBody({ type: 'Spike', body: `${bodyFor('Spike')}\n## Timebox\n\n1h\n` });
  assert.deepEqual(duplicated.errors, ['Section ## Timebox appears more than once']);
});

test('validateIssueBody checks criterion IDs', () => {
  const noEpicId = validateIssueBody({ type: 'Epic', body: bodyFor('Epic', { overrides: { 'Success criteria': '- [ ] AC1 x' } }) });
  assert.equal(noEpicId.ok, false);
  const noAc = validateIssueBody({ type: 'Chore', body: bodyFor('Chore', { overrides: { 'Acceptance criteria': 'prose only' } }) });
  assert.equal(noAc.ok, false);
  const duplicate = validateIssueBody({ type: 'Feature', body: bodyFor('Feature', { overrides: { 'Acceptance criteria': '- [ ] AC1 a\n- [ ] AC1 b' } }) });
  assert.deepEqual(duplicate.errors, ['Acceptance criteria: duplicate criterion AC1']);
  const epicDuplicate = validateIssueBody({ type: 'Epic', body: bodyFor('Epic', { overrides: { 'Success criteria': '- [ ] E1 a\n- [ ] E1 b' } }) });
  assert.equal(epicDuplicate.ok, false);
});

test('validateIssueBody checks Serves', () => {
  for (const serves of ['E1, E2', 'E1 E2', 'E3']) {
    assert.equal(validateIssueBody({ type: 'Feature', body: bodyFor('Feature', { overrides: { Serves: serves } }) }).ok, true, serves);
  }
  for (const serves of ['AC1', 'E1, foo', '#4', '']) {
    assert.equal(validateIssueBody({ type: 'Feature', body: bodyFor('Feature', { overrides: { Serves: serves } }) }).ok, false, serves);
  }
  assert.equal(validateIssueBody({ type: 'Spike', body: bodyFor('Spike', { overrides: { Serves: '' } }) }).ok, false);
});

test('validateIssueBody lets a Bug leave Serves empty', () => {
  assert.equal(validateIssueBody({ type: 'Bug', body: bodyFor('Bug', { overrides: { Serves: '' } }) }).ok, true);
  assert.equal(validateIssueBody({ type: 'Bug', body: bodyFor('Bug', { overrides: { Serves: '_No response_' } }) }).ok, true);
  assert.equal(validateIssueBody({ type: 'Bug', body: bodyFor('Bug', { overrides: { Serves: 'nope' } }) }).ok, false);
});

test('validateIssueBody accepts form-generated level-3 bodies', () => {
  const body = bodyFor('Bug', { level: '###', overrides: { Serves: '_No response_', Context: '_No response_' } });
  assert.deepEqual(validateIssueBody({ type: 'Bug', body }), { ok: true, errors: [] });
});

test('validateIssueBody treats _No response_ as empty content', () => {
  const body = bodyFor('Feature', { level: '###', overrides: { 'Acceptance criteria': '_No response_' } });
  assert.equal(validateIssueBody({ type: 'Feature', body }).ok, false);
});

test('validateIssueBody keeps level-3 headings inside a level-2 body as content', () => {
  const body = `${bodyFor('Spike')}\n### Question\n\nextra\n`;
  assert.equal(validateIssueBody({ type: 'Spike', body }).ok, true);
});

test('validateIssueBody handles CRLF bodies', () => {
  const body = bodyFor('Feature').replace(/\n/g, '\r\n');
  assert.deepEqual(validateIssueBody({ type: 'Feature', body }), { ok: true, errors: [] });
  const form = bodyFor('Feature', { level: '###' }).replace(/\n/g, '\r\n');
  assert.deepEqual(validateIssueBody({ type: 'Feature', body: form }), { ok: true, errors: [] });
});

test('isHotfixLane needs Bug, no parent, valid priority:p0', () => {
  const hotfix = { type: 'Bug', ancestors: [], validLabels: ['priority:p0'] };
  assert.equal(isHotfixLane(facts(hotfix), config), true);
  assert.equal(isHotfixLane(facts({ ...hotfix, type: 'Feature' }), config), false);
  assert.equal(isHotfixLane(facts({ ...hotfix, ancestors: [{ number: 1, type: 'Epic', validLabels: [] }] }), config), false);
  assert.equal(isHotfixLane(facts({ ...hotfix, validLabels: [], labels: ['priority:p0'] }), config), false);
  assert.equal(isHotfixLane(facts({ ...hotfix, validLabels: ['priority:p1'] }), config), false);
});

test('leaseState: draft PR uses last agent comment, else createdAt', () => {
  const context = { config, now: NOW, claimCommentAt: null, claimCommitAt: null };
  const byComment = leaseState(pr({ createdAt: minutesAgo(500), lastAgentCommentAt: minutesAgo(60) }), context);
  assert.deepEqual(byComment, { expired: false, released: false, since: minutesAgo(60) });
  const byCreated = leaseState(pr({ createdAt: minutesAgo(300) }), context);
  assert.deepEqual(byCreated, { expired: true, released: false, since: minutesAgo(300) });
  assert.equal(leaseState(pr({ createdAt: minutesAgo(240) }), context).expired, false);
  assert.equal(leaseState(pr({ released: true }), context).released, true);
});

test('leaseState: ready PRs never expire', () => {
  const context = { config, now: NOW.toISOString(), claimCommentAt: null, claimCommitAt: null };
  const ready = leaseState(pr({ draft: false, createdAt: minutesAgo(9999) }), context);
  assert.equal(ready.expired, false);
});

test('leaseState: no PR uses claim comment, then claim commit', () => {
  const base = { config, now: NOW };
  const fresh = leaseState(null, { ...base, claimCommentAt: minutesAgo(10), claimCommitAt: minutesAgo(500) });
  assert.deepEqual(fresh, { expired: false, released: false, since: minutesAgo(10) });
  const stale = leaseState(null, { ...base, claimCommentAt: null, claimCommitAt: minutesAgo(31) });
  assert.deepEqual(stale, { expired: true, released: false, since: minutesAgo(31) });
  assert.equal(leaseState(null, { ...base, claimCommentAt: null, claimCommitAt: minutesAgo(30) }).expired, false);
});

test('leaseState: no PR and no claim evidence is expired', () => {
  const result = leaseState(null, { config, now: NOW, claimCommentAt: null, claimCommitAt: null });
  assert.deepEqual(result, { expired: true, released: false, since: null });
});

test('deriveStatus: every 4.4 row', () => {
  assert.equal(status({ state: 'closed' }), 'done');
  assert.equal(status({ validLabels: ['needs-decision'] }), 'needs-decision');
  assert.equal(status({ pr: pr({ inMergeQueue: true, draft: false }), branch: { exists: true, sha: 'a' } }), 'queued');
  assert.equal(status({ pr: pr({ draft: false }), branch: { exists: true, sha: 'a' } }), 'in-review');
  assert.equal(status({ pr: pr(), branch: { exists: true, sha: 'a' } }), 'claimed');
  assert.equal(status({ pr: pr({ state: 'closed' }), branch: { exists: true, sha: 'a' } }), 'orphaned');
  assert.equal(status({ ancestors: [{ number: 1, type: 'Epic', validLabels: [] }] }), 'proposed');
  assert.equal(status({ blockedBy: [{ number: 2, state: 'open' }] }), 'blocked');
  assert.equal(status({}), 'ready');
});

test('deriveStatus: claim without PR depends on the claim window', () => {
  const branch = { exists: true, sha: 'a' };
  assert.equal(status({ branch, claimCommentAt: minutesAgo(5) }), 'claimed');
  assert.equal(status({ branch, claimCommitAt: minutesAgo(5) }), 'claimed');
  assert.equal(status({ branch, claimCommentAt: minutesAgo(45) }), 'orphaned');
  assert.equal(status({ branch }), 'orphaned');
});

test('deriveStatus: precedence conflicts', () => {
  const branch = { exists: true, sha: 'a' };
  assert.equal(status({ state: 'closed', validLabels: ['needs-decision'] }), 'done');
  assert.equal(status({ validLabels: ['needs-decision'], pr: pr({ inMergeQueue: true, draft: false }), branch }), 'needs-decision');
  assert.equal(status({ pr: pr({ inMergeQueue: true, draft: false }), branch }), 'queued');
  assert.equal(status({ pr: pr({ draft: false }), branch, blockedBy: [{ number: 2, state: 'open' }] }), 'in-review');
  assert.equal(status({ pr: pr(), branch, ancestors: [] }), 'claimed');
  assert.equal(status({ pr: pr({ state: 'closed' }), branch, ancestors: [] }), 'orphaned');
  assert.equal(status({ ancestors: [{ number: 1, type: 'Epic', validLabels: [] }], blockedBy: [{ number: 2, state: 'open' }] }), 'proposed');
});

test('deriveStatus: labels come from validLabels only', () => {
  assert.equal(status({ labels: ['needs-decision'] }), 'ready');
  assert.equal(status({ ancestors: [{ number: 1, type: 'Epic', validLabels: [] }], labels: ['accepted'] }), 'proposed');
});

test('deriveStatus: proposed covers epics and unaccepted ancestors', () => {
  assert.equal(status({ type: 'Epic', ancestors: [] }), 'proposed');
  const nested = [{ number: 2, type: 'Feature', validLabels: [] }, { number: 1, type: 'Epic', validLabels: ['accepted'] }];
  assert.equal(status({ ancestors: nested }), 'ready');
  const nearestAccepted = [{ number: 2, type: 'Epic', validLabels: ['accepted'] }, { number: 1, type: 'Epic', validLabels: [] }];
  assert.equal(status({ ancestors: nearestAccepted }), 'ready');
});

test('deriveStatus: an accepted epic is not proposed', () => {
  const accepted = { type: 'Epic', ancestors: [], validLabels: ['accepted'] };
  assert.equal(status(accepted), 'ready');
  assert.equal(status({ ...accepted, blockedBy: [{ number: 2, state: 'open' }] }), 'blocked');
  assert.equal(status({ ...accepted, validLabels: [], labels: ['accepted'] }), 'proposed');
});

test('deriveStatus: only an Epic ancestor can supply accepted', () => {
  const ancestors = [{ number: 2, type: 'Feature', validLabels: ['accepted'] }, { number: 1, type: 'Epic', validLabels: [] }];
  assert.equal(status({ ancestors }), 'proposed');
});

test('deriveStatus: expired draft lease stays claimed', () => {
  const stale = pr({ createdAt: minutesAgo(999) });
  assert.equal(status({ pr: stale, branch: { exists: true, sha: 'a' } }), 'claimed');
});

test('deriveStatus: merged or closed PR with the ref present is orphaned', () => {
  const branch = { exists: true, sha: 'a' };
  const merged = deriveStatus(facts({ pr: pr({ state: 'closed', merged: true }), branch }), { config, now: NOW });
  assert.equal(merged.status, 'orphaned');
  assert.match(merged.reason, /#7.*merged.*issue\/5/);
  assert.equal(status({ pr: pr({ state: 'closed', draft: false }), branch }), 'orphaned');
});

test('leaseState: unparseable timestamps count as expired', () => {
  const context = { config, now: NOW, claimCommentAt: null, claimCommitAt: null };
  assert.equal(leaseState(pr({ createdAt: 'garbage' }), context).expired, true);
  assert.equal(leaseState(pr(), { ...context, now: 'garbage' }).expired, true);
  assert.equal(leaseState(null, { ...context, claimCommentAt: 'garbage' }).expired, true);
});

test('leaseState: a ready PR has since null', () => {
  const context = { config, now: NOW, claimCommentAt: null, claimCommitAt: null };
  assert.deepEqual(leaseState(pr({ draft: false }), context), { expired: false, released: false, since: null });
});

test('validateIssueBody: form answers keep their own headings', () => {
  const withNotes = bodyFor('Feature', { level: '###', overrides: { Context: 'see below\n## Notes\nmore' } });
  assert.equal(validateIssueBody({ type: 'Feature', body: withNotes }).ok, true);
  const withBackend = bodyFor('Feature', {
    level: '###',
    overrides: { 'Acceptance criteria': '### Backend\n- [ ] AC1 a\n- [ ] AC2 b' },
  });
  assert.equal(validateIssueBody({ type: 'Feature', body: withBackend }).ok, true);
});

test('parseConventionalTitle accepts a scope with punctuation', () => {
  assert.equal(parseConventionalTitle('feat(api/v2): x').scope, 'api/v2');
  assert.equal(parseConventionalTitle('feat(a b): x'), null);
});

test('deriveStatus: closed blockers do not block', () => {
  assert.equal(status({ blockedBy: [{ number: 2, state: 'closed' }, { number: 3, state: 'closed' }] }), 'ready');
  assert.match(deriveStatus(facts({ blockedBy: [{ number: 2, state: 'open' }] }), { config, now: NOW }).reason, /#2/);
});

test('deriveStatus: hotfix lane counts as accepted', () => {
  const hotfix = { type: 'Bug', ancestors: [], validLabels: ['priority:p0'] };
  const result = deriveStatus(facts(hotfix), { config, now: NOW });
  assert.deepEqual(result, { status: 'ready', reason: 'hotfix lane' });
  assert.equal(status({ ...hotfix, blockedBy: [{ number: 2, state: 'open' }] }), 'blocked');
  assert.equal(status({ ...hotfix, validLabels: [] }), 'proposed');
});

test('deriveStatus accepts now as an ISO string', () => {
  const claimed = facts({ branch: { exists: true, sha: 'a' }, claimCommentAt: minutesAgo(5) });
  assert.equal(deriveStatus(claimed, { config, now: NOW.toISOString() }).status, 'claimed');
});

// loadIssueFacts

const loadConfig = {
  accounts: { owner: 'Owner1', agent: 'Agent-Bot' },
  apps: {},
  trustedAuthors: [],
  labelActors: { accepted: 'owner', 'priority:*': 'owner' },
};
const REPO = '/repos/acme/app';
const found = (data, headers = {}) => ({ status: 200, data, headers });
const missing = { status: 404, data: { message: 'Not Found' }, headers: {} };
const labeledBy = (name, login, createdAt = '2026-01-01T00:00:00Z') => (
  { event: 'labeled', label: { name }, actor: { login }, created_at: createdAt }
);
const issueData = (overrides = {}) => ({
  number: 5, title: 'feat: thing', type: { name: 'Feature' }, state: 'open', state_reason: null,
  user: { login: 'owner1' }, body: 'body', labels: [], repository_url: 'https://api.github.com/repos/Acme/App', ...overrides,
});
const mergeQueueReply = (isInMergeQueue) => found({ data: { repository: { pullRequest: { isInMergeQueue } } } });

function issueRoutes(overrides = {}) {
  return {
    [`GET ${REPO}/issues/5`]: found(issueData()),
    [`GET ${REPO}/issues/5/timeline?per_page=100`]: found([]),
    [`GET ${REPO}/issues/5/parent`]: missing,
    [`GET ${REPO}/issues/5/dependencies/blocked_by?per_page=100`]: found([]),
    [`GET ${REPO}/git/ref/heads/issue/5`]: missing,
    [`GET ${REPO}/issues/5/comments?per_page=100`]: found([]),
    [`GET ${REPO}/pulls?head=acme:issue/5&per_page=100&state=all`]: found([]),
    ...overrides,
  };
}

const load = (overrides) => loadIssueFacts(
  createFixtureClient(issueRoutes(overrides)),
  { owner: 'acme', repo: 'app', number: 5 },
  { config: loadConfig },
);

test('loadIssueFacts: bare issue with no branch, parent or PR', async () => {
  assert.deepEqual(await load(), {
    number: 5, title: 'feat: thing', type: 'Feature', state: 'open', stateReason: null, author: 'owner1', body: 'body',
    labels: [], validLabels: [], ancestors: [], blockedBy: [], branch: { exists: false, sha: null },
    claimCommentAt: null, claimCommitAt: null, pr: null,
  });
});

test('loadIssueFacts: two-level parent chain, nearest first, ends on 404', async () => {
  const facts = await load({
    [`GET ${REPO}/issues/5/parent`]: found(issueData({ number: 3, type: { name: 'Feature' }, labels: [{ name: 'size:s' }] })),
    [`GET ${REPO}/issues/3/timeline?per_page=100`]: found([]),
    [`GET ${REPO}/issues/3/parent`]: found(issueData({ number: 1, type: { name: 'Epic' }, labels: [{ name: 'accepted' }] })),
    [`GET ${REPO}/issues/1/timeline?per_page=100`]: found([labeledBy('accepted', 'OWNER1')]),
    [`GET ${REPO}/issues/1/parent`]: missing,
  });
  assert.deepEqual(facts.ancestors, [
    { number: 3, type: 'Feature', validLabels: ['size:s'] },
    { number: 1, type: 'Epic', validLabels: ['accepted'] },
  ]);
});

test('loadIssueFacts: a parent cycle throws GitHubError', async () => {
  await assert.rejects(
    load({
      [`GET ${REPO}/issues/5/parent`]: found(issueData({ number: 3 })),
      [`GET ${REPO}/issues/3/timeline?per_page=100`]: found([]),
      [`GET ${REPO}/issues/3/parent`]: found(issueData({ number: 5 })),
    }),
    (error) => error instanceof GitHubError && /cycle/.test(error.message),
  );
});

test('loadIssueFacts: blocked_by keeps number and state', async () => {
  const facts = await load({
    [`GET ${REPO}/issues/5/dependencies/blocked_by?per_page=100`]: found([
      { number: 8, state: 'open', title: 'x' }, { number: 9, state: 'closed' },
    ]),
  });
  assert.deepEqual(facts.blockedBy, [{ number: 8, state: 'open' }, { number: 9, state: 'closed' }]);
});

test('loadIssueFacts: protected label applied by the wrong actor is not valid', async () => {
  const facts = await load({
    [`GET ${REPO}/issues/5`]: found(issueData({ labels: [{ name: 'accepted' }, { name: 'priority:p0' }, { name: 'size:s' }] })),
    [`GET ${REPO}/issues/5/timeline?per_page=100`]: found([
      labeledBy('accepted', 'someone-else'), labeledBy('priority:p0', 'owner1'), labeledBy('size:s', 'someone-else'),
    ]),
  });
  assert.deepEqual(facts.labels, ['accepted', 'priority:p0', 'size:s']);
  assert.deepEqual(facts.validLabels, ['priority:p0', 'size:s']);
});

test('loadIssueFacts: claim commit head with no PR sets claimCommitAt', async () => {
  const facts = await load({
    [`GET ${REPO}/git/ref/heads/issue/5`]: found({ object: { sha: 'abc123' } }),
    [`GET ${REPO}/git/commits/abc123`]: found({
      message: 'chore(claim): #5 [session s-1]\n\nbody', committer: { date: '2026-01-01T10:00:00Z' },
    }),
  });
  assert.deepEqual(facts.branch, { exists: true, sha: 'abc123' });
  assert.equal(facts.claimCommitAt, '2026-01-01T10:00:00Z');
  assert.equal(facts.pr, null);
});

test('loadIssueFacts: a head commit that is not a claim commit gives null', async () => {
  for (const message of ['feat: work', 'chore(claim): #6 [session s-1]', 'chore(claim): #5 [session ]']) {
    const facts = await load({
      [`GET ${REPO}/git/ref/heads/issue/5`]: found({ object: { sha: 'abc123' } }),
      [`GET ${REPO}/git/commits/abc123`]: found({ message, committer: { date: '2026-01-01T10:00:00Z' } }),
    });
    assert.equal(facts.claimCommitAt, null, message);
  }
});

test('loadIssueFacts: claim comment is the newest agent comment with the claim marker', async () => {
  const facts = await load({
    [`GET ${REPO}/issues/5/comments?per_page=100`]: found([
      { user: { login: 'agent-bot' }, body: 'claim <!-- groundwork:claim -->', created_at: '2026-01-01T08:00:00Z' },
      { user: { login: 'AGENT-BOT' }, body: 'again <!-- groundwork:claim -->', created_at: '2026-01-01T09:00:00Z' },
      { user: { login: 'agent-bot' }, body: 'no marker', created_at: '2026-01-01T11:00:00Z' },
      { user: { login: 'intruder' }, body: '<!-- groundwork:claim -->', created_at: '2026-01-01T12:00:00Z' },
    ]),
  });
  assert.equal(facts.claimCommentAt, '2026-01-01T09:00:00Z');
});

test('loadIssueFacts: draft PR with agent comments and the released marker', async () => {
  const facts = await load({
    [`GET ${REPO}/git/ref/heads/issue/5`]: found({ object: { sha: 'abc123' } }),
    [`GET ${REPO}/git/commits/abc123`]: found({ message: 'feat: work', committer: { date: '2026-01-01T10:00:00Z' } }),
    [`GET ${REPO}/pulls?head=acme:issue/5&per_page=100&state=all`]: found([
      { number: 6, state: 'closed', draft: false, merged_at: null, created_at: '2026-01-01T01:00:00Z', head: { ref: 'issue/5', repo: { full_name: 'acme/app' } }, body: '' },
      {
        number: 7, state: 'open', draft: true, merged_at: null, created_at: '2026-01-01T02:00:00Z',
        head: { ref: 'issue/5', repo: { full_name: 'fork/app' } }, body: 'state\n<!-- groundwork:released -->',
      },
    ]),
    [`GET ${REPO}/issues/7/comments?per_page=100`]: found([
      { user: { login: 'agent-bot' }, body: 'one', created_at: '2026-01-01T03:00:00Z' },
      { user: { login: 'Agent-Bot' }, body: 'two', created_at: '2026-01-01T05:00:00Z' },
      { user: { login: 'intruder' }, body: 'noise', created_at: '2026-01-01T06:00:00Z' },
    ]),
    'POST /graphql': mergeQueueReply(false),
  });
  assert.deepEqual(facts.pr, {
    number: 7, state: 'open', merged: false, draft: true, inMergeQueue: false, released: true,
    headRepo: 'fork/app', createdAt: '2026-01-01T02:00:00Z', lastAgentCommentAt: '2026-01-01T05:00:00Z',
  });
  assert.equal(facts.claimCommitAt, null);
});

test('loadIssueFacts: merged PR is closed and merged, and skips the merge-queue read', async () => {
  const calls = [];
  const client = createFixtureClient(issueRoutes({
    [`GET ${REPO}/git/ref/heads/issue/5`]: found({ object: { sha: 'abc123' } }),
    [`GET ${REPO}/git/commits/abc123`]: found({ message: 'feat: work', committer: { date: '2026-01-01T10:00:00Z' } }),
    [`GET ${REPO}/pulls?head=acme:issue/5&per_page=100&state=all`]: found([
      { number: 7, state: 'closed', draft: false, merged_at: '2026-01-02T00:00:00Z', created_at: '2026-01-01T02:00:00Z', head: { ref: 'issue/5', repo: null }, body: null },
    ]),
    [`GET ${REPO}/issues/7/comments?per_page=100`]: found([]),
  }), { onCall: (record) => calls.push(record.path) });
  const facts = await loadIssueFacts(client, { owner: 'acme', repo: 'app', number: 5 }, { config: loadConfig });
  assert.deepEqual(facts.pr, {
    number: 7, state: 'closed', merged: true, draft: false, inMergeQueue: false, released: false,
    headRepo: '', createdAt: '2026-01-01T02:00:00Z', lastAgentCommentAt: null,
  });
  assert.ok(!calls.includes('/graphql'));
});

test('loadIssueFacts: PR with a merge-queue entry is inMergeQueue', async () => {
  const facts = await load({
    [`GET ${REPO}/pulls?head=acme:issue/5&per_page=100&state=all`]: found([
      { number: 7, state: 'open', draft: false, merged_at: null, created_at: '2026-01-01T02:00:00Z', head: { ref: 'issue/5', repo: { full_name: 'acme/app' } }, body: '' },
    ]),
    [`GET ${REPO}/issues/7/comments?per_page=100`]: found([]),
    'POST /graphql': mergeQueueReply(true),
    [`GET ${REPO}/git/ref/heads/issue/5`]: found({ object: { sha: 'abc123' } }),
    [`GET ${REPO}/git/commits/abc123`]: found({ message: 'feat: work', committer: { date: '2026-01-01T10:00:00Z' } }),
  });
  assert.equal(facts.pr.inMergeQueue, true);
});

const pullData = (overrides = {}) => ({
  number: 7, state: 'open', draft: false, merged_at: null, created_at: '2026-01-01T02:00:00Z',
  head: { ref: 'issue/5', repo: { full_name: 'acme/app' } }, body: '', ...overrides,
});
const PULLS_KEY = `GET ${REPO}/pulls?head=acme:issue/5&per_page=100&state=all`;

test('loadIssueFacts: a parent in another repository throws GitHubError', async () => {
  await assert.rejects(
    load({
      [`GET ${REPO}/issues/5/parent`]: found(issueData({ number: 3, repository_url: 'https://api.github.com/repos/acme/other' })),
    }),
    (error) => error instanceof GitHubError && /not in acme\/app/.test(error.message),
  );
});

test('loadIssueFacts: a 404 parent read with a parent_issue_url throws GitHubError', async () => {
  await assert.rejects(
    load({ [`GET ${REPO}/issues/5`]: found(issueData({ parent_issue_url: `https://api.github.com${REPO}/issues/3` })) }),
    (error) => error instanceof GitHubError && /cannot be read/.test(error.message),
  );
});

test('loadIssueFacts: a custom issue type name passes through', async () => {
  const facts = await load({ [`GET ${REPO}/issues/5`]: found(issueData({ type: { name: 'Initiative' } })) });
  assert.equal(facts.type, 'Initiative');
});

test('loadIssueFacts: a stray PR with another head ref is ignored', async () => {
  const facts = await load({
    [PULLS_KEY]: found([pullData({ number: 9, created_at: '2026-01-05T00:00:00Z', head: { ref: 'issue/50', repo: null } })]),
  });
  assert.equal(facts.pr, null);
});

test('loadIssueFacts: an open older PR beats a newer closed one', async () => {
  const facts = await load({
    [PULLS_KEY]: found([
      pullData({ number: 6, state: 'open', created_at: '2026-01-01T01:00:00Z' }),
      pullData({ number: 8, state: 'closed', created_at: '2026-01-03T00:00:00Z' }),
    ]),
    [`GET ${REPO}/issues/6/comments?per_page=100`]: found([]),
    'POST /graphql': mergeQueueReply(false),
  });
  assert.equal(facts.pr.number, 6);
  assert.equal(facts.pr.state, 'open');
});

test('loadIssueFacts: a missing pull request in the merge-queue read throws GitHubError', async () => {
  await assert.rejects(
    load({
      [PULLS_KEY]: found([pullData()]),
      [`GET ${REPO}/issues/7/comments?per_page=100`]: found([]),
      'POST /graphql': found({ data: { repository: { pullRequest: null } } }),
    }),
    (error) => error instanceof GitHubError && /merge queue/.test(error.message),
  );
});

test('loadIssueFacts: the latest labeled event decides label validity', async () => {
  const facts = await load({
    [`GET ${REPO}/issues/5`]: found(issueData({ labels: [{ name: 'accepted' }] })),
    [`GET ${REPO}/issues/5/timeline?per_page=100`]: found([
      labeledBy('accepted', 'owner1', '2026-01-01T00:00:00Z'), labeledBy('accepted', 'someone-else', '2026-01-02T00:00:00Z'),
    ]),
  });
  assert.deepEqual(facts.validLabels, []);
});

test('loadIssueFacts: the timeline is read across pages', async () => {
  const nextLink = `<https://api.github.com${REPO}/issues/5/timeline?page=2&per_page=100>; rel="next"`;
  const facts = await load({
    [`GET ${REPO}/issues/5`]: found(issueData({ labels: [{ name: 'accepted' }] })),
    [`GET ${REPO}/issues/5/timeline?per_page=100`]: found([{ event: 'commented', created_at: '2026-01-01T00:00:00Z' }], { link: nextLink }),
    [`GET ${REPO}/issues/5/timeline?page=2&per_page=100`]: found([labeledBy('accepted', 'owner1')]),
  });
  assert.deepEqual(facts.validLabels, ['accepted']);
});

test('loadIssueFacts: a claim commit subject with trailing text gives null', async () => {
  const facts = await load({
    [`GET ${REPO}/git/ref/heads/issue/5`]: found({ object: { sha: 'abc123' } }),
    [`GET ${REPO}/git/commits/abc123`]: found({
      message: 'chore(claim): #5 [session s-1] extra', committer: { date: '2026-01-01T10:00:00Z' },
    }),
  });
  assert.equal(facts.claimCommitAt, null);
});

test('loadIssueFacts: a non-404 error propagates as GitHubError', async () => {
  await assert.rejects(
    load({ [`GET ${REPO}/git/ref/heads/issue/5`]: { status: 500, data: { message: 'boom' }, headers: {} } }),
    (error) => error instanceof GitHubError && error.status === 500,
  );
  await assert.rejects(
    load({ [`GET ${REPO}/issues/5/parent`]: { status: 403, data: {}, headers: {} } }),
    (error) => error instanceof GitHubError && error.status === 403,
  );
});

test('claimCommitMessage and parseClaimCommit round-trip both kinds', () => {
  const claim = { number: 82, session: 'w82-a1', kind: 'claim' };
  assert.equal(claimCommitMessage(claim), 'chore(claim): #82 [session w82-a1]');
  assert.deepEqual(parseClaimCommit(claimCommitMessage(claim)), claim);
  const takeover = { ...claim, kind: 'takeover' };
  assert.equal(claimCommitMessage(takeover), 'chore(claim): #82 takeover [session w82-a1]');
  assert.deepEqual(parseClaimCommit(claimCommitMessage(takeover)), takeover);
  assert.equal(claimCommitMessage({ number: 1, session: 's' }), 'chore(claim): #1 [session s]');
});

test('parseClaimCommit reads the subject only and rejects other shapes', () => {
  assert.equal(parseClaimCommit('chore(claim): #5 [session s-1]\r\n\nbody').number, 5);
  for (const message of ['', 'feat: work', 'chore(claim): #5 [session ]', 'chore(claim): #5 [session a b]',
    'chore(claim): #5 [session s-1] extra', 'chore(claim): #5 handover [session s-1]']) {
    assert.equal(parseClaimCommit(message), null, message);
  }
});

test('isValidSessionId accepts letters, digits, dot, underscore and hyphen only', () => {
  for (const id of ['a1b2', 'w82-a1', 'A.b_c']) assert.equal(isValidSessionId(id), true, id);
  for (const id of ['', 'a b', 'a]b', 'a·b', 'a(b)', undefined]) assert.equal(isValidSessionId(id), false, String(id));
});

test('isValidAgent accepts model/harness and rejects header-breaking characters', () => {
  for (const id of ['sonnet/claude-code', 'gpt-5.1/cli']) assert.equal(isValidAgent(id), true, id);
  for (const id of ['', 'codex', '/', 'a/', '/b', 'a/b/c', 'a b/c', 'a(b)/c', 'a·b/c', 'a/b)', undefined]) assert.equal(isValidAgent(id), false, String(id));
});

test('loadIssueFacts: a takeover commit head sets claimCommitAt', async () => {
  const facts = await load({
    [`GET ${REPO}/git/ref/heads/issue/5`]: found({ object: { sha: 'abc123' } }),
    [`GET ${REPO}/git/commits/abc123`]: found({
      message: 'chore(claim): #5 takeover [session s-2]', committer: { date: '2026-01-01T11:00:00Z' },
    }),
  });
  assert.equal(facts.claimCommitAt, '2026-01-01T11:00:00Z');
});

test('parseFooter reads the last line under the last ---, also with the released marker trailing', () => {
  const footer = { agent: 'sonnet/claude-code', session: 'w87-a1' };
  assert.deepEqual(parseFooter('x\n\n---\nAgent: sonnet/claude-code · session w87-a1\n'), footer);
  assert.deepEqual(parseFooter('x\r\n---\r\nAgent: sonnet/claude-code · session w87-a1\r\n'), footer);
  assert.deepEqual(parseFooter('x\n---\nAgent: sonnet/claude-code · session w87-a1\n\n<!-- groundwork:released -->\n'), footer);
});

test('parseFooter rejects a missing break, a trailing line, a bad agent and no body', () => {
  assert.equal(parseFooter('Agent: a/b · session s1'), null);
  assert.equal(parseFooter('x\n---\nAgent: a/b · session s1\nmore text'), null);
  assert.equal(parseFooter('x\n---\nAgent: codex · session s1'), null);
  assert.equal(parseFooter('x\n---\nAgent: a/b · session'), null);
  assert.equal(parseFooter(null), null);
});

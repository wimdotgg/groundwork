import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as model from './issue-model.mjs';
import {
  ISSUE_TYPES,
  REQUIRED_HEADINGS,
  TITLE_TYPES,
  deriveStatus,
  isHotfixLane,
  leaseState,
  parseConventionalTitle,
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

test('exports exclude loadIssueFacts', () => {
  assert.equal('loadIssueFacts' in model, false);
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

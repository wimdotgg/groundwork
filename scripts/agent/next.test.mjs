import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureClient } from '../lib/github.mjs';
import { loadConfig, repoRoot } from '../lib/config.mjs';
import { chooseNext, formatOutput, parseArgs, rankCandidates } from './next.mjs';

const config = await loadConfig({ root: repoRoot(import.meta.url) });
const repoRef = { owner: 'wimdotgg', repo: 'groundwork' };
const BASE = '/repos/wimdotgg/groundwork';
const NOW = new Date('2026-01-01T12:00:00Z');
const minutesAgo = (minutes) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const OWNER = 'wianvdm';
const OK_BODY = [
  'Outcome', 'Serves', 'Scope', 'Touches', 'Acceptance criteria', 'Verification plan', 'Risk', 'Context',
].map((heading) => `## ${heading}\n${heading === 'Serves' ? 'E1' : heading === 'Acceptance criteria' ? '- [ ] AC1 done' : 'x'}\n`).join('\n');
const OLD = minutesAgo(600);

function labeledEvents(labels) {
  return labels
    .filter((label) => label === 'accepted' || label.startsWith('priority:'))
    .map((label) => ({ event: 'labeled', label: { name: label }, actor: { login: OWNER }, created_at: OLD }));
}

// One issue's worth of fixtures for `loadIssueFacts`.
function issueRoutes(issue) {
  const { number, parent = null, labels = [], ref = null, pr = null, type = 'Feature' } = issue;
  const own = `${BASE}/issues/${number}`;
  const routes = {
    [`GET ${own}`]: { status: 200, data: {
      number, title: `task ${number}`, type: { name: type }, state: 'open', user: { login: issue.author ?? OWNER },
      body: issue.body ?? OK_BODY, labels: labels.map((name) => ({ name })),
    } },
    [`GET ${own}/timeline?per_page=100`]: { status: 200, data: labeledEvents(labels) },
    [`GET ${own}/parent`]: parent
      ? { status: 200, data: {
        number: parent.number, repository_url: `https://api.github.com${BASE}`, type: { name: 'Epic' },
        labels: parent.labels.map((name) => ({ name })),
      } }
      : { status: 404, data: {} },
    [`GET ${own}/dependencies/blocked_by?per_page=100`]: { status: 200, data: issue.blockedBy ?? [] },
    [`GET ${BASE}/git/ref/heads/issue/${number}`]: ref ? { status: 200, data: { object: { sha: `sha${number}` } } } : { status: 404, data: {} },
    [`GET ${own}/comments?per_page=100`]: { status: 200, data: [] },
    [`GET ${BASE}/pulls?head=wimdotgg%3Aissue%2F${number}&per_page=100&state=all`]: { status: 200, data: pr ? [{
      number: 900 + number, state: 'open', draft: pr.draft ?? true, head: { ref: `issue/${number}`, repo: { full_name: 'wimdotgg/groundwork' } },
      created_at: pr.createdAt, body: pr.released ? '<!-- groundwork:released -->' : '',
    }] : [] },
  };
  if (ref) {
    routes[`GET ${BASE}/git/commits/sha${number}`] = { status: 200, data: { message: `chore(claim): #${number} [session s]`, committer: { date: minutesAgo(5) } } };
  }
  if (pr) routes[`GET ${BASE}/issues/${900 + number}/comments?per_page=100`] = { status: 200, data: [] };
  return routes;
}

// `epics`: [{ number, labels, children: [issue] }]; `bugs`: top-level p0 Bug issues.
function world({ epics = [], bugs = [] }) {
  const routes = {
    [`GET ${BASE}/issues?per_page=100&state=open&type=Epic`]: { status: 200, data: epics.map((epic) => ({ number: epic.number })) },
    [`GET ${BASE}/issues?labels=priority%3Ap0&per_page=100&state=open&type=Bug`]: { status: 200, data: bugs.map((bug) => ({ number: bug.number })) },
  };
  const graphql = [];
  const addIssue = (issue) => {
    Object.assign(routes, issueRoutes(issue));
    if (issue.pr) graphql.push({ status: 200, data: { data: { repository: { pullRequest: { isInMergeQueue: false } } } } });
  };
  for (const epic of epics) {
    addIssue({ ...epic, type: 'Epic' });
    routes[`GET ${BASE}/issues/${epic.number}/sub_issues?per_page=100`] = {
      status: 200, data: epic.children.map((child) => ({ number: child.number, state: 'open', type: { name: child.type ?? 'Feature' } })),
    };
    epic.children.forEach((child) => addIssue({ ...child, parent: epic }));
  }
  bugs.forEach(addIssue);
  if (graphql.length > 0) routes['POST /graphql'] = graphql;
  return createFixtureClient(routes);
}

const run = (spec) => rankCandidates({ client: world(spec), repoRef, config, now: NOW });
const order = ({ ranked }) => ranked.map((entry) => entry.pick.number);
const sized = (extra = []) => ['size:M', ...extra];
const task = (number, extra = {}) => ({ number, labels: sized(), ...extra });
const accepted = (number, children, extra = []) => ({ number, labels: ['accepted', ...extra], children });

test('AC1: a takeover candidate ranks before every fresh task', async () => {
  const stale = { createdAt: minutesAgo(300) };
  const result = await run({ epics: [
    accepted(10, [task(11), task(12, { ref: true, pr: stale })], ['priority:p3']),
    accepted(20, [task(21, { ref: true, pr: { createdAt: minutesAgo(10), released: true } })], ['priority:p0']),
  ] });
  assert.deepEqual(order(result), [21, 12, 11]);
  assert.equal(result.ranked[0].pick.kind, 'takeover');
  assert.equal(result.ranked[0].pick.reason, 'PR #921 carries the released marker');
  assert.equal(result.ranked[1].pick.reason, 'lease on PR #912 expired');
  assert.equal(result.ranked[2].pick.kind, 'fresh');
});

test('AC1: a live lease and a needs-decision task are not takeover candidates', async () => {
  const result = await run({ epics: [accepted(10, [
    task(11, { ref: true, pr: { createdAt: minutesAgo(10) } }),
    task(12, { ref: true, labels: sized(['needs-decision']), pr: { createdAt: minutesAgo(300) } }),
  ])] });
  assert.deepEqual(order(result), []);
  assert.deepEqual(result.skipped.map(({ number, code }) => [number, code]), [[11, 'claimed'], [12, 'needs-decision']]);
});

test('AC2: p0 hotfix, then epic priority, then sub-issue order', async () => {
  const result = await run({
    epics: [
      accepted(10, [task(11), task(12)], ['priority:p2']),
      accepted(20, [task(21), task(22)], ['priority:p1']),
      accepted(30, [task(31)]),
    ],
    bugs: [{ number: 40, type: 'Bug', labels: sized(['priority:p0']), body: `${OK_BODY}\n## Reproduction\nx\n\n## Expected vs actual\nx\n` }],
  });
  assert.deepEqual(order(result), [40, 21, 22, 11, 12, 31]);
  assert.equal(result.ranked[0].pick.epic, null);
  assert.equal(result.ranked[1].pick.epic, 20);
});

test('AC3: every skipped candidate carries its code and reason', async () => {
  const noForm = '## Outcome\nonly this\n';
  const result = await run({
    epics: [
      accepted(10, [
        task(11),
        task(12, { blockedBy: [{ number: 99, state: 'open' }] }),
        task(13, { ref: true, pr: { createdAt: minutesAgo(10) } }),
        task(14, { ref: true, pr: { createdAt: minutesAgo(10), draft: false } }),
        task(15, { labels: ['size:M', 'needs-format'] }),
        task(16, { body: noForm }),
        { number: 17, labels: [] },
        { number: 18, labels: ['size:L'] },
        task(19, { author: 'stranger' }),
        { number: 30, type: 'Epic', labels: [] },
      ]),
      { number: 20, labels: [], children: [task(21)] },
    ],
  });
  const codes = Object.fromEntries(result.skipped.map(({ number, code }) => [number, code]));
  assert.deepEqual(codes, {
    12: 'blocked', 13: 'claimed', 14: 'in-review', 15: 'needs-format', 16: 'needs-format', 17: 'size',
    18: 'size', 19: 'untrusted-author', 30: 'epic', 21: 'proposed',
  });
  assert.deepEqual(order(result), [11]);
  assert.ok(result.skipped.every((entry) => entry.reason.length > 0));
  assert.equal(result.skipped.find((entry) => entry.number === 16).reason, 'Missing section ## Serves');
});

test('AC4: --json prints the shape fixed in spec 13', async () => {
  const result = await run({ epics: [accepted(10, [task(11), task(12, { labels: [] })])] });
  const json = JSON.parse(formatOutput(chooseNext(result.ranked, result.skipped), { json: true }));
  assert.deepEqual(json, {
    ok: true,
    next: { kind: 'fresh', number: 11, pr: null, epic: 10, title: 'task 11', reason: 'accepted ancestor' },
    skipped: [{ number: 12, code: 'size', reason: 'needs exactly size:S or size:M' }],
  });
});

test('AC4: nothing ready is a null next with the skipped list', async () => {
  const result = await run({ epics: [{ number: 10, labels: [], children: [task(11)] }] });
  const json = JSON.parse(formatOutput(chooseNext(result.ranked, result.skipped), { json: true }));
  assert.equal(json.ok, true);
  assert.equal(json.next, null);
  assert.deepEqual(json.skipped.map((entry) => entry.code), ['proposed']);
  assert.match(formatOutput(chooseNext(result.ranked, result.skipped), { json: false }), /^nothing ready\nskipped #11 proposed:/);
});

test('arguments: only --json is accepted', () => {
  assert.deepEqual(parseArgs(['--json']), { json: true });
  assert.deepEqual(parseArgs([]), { json: false });
  assert.throws(() => parseArgs(['--verbose']), /usage/);
});

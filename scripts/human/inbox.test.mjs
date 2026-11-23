import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureClient } from '../lib/github.mjs';
import { loadConfig, repoRoot } from '../lib/config.mjs';
import { collectInbox, formatOutput, isProtectedPath, parseArgs, parseProtectedPatterns } from './inbox.mjs';

const root = repoRoot(import.meta.url);
const config = await loadConfig({ root });
const repoRef = { owner: 'wimdotgg', repo: 'groundwork' };
const BASE = '/repos/wimdotgg/groundwork';
const HTML = 'https://github.com/wimdotgg/groundwork';
const OWNER = 'wianvdm';
const LONG_AGO = '2026-01-01T00:00:00Z';

const issue = (number, extra = {}) => ({
  number, title: `issue ${number}`, html_url: `${HTML}/issues/${number}`, labels: [], user: { login: OWNER }, ...extra,
});
const pull = (number, extra = {}) => ({
  number,
  title: `pull ${number}`,
  html_url: `${HTML}/pull/${number}`,
  labels: [],
  draft: false,
  user: { login: OWNER },
  head: { sha: `head${number}`, ref: `topic-${number}`, repo: { full_name: 'wimdotgg/groundwork' } },
  ...extra,
});
const alertTitle = (number) => `\`\`\`untrusted github-actions[bot]\n#${number} issue ${number}\n\`\`\``;

// Routes every list the inbox reads; a test overrides the ones it cares about.
function inboxClient(overrides = {}, options = {}) {
  const ok = (data) => ({ status: 200, data });
  return createFixtureClient({
    [`GET ${BASE}/issues?per_page=100&state=open`]: ok([]),
    [`GET ${BASE}/pulls?per_page=100&state=open`]: ok([]),
    [`GET ${BASE}/actions/runs?per_page=100&status=waiting`]: ok({ total_count: 0, workflow_runs: [] }),
    [`GET ${BASE}/git/matching-refs/heads/issue/?per_page=100`]: ok([]),
    ...overrides,
  }, options);
}

const sectionOf = (sections, key) => sections.find((section) => section.key === key);
const collect = (client) => collectInbox({ client, repoRef, config, root });

test('an inbox with nothing waiting prints one line', async () => {
  const sections = await collect(inboxClient());
  assert.equal(formatOutput(sections, { json: false }), 'inbox empty: nothing waits on you');
  assert.equal(JSON.parse(formatOutput(sections, { json: true })).empty, true);
});

test('lists an epic without a valid accepted label as a proposed epic', async () => {
  const sections = await collect(inboxClient({
    [`GET ${BASE}/issues?per_page=100&state=open`]: { status: 200, data: [
      issue(10, { type: { name: 'Epic' } }),
      issue(11, { type: { name: 'Epic' }, labels: [{ name: 'accepted' }] }),
    ] },
    [`GET ${BASE}/issues/10/timeline?per_page=100`]: { status: 200, data: [] },
    [`GET ${BASE}/issues/11/timeline?per_page=100`]: { status: 200, data: [
      { event: 'labeled', label: { name: 'accepted' }, actor: { login: OWNER }, created_at: LONG_AGO },
    ] },
  }));
  assert.deepEqual(sectionOf(sections, 'proposed-epics').items, [{ title: '#10 issue 10', url: `${HTML}/issues/10` }]);
});

test('lists needs-decision issues and pull requests', async () => {
  const flagged = [{ name: 'needs-decision' }];
  const sections = await collect(inboxClient({
    [`GET ${BASE}/issues?per_page=100&state=open`]: { status: 200, data: [
      issue(20, { labels: flagged }),
      issue(21),
      issue(22, { labels: flagged, pull_request: {} }),
    ] },
    [`GET ${BASE}/pulls?per_page=100&state=open`]: { status: 200, data: [pull(22, { labels: flagged })] },
    [`GET ${BASE}/pulls/22/files?per_page=100`]: { status: 200, data: [] },
  }));
  assert.deepEqual(sectionOf(sections, 'needs-decision').items.map((item) => item.title), ['#20 issue 20', '#22 pull 22']);
  assert.equal(sectionOf(sections, 'needs-decision').items[1].detail, 'PR');
});

test('lists ready pull requests on protected paths and skips drafts, unprotected PRs and the release PR', async () => {
  const sections = await collect(inboxClient({
    [`GET ${BASE}/pulls?per_page=100&state=open`]: { status: 200, data: [
      pull(30), pull(31), pull(32, { draft: true }), pull(33, { labels: [{ name: 'autorelease: pending' }] }),
    ] },
    [`GET ${BASE}/pulls/30/files?per_page=100`]: { status: 200, data: [{ filename: 'scripts/lib/github.mjs' }] },
    [`GET ${BASE}/pulls/30/reviews?per_page=100`]: { status: 200, data: [] },
    [`GET ${BASE}/pulls/31/files?per_page=100`]: { status: 200, data: [{ filename: 'scripts/agent/next.mjs' }] },
  }));
  assert.deepEqual(sectionOf(sections, 'protected-pulls').items.map((item) => item.title), ['#30 pull 30']);
});

test('lists the release PR by its autorelease label', async () => {
  const sections = await collect(inboxClient({
    [`GET ${BASE}/pulls?per_page=100&state=open`]: { status: 200, data: [
      pull(40, { labels: [{ name: 'autorelease: pending' }] }), pull(41),
    ] },
    [`GET ${BASE}/pulls/41/files?per_page=100`]: { status: 200, data: [] },
  }));
  assert.deepEqual(sectionOf(sections, 'release-pull').items.map((item) => item.title), ['#40 pull 40']);
});

test('lists runs waiting on a production or admin approval', async () => {
  const runs = [
    { id: 1, name: 'deploy', html_url: `${HTML}/actions/runs/1` },
    { id: 2, name: 'build', html_url: `${HTML}/actions/runs/2` },
  ];
  const sections = await collect(inboxClient({
    [`GET ${BASE}/actions/runs?per_page=100&status=waiting`]: { status: 200, data: { total_count: 2, workflow_runs: runs } },
    [`GET ${BASE}/actions/runs/1/pending_deployments?per_page=100`]: { status: 200, data: [{ environment: { name: 'admin' } }] },
    [`GET ${BASE}/actions/runs/2/pending_deployments?per_page=100`]: { status: 200, data: [{ environment: { name: 'staging' } }] },
  }));
  assert.deepEqual(sectionOf(sections, 'pending-approvals').items, [
    { title: 'deploy #1', url: `${HTML}/actions/runs/1`, detail: 'admin' },
  ]);
});

test('lists open issues authored by github-actions[bot] as alerts', async () => {
  const sections = await collect(inboxClient({
    [`GET ${BASE}/issues?per_page=100&state=open`]: { status: 200, data: [
      issue(50, { user: { login: 'github-actions[bot]' } }), issue(51),
    ] },
  }));
  assert.deepEqual(sectionOf(sections, 'alert-issues').items.map((item) => item.title), [alertTitle(50)]);
});

test('lists a claim whose PR closed unmerged with the branch to delete', async () => {
  const own = `${BASE}/issues/60`;
  const sections = await collect(inboxClient({
    [`GET ${BASE}/issues?per_page=100&state=open`]: { status: 200, data: [issue(60)] },
    [`GET ${BASE}/git/matching-refs/heads/issue/?per_page=100`]: { status: 200, data: [
      { ref: 'refs/heads/issue/60' }, { ref: 'refs/heads/issue/61' },
    ] },
    [`GET ${own}`]: { status: 200, data: issue(60, { type: { name: 'Feature' }, state: 'open', body: '' }) },
    [`GET ${own}/timeline?per_page=100`]: { status: 200, data: [] },
    [`GET ${own}/parent`]: { status: 404, data: {} },
    [`GET ${own}/dependencies/blocked_by?per_page=100`]: { status: 200, data: [] },
    [`GET ${BASE}/git/ref/heads/issue/60`]: { status: 200, data: { object: { sha: 'sha60' } } },
    [`GET ${own}/comments?per_page=100`]: { status: 200, data: [] },
    [`GET ${BASE}/git/commits/sha60`]: { status: 200, data: { message: 'chore(claim): #60 [session s]', committer: { date: LONG_AGO } } },
    [`GET ${BASE}/pulls?head=wimdotgg%3Aissue%2F60&per_page=100&state=all`]: { status: 200, data: [{
      number: 960, state: 'closed', draft: true, head: { ref: 'issue/60', repo: { full_name: 'wimdotgg/groundwork' } }, created_at: LONG_AGO, body: '',
    }] },
    [`GET ${BASE}/issues/960/comments?per_page=100`]: { status: 200, data: [] },
  }));
  assert.deepEqual(sectionOf(sections, 'orphaned-claims').items, [
    { title: '#60 issue 60', url: `${HTML}/issues/60`, detail: 'delete branch issue/60' },
  ]);
});

test('marks a section the token cannot read as unreadable and keeps the others', async () => {
  const sections = await collect(inboxClient({
    [`GET ${BASE}/actions/runs?per_page=100&status=waiting`]: { status: 403, data: { message: 'Resource not accessible by integration' } },
    [`GET ${BASE}/issues?per_page=100&state=open`]: { status: 200, data: [issue(70, { user: { login: 'github-actions[bot]' } })] },
  }));
  assert.match(sectionOf(sections, 'pending-approvals').unreadable, /403|not accessible/i);
  assert.equal(sectionOf(sections, 'alert-issues').items.length, 1);
  const text = formatOutput(sections, { json: false });
  assert.match(text, /Pending production and admin approvals: unreadable/);
  assert.match(text, /Alert issues \(1\)/);
});

test('formats items with their links, and --json carries every section', async () => {
  const sections = await collect(inboxClient({
    [`GET ${BASE}/issues?per_page=100&state=open`]: { status: 200, data: [issue(80, { user: { login: 'github-actions[bot]' } })] },
  }));
  assert.equal(formatOutput(sections, { json: false }), `Alert issues (1)\n  ${alertTitle(80)}\n    ${HTML}/issues/80`);
  const json = JSON.parse(formatOutput(sections, { json: true }));
  assert.equal(json.ok, true);
  assert.equal(json.sections.length, 8);
});

test('matches protected paths from CODEOWNERS as prefixes, exact paths and globs', () => {
  const patterns = parseProtectedPatterns('# note\n/scripts/lib/ @o\n/AGENTS.md @o\n/scripts/verify* @o\n');
  assert.deepEqual(patterns, ['/scripts/lib/', '/AGENTS.md', '/scripts/verify*']);
  assert.equal(isProtectedPath('scripts/lib/a.mjs', patterns), true);
  assert.equal(isProtectedPath('AGENTS.md', patterns), true);
  assert.equal(isProtectedPath('scripts/verify.cmd', patterns), true);
  assert.equal(isProtectedPath('scripts/agent/next.mjs', patterns), false);
});

test('an anchored pattern without a trailing slash covers a directory of that name', () => {
  assert.equal(isProtectedPath('docs/a.md', ['/docs']), true);
  assert.equal(isProtectedPath('other/docs/a.md', ['/docs']), false);
});

test('a glob on a directory name covers files below the match', () => {
  assert.equal(isProtectedPath('scripts/verify/x.sh', ['/scripts/verify*']), true);
});

test('an unanchored pattern matches at any depth', () => {
  assert.equal(isProtectedPath('app/web/vite.config.js', ['*.config.js']), true);
  assert.equal(isProtectedPath('app/config/a.json', ['config/']), true);
  assert.equal(isProtectedPath('app/config', ['config/']), false);
  assert.equal(isProtectedPath('app/web/main.js', ['*.config.js']), false);
});

test('an error other than 403 or 404 stops the run', async () => {
  const client = inboxClient({
    [`GET ${BASE}/actions/runs?per_page=100&status=waiting`]: { status: 500, data: { message: 'boom' } },
  });
  await assert.rejects(collect(client), /boom|500/);
});

test('leaves out a protected PR the owner approved on its current head', async () => {
  const review = (commit, state = 'APPROVED', login = OWNER) => ({ state, commit_id: commit, user: { login } });
  const sections = await collect(inboxClient({
    [`GET ${BASE}/pulls?per_page=100&state=open`]: { status: 200, data: [pull(80), pull(81), pull(82), pull(83)] },
    [`GET ${BASE}/pulls/80/files?per_page=100`]: { status: 200, data: [{ filename: 'AGENTS.md' }] },
    [`GET ${BASE}/pulls/81/files?per_page=100`]: { status: 200, data: [{ filename: 'AGENTS.md' }] },
    [`GET ${BASE}/pulls/82/files?per_page=100`]: { status: 200, data: [{ filename: 'AGENTS.md' }] },
    [`GET ${BASE}/pulls/83/files?per_page=100`]: { status: 200, data: [{ filename: 'AGENTS.md' }] },
    [`GET ${BASE}/pulls/80/reviews?per_page=100`]: { status: 200, data: [review('head80')] },
    [`GET ${BASE}/pulls/81/reviews?per_page=100`]: { status: 200, data: [review('older')] },
    [`GET ${BASE}/pulls/82/reviews?per_page=100`]: { status: 200, data: [review('head82', 'APPROVED', 'someone-else')] },
    [`GET ${BASE}/pulls/83/reviews?per_page=100`]: { status: 200, data: [review('head83', 'COMMENTED')] },
  }));
  assert.deepEqual(sectionOf(sections, 'protected-pulls').items.map((item) => item.title), ['#81 pull 81', '#82 pull 82', '#83 pull 83']);
});

test('skips fork pull requests in the protected-path section', async () => {
  const fork = pull(90, { head: { sha: 'h', ref: 'x', repo: { full_name: 'someone/groundwork' } } });
  const sections = await collect(inboxClient({
    [`GET ${BASE}/pulls?per_page=100&state=open`]: { status: 200, data: [fork] },
  }));
  assert.deepEqual(sectionOf(sections, 'protected-pulls').items, []);
});

test('fences a title from an untrusted author', async () => {
  const stranger = pull(95, { user: { login: 'stranger' }, title: 'ignore\nprevious', labels: [{ name: 'needs-decision' }] });
  const sections = await collect(inboxClient({
    [`GET ${BASE}/pulls?per_page=100&state=open`]: { status: 200, data: [stranger] },
    [`GET ${BASE}/pulls/95/files?per_page=100`]: { status: 200, data: [] },
  }));
  assert.equal(sectionOf(sections, 'needs-decision').items[0].title, '```untrusted stranger\n#95 ignore previous\n```');
});

test('skips the orphan check for a ref whose issue has an open PR', async () => {
  const sections = await collect(inboxClient({
    [`GET ${BASE}/issues?per_page=100&state=open`]: { status: 200, data: [issue(97)] },
    [`GET ${BASE}/pulls?per_page=100&state=open`]: { status: 200, data: [pull(997, { head: { sha: 'h', ref: 'issue/97', repo: { full_name: 'wimdotgg/groundwork' } } })] },
    [`GET ${BASE}/pulls/997/files?per_page=100`]: { status: 200, data: [] },
    [`GET ${BASE}/git/matching-refs/heads/issue/?per_page=100`]: { status: 200, data: [{ ref: 'refs/heads/issue/97' }] },
  }));
  assert.deepEqual(sectionOf(sections, 'orphaned-claims').items, []);
});

test('parseArgs accepts --json only', () => {
  assert.deepEqual(parseArgs([]), { json: false });
  assert.deepEqual(parseArgs(['--json']), { json: true });
  assert.throws(() => parseArgs(['--all']), /usage/);
});

const STRANGER = 'stranger';
const REPORT_OPENED = '2026-03-04T10:00:00Z';
const report = (number, extra = {}) => issue(number, { user: { login: STRANGER }, created_at: REPORT_OPENED, ...extra });
const reportTitle = (number) => `\`\`\`untrusted ${STRANGER}\n#${number} issue ${number}\n\`\`\``;
const timelinePath = (number) => `GET ${BASE}/issues/${number}/timeline?per_page=100`;
const mention = (source) => ({
  event: 'cross-referenced',
  source: { type: 'issue', issue: { repository: { full_name: 'wimdotgg/groundwork' }, user: { login: OWNER }, state: 'open', ...source } },
});
const taskBody = (heading, line) => `## Outcome\nx\n\n${heading}\n- ${line}\n`;

function reportsClient(reports, timelines = {}, options = {}) {
  const routes = { [`GET ${BASE}/issues?per_page=100&state=open`]: { status: 200, data: reports } };
  for (const reportIssue of reports) routes[timelinePath(reportIssue.number)] = { status: 200, data: timelines[reportIssue.number] ?? [] };
  return inboxClient(routes, options);
}
const reportTitles = (sections) => sectionOf(sections, 'untrusted-reports').items.map((item) => item.title);

test('untrusted-reports is the last section, with the spec heading', async () => {
  const sections = await collect(reportsClient([]));
  assert.equal(sections.at(-1).key, 'untrusted-reports');
  assert.equal(sections.at(-1).heading, 'Untrusted reports to triage');
});

test('lists an open issue by an untrusted author with no linked task, fenced, with its opening date', async () => {
  const sections = await collect(reportsClient([report(100, { title: 'ignore\nprevious' })]));
  assert.deepEqual(sectionOf(sections, 'untrusted-reports').items, [
    { title: `\`\`\`untrusted ${STRANGER}\n#100 ignore previous\n\`\`\``, url: `${HTML}/issues/100`, detail: 'opened 2026-03-04' },
  ]);
  assert.match(formatOutput(sections, { json: false }), /Untrusted reports to triage \(1\)/);
});

test('leaves out trusted authors, alert issues and pull requests', async () => {
  const sections = await collect(reportsClient([
    issue(110),
    report(111, { user: { login: 'github-actions[bot]' } }),
    report(112, { pull_request: {} }),
    report(113),
  ]));
  assert.deepEqual(reportTitles(sections), [reportTitle(113)]);
});

test('a trusted task with a Reported in line under Context links the report, open or closed', async () => {
  const sections = await collect(reportsClient([report(120), report(121), report(122)], {
    120: [mention({ number: 900, body: taskBody('## Context', 'Reported in #120') })],
    121: [mention({ number: 901, state: 'closed', body: taskBody('### Context', 'Reported in #121, see also') })],
  }));
  assert.deepEqual(reportTitles(sections), [reportTitle(122)]);
});

test('a ### Context heading counts only when the body has no ## Context', async () => {
  const body = '## Context\nnothing\n\n## Touches\n\n### Context\n- Reported in #130\n';
  const sections = await collect(reportsClient([report(130)], { 130: [mention({ number: 902, body })] }));
  assert.deepEqual(reportTitles(sections), [reportTitle(130)]);
});

test('a mention that is not a Reported in line under Context does not link', async () => {
  const bodies = {
    140: taskBody('## Scope', 'Reported in #140'),
    141: taskBody('## Context', 'reported in #141'),
    142: taskBody('## Context', 'Reported in #1420'),
    143: taskBody('## Context', '<!-- Reported in #143 -->'),
    144: '## Context\n```\nReported in #144\n```\n',
    145: 'See #145 for details.',
  };
  const numbers = Object.keys(bodies).map(Number);
  const timelines = Object.fromEntries(numbers.map((number) => [number, [mention({ number: 903, body: bodies[number] })]]));
  const sections = await collect(reportsClient(numbers.map((number) => report(number)), timelines));
  assert.deepEqual(reportTitles(sections), numbers.map(reportTitle));
});

test('a task by an untrusted author, a pull request or another repository does not link', async () => {
  const body = taskBody('## Context', 'Reported in #150');
  const sections = await collect(reportsClient([report(150)], { 150: [
    mention({ number: 904, body, user: { login: STRANGER } }),
    mention({ number: 905, body, pull_request: {} }),
    mention({ number: 906, body, repository: { full_name: 'someone/else' } }),
    { event: 'labeled', label: { name: 'x' } },
  ] }));
  assert.deepEqual(reportTitles(sections), [reportTitle(150)]);
});

test('a 403 or 404 on a timeline marks the section unreadable and keeps the others', async () => {
  for (const status of [403, 404]) {
    const client = inboxClient({
      [`GET ${BASE}/issues?per_page=100&state=open`]: { status: 200, data: [report(160), issue(161, { user: { login: 'github-actions[bot]' } })] },
      [timelinePath(160)]: { status, data: { message: 'nope' } },
    });
    const sections = await collect(client);
    assert.match(sectionOf(sections, 'untrusted-reports').unreadable, new RegExp(String(status)));
    assert.equal(sectionOf(sections, 'alert-issues').items.length, 1);
    assert.match(formatOutput(sections, { json: false }), /Untrusted reports to triage: unreadable/);
  }
});

test('the triage read sends GET requests only', async () => {
  const methods = [];
  const linked = [mention({ number: 907, body: taskBody('## Context', 'Reported in #170') })];
  await collect(reportsClient([report(170), report(171)], { 170: linked }, { onCall: (record) => methods.push(record.method) }));
  assert.ok(methods.length > 0);
  assert.deepEqual([...new Set(methods)], ['GET']);
});

test('--json keeps the shape and carries the untrusted-reports key', async () => {
  const sections = await collect(reportsClient([report(180)]));
  const json = JSON.parse(formatOutput(sections, { json: true }));
  assert.deepEqual(Object.keys(json), ['ok', 'empty', 'sections']);
  assert.equal(json.empty, false);
  assert.equal(json.sections.at(-1).key, 'untrusted-reports');
});

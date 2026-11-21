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
  number, title: `pull ${number}`, html_url: `${HTML}/pull/${number}`, labels: [], draft: false, ...extra,
});

// Routes every list the inbox reads; a test overrides the ones it cares about.
function inboxClient(overrides = {}) {
  const ok = (data) => ({ status: 200, data });
  return createFixtureClient({
    [`GET ${BASE}/issues?per_page=100&state=open`]: ok([]),
    [`GET ${BASE}/pulls?per_page=100&state=open`]: ok([]),
    [`GET ${BASE}/actions/runs?per_page=100&status=waiting`]: ok({ total_count: 0, workflow_runs: [] }),
    [`GET ${BASE}/git/matching-refs/heads/issue/?per_page=100`]: ok([]),
    ...overrides,
  });
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
  assert.deepEqual(sectionOf(sections, 'alert-issues').items.map((item) => item.title), ['#50 issue 50']);
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
  assert.equal(formatOutput(sections, { json: false }), `Alert issues (1)\n  #80 issue 80\n    ${HTML}/issues/80`);
  const json = JSON.parse(formatOutput(sections, { json: true }));
  assert.equal(json.ok, true);
  assert.equal(json.sections.length, 7);
});

test('matches protected paths from CODEOWNERS as prefixes, exact paths and globs', () => {
  const patterns = parseProtectedPatterns('# note\n/scripts/lib/ @o\n/AGENTS.md @o\n/scripts/verify* @o\n');
  assert.deepEqual(patterns, ['scripts/lib/', 'AGENTS.md', 'scripts/verify*']);
  assert.equal(isProtectedPath('scripts/lib/a.mjs', patterns), true);
  assert.equal(isProtectedPath('AGENTS.md', patterns), true);
  assert.equal(isProtectedPath('scripts/verify.cmd', patterns), true);
  assert.equal(isProtectedPath('scripts/agent/next.mjs', patterns), false);
});

test('parseArgs accepts --json only', () => {
  assert.deepEqual(parseArgs([]), { json: false });
  assert.deepEqual(parseArgs(['--json']), { json: true });
  assert.throws(() => parseArgs(['--all']), /usage/);
});

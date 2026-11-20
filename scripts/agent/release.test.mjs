import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFixtureClient } from '../lib/github.mjs';
import { hasMarker } from '../lib/markdown.mjs';
import { parseArguments, release, ReleaseRefusal } from './release.mjs';

const REPO = { owner: 'o', repo: 'r' };
const AGENT = 'o-agent[bot]';
const SESSION = 'w89-a1';
const config = { accounts: { agent: AGENT } };
const handoverTemplate = await readFile(new URL('../../.github/groundwork/templates/handover-comment.md', import.meta.url), 'utf8');
const ok = (data) => ({ status: 200, data, headers: {} });
const created = { status: 201, data: {}, headers: {} };

const STATE = [
  '## State  (checkpoint 2 · 2026-11-20 10:00 · sonnet/claude-code · session w89-a1)',
  'Done:        built release.mjs',
  'In progress: none',
  'Next:        none',
  'Proven:      tests',
  'Unproven:    none',
  'Rejected:    none',
  'Gotchas:     footer stays last',
  'Open:        spec 13 wording',
].join('\n');
const FOOTER = '---\nAgent: sonnet/claude-code · session w89-a1';
const MARKER = '<!-- groundwork:released -->';
const prBody = (session = SESSION) => `Closes #89\n\n${STATE}\n\n${FOOTER.replace(SESSION, session)}\n`;

const pull = (overrides = {}) => ({
  number: 7, node_id: 'PR_7', state: 'open', draft: true, merged_at: null, merge_commit_sha: 'abc123',
  created_at: '2026-11-20T09:00:00Z', head: { ref: 'issue/89' }, body: prBody(), ...overrides,
});
const mergedPull = (overrides = {}) => pull({ state: 'closed', draft: false, merged_at: '2026-11-21T08:30:00Z', ...overrides });

const PULLS = 'GET /repos/o/r/pulls?head=o%3Aissue%2F89&per_page=100&state=all';
const ISSUE_COMMENTS = 'GET /repos/o/r/issues/89/comments?per_page=100';
const PATCH_PULL = 'PATCH /repos/o/r/pulls/7';

/** Fixture client that also keeps every write, GraphQL mutations included. */
function recordingClient(routes) {
  const writes = [];
  const client = createFixtureClient(routes);
  const { request, graphql } = client;
  client.request = async (method, path, options) => {
    if (method !== 'GET') writes.push({ method, path, body: options?.body });
    return request(method, path, options);
  };
  client.graphql = async (query, variables) => {
    writes.push({ method: 'POST', path: '/graphql', body: variables });
    return graphql(query, variables);
  };
  return { client, writes };
}

const context = (client) => ({ client, repo: REPO, config, handoverTemplate });
const run = (client, mode) => release(context(client), { number: 89, mode, session: SESSION });
const refusalWith = (exitCode, pattern) => (error) => error instanceof ReleaseRefusal
  && error.exitCode === exitCode && pattern.test(error.message);

test('decision: puts the released marker above the footer, keeps the State, writes one PATCH with only body', async () => {
  const { client, writes } = recordingClient({ [PULLS]: ok([pull()]), [PATCH_PULL]: ok({}) });
  const result = await run(client, 'decision');
  assert.deepEqual(result, { ok: true, number: 89, mode: 'decision', changed: true });
  assert.equal(writes.length, 1);
  assert.deepEqual([writes[0].method, writes[0].path], ['PATCH', '/repos/o/r/pulls/7']);
  assert.deepEqual(Object.keys(writes[0].body), ['body']);
  const { body } = writes[0].body;
  assert.ok(hasMarker(body, 'released'));
  assert.ok(body.includes(STATE));
  assert.ok(body.trimEnd().endsWith(FOOTER));
});

test('decision: a ready PR is converted to draft first, then marked', async () => {
  const { client, writes } = recordingClient({
    [PULLS]: ok([pull({ draft: false })]), 'POST /graphql': ok({ data: {} }), [PATCH_PULL]: ok({}),
  });
  const result = await run(client, 'decision');
  assert.equal(result.changed, true);
  assert.deepEqual(writes.map((write) => write.path), ['/graphql', '/repos/o/r/pulls/7']);
  assert.deepEqual(writes[0].body, { id: 'PR_7' });
});

test('decision: a rerun changes nothing', async () => {
  const marked = prBody().replace('---', `${MARKER}\n\n---`);
  const { client, writes } = recordingClient({ [PULLS]: ok([pull({ body: marked })]) });
  assert.equal((await run(client, 'decision')).changed, false);
  assert.deepEqual(writes, []);
});

test('decision: another session in the footer exits 3 before any write, ready PR or not', async () => {
  for (const draft of [true, false]) {
    const { client, writes } = recordingClient({ [PULLS]: ok([pull({ draft, body: prBody('other-1') })]) });
    await assert.rejects(run(client, 'decision'), (error) => refusalWith(3, /other-1/)(error) && error.session === 'other-1');
    assert.deepEqual(writes, []);
  }
});

test('decision: refuses a closed PR with exit 1', async () => {
  const { client, writes } = recordingClient({ [PULLS]: ok([pull({ state: 'closed' })]) });
  await assert.rejects(run(client, 'decision'), refusalWith(1, /not open/));
  assert.deepEqual(writes, []);
});

test('merged: refuses an unmerged PR with exit 1', async () => {
  const { client, writes } = recordingClient({ [PULLS]: ok([pull()]) });
  await assert.rejects(run(client, 'merged'), refusalWith(1, /not merged/));
  assert.deepEqual(writes, []);
});

const featureIssue = ok({ number: 89, type: { name: 'Feature' } });

test('merged: posts the handover from the template and ignores a marker from another author', async () => {
  const { client, writes } = recordingClient({
    [PULLS]: ok([mergedPull()]),
    'GET /repos/o/r/issues/89': featureIssue,
    [ISSUE_COMMENTS]: ok([{ user: { login: 'someone' }, body: '<!-- groundwork:handover -->' }]),
    'POST /repos/o/r/issues/89/comments': created,
  });
  const result = await run(client, 'merged');
  assert.deepEqual(result, { ok: true, number: 89, mode: 'merged', changed: true });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.body, [
    'Handover: #89 merged in PR #7.',
    'Done: built release.mjs',
    'Follow-ups: spec 13 wording',
    'Gotchas: footer stays last',
    'Session: w89-a1',
    '<!-- groundwork:handover -->',
  ].join('\n'));
});

test('merged: a rerun posts no second handover', async () => {
  const { client, writes } = recordingClient({
    [PULLS]: ok([mergedPull()]),
    'GET /repos/o/r/issues/89': featureIssue,
    [ISSUE_COMMENTS]: ok([{ user: { login: AGENT }, body: 'Handover: #89\n<!-- groundwork:handover -->' }]),
  });
  assert.equal((await run(client, 'merged')).changed, false);
  assert.deepEqual(writes, []);
});

test('merged: refuses before any write when a State field is missing', async () => {
  const body = prBody().replace(/Gotchas:.*\n/, '');
  const { client, writes } = recordingClient({ [PULLS]: ok([mergedPull({ body })]) });
  await assert.rejects(run(client, 'merged'), /handover not filled: <gotchas>/);
  assert.deepEqual(writes, []);
});

const DECISION_URL = 'https://github.com/o/r/blob/abc123/docs/decisions/89-queue-shape.md';
const DECISION_LINE = `- 2026-11-21: Spike #89 decided in [docs/decisions/89-queue-shape.md](${DECISION_URL}) (PR #7).`;
const EPIC_BODY = '## Goal\ng\n\n## Decisions\n- 2026-11-01: earlier choice.\n\n## Open questions\nnone\n';
const epic = (body, overrides = {}) => ok({
  number: 74, type: { name: 'Epic' }, repository_url: 'https://api.github.com/repos/o/r', body, ...overrides,
});
const spikeRoutes = (parent, comments = []) => ({
  [PULLS]: ok([mergedPull()]),
  'GET /repos/o/r/issues/89': ok({ number: 89, type: { name: 'Spike' } }),
  'GET /repos/o/r/issues/89/parent': parent,
  'GET /repos/o/r/pulls/7/files?per_page=100': ok([
    { filename: 'docs/decisions/890-other.md' }, { filename: 'docs/decisions/89-queue-shape.md' },
  ]),
  [ISSUE_COMMENTS]: ok(comments),
  'POST /repos/o/r/issues/89/comments': created,
  'PATCH /repos/o/r/issues/74': ok({}),
});
const epicWrite = (writes) => writes.find((write) => write.path === '/repos/o/r/issues/74');

test('merged spike: appends one dated line linking the file at the merge commit', async () => {
  const { client, writes } = recordingClient(spikeRoutes(epic(EPIC_BODY)));
  assert.equal((await run(client, 'merged')).changed, true);
  assert.equal(epicWrite(writes).body.body, EPIC_BODY.replace('choice.\n', `choice.\n${DECISION_LINE}\n`));
});

test('merged spike: keeps HTML comments and fences in Decisions', async () => {
  const decisions = '<!-- keep me -->\n- a.\n\n```\nfenced\n```';
  const { client, writes } = recordingClient(spikeRoutes(epic(`## Decisions\n${decisions}\n\n## Open questions\nnone\n`)));
  await run(client, 'merged');
  assert.ok(epicWrite(writes).body.body.includes(`${decisions}\n${DECISION_LINE}\n`));
});

test('merged spike: a rerun adds no second line and no second comment', async () => {
  const posted = [{ user: { login: AGENT }, body: '<!-- groundwork:handover -->' }];
  const { client, writes } = recordingClient(spikeRoutes(epic(EPIC_BODY.replace('choice.\n', `choice.\n${DECISION_LINE}\n`)), posted));
  assert.equal((await run(client, 'merged')).changed, false);
  assert.deepEqual(writes, []);
});

test('merged spike: refuses before posting when the decision file, the parent repo or the parent type is wrong', async () => {
  const noFile = spikeRoutes(epic(EPIC_BODY));
  noFile['GET /repos/o/r/pulls/7/files?per_page=100'] = ok([{ filename: 'README.md' }]);
  const cases = [
    [noFile, /docs\/decisions\/89-<slug>\.md/],
    [spikeRoutes(epic(EPIC_BODY, { repository_url: 'https://api.github.com/repos/x/y' })), /not in o\/r/],
    [spikeRoutes(epic(EPIC_BODY, { type: { name: 'Feature' } })), /not an Epic/],
  ];
  for (const [routes, pattern] of cases) {
    const { client, writes } = recordingClient(routes);
    await assert.rejects(run(client, 'merged'), refusalWith(1, pattern));
    assert.deepEqual(writes, []);
  }
});

test('parseArguments: one mode, a valid session, a positive issue number', () => {
  assert.deepEqual(parseArguments(['89', '--decision', '--session', 'a.b-1', '--json'], {}), {
    number: 89, mode: 'decision', session: 'a.b-1', json: true,
  });
  assert.equal(parseArguments(['89', '--merged'], { GROUNDWORK_SESSION: 's1' }).session, 's1');
  assert.throws(() => parseArguments(['89', '--decision'], {}), /session id required/);
});

test('parseArguments: rejects an unknown flag and a --session value that is a flag', () => {
  assert.throws(() => parseArguments(['89', '--decision', '--force', '--session', 's'], {}), /unknown flag --force/);
  assert.throws(() => parseArguments(['89', '--decision', '--session', '--json'], {}), /--session needs a value/);
  assert.throws(() => parseArguments(['89', '--decision', '--session'], {}), /--session needs a value/);
});

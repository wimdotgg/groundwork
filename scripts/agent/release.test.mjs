import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFixtureClient } from '../lib/github.mjs';
import { hasMarker } from '../lib/markdown.mjs';
import { footerSession, parseArguments, release, ReleaseRefusal } from './release.mjs';

const REPO = { owner: 'o', repo: 'r' };
const AGENT = 'o-agent[bot]';
const SESSION = 'w89-a1';
const config = { accounts: { agent: AGENT } };
const handoverTemplate = await readFile(new URL('../../.github/groundwork/templates/handover-comment.md', import.meta.url), 'utf8');
const ok = (data) => ({ status: 200, data, headers: {} });
const notFound = { status: 404, data: {}, headers: {} };

const STATE = [
  '## State  (checkpoint 2 · 2026-11-20 10:00 · sonnet/claude-code · session w89-a1)',
  'Done:        built release.mjs',
  'In progress: none',
  'Next:        none',
  'Proven:      tests',
  'Unproven:    none',
  'Rejected:    none',
  'Gotchas:     marker sits after the footer',
  'Open:        spec 13 wording',
].join('\n');
const FOOTER = '---\nAgent: sonnet/claude-code · session w89-a1';
const prBody = (session = SESSION) => `Closes #89\n\n${STATE}\n\n${FOOTER.replace(SESSION, session)}\n`;

const pull = (overrides = {}) => ({
  number: 7, state: 'open', draft: true, merged_at: null, created_at: '2026-11-20T09:00:00Z',
  head: { ref: 'issue/89' }, body: prBody(), ...overrides,
});
const mergedPull = (overrides = {}) => pull({ state: 'closed', draft: false, merged_at: '2026-11-21T08:30:00Z', ...overrides });

const PULLS = 'GET /repos/o/r/pulls?head=o%3Aissue%2F89&per_page=100&state=all';
const ISSUE_COMMENTS = 'GET /repos/o/r/issues/89/comments?per_page=100';

/** Fixture client that also keeps the body of every write. */
function recordingClient(routes) {
  const writes = [];
  const client = createFixtureClient(routes);
  const request = client.request.bind(client);
  client.request = async (method, path, options) => {
    if (method !== 'GET') writes.push({ method, path, body: options?.body });
    return request(method, path, options);
  };
  return { client, writes };
}

const context = (client) => ({ client, repo: REPO, config, handoverTemplate });
const run = (client, mode) => release(context(client), { number: 89, mode, session: SESSION });

test('decision: adds the released marker, keeps the State and the footer, leaves the PR a draft', async () => {
  const { client, writes } = recordingClient({ [PULLS]: ok([pull()]), 'PATCH /repos/o/r/pulls/7': ok({}) });
  const result = await run(client, 'decision');
  assert.deepEqual(result, { ok: true, number: 89, mode: 'decision', changed: true });
  assert.equal(writes.length, 1);
  assert.deepEqual([writes[0].method, writes[0].path], ['PATCH', '/repos/o/r/pulls/7']);
  const { body } = writes[0].body;
  assert.ok(hasMarker(body, 'released'));
  assert.ok(body.includes(STATE));
  assert.ok(body.includes(FOOTER));
  assert.deepEqual(Object.keys(writes[0].body), ['body']);
});

test('decision: a rerun changes nothing', async () => {
  const marked = prBody().trimEnd() + '\n\n<!-- groundwork:released -->\n';
  const { client, writes } = recordingClient({ [PULLS]: ok([pull({ body: marked })]) });
  const result = await run(client, 'decision');
  assert.equal(result.changed, false);
  assert.deepEqual(writes, []);
});

test('decision: another session in the footer exits 3 before any write', async () => {
  const { client, writes } = recordingClient({ [PULLS]: ok([pull({ body: prBody('other-1') })]) });
  await assert.rejects(run(client, 'decision'), (error) => {
    assert.ok(error instanceof ReleaseRefusal);
    assert.equal(error.exitCode, 3);
    assert.equal(error.session, 'other-1');
    return true;
  });
  assert.deepEqual(writes, []);
});

test('decision: refuses a PR that is not an open draft, or a missing PR', async () => {
  const ready = recordingClient({ [PULLS]: ok([pull({ draft: false })]) });
  await assert.rejects(run(ready.client, 'decision'), /not an open draft/);
  const none = recordingClient({ [PULLS]: ok([]) });
  await assert.rejects(run(none.client, 'decision'), /no pull request/);
});

test('footerSession: finds the footer even when a marker follows it', () => {
  assert.equal(footerSession(`${prBody()}\n<!-- groundwork:released -->\n`), SESSION);
  assert.equal(footerSession('no footer'), null);
});

test('merged: refuses an unmerged PR with exit 1', async () => {
  const { client, writes } = recordingClient({ [PULLS]: ok([pull()]) });
  await assert.rejects(run(client, 'merged'), (error) => error instanceof ReleaseRefusal && error.exitCode === 1 && /not merged/.test(error.message));
  assert.deepEqual(writes, []);
});

const featureIssue = ok({ number: 89, type: { name: 'Feature' } });

test('merged: posts the handover from the template with Done, Gotchas and Follow-ups from the State', async () => {
  const { client, writes } = recordingClient({
    [PULLS]: ok([mergedPull()]),
    'GET /repos/o/r/issues/89': featureIssue,
    [ISSUE_COMMENTS]: ok([{ user: { login: 'someone' }, body: '<!-- groundwork:handover -->' }]),
    'POST /repos/o/r/issues/89/comments': { status: 201, data: {}, headers: {} },
  });
  const result = await run(client, 'merged');
  assert.deepEqual(result, { ok: true, number: 89, mode: 'merged', changed: true });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.body, [
    'Handover: #89 merged in PR #7.',
    'Done: built release.mjs',
    'Follow-ups: spec 13 wording',
    'Gotchas: marker sits after the footer',
    'Session: w89-a1',
    '<!-- groundwork:handover -->',
  ].join('\n'));
});

test('merged: a rerun posts no second handover; a marker from another author does not count', async () => {
  const { client, writes } = recordingClient({
    [PULLS]: ok([mergedPull()]),
    'GET /repos/o/r/issues/89': featureIssue,
    [ISSUE_COMMENTS]: ok([{ user: { login: AGENT }, body: 'Handover: #89\n<!-- groundwork:handover -->' }]),
  });
  const result = await run(client, 'merged');
  assert.equal(result.changed, false);
  assert.deepEqual(writes, []);
});

test('merged: refuses before any write when a State field is missing', async () => {
  const body = prBody().replace(/Gotchas:.*\n/, '');
  const { client, writes } = recordingClient({ [PULLS]: ok([mergedPull({ body })]) });
  await assert.rejects(run(client, 'merged'), /handover not filled: <gotchas>/);
  assert.deepEqual(writes, []);
});

const EPIC_BODY = '## Goal\ng\n\n## Decisions\n- 2026-11-01: earlier choice.\n\n## Open questions\nnone\n';
const spikeRoutes = (epicBody, comments) => ({
  [PULLS]: ok([mergedPull()]),
  'GET /repos/o/r/issues/89': ok({ number: 89, type: { name: 'Spike' } }),
  'GET /repos/o/r/issues/89/parent': ok({ number: 74 }),
  'GET /repos/o/r/pulls/7/files?per_page=100': ok([
    { filename: 'docs/decisions/890-other.md' }, { filename: 'docs/decisions/89-queue-shape.md' },
  ]),
  'GET /repos/o/r/issues/74': ok({ number: 74, body: epicBody }),
  [ISSUE_COMMENTS]: ok(comments),
  'POST /repos/o/r/issues/89/comments': { status: 201, data: {}, headers: {} },
  'PATCH /repos/o/r/issues/74': ok({}),
});

test('merged spike: appends one dated decision line to the epic Decisions', async () => {
  const { client, writes } = recordingClient(spikeRoutes(EPIC_BODY, []));
  const result = await run(client, 'merged');
  assert.equal(result.changed, true);
  const epicWrite = writes.find((write) => write.method === 'PATCH');
  assert.equal(epicWrite.body.body, [
    '## Goal', 'g', '',
    '## Decisions',
    '- 2026-11-01: earlier choice.',
    '- 2026-11-21: Spike #89 decided in [docs/decisions/89-queue-shape.md](docs/decisions/89-queue-shape.md) (PR #7).',
    '', '## Open questions', 'none', '',
  ].join('\n'));
});

test('merged spike: a rerun adds no second line and no second comment', async () => {
  const withLine = EPIC_BODY.replace('\n\n## Open', '\n- 2026-11-21: Spike #89 decided in [docs/decisions/89-queue-shape.md](docs/decisions/89-queue-shape.md) (PR #7).\n\n## Open');
  const posted = [{ user: { login: AGENT }, body: '<!-- groundwork:handover -->' }];
  const { client, writes } = recordingClient(spikeRoutes(withLine, posted));
  const result = await run(client, 'merged');
  assert.equal(result.changed, false);
  assert.deepEqual(writes, []);
});

test('merged spike: refuses when the PR carries no decision file', async () => {
  const routes = spikeRoutes(EPIC_BODY, []);
  routes['GET /repos/o/r/pulls/7/files?per_page=100'] = ok([{ filename: 'README.md' }]);
  routes['GET /repos/o/r/issues/89/parent'] = ok({ number: 74 });
  const { client } = recordingClient(routes);
  await assert.rejects(run(client, 'merged'), /docs\/decisions\/89-<slug>\.md/);
});

test('merged spike: refuses a spike without a parent epic', async () => {
  const routes = spikeRoutes(EPIC_BODY, []);
  routes['GET /repos/o/r/issues/89/parent'] = notFound;
  const { client } = recordingClient(routes);
  await assert.rejects(run(client, 'merged'), /no parent epic/);
});

test('parseArguments: one mode, a valid session, a positive issue number', () => {
  assert.deepEqual(parseArguments(['89', '--decision', '--session', 'a.b-1', '--json'], {}), {
    number: 89, mode: 'decision', session: 'a.b-1', json: true,
  });
  assert.equal(parseArguments(['89', '--merged'], { GROUNDWORK_SESSION: 's1' }).session, 's1');
  assert.throws(() => parseArguments(['89', '--session', 's'], {}), /exactly one/);
  assert.throws(() => parseArguments(['89', '--decision', '--merged', '--session', 's'], {}), /exactly one/);
  assert.throws(() => parseArguments(['89', '--decision'], {}), /session id required/);
  assert.throws(() => parseArguments(['89', '--decision', '--session', 'a b'], {}), /invalid session/);
  assert.throws(() => parseArguments(['x', '--decision', '--session', 's'], {}), /usage/);
});

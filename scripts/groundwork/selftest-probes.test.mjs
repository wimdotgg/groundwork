import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureClient } from '../lib/github.mjs';
import { PROBE_IDS, runProbes } from './selftest-probes.mjs';

const ORG = 'wimdotgg';
const REPO = 'selftest-1';
const BASE = `/repos/${ORG}/${REPO}`;

const reply = (status, data = {}) => ({ status, data });

/** A repository where every probe passes; `overrides` replace single routes. */
function routes(overrides = {}) {
  return {
    [`GET ${BASE}/git/ref/heads/main`]: reply(200, { object: { sha: 'm1' } }),
    [`GET ${BASE}/git/commits/m1`]: reply(200, { tree: { sha: 't1' } }),
    [`POST ${BASE}/git/commits`]: reply(201, { sha: 'c1' }),
    // V3 creates twice (201, then 422), V16 creates once.
    [`POST ${BASE}/git/refs`]: [reply(201), reply(422), reply(201)],
    [`DELETE ${BASE}/git/refs/heads/selftest-v3`]: reply(204),
    [`DELETE ${BASE}/git/refs/heads/issue/1`]: reply(204),
    [`PATCH ${BASE}/git/refs/heads/issue/1`]: [reply(200), reply(422)],
    [`PATCH ${BASE}/git/refs/heads/main`]: reply(422),
    [`GET ${BASE}/rulesets?per_page=100`]: reply(200, [{ id: 5, name: 'main' }, { id: 6, name: 'release-tag-immutability' }]),
    [`GET ${BASE}/rulesets/6`]: reply(200, { rules: [{ type: 'deletion' }, { type: 'update' }] }),
    ...overrides,
  };
}

async function probe(overrides) {
  const calls = [];
  const client = createFixtureClient(routes(overrides), { onCall: ({ method, path }) => calls.push(`${method} ${path}`) });
  const lines = [];
  const rows = await runProbes({ client, org: ORG, repo: REPO, log: (line) => lines.push(line) });
  return { rows, calls, lines };
}

const rowFor = (rows, id) => rows.find((row) => row.id === id);

test('runProbes returns one passing row per probe id, in order, in the contract shape', async () => {
  const { rows, lines } = await probe();
  assert.deepEqual(rows.map((row) => row.id), PROBE_IDS);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row), ['id', 'name', 'ok', 'detail']);
    assert.equal(row.ok, true, `${row.id}: ${row.detail}`);
  }
  assert.equal(lines.length, PROBE_IDS.length);
});

test('V3 fails when the repeat create is accepted', async () => {
  const { rows } = await probe({ [`POST ${BASE}/git/refs`]: [reply(201), reply(201), reply(201)] });
  assert.equal(rowFor(rows, 'V3').ok, false);
  assert.match(rowFor(rows, 'V3').detail, /second create returned 201, expected 422/);
});

test('V11 fails when the tag ruleset has no update rule', async () => {
  const { rows } = await probe({ [`GET ${BASE}/rulesets/6`]: reply(200, { rules: [{ type: 'deletion' }] }) });
  assert.equal(rowFor(rows, 'V11').ok, false);
  assert.match(rowFor(rows, 'V11').detail, /no update rule/);
});

test('V11 fails when the tag ruleset is missing', async () => {
  const { rows } = await probe({ [`GET ${BASE}/rulesets?per_page=100`]: reply(200, []) });
  assert.match(rowFor(rows, 'V11').detail, /not found/);
});

test('V16 fails when the forced rewind is accepted', async () => {
  const { rows } = await probe({ [`PATCH ${BASE}/git/refs/heads/issue/1`]: [reply(200), reply(200)] });
  assert.equal(rowFor(rows, 'V16').ok, false);
  assert.match(rowFor(rows, 'V16').detail, /forced rewind returned 200/);
});

test('V16 passes when the forced rewind is rejected with 409', async () => {
  const { rows } = await probe({ [`PATCH ${BASE}/git/refs/heads/issue/1`]: [reply(200), reply(409)] });
  assert.equal(rowFor(rows, 'V16').ok, true);
});

test('V16 fails when the fast-forward is rejected', async () => {
  const { rows } = await probe({ [`PATCH ${BASE}/git/refs/heads/issue/1`]: [reply(422), reply(422)] });
  assert.match(rowFor(rows, 'V16').detail, /fast-forward returned 422/);
});

test('push-main passes when the non-forced push is rejected', async () => {
  const { rows } = await probe({ [`PATCH ${BASE}/git/refs/heads/main`]: reply(409) });
  assert.equal(rowFor(rows, 'push-main').ok, true);
  assert.match(rowFor(rows, 'push-main').detail, /409/);
});

test('push-main fails when main accepts the push', async () => {
  const { rows } = await probe({ [`PATCH ${BASE}/git/refs/heads/main`]: reply(200) });
  assert.equal(rowFor(rows, 'push-main').ok, false);
  assert.match(rowFor(rows, 'push-main').detail, /push to main returned 200/);
});

test('runProbes does not throw when one probe fails and still runs the others', async () => {
  const { rows } = await probe({ [`GET ${BASE}/rulesets?per_page=100`]: reply(500, { message: 'boom' }) });
  assert.deepEqual(rows.map((row) => row.ok), [true, false, true, true]);
  assert.match(rowFor(rows, 'V11').detail, /500 boom/);
});

test('a probe whose request has no fixture becomes a failed row', async () => {
  const client = createFixtureClient({});
  const rows = await runProbes({ client, org: ORG, repo: REPO, log: () => {} });
  assert.equal(rows.length, PROBE_IDS.length);
  assert.ok(rows.every((row) => row.ok === false && row.detail.includes('no fixture')));
});

test('every call stays under the selftest repository', async () => {
  const { calls } = await probe();
  assert.ok(calls.length > 0);
  for (const call of calls) assert.ok(call.split(' ')[1].startsWith(`${BASE}/`), call);
});

test('writes touch only the probe branches and main', async () => {
  const { calls } = await probe();
  const writes = calls.filter((call) => !call.startsWith('GET '));
  const allowed = [/\/git\/commits$/, /\/git\/refs$/, /\/git\/refs\/heads\/(selftest-v3|issue\/1|main)$/];
  for (const write of writes) assert.ok(allowed.some((pattern) => pattern.test(write)), write);
});

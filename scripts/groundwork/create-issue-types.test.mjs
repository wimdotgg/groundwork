import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubError, createFixtureClient } from '../lib/github.mjs';
import { ISSUE_TYPES } from '../lib/issue-model.mjs';
import {
  OP,
  PERMISSIONS,
  TOKEN_SCOPE,
  TYPE_DESCRIPTIONS,
  run,
  syncIssueTypes,
  validateArgs,
} from './create-issue-types.mjs';

const ORG = 'acme';
const LIST_KEY = `GET /orgs/${ORG}/issue-types?per_page=100`;

function typeObj(name, { id = 1, is_enabled = true, description = null, color = 'gray' } = {}) {
  return { id, node_id: `IT_${id}`, name, description, color, is_enabled, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
}

// The end state every successful run converges on: exactly ISSUE_TYPES, all enabled.
function theFive() {
  return ISSUE_TYPES.map((name, index) => typeObj(name, { id: 100 + index, description: TYPE_DESCRIPTIONS[name] }));
}

function logSink() {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
}

function callLog() {
  const calls = [];
  return { calls, onCall: (record) => calls.push(record) };
}

// The fixture transport's onCall never sees a body, so record request bodies here.
function recordingClient(routes, options) {
  const inner = createFixtureClient(routes, options);
  const bodies = [];
  return {
    bodies,
    client: {
      ...inner,
      request: (method, path, requestOptions = {}) => {
        if (requestOptions.body !== undefined) bodies.push({ method, path, body: requestOptions.body });
        return inner.request(method, path, requestOptions);
      },
    },
  };
}

test('exports the op contract', () => {
  assert.equal(OP, 'create-issue-types');
  assert.equal(TOKEN_SCOPE, 'org');
  assert.deepEqual(PERMISSIONS, { issue_types: 'write' });
  assert.deepEqual(Object.keys(TYPE_DESCRIPTIONS), ISSUE_TYPES);
});

test('validateArgs accepts no keys and rejects unknown keys', () => {
  assert.deepEqual(validateArgs({}), []);
  const errors = validateArgs({ repo: 'app' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown argument "repo"/);
  assert.deepEqual(validateArgs(null), ['args must be a JSON object']);
  assert.deepEqual(validateArgs(['repo']), ['args must be a JSON object']);
});

test('fresh org: deletes the default Task before creating the missing types', async () => {
  const { calls, onCall } = callLog();
  const { lines, log } = logSink();
  const { bodies, client } = recordingClient({
    [LIST_KEY]: [
      { status: 200, data: [typeObj('Task', { id: 410 }), typeObj('Bug', { id: 411 }), typeObj('Feature', { id: 412 })] },
      { status: 200, data: theFive() },
    ],
    'POST /orgs/acme/issue-types': { status: 201, data: {} },
    'DELETE /orgs/acme/issue-types/410': { status: 204, data: null },
  }, { onCall });
  const result = await syncIssueTypes({ client, org: ORG, log });
  assert.deepEqual(result, {
    ok: true,
    summary: 'synced issue types: deleted Task; created Epic; created Chore; created Spike',
  });
  assert.deepEqual(lines, [
    'deleted issue type Task', 'created issue type Epic', 'created issue type Chore', 'created issue type Spike',
  ]);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    'GET /orgs/acme/issue-types?per_page=100',
    'DELETE /orgs/acme/issue-types/410',
    'POST /orgs/acme/issue-types',
    'POST /orgs/acme/issue-types',
    'POST /orgs/acme/issue-types',
    'GET /orgs/acme/issue-types?per_page=100',
  ]);
  assert.deepEqual(bodies.map((entry) => entry.body), [
    { name: 'Epic', is_enabled: true, description: TYPE_DESCRIPTIONS.Epic },
    { name: 'Chore', is_enabled: true, description: TYPE_DESCRIPTIONS.Chore },
    { name: 'Spike', is_enabled: true, description: TYPE_DESCRIPTIONS.Spike },
  ]);
});

test('already-correct org: no write calls', async () => {
  const { calls, onCall } = callLog();
  const { lines, log } = logSink();
  const { bodies, client } = recordingClient({ [LIST_KEY]: { status: 200, data: theFive() } }, { onCall });
  const result = await run({
    client, token: 'minted', org: ORG, repo: null, settingsRoot: '', config: {}, env: {}, log,
  });
  assert.deepEqual(result, { ok: true, summary: 'issue types already in place' });
  assert.deepEqual(lines, []);
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'GET']);
  assert.deepEqual(bodies, []);
});

test('disabled wanted type is enabled through the update endpoint', async () => {
  const { calls, onCall } = callLog();
  const { lines, log } = logSink();
  const disabled = theFive().map((type) => (type.name === 'Spike' ? { ...type, is_enabled: false } : type));
  const { bodies, client } = recordingClient({
    [LIST_KEY]: [
      { status: 200, data: disabled },
      { status: 200, data: theFive() },
    ],
    'PUT /orgs/acme/issue-types/104': { status: 200, data: {} },
  }, { onCall });
  const result = await syncIssueTypes({ client, org: ORG, log });
  assert.equal(result.ok, true);
  assert.match(result.summary, /enabled Spike/);
  assert.deepEqual(lines, ['enabled issue type Spike']);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    'GET /orgs/acme/issue-types?per_page=100',
    'PUT /orgs/acme/issue-types/104',
    'GET /orgs/acme/issue-types?per_page=100',
  ]);
  assert.deepEqual(bodies, [{
    method: 'PUT',
    path: '/orgs/acme/issue-types/104',
    body: { name: 'Spike', is_enabled: true, description: TYPE_DESCRIPTIONS.Spike, color: 'gray' },
  }]);
});

test('case variant bug is renamed to Bug, not duplicated or deleted', async () => {
  const { calls, onCall } = callLog();
  const { lines, log } = logSink();
  const existing = [
    typeObj('bug', { id: 411, description: null, color: 'red' }),
    ...theFive().filter((type) => type.name !== 'Bug'),
  ];
  const { bodies, client } = recordingClient({
    [LIST_KEY]: [
      { status: 200, data: existing },
      { status: 200, data: theFive() },
    ],
    'PUT /orgs/acme/issue-types/411': { status: 200, data: {} },
  }, { onCall });
  const result = await syncIssueTypes({ client, org: ORG, log });
  assert.equal(result.ok, true);
  assert.match(result.summary, /renamed bug to Bug/);
  assert.deepEqual(lines, ['renamed issue type bug to Bug']);
  assert.deepEqual(calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path}`), [
    'PUT /orgs/acme/issue-types/411',
  ]);
  assert.deepEqual(bodies, [{
    method: 'PUT',
    path: '/orgs/acme/issue-types/411',
    body: { name: 'Bug', is_enabled: true, description: TYPE_DESCRIPTIONS.Bug, color: 'red' },
  }]);
});

test('update preserves an existing description and omits color when the type has none', async () => {
  const { lines, log } = logSink();
  const existing = [
    typeObj('Spike', { id: 104, is_enabled: false, description: 'custom spike', color: null }),
    ...theFive().filter((type) => type.name !== 'Spike'),
  ];
  const { bodies, client } = recordingClient({
    [LIST_KEY]: [
      { status: 200, data: existing },
      { status: 200, data: theFive() },
    ],
    'PUT /orgs/acme/issue-types/104': { status: 200, data: {} },
  });
  const result = await syncIssueTypes({ client, org: ORG, log });
  assert.equal(result.ok, true);
  assert.deepEqual(lines, ['enabled issue type Spike']);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].body.description, 'custom spike');
  assert.equal('color' in bodies[0].body, false);
});

test("case variant 'task' is deleted like the default Task", async () => {
  const { calls, onCall } = callLog();
  const { lines, log } = logSink();
  const { bodies, client } = recordingClient({
    [LIST_KEY]: [
      { status: 200, data: [typeObj('task', { id: 410 }), ...theFive()] },
      { status: 200, data: theFive() },
    ],
    'DELETE /orgs/acme/issue-types/410': { status: 204, data: null },
  }, { onCall });
  const result = await syncIssueTypes({ client, org: ORG, log });
  assert.equal(result.ok, true);
  assert.match(result.summary, /deleted task/);
  assert.deepEqual(lines, ['deleted issue type task']);
  assert.deepEqual(calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path}`), [
    'DELETE /orgs/acme/issue-types/410',
  ]);
  assert.deepEqual(bodies, []);
});

test('custom type outside the five is left alone and makes the run report ok:false', async () => {
  const { calls, onCall } = callLog();
  const { log } = logSink();
  const { client } = recordingClient({
    [LIST_KEY]: [
      { status: 200, data: [typeObj('Task', { id: 410 }), typeObj('Question', { id: 420 })] },
      { status: 200, data: [...theFive(), typeObj('Question', { id: 420 })] },
    ],
    'POST /orgs/acme/issue-types': { status: 201, data: {} },
    'DELETE /orgs/acme/issue-types/410': { status: 204, data: null },
  }, { onCall });
  const result = await syncIssueTypes({ client, org: ORG, log });
  assert.equal(result.ok, false);
  assert.match(result.summary, /extra Question/);
  assert.match(result.summary, /left for the owner: Question/);
  assert.deepEqual(
    calls.filter((call) => call.method === 'DELETE').map((call) => call.path),
    ['/orgs/acme/issue-types/410'],
  );
});

test('a delete that does not stick is reported as divergence', async () => {
  const { log } = logSink();
  const client = createFixtureClient({
    [LIST_KEY]: [
      { status: 200, data: [typeObj('Task', { id: 410 })] },
      { status: 200, data: [...theFive(), typeObj('Task', { id: 410 })] },
    ],
    'POST /orgs/acme/issue-types': { status: 201, data: {} },
    'DELETE /orgs/acme/issue-types/410': { status: 204, data: null },
  });
  const result = await syncIssueTypes({ client, org: ORG, log });
  assert.equal(result.ok, false);
  assert.match(result.summary, /extra Task/);
});

test('API failure on a write throws GitHubError', async () => {
  const { lines, log } = logSink();
  const client = createFixtureClient({
    [LIST_KEY]: { status: 200, data: [typeObj('Task', { id: 410 }), typeObj('Bug', { id: 411 }), typeObj('Feature', { id: 412 })] },
    'DELETE /orgs/acme/issue-types/410': { status: 204, data: null },
    'POST /orgs/acme/issue-types': { status: 500, data: { message: 'boom' } },
  });
  await assert.rejects(
    syncIssueTypes({ client, org: ORG, log }),
    (error) => error instanceof GitHubError && error.status === 500 && /boom/.test(error.message),
  );
  assert.deepEqual(lines, ['deleted issue type Task']);
});

test('syncIssueTypes requires an org', async () => {
  const client = createFixtureClient({});
  await assert.rejects(syncIssueTypes({ client, org: null, log: () => {} }), GitHubError);
});

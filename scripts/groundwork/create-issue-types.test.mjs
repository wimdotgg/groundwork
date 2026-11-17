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

function typeObj(name, { id = 1, is_enabled = true, description = null } = {}) {
  return { id, node_id: `IT_${id}`, name, description, color: 'gray', is_enabled, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
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

test('fresh org: creates the missing types and deletes the default Task', async () => {
  const { calls, onCall } = callLog();
  const { lines, log } = logSink();
  const client = createFixtureClient({
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
    summary: 'synced issue types: created Epic; created Chore; created Spike; deleted Task',
  });
  assert.deepEqual(lines, [
    'created issue type Epic', 'created issue type Chore', 'created issue type Spike', 'deleted issue type Task',
  ]);
  const methods = calls.map((call) => call.method);
  assert.deepEqual(methods.filter((method) => method !== 'GET').sort(), ['DELETE', 'POST', 'POST', 'POST']);
  assert.equal(calls.filter((call) => call.method === 'GET').length, 2);
});

test('already-correct org: no write calls', async () => {
  const { calls, onCall } = callLog();
  const { lines, log } = logSink();
  const client = createFixtureClient({ [LIST_KEY]: { status: 200, data: theFive() } }, { onCall });
  const result = await run({
    client, token: 'minted', org: ORG, repo: null, settingsRoot: '', config: {}, env: {}, log,
  });
  assert.deepEqual(result, { ok: true, summary: 'issue types already in place' });
  assert.deepEqual(lines, []);
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'GET']);
});

test('disabled wanted type is enabled through the update endpoint', async () => {
  const { calls, onCall } = callLog();
  const { lines, log } = logSink();
  const disabled = theFive().map((type) => (type.name === 'Spike' ? { ...type, is_enabled: false } : type));
  const client = createFixtureClient({
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
});

test('unexpected surviving type makes the run report ok:false', async () => {
  const { lines, log } = logSink();
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
    [LIST_KEY]: { status: 200, data: [typeObj('Task', { id: 410 })] },
    'POST /orgs/acme/issue-types': { status: 201, data: {} },
    'DELETE /orgs/acme/issue-types/410': { status: 500, data: { message: 'boom' } },
  });
  await assert.rejects(
    syncIssueTypes({ client, org: ORG, log }),
    (error) => error instanceof GitHubError && error.status === 500 && /boom/.test(error.message),
  );
  assert.deepEqual(lines, ['created issue type Epic', 'created issue type Feature', 'created issue type Bug', 'created issue type Chore', 'created issue type Spike']);
});

test('syncIssueTypes requires an org', async () => {
  const client = createFixtureClient({});
  await assert.rejects(syncIssueTypes({ client, org: '', log: () => {} }), GitHubError);
});

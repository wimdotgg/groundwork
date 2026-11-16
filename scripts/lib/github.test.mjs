import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GitHubError, apiPath, createClient, createFixtureClient, parseGhOutput, repoFromEnv,
} from './github.mjs';

const ok = (data, headers = {}) => ({ status: 200, data, headers });

test('fixture: first page key has sorted query and per_page=100', async () => {
  const client = createFixtureClient({ 'GET /repos/o/r/pulls/7/files?per_page=100': ok([{ a: 1 }]) });
  assert.deepEqual(await client.paginate('/repos/o/r/pulls/7/files'), [{ a: 1 }]);
});

test('fixture: caller query merges with per_page and sorts by name', async () => {
  const client = createFixtureClient({ 'GET /x?per_page=100&state=open': ok([1]) });
  assert.deepEqual(await client.paginate('/x', { query: { state: 'open' } }), [1]);
});

test('fixture: paginate follows Link next to page 2 and unwraps itemsKey', async () => {
  const client = createFixtureClient({
    'GET /repos/o/r/actions/runs?per_page=100': ok(
      { total_count: 3, workflow_runs: [1, 2] },
      { Link: '<https://api.github.com/repos/o/r/actions/runs?per_page=100&page=2>; rel="next", <https://api.github.com/repos/o/r/actions/runs?page=2&per_page=100>; rel="last"' },
    ),
    'GET /repos/o/r/actions/runs?page=2&per_page=100': ok({ total_count: 3, workflow_runs: [3] }),
  });
  assert.deepEqual(await client.paginate('/repos/o/r/actions/runs', { itemsKey: 'workflow_runs' }), [1, 2, 3]);
});

test('fixture: array responses are yielded in order', async () => {
  const client = createFixtureClient({ 'GET /a': [ok('first'), ok('second')] });
  assert.equal((await client.request('GET', '/a')).data, 'first');
  assert.equal((await client.request('GET', '/a')).data, 'second');
  await assert.rejects(client.request('GET', '/a'), (e) => e.status === 0);
});

test('fixture: unmatched key throws GitHubError status 0', async () => {
  const client = createFixtureClient({});
  await assert.rejects(client.request('GET', '/missing'), (e) => {
    assert.ok(e instanceof GitHubError);
    assert.equal(e.status, 0);
    assert.equal(e.message, 'no fixture for GET /missing');
    return true;
  });
});

test('okStatuses accepts 422 and 404; others throw', async () => {
  const client = createFixtureClient({
    'POST /claim': { status: 422, data: { message: 'exists' } },
    'GET /probe': { status: 404, data: { message: 'Not Found' } },
  });
  assert.equal((await client.request('POST', '/claim', { okStatuses: [422] })).status, 422);
  assert.equal((await client.request('GET', '/probe', { okStatuses: [404] })).status, 404);
  await assert.rejects(client.request('GET', '/probe'), (e) => e.status === 404);
});

test('non-2xx throws GitHubError with apiMessage, method and path', async () => {
  const client = createFixtureClient({ 'PATCH /x': { status: 403, data: { message: 'Resource not accessible' } } });
  await assert.rejects(client.request('PATCH', '/x'), (e) => {
    assert.equal(e.name, 'GitHubError');
    assert.equal(e.status, 403);
    assert.equal(e.method, 'PATCH');
    assert.equal(e.path, '/x');
    assert.equal(e.apiMessage, 'Resource not accessible');
    assert.ok(!e.message.includes('\n'));
    return true;
  });
});

test('graphql returns data and throws the first error message', async () => {
  const client = createFixtureClient({
    'POST /graphql': [
      ok({ data: { viewer: { login: 'a' } } }),
      ok({ errors: [{ message: 'first bad' }, { message: 'second bad' }] }),
    ],
  });
  assert.deepEqual(await client.graphql('query { viewer { login } }'), { viewer: { login: 'a' } });
  await assert.rejects(client.graphql('query'), (e) => e instanceof GitHubError && e.apiMessage === 'first bad');
});

test('apiPath encodes segments and rejects a missing param', () => {
  assert.equal(apiPath('/repos/{owner}/{repo}/contents/{path}', { owner: 'o', repo: 'r', path: 'a b/c' }), '/repos/o/r/contents/a%20b%2Fc');
  assert.throws(() => apiPath('/repos/{owner}/{repo}', { owner: 'o' }), (e) => e instanceof GitHubError && e.status === 0);
});

test('repoFromEnv parses valid and rejects absent or malformed', () => {
  assert.deepEqual(repoFromEnv({ GITHUB_REPOSITORY: 'WianVDM/groundwork' }), { owner: 'WianVDM', repo: 'groundwork' });
  for (const value of [undefined, '', 'noslash', 'a/b/c', '/r', 'o/']) {
    assert.throws(() => repoFromEnv({ GITHUB_REPOSITORY: value }), (e) => e instanceof GitHubError && e.status === 0);
  }
});

test('onCall receives method, path and status, never a body', async () => {
  const calls = [];
  const client = createFixtureClient({ 'POST /x': ok({ secret: 1 }) }, { onCall: (record) => calls.push(record) });
  await client.request('POST', '/x', { body: { token: 'hunter2' } });
  assert.deepEqual(calls, [{ method: 'POST', path: '/x', status: 200 }]);
  assert.ok(!JSON.stringify(calls).includes('hunter2'));
});

test('parseGhOutput reads status, headers and JSON body', () => {
  const sample = [
    'HTTP/2.0 200 OK',
    'Content-Type: application/json; charset=utf-8',
    'Link: <https://api.github.com/x?page=2>; rel="next"',
    'X-Ratelimit-Remaining: 59',
    '',
    '[{"id":1}]',
  ].join('\r\n');
  const parsed = parseGhOutput(sample);
  assert.equal(parsed.status, 200);
  assert.deepEqual(parsed.data, [{ id: 1 }]);
  assert.equal(parsed.headers.link, '<https://api.github.com/x?page=2>; rel="next"');
  assert.equal(parsed.headers['x-ratelimit-remaining'], '59');
});

test('parseGhOutput handles empty body, error status and garbage', () => {
  assert.deepEqual(parseGhOutput('HTTP/2.0 204 No Content\n\n'), { status: 204, data: null, headers: {} });
  assert.equal(parseGhOutput('HTTP/1.1 404 Not Found\nA: b\n\n{"message":"Not Found"}').data.message, 'Not Found');
  assert.throws(() => parseGhOutput('gh: not logged in'), (e) => e instanceof GitHubError && e.status === 0);
});

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const { status, body, headers } = responses.shift();
    return { status, text: async () => body, headers: new Headers(headers) };
  };
  return { impl, calls };
}

test('fetch transport sends auth header, base URL from GITHUB_API_URL and JSON body', async () => {
  const { impl, calls } = fakeFetch([{ status: 201, body: '{"id":9}', headers: { 'Content-Type': 'application/json' } }]);
  const client = createClient({
    env: { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 'tok', GITHUB_API_URL: 'https://ghe.example/api/v3' },
    fetchImpl: impl,
  });
  assert.equal(client.transport, 'fetch');
  const response = await client.request('POST', '/repos/o/r/issues', { body: { title: 't' }, query: { b: 1, a: 2 } });
  assert.equal(response.status, 201);
  assert.deepEqual(response.data, { id: 9 });
  assert.equal(calls[0].url, 'https://ghe.example/api/v3/repos/o/r/issues?a=2&b=1');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].init.body, '{"title":"t"}');
});

test('fetch transport defaults to api.github.com and an explicit token wins', async () => {
  const { impl, calls } = fakeFetch([{ status: 200, body: '[]' }]);
  const client = createClient({ env: { GITHUB_TOKEN: 'ignored' }, token: 'minted', fetchImpl: impl });
  await client.request('GET', '/user');
  assert.equal(calls[0].url, 'https://api.github.com/user');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer minted');
});

test('fetch transport paginates via Link and strips the API base path', async () => {
  const { impl, calls } = fakeFetch([
    { status: 200, body: '[1]', headers: { Link: '<https://ghe.example/api/v3/things?page=2&per_page=100>; rel="next"' } },
    { status: 200, body: '[2]' },
  ]);
  const client = createClient({
    env: { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 't', GITHUB_API_URL: 'https://ghe.example/api/v3' },
    fetchImpl: impl,
  });
  assert.deepEqual(await client.paginate('/things'), [1, 2]);
  assert.equal(calls[0].url, 'https://ghe.example/api/v3/things?per_page=100');
  assert.equal(calls[1].url, 'https://ghe.example/api/v3/things?page=2&per_page=100');
});

test('fetch transport: empty GITHUB_TOKEN throws; network failure is status 0', async () => {
  assert.throws(() => createClient({ env: { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: '' } }), (e) => e instanceof GitHubError && e.status === 0);
  assert.throws(() => createClient({ env: { GITHUB_ACTIONS: 'true' } }), GitHubError);
  const failing = async () => { throw new Error('connect ECONNREFUSED\nstack'); };
  const calls = [];
  const client = createClient({ env: { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 't' }, fetchImpl: failing, onCall: (r) => calls.push(r) });
  await assert.rejects(client.request('GET', '/x'), (e) => e.status === 0 && !e.message.includes('\n'));
  assert.deepEqual(calls, [{ method: 'GET', path: '/x', status: 0 }]);
});

test('createClient picks the gh transport outside Actions without spawning', () => {
  assert.equal(createClient({ env: {} }).transport, 'gh');
});

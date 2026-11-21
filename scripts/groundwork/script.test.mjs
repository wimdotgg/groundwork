import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFixtureClient } from '../lib/github.mjs';
import * as example from '../../admin-ops/repo-info.mjs';
import { grants, parseScript, plan, run, runChild, validateArgs } from './script.mjs';

const ORG = 'acme';
const CONTROL = 'groundwork';
const TARGET = 'proj';
const REF = 'a'.repeat(40);
const TOKEN = 'ghs_target_token';
const SCRIPT_PATH = 'admin-ops/probe.mjs';
const contentsPath = `/repos/${ORG}/${CONTROL}/contents/admin-ops/probe.mjs?ref=${REF}`;
const mainPath = `/repos/${ORG}/${CONTROL}/git/ref/heads/main`;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const fileRoutes = (source) => ({
  [`GET ${contentsPath}`]: { status: 200, data: { type: 'file', encoding: 'base64', content: Buffer.from(source).toString('base64') } },
  [`GET ${mainPath}`]: { status: 200, data: { object: { sha: REF } } },
});
const withBody = (body) => `export const permissions = { "issues": "read" };\nexport async function run({ log }) {\n${body}\n}\n`;
const ISOLATION_PROBE = withBody('  log(JSON.stringify(Object.keys(process.env)));\n  return { ok: true, summary: "probed" };');

test('parseScript: reads the permissions of the shipped example, which are read-only', async () => {
  const source = await readFile(new URL('../../admin-ops/repo-info.mjs', import.meta.url), 'utf8');
  const { permissions } = parseScript(source);
  assert.deepEqual(permissions, example.permissions);
  assert.ok(Object.values(permissions).every((level) => level === 'read'));
});

test('parseScript: refuses a missing, repeated or malformed permissions statement', () => {
  const statement = 'export const permissions = { "issues": "read" };';
  const refused = [
    'export async function run() {}',
    `${statement}\n${statement}`,
    `// ${statement}\n${statement}`,
    'export const permissions = { issues: "read" };',
    "export const permissions = { 'issues': 'read' };",
    'export const permissions = {};',
    'export const permissions = { "issues": "admin" };',
    'export const permissions = { "Issues": "read" };',
    'export const permissions = { "issues": { "a": "read" } };',
    'export const permissions = { "issues": "read" }',
  ];
  for (const source of refused) assert.ok(parseScript(source).problem, source);
});

test('parseScript: refuses module loading and code evaluation tokens anywhere, comments included', () => {
  const tokens = ['import fs from "node:fs";', '// import later', 'const x = require ("fs");', 'process.getBuiltinModule("fs");', 'eval ("1");', 'new Function ("return 1");', '(() => {}).constructor ("return 1")();', 'process . binding("fs");'];
  for (const token of tokens) assert.match(parseScript(`export const permissions = { "issues": "read" };\n${token}`).problem, /forbidden token/, token);
});

test('validateArgs: caps the serialised args at 2000 characters', () => {
  assert.deepEqual(validateArgs({ text: 'x'.repeat(1900) }), []);
  assert.equal(validateArgs({ text: 'x'.repeat(2000) }).length, 1);
});

test('grants: the target entry exists only once the permissions are parsed', () => {
  const inputs = { targetRepo: TARGET, controlRepo: CONTROL };
  assert.deepEqual(grants(inputs), [{ repositories: [CONTROL], permissions: { contents: 'read' }, match: 'exact' }]);
  assert.deepEqual(grants({ ...inputs, scriptPermissions: { issues: 'read' } }).at(-1), { repositories: [TARGET], permissions: { issues: 'read' }, match: 'exact' });
});

const planRequest = { ref: REF, scriptPath: SCRIPT_PATH };
const planFor = (source, routes = fileRoutes(source)) => plan({ client: createFixtureClient(routes), org: ORG, controlRepo: CONTROL, request: planRequest });

test('plan: returns the file, its SHA-256, the parsed permissions and the job output', async () => {
  const source = withBody('  return { ok: true, summary: "x" };');
  const details = await planFor(source);
  assert.equal(details.source, source);
  assert.deepEqual(details.scriptPermissions, { issues: 'read' });
  assert.deepEqual(details.outputs, { script_sha256: sha256(source) });
  assert.ok(details.facts.includes(`SHA-256: ${sha256(source)}`));
});

test('plan: refuses a ref that is not the main head and a file the parser refuses, before any other call', async () => {
  const source = withBody('  return { ok: true, summary: "x" };');
  const moved = await planFor(source, { ...fileRoutes(source), [`GET ${mainPath}`]: { status: 200, data: { object: { sha: 'b'.repeat(40) } } } });
  assert.match(moved.problem, /not the current main head/);
  const refused = await planFor('export async function run() {}');
  assert.match(refused.problem, /admin-ops\/probe\.mjs refused/);
});

/** Local GitHub API stand-in; the child reaches it through `GITHUB_API_URL`. */
async function withApiServer(callback) {
  const authorizations = [];
  const server = createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ name: TARGET, default_branch: 'trunk' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await callback({ apiUrl: `http://127.0.0.1:${server.address().port}`, authorizations });
  } finally {
    server.close();
  }
}

const PARENT_SECRETS = { ADMIN_APP_KEY: 'PRIVATE-KEY', RELEASE_APP_KEY: 'RELEASE-KEY', INPUT_OP: 'script', GITHUB_REF: 'refs/heads/main' };

/** `run` with a fake `withToken` that records each grant request and serves the control read from fixtures. */
async function runScript(source, { plannedSha256 = sha256(source), env = {} } = {}) {
  const record = { mints: [], calls: [], logs: [], permissionsSet: [] };
  const control = createFixtureClient(fileRoutes(source));
  const result = await run({
    org: ORG,
    repo: TARGET,
    config: { controlRepo: CONTROL },
    env: { ...PARENT_SECRETS, INPUT_REF: REF, INPUT_SCRIPT_PATH: SCRIPT_PATH, INPUT_ARGS: '{"n":1}', PLAN_SCRIPT_SHA256: plannedSha256, ...env },
    log: (line) => record.logs.push(line),
    recordCall: (call) => record.calls.push(call),
    setScriptPermissions: (permissions) => record.permissionsSet.push(permissions),
    withToken: async (request, callback) => {
      record.mints.push(request);
      return callback({ client: control, token: TOKEN });
    },
  }).catch((error) => ({ error }));
  return { result, ...record };
}

test('run: one target mint with the script permissions, a child that sees no secret, and the reported calls and logs', async () => {
  const source = withBody('  const { data } = await github.request("GET", `/repos/acme/${repo}`);\n  log(JSON.stringify(Object.keys(process.env)));\n  return { ok: true, summary: data.default_branch };')
    .replace('run({ log })', 'run({ github, repo, log })');
  await withApiServer(async ({ apiUrl, authorizations }) => {
    const { result, mints, calls, logs, permissionsSet } = await runScript(source, { env: { GITHUB_API_URL: apiUrl } });
    assert.deepEqual(result, { ok: true, summary: 'Script result: `trunk`' });
    assert.deepEqual(mints, [
      { repositories: [CONTROL], permissions: { contents: 'read' } },
      { repositories: [TARGET], permissions: { issues: 'read' } },
    ]);
    assert.deepEqual(permissionsSet, [{ issues: 'read' }]);
    assert.deepEqual(calls, [{ method: 'GET', path: `/repos/${ORG}/${TARGET}`, status: 200 }]);
    assert.deepEqual(authorizations, [`Bearer ${TOKEN}`]);
    const seen = JSON.parse(logs[0]);
    assert.deepEqual(seen.filter((name) => /ADMIN_APP_KEY|RELEASE_APP_KEY|^INPUT_|^GITHUB_/.test(name)), []);
  });
});

test('run: refuses a missing or different planned SHA-256 before the target mint', async () => {
  const empty = await runScript(ISOLATION_PROBE, { plannedSha256: '' });
  assert.match(empty.result.error.message, /PLAN_SCRIPT_SHA256/);
  assert.deepEqual(empty.mints, []);
  const different = await runScript(ISOLATION_PROBE, { plannedSha256: sha256('other') });
  assert.match(different.result.error.message, /differs/);
  assert.equal(different.mints.length, 1, 'only the control read');
  assert.deepEqual(different.permissionsSet, []);
});

test('run: a stray console.log, a missing result and a failing child fail the run', async () => {
  const bodies = ['  console.log("hello");\n  return { ok: true, summary: "x" };', '  process.stdout.write("{\\"type\\":\\"other\\"}\\n");\n  return { ok: true, summary: "x" };', '  throw new Error("boom");'];
  for (const body of bodies) {
    const { result } = await runScript(withBody(body));
    assert.ok(result.error, body);
  }
  assert.match((await runScript(withBody('  console.log("hello");'))).result.error.message, /not a protocol line/);
});

test('shipped example: reports the default branch and logs it', async () => {
  const github = createFixtureClient({ [`GET /repos/${ORG}/${TARGET}`]: { status: 200, data: { default_branch: 'trunk' } } });
  const logs = [];
  const result = await example.run({ github, org: ORG, repo: TARGET, log: (line) => logs.push(line) });
  assert.deepEqual([result.ok, result.summary, logs], [true, `${TARGET} default branch: trunk`, ['default branch trunk']]);
});

test('run: calls and logs reported before a throw are still recorded', async () => {
  const source = withBody('  log("before");\n  await github.request("DELETE", `/repos/acme/${repo}`);\n  throw new Error("boom");').replace('run({ log })', 'run({ github, repo, log })');
  await withApiServer(async ({ apiUrl }) => {
    const { result, calls, logs } = await runScript(source, { env: { GITHUB_API_URL: apiUrl } });
    assert.match(result.error.message, /code 1/);
    assert.deepEqual(calls, [{ method: 'DELETE', path: `/repos/${ORG}/${TARGET}`, status: 200 }]);
    assert.deepEqual(logs, ['before']);
  });
});

test('run: a forged summary becomes one inert line in a code span', async () => {
  const forged = 'ok\\n### API calls\\n| GET | /x | 200 |\\n<details>';
  const { result } = await runScript(withBody(`  return { ok: true, summary: "${forged}" };`));
  assert.match(result.summary, /^Script result: `[^`\n<>|]*`$/);
});

test('runChild: the child is denied an outside read, a write and a spawn', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'script-child-'));
  const outside = path.join(directory, 'outside.txt');
  await writeFile(outside, 'data');
  const source = [
    'export async function run() {',
    '  const denied = (action) => { try { action(); return "allowed"; } catch (error) { return error.code; } };',
    '  const fs = process.getBuiltinModule("fs");',
    '  const spawnProcess = process.getBuiltinModule("child_process");',
    `  const outcomes = [denied(() => fs.readFileSync(${JSON.stringify(outside)})), denied(() => fs.writeFileSync(${JSON.stringify(`${outside}.new`)}, "x")), denied(() => spawnProcess.spawnSync("node"))];`,
    '  return { ok: true, summary: outcomes.join() };',
    '}',
  ].join('\n');
  const { stdout } = await runChild({ source, token: TOKEN, org: ORG, repo: TARGET, args: {} }, {});
  const result = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.type === 'result');
  assert.equal(result.summary, 'ERR_ACCESS_DENIED,ERR_ACCESS_DENIED,ERR_ACCESS_DENIED');
});

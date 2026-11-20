import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createFixtureClient } from '../lib/github.mjs';
import {
  buildChildEnv, createAppJwt, credentialOutput, fetchBotUserId, mintInstallationToken, nodeVersionError,
  resolveClientId, resolvePrivateKey,
} from './token.mjs';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const STORE = 'C:\\Users\\me\\AppData\\Roaming\\groundwork\\demo-agent';
const windows = { env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, platform: 'win32', slug: 'demo-agent' };
const linux = { env: {}, platform: 'linux', slug: 'demo-agent' };
const unreachable = async () => { throw new Error('unreachable'); };

test('buildChildEnv: token, bot identity and credential helper chain', () => {
  const env = buildChildEnv({
    baseEnv: { PATH: '/bin', GH_TOKEN: 'owner-token' }, token: 'ghs_x', slug: 'demo-agent', botId: 42,
    execPath: 'C:\\node\\node.exe', scriptPath: 'C:\\repo\\scripts\\agent\\token.mjs',
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.GH_TOKEN, 'ghs_x');
  for (const name of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']) assert.equal(env[name], 'demo-agent[bot]');
  for (const name of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) assert.equal(env[name], '42+demo-agent[bot]@users.noreply.github.com');
  assert.equal(env.GIT_CONFIG_COUNT, '2');
  assert.equal(env.GIT_CONFIG_KEY_0, 'credential.https://github.com.helper');
  assert.equal(env.GIT_CONFIG_VALUE_0, '');
  assert.equal(env.GIT_CONFIG_KEY_1, env.GIT_CONFIG_KEY_0);
  assert.equal(env.GIT_CONFIG_VALUE_1, '!"C:/node/node.exe" "C:/repo/scripts/agent/token.mjs" credential');
});

test('credentialOutput: get prints the pair, store and erase print nothing', () => {
  assert.equal(credentialOutput('get', 'ghs_x'), 'username=x-access-token\npassword=ghs_x\n');
  assert.equal(credentialOutput('store', 'ghs_x'), '');
  assert.equal(credentialOutput('erase', 'ghs_x'), '');
});

test('resolveClientId: env wins, then the Windows metadata file (BOM tolerated), else an instruction', async () => {
  const fromEnv = { ...linux, env: { GROUNDWORK_AGENT_CLIENT_ID: 'Iv1' }, readText: unreachable };
  assert.equal(await resolveClientId(fromEnv), 'Iv1');
  const readText = async (file) => {
    assert.equal(file, `${STORE}.json`);
    return `\uFEFF${JSON.stringify({ clientId: 'Iv2' })}`;
  };
  assert.equal(await resolveClientId({ ...windows, readText }), 'Iv2');
  await assert.rejects(resolveClientId({ ...linux, readText: unreachable }), /GROUNDWORK_AGENT_CLIENT_ID/);
  await assert.rejects(resolveClientId({ ...windows, readText: async () => '{}' }), /GROUNDWORK_AGENT_CLIENT_ID/);
});

test('resolvePrivateKey: key file env wins, then DPAPI on Windows, else an instruction', async () => {
  const readText = async (file) => `pem from ${file}`;
  const decryptDpapi = async (file) => `decrypted ${file}`;
  const fromFile = { ...linux, env: { GROUNDWORK_AGENT_KEY_FILE: '/keys/a.pem' }, readText, decryptDpapi: unreachable };
  assert.equal(await resolvePrivateKey(fromFile), 'pem from /keys/a.pem');
  assert.equal(await resolvePrivateKey({ ...windows, readText: unreachable, decryptDpapi }), `decrypted ${STORE}.pem.dpapi`);
  await assert.rejects(resolvePrivateKey({ ...linux, readText, decryptDpapi }), /set GROUNDWORK_AGENT_KEY_FILE/);
  await assert.rejects(
    resolvePrivateKey({ ...windows, readText, decryptDpapi: unreachable }),
    (error) => /cannot read the App private key/.test(error.message) && !error.message.includes('\n'),
  );
});

test('createAppJwt: RS256, client ID as issuer, verifiable signature, key never echoed', () => {
  const now = new Date('2030-01-01T00:00:00Z');
  const [header, payload, signature] = createAppJwt({ clientId: 'Iv1', privateKey, now }).split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const seconds = now.getTime() / 1000;
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { iat: seconds - 60, exp: seconds + 540, iss: 'Iv1' });
  assert.ok(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, signature, 'base64url'));
  assert.throws(() => createAppJwt({ clientId: 'Iv1', privateKey: 'secret-ish' }), (error) => !error.message.includes('secret-ish'));
});

test('mintInstallationToken: org installation lookup, then token; failures are one line', async () => {
  const calls = [];
  const client = createFixtureClient({
    'GET /orgs/acme/installation': { status: 200, data: { id: 7 } },
    'POST /app/installations/7/access_tokens': { status: 201, data: { token: 'ghs_x' } },
  }, { onCall: (record) => calls.push(`${record.method} ${record.path}`) });
  assert.equal(await mintInstallationToken(client, 'acme'), 'ghs_x');
  assert.deepEqual(calls, ['GET /orgs/acme/installation', 'POST /app/installations/7/access_tokens']);
  const noInstallation = createFixtureClient({ 'GET /orgs/acme/installation': { status: 200, data: {} } });
  await assert.rejects(mintInstallationToken(noInstallation, 'acme'), /acme has no installation/);
});

test('fetchBotUserId: reads the bot user id', async () => {
  const client = createFixtureClient({ 'GET /users/demo-agent%5Bbot%5D': { status: 200, data: { id: 42 } } });
  assert.equal(await fetchBotUserId(client, 'demo-agent[bot]'), 42);
});

test('nodeVersionError: names Node 24 for an older major, null from 24 on', () => {
  assert.match(nodeVersionError('22.23.4'), /Node 24 or newer \(running 22\.23\.4\)/);
  assert.equal(nodeVersionError('24.0.0'), null);
  assert.equal(nodeVersionError('26.13.1'), null);
});

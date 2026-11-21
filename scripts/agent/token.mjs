import { spawn } from 'node:child_process';
import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubError, apiPath, createClient } from '../lib/github.mjs';
import { loadConfig, repoRoot } from '../lib/config.mjs';

/** @typedef {import('../lib/github.mjs').GitHubClient} GitHubClient */
/** @typedef {{ env: Record<string, string|undefined>, platform: string, slug: string,
 *   readText: (file: string) => Promise<string>, decryptDpapi: (file: string) => Promise<string> }} KeySources */

const KEY_FILE_VARIABLE = 'GROUNDWORK_AGENT_KEY_FILE';
const CLIENT_ID_VARIABLE = 'GROUNDWORK_AGENT_CLIENT_ID';
const GIT_HELPER_KEY = 'credential.https://github.com.helper';
const JWT_BACKDATE_SECONDS = 60;
const JWT_VALID_SECONDS = 540;
const DPAPI_SCRIPT = '$s = Get-Content $env:GROUNDWORK_DPAPI_FILE | ConvertTo-SecureString; '
  + '[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))';
const USAGE = 'usage: token.mjs exec -- <command> [args...] | token.mjs credential <get|store|erase>';

const MIN_NODE_MAJOR = 24;

/**
 * Every agent script ends with `if (import.meta.main)`, which an old Node leaves undefined, so the script would
 * exit 0 having done nothing. Every script imports this module, so the check below runs for all of them.
 * @param {string} version `process.versions.node`
 * @returns {string|null} the one-line error, or null when the version is supported
 */
export function nodeVersionError(version) {
  if (Number(version.split('.')[0]) >= MIN_NODE_MAJOR) return null;
  return `groundwork agent scripts need Node ${MIN_NODE_MAJOR} or newer (running ${version})`;
}

const unsupportedNode = nodeVersionError(process.versions.node);
if (unsupportedNode) {
  console.error(unsupportedNode);
  process.exit(1);
}

/** @returns {string|undefined} where setup stores `<slug><suffix>` on Windows */
function windowsStorePath({ env, platform, slug }, suffix) {
  if (platform !== 'win32' || !env.APPDATA) return undefined;
  return path.win32.join(env.APPDATA, 'groundwork', `${slug}${suffix}`);
}

/**
 * @param {KeySources} sources
 * @returns {Promise<string>} the App client ID: env first, else the Windows metadata file
 */
export async function resolveClientId(sources) {
  if (sources.env[CLIENT_ID_VARIABLE]) return sources.env[CLIENT_ID_VARIABLE];
  const metadataFile = windowsStorePath(sources, '.json');
  try {
    // PowerShell writes the metadata with a byte order mark, which JSON.parse rejects.
    const clientId = JSON.parse((await sources.readText(metadataFile)).replace(/^﻿/, '')).clientId;
    if (typeof clientId === 'string' && clientId !== '') return clientId;
  } catch {
    // No usable metadata file: fall through to the instruction.
  }
  throw new GitHubError(`token: set ${CLIENT_ID_VARIABLE} to the App client ID`);
}

/**
 * @param {KeySources} sources
 * @returns {Promise<string>} the App private key as PEM: key file first, else DPAPI on Windows
 */
export async function resolvePrivateKey(sources) {
  const keyFile = sources.env[KEY_FILE_VARIABLE];
  const dpapiFile = windowsStorePath(sources, '.pem.dpapi');
  if (!keyFile && !dpapiFile) throw new GitHubError(`token: set ${KEY_FILE_VARIABLE} to the App private key PEM path`);
  try {
    return await (keyFile ? sources.readText(keyFile) : sources.decryptDpapi(dpapiFile));
  } catch {
    throw new GitHubError(`token: cannot read the App private key; check ${keyFile ?? dpapiFile} or set ${KEY_FILE_VARIABLE}`);
  }
}

/**
 * @param {{ clientId: string, privateKey: string, now?: Date }} options
 * @returns {string} RS256 JWT
 */
export function createAppJwt({ clientId, privateKey, now = new Date() }) {
  const seconds = Math.floor(now.getTime() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = { iat: seconds - JWT_BACKDATE_SECONDS, exp: seconds + JWT_VALID_SECONDS, iss: clientId };
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}`;
  try {
    return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url')}`;
  } catch {
    throw new GitHubError('token: private key is not a usable RSA PEM');
  }
}

/**
 * @param {GitHubClient} client authenticated with the App JWT
 * @param {string} org
 * @returns {Promise<string>} installation token covering every repository of the installation
 */
export async function mintInstallationToken(client, org) {
  const installation = await client.request('GET', apiPath('/orgs/{org}/installation', { org }));
  if (typeof installation.data?.id !== 'number') throw new GitHubError(`token: ${org} has no installation of this App`);
  const response = await client.request('POST', apiPath('/app/installations/{id}/access_tokens', { id: installation.data.id }));
  if (!response.data?.token) throw new GitHubError('token: access_tokens response has no token');
  return response.data.token;
}

/**
 * @param {GitHubClient} client authenticated with the installation token (the user endpoint rejects the App JWT)
 * @param {string} botLogin for example `my-app[bot]`
 * @returns {Promise<number>}
 */
export async function fetchBotUserId(client, botLogin) {
  const response = await client.request('GET', apiPath('/users/{login}', { login: botLogin }));
  if (typeof response.data?.id !== 'number') throw new GitHubError(`token: user ${botLogin} not found`);
  return response.data.id;
}

/**
 * @param {{ baseEnv: Record<string, string|undefined>, token: string, slug: string, botId: number,
 *   execPath: string, scriptPath: string }} options
 * @returns {Record<string, string|undefined>} environment for the child process
 */
export function buildChildEnv({ baseEnv, token, slug, botId, execPath, scriptPath }) {
  const botLogin = `${slug}[bot]`;
  const email = `${botId}+${botLogin}@users.noreply.github.com`;
  // Forward slashes survive the sh that git runs helpers through; backslashes do not.
  const helper = `!"${execPath.replaceAll('\\', '/')}" "${scriptPath.replaceAll('\\', '/')}" credential`;
  return {
    ...baseEnv,
    GH_TOKEN: token,
    GIT_AUTHOR_NAME: botLogin,
    GIT_COMMITTER_NAME: botLogin,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_EMAIL: email,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: GIT_HELPER_KEY,
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: GIT_HELPER_KEY,
    GIT_CONFIG_VALUE_1: helper,
  };
}

/**
 * @param {string} action git credential action: get, store or erase
 * @param {string} token
 * @returns {string} what the helper prints to stdout
 */
export function credentialOutput(action, token) {
  return action === 'get' ? `username=x-access-token\npassword=${token}\n` : '';
}

function decryptWithPowershell(file) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', DPAPI_SCRIPT], {
      env: { ...process.env, GROUNDWORK_DPAPI_FILE: file },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(output) : reject(new Error('decrypt failed'))));
  });
}

function runChild(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit' });
    child.on('error', (error) => reject(new GitHubError(`token: cannot run ${command}: ${error.code ?? 'spawn failed'}`)));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function main(argv) {
  const [mode, ...rest] = argv;
  const isCredential = mode === 'credential';
  if (isCredential && rest[0] !== 'get') return 0;
  if (!isCredential && (mode !== 'exec' || rest[0] !== '--' || rest.length < 2)) throw new GitHubError(USAGE);
  const config = await loadConfig({ root: repoRoot(import.meta.url) });
  const slug = config.apps.agent;
  if (!slug) throw new GitHubError('token: config.json has no apps.agent');
  const sources = {
    env: process.env, platform: process.platform, slug,
    readText: (file) => readFile(file, 'utf8'), decryptDpapi: decryptWithPowershell,
  };
  const jwt = createAppJwt({ clientId: await resolveClientId(sources), privateKey: await resolvePrivateKey(sources) });
  const token = await mintInstallationToken(createClient({ env: process.env, token: jwt }), config.org);
  if (isCredential) {
    process.stdout.write(credentialOutput('get', token));
    return 0;
  }
  const botId = await fetchBotUserId(createClient({ env: process.env, token }), `${slug}[bot]`);
  const scriptPath = fileURLToPath(import.meta.url);
  const env = buildChildEnv({ baseEnv: process.env, token, slug, botId, execPath: process.execPath, scriptPath });
  return runChild(rest[1], rest.slice(2), env);
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message.split(/\r?\n/)[0] : 'token: failed');
    process.exitCode = 1;
  }
}

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubError, apiPath, createClient } from '../lib/github.mjs';

/** Op identity, read by admin-run (12.1). */
export const OP = 'script';

/** No token up front: the grants are the control-repository read and the target with the script's own `permissions` (12.1). */
export const TOKEN_SCOPE = 'deferred';

/** Empty: the target grant is the exact `permissions` export of the reviewed script, not a fixed set. */
export const PERMISSIONS = {};

export const CONTROL_READ_PERMISSIONS = { contents: 'read' };

const ARGS_MAX_LENGTH = 2000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PERMISSION_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const PERMISSION_LEVELS = new Set(['read', 'write']);
const PERMISSIONS_STATEMENT = /^export const permissions = (\{[^{}]*\});[ \t]*$/gm;
const PERMISSIONS_MENTION = /\bexport\s+const\s+permissions\b/g;
/** Refused anywhere in the file, comments included: a comment-aware scanner would be more code than the check is worth. */
const FORBIDDEN_TOKENS = [/\bimport\b/, /\brequire\s*\(/, /\bgetBuiltinModule\b/, /\beval\s*\(/, /\bFunction\s*\(/, /\bprocess\s*\.\s*binding\b/];
const CHILD_ARGUMENT = '--script-child';
const CHILD_ENV_ALLOWLIST = ['SystemRoot'];
const CHILD_TIMEOUT_MS = 15 * 60 * 1000;
const CHILD_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const SCRIPTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROTOCOL_TYPES = new Set(['call', 'log', 'result']);

/** @returns {string[]} problems with the `args` object the script receives */
export function validateArgs(args) {
  return JSON.stringify(args).length > ARGS_MAX_LENGTH ? [`must be at most ${ARGS_MAX_LENGTH} characters of JSON`] : [];
}

/**
 * Static text check, never executes the file: the one strict-JSON `permissions` statement and none of the forbidden tokens.
 * @param {string} source text of `admin-ops/<name>.mjs`
 * @returns {{ permissions?: Record<string, 'read'|'write'>, problem?: string }}
 */
export function parseScript(source) {
  const forbidden = FORBIDDEN_TOKENS.find((token) => token.test(source));
  if (forbidden !== undefined) return { problem: `file contains forbidden token ${forbidden.source}` };
  const statements = [...source.matchAll(PERMISSIONS_STATEMENT)];
  const mentions = source.match(PERMISSIONS_MENTION) ?? [];
  if (statements.length !== 1 || mentions.length !== 1) return { problem: 'file needs exactly one `export const permissions = {...};` statement' };
  let permissions;
  try {
    permissions = JSON.parse(statements[0][1]);
  } catch {
    return { problem: 'permissions is not strict JSON' };
  }
  const entries = Object.entries(permissions);
  const valid = entries.length > 0 && entries.every(([name, level]) => PERMISSION_NAME_PATTERN.test(name) && PERMISSION_LEVELS.has(level));
  return valid ? { permissions } : { problem: 'permissions needs snake_case keys with the value read or write, and at least one key' };
}

/** The control read, and the target with the parsed `permissions` once `apply` has verified the file; the target entry is omitted until then. */
export function grants({ targetRepo, controlRepo, scriptPermissions }) {
  const controlRead = { repositories: [controlRepo], permissions: CONTROL_READ_PERMISSIONS, match: 'exact' };
  if (scriptPermissions === undefined) return [controlRead];
  return [controlRead, { repositories: [targetRepo], permissions: scriptPermissions, match: 'exact' }];
}

/** @returns {Promise<{ source: string, sha256: string }>} the file at `ref`; the hash is over the blob bytes */
export async function fetchScript(client, { org, repo, ref, scriptPath }) {
  const fileName = scriptPath.slice(scriptPath.lastIndexOf('/') + 1);
  const filePath = `${apiPath('/repos/{org}/{repo}/contents/admin-ops/', { org, repo })}${encodeURIComponent(fileName)}`;
  const file = (await client.request('GET', filePath, { query: { ref } })).data;
  if (file?.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string') {
    throw new GitHubError(`GET ${filePath}: response is not a base64 file`);
  }
  const bytes = Buffer.from(file.content, 'base64');
  return { source: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * `plan` shows the owner the file the run will execute and holds no secret. `ref` must be the current `main` head,
 * so a later fix or deletion of a script never leaves an older revision runnable.
 * @returns {Promise<{ problem?: string, facts?: string[], source?: string, scriptPermissions?: object, outputs?: object }>}
 */
export async function plan({ client, org, controlRepo, request }) {
  const { ref, scriptPath } = request;
  const mainPath = apiPath('/repos/{org}/{repo}/git/ref/heads/main', { org, repo: controlRepo });
  if ((await client.request('GET', mainPath)).data?.object?.sha !== ref) return { problem: 'ref is not the current main head of the control repository' };
  const { source, sha256 } = await fetchScript(client, { org, repo: controlRepo, ref, scriptPath });
  const parsed = parseScript(source);
  if (parsed.problem !== undefined) return { problem: `${scriptPath} refused: ${parsed.problem}` };
  return {
    facts: [`Script: ${scriptPath}`, `SHA-256: ${sha256}`],
    source,
    scriptPermissions: parsed.permissions,
    outputs: { script_sha256: sha256 },
  };
}

/** Only the allowlisted names, none of which holds a secret. */
const childEnvironment = (env) => Object.fromEntries(CHILD_ENV_ALLOWLIST.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]));

/** Runs this file as the child and resolves with its stdout once it exits; the input, token included, goes over stdin. */
function runChild(input, env) {
  return new Promise((resolve, reject) => {
    const flags = ['--permission', `--allow-fs-read=${SCRIPTS_ROOT}`];
    const child = spawn(process.execPath, [...flags, fileURLToPath(import.meta.url), CHILD_ARGUMENT], {
      env: childEnvironment(env),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CHILD_TIMEOUT_MS,
    });
    const output = { stdout: '', stderr: '' };
    for (const stream of ['stdout', 'stderr']) {
      child[stream].setEncoding('utf8').on('data', (chunk) => {
        output[stream] = (output[stream] + chunk).slice(0, CHILD_OUTPUT_LIMIT_BYTES);
      });
    }
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ ...output, code, signal }));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

/** Every stdout line must be a protocol line; a stray `console.log` fails the run instead of passing as a record. */
function parseProtocol(stdout) {
  return stdout.split('\n').filter((line) => line !== '').map((line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      throw new GitHubError('script wrote a line that is not a protocol line');
    }
    if (!PROTOCOL_TYPES.has(message?.type)) throw new GitHubError('script wrote a line that is not a protocol line');
    return message;
  });
}

async function runInChild(input, { env, log, recordCall }) {
  const { stdout, stderr, code, signal } = await runChild(input, env);
  if (code !== 0) throw new GitHubError(`script exited with ${signal ?? `code ${code}`}: ${stderr.trim().split('\n').at(-1) ?? ''}`);
  const messages = parseProtocol(stdout);
  const results = messages.filter((message) => message.type === 'result');
  if (results.length !== 1) throw new GitHubError('script must report exactly one result');
  for (const message of messages) {
    if (message.type === 'call') recordCall({ method: message.method, path: message.path, status: message.status });
    if (message.type === 'log') log(message.line);
  }
  return { ok: results[0].ok === true, summary: String(results[0].summary ?? '') };
}

/**
 * Re-fetches the file, refuses a hash other than the one `plan` printed, then runs it with one token on `target_repo`
 * holding exactly its parsed `permissions` (12.1). The script never sees the environment.
 * @returns {Promise<{ ok: boolean, summary: string }>}
 */
export async function run({ org, repo, env, config, log, recordCall, withToken, setScriptPermissions }) {
  const plannedSha256 = env.PLAN_SCRIPT_SHA256 ?? '';
  if (!SHA256_PATTERN.test(plannedSha256)) throw new GitHubError('PLAN_SCRIPT_SHA256 is missing or not a SHA-256');
  const { INPUT_REF: ref, INPUT_SCRIPT_PATH: scriptPath, INPUT_ARGS: argsText } = env;
  const controlRead = { repositories: [config.controlRepo], permissions: CONTROL_READ_PERMISSIONS };
  const fetched = await withToken(controlRead, ({ client }) => fetchScript(client, { org, repo: config.controlRepo, ref, scriptPath }));
  if (fetched.sha256 !== plannedSha256) throw new GitHubError('script SHA-256 differs from the one plan printed');
  const parsed = parseScript(fetched.source);
  if (parsed.problem !== undefined) throw new GitHubError(`${scriptPath} refused: ${parsed.problem}`);
  setScriptPermissions(parsed.permissions);
  const input = { source: fetched.source, org, repo, args: JSON.parse(argsText), apiUrl: env.GITHUB_API_URL };
  return withToken({ repositories: [repo], permissions: parsed.permissions }, ({ token }) => runInChild({ ...input, token }, { env, log, recordCall }));
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin.setEncoding('utf8')) text += chunk;
  return text;
}

/** Child entry: the reviewed file is imported as a data URL, which `parseScript` already guaranteed has no import of its own. */
async function runAsChild() {
  const input = JSON.parse(await readStdin());
  const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const github = createClient({
    env: { GITHUB_ACTIONS: 'true', GITHUB_API_URL: input.apiUrl },
    token: input.token,
    onCall: ({ method, path: callPath, status }) => emit({ type: 'call', method, path: callPath, status }),
  });
  const reviewed = await import(`data:text/javascript;base64,${Buffer.from(input.source).toString('base64')}`);
  const result = await reviewed.run({ github, org: input.org, repo: input.repo, args: input.args, log: (line) => emit({ type: 'log', line: String(line) }) });
  emit({ type: 'result', ok: result?.ok === true, summary: String(result?.summary ?? '') });
}

if (import.meta.main && process.argv.includes(CHILD_ARGUMENT)) {
  await runAsChild().catch((error) => {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}

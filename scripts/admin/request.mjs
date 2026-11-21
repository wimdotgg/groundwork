import { ConfigError, loadConfig, repoRoot } from '../lib/config.mjs';
import { GitHubError, apiPath, createClient } from '../lib/github.mjs';

/** @typedef {'apply-settings'|'bootstrap'|'bootstrap-pass2'|'check'|'create-issue-types'|'probe'} Op */
/** @typedef {{ op: Op, repo: string, ref: string, args: object, json: boolean }} Request */
/** @typedef {{ exitCode: number, stdout: string, stderr: string }} Outcome */

const USAGE = 'usage: request.mjs <apply-settings|bootstrap|bootstrap-pass2|check|create-issue-types|probe> [--repo <name>] [--ref <sha>] [--args <json>] [--json]';
const REPO_PATTERN = /^[A-Za-z0-9._-]+$/;
const DOT_SEGMENTS = new Set(['.', '..']);
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const OPS_NEEDING_REPO = new Set(['apply-settings', 'bootstrap', 'bootstrap-pass2', 'check', 'probe']);
const OPS_WITHOUT_ARGS = new Set(['bootstrap-pass2', 'probe']);
const OPS = new Set([...OPS_NEEDING_REPO, 'create-issue-types']);
const VALUE_FLAGS = new Set(['--repo', '--ref', '--args']);
const WORKFLOW_FILE = 'admin-run.yml';
const DISPATCH_REF = 'main';
const PROBE_MESSAGE = 'chore(check): probe';
const PROBE_REJECTED_STATUSES = [409, 422];
const PROBE_REJECTED_TEXT = 'push probe rejected: main is protected';
const PROBE_ACCEPTED_TEXT = 'push probe accepted: main is NOT protected; probe commit left on main as evidence';

function usageError(message) {
  return new ConfigError(`${message}. ${USAGE}`);
}

/**
 * Splits `--flag value` and `--flag=value` tokens.
 * @param {string[]} tokens
 * @returns {{ positional: string[], values: Record<string, string>, json: boolean }}
 */
function readTokens(tokens) {
  const positional = [];
  const values = {};
  let json = false;
  for (let index = 0; index < tokens.length; index++) {
    const [flag, inlineValue] = tokens[index].split(/=(.*)/s, 2);
    if (flag === '--json' && inlineValue === undefined) {
      json = true;
      continue;
    }
    if (!flag.startsWith('--')) {
      positional.push(tokens[index]);
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw usageError(`unknown flag ${flag}`);
    const value = inlineValue ?? tokens[++index];
    if (value === undefined) throw usageError(`${flag} needs a value`);
    if (flag in values) throw usageError(`${flag} given twice`);
    values[flag] = value;
  }
  return { positional, values, json };
}

function parseArgsObject(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw usageError('--args is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw usageError('--args must be a JSON object');
  }
  return parsed;
}

function checkFlagsForOp(op, values) {
  const repoGiven = '--repo' in values;
  if (OPS_NEEDING_REPO.has(op) && !repoGiven) throw usageError(`${op} needs --repo`);
  if (!OPS_NEEDING_REPO.has(op) && repoGiven) throw usageError(`${op} takes no --repo`);
  if ('--ref' in values && op !== 'apply-settings') throw usageError('--ref only applies to apply-settings');
  if ('--args' in values && OPS_WITHOUT_ARGS.has(op)) throw usageError(`${op} takes no --args`);
}

/**
 * @param {string[]} argv arguments after the script name
 * @returns {Request} `ref` is empty when not given
 */
export function parseArgs(argv) {
  const { positional, values, json } = readTokens(argv);
  if (positional.length !== 1) throw usageError('expected exactly one op');
  const op = positional[0];
  if (!OPS.has(op)) throw usageError(`unknown op ${op}`);
  checkFlagsForOp(op, values);
  const repo = values['--repo'] ?? '';
  if ('--repo' in values && (!REPO_PATTERN.test(repo) || DOT_SEGMENTS.has(repo))) {
    throw usageError('--repo must match [A-Za-z0-9._-]+ and not be . or ..');
  }
  const ref = values['--ref'] ?? '';
  if ('--ref' in values && !SHA_PATTERN.test(ref)) throw usageError('--ref must be a 40-character lowercase hex SHA');
  const args = '--args' in values ? parseArgsObject(values['--args']) : {};
  return { op, repo, ref, args, json };
}

async function currentMainSha(client, org, repo) {
  const path = apiPath('/repos/{org}/{repo}/git/ref/heads/main', { org, repo });
  const sha = (await client.request('GET', path)).data?.object?.sha;
  if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) throw new GitHubError(`GET ${path}: response has no commit SHA`);
  return sha;
}

async function dispatchAdminRun({ request, client, config }) {
  const { org, controlRepo } = config;
  const needsRef = request.op === 'apply-settings';
  const ref = needsRef && request.ref === '' ? await currentMainSha(client, org, request.repo) : request.ref;
  const inputs = { op: request.op, target_repo: request.repo, ref, args: JSON.stringify(request.args) };
  const path = apiPath('/repos/{org}/{repo}/actions/workflows/{file}/dispatches', { org, repo: controlRepo, file: WORKFLOW_FILE });
  const response = await client.request('POST', path, { body: { ref: DISPATCH_REF, inputs, return_run_details: true } });
  const runUrl = response.data?.html_url;
  const hasRun = typeof runUrl === 'string' && runUrl !== '';
  const approveUrl = hasRun ? runUrl : `https://github.com/${org}/${controlRepo}/actions/workflows/${WORKFLOW_FILE}`;
  return { op: request.op, targetRepo: request.repo, ref, approveUrl, runDetails: hasRun };
}

function describeDispatch(result) {
  const lead = result.runDetails ? 'dispatched; approve the run' : 'dispatched; run URL not returned, find the run here';
  return `${lead}: ${result.approveUrl}`;
}

async function runPushProbe({ request, client, config }) {
  const { org } = config;
  const repo = request.repo;
  const sha = await currentMainSha(client, org, repo);
  const commitPath = apiPath('/repos/{org}/{repo}/git/commits/{sha}', { org, repo, sha });
  const tree = (await client.request('GET', commitPath)).data?.tree?.sha;
  if (typeof tree !== 'string') throw new GitHubError(`GET ${commitPath}: response has no tree SHA`);
  const created = await client.request('POST', apiPath('/repos/{org}/{repo}/git/commits', { org, repo }), {
    body: { message: PROBE_MESSAGE, tree, parents: [sha] },
  });
  const probeSha = created.data?.sha;
  if (typeof probeSha !== 'string') throw new GitHubError('POST git/commits: response has no commit SHA');
  const update = await client.request('PATCH', apiPath('/repos/{org}/{repo}/git/refs/heads/main', { org, repo }), {
    body: { sha: probeSha, force: false },
    okStatuses: PROBE_REJECTED_STATUSES,
  });
  const rejected = PROBE_REJECTED_STATUSES.includes(update.status);
  // An unprotected main that moved after the first read also answers 422 (non-fast-forward).
  if (rejected && (await currentMainSha(client, org, repo)) !== sha) {
    throw new GitHubError('push probe inconclusive: main moved during the probe; rerun');
  }
  return { op: 'probe', targetRepo: repo, protected: rejected, status: update.status, probeSha };
}

function stdoutFor({ exitCode, text, result, json }) {
  if (json) return `${JSON.stringify(result)}\n`;
  if (exitCode !== 0) return '';
  return `${text}\n`;
}

function outcome({ exitCode, text, result, json }) {
  const stdout = stdoutFor({ exitCode, text, result, json });
  const stderr = exitCode === 0 ? '' : `${text}\n`;
  return { exitCode, stdout, stderr };
}

/**
 * @param {{ argv: string[], client: import('../lib/github.mjs').GitHubClient,
 *   config: import('../lib/config.mjs').Config }} options
 * @returns {Promise<Outcome>}
 */
export async function main({ argv, client, config }) {
  const request = parseArgs(argv);
  if (request.op === 'probe') {
    const result = await runPushProbe({ request, client, config });
    const text = result.protected ? PROBE_REJECTED_TEXT : PROBE_ACCEPTED_TEXT;
    return outcome({ exitCode: result.protected ? 0 : 1, text, result, json: request.json });
  }
  const result = await dispatchAdminRun({ request, client, config });
  return outcome({ exitCode: 0, text: describeDispatch(result), result, json: request.json });
}

async function runCli() {
  try {
    const config = await loadConfig({ root: repoRoot(import.meta.url) });
    const client = createClient({ env: process.env });
    const { exitCode, stdout, stderr } = await main({ argv: process.argv.slice(2), client, config });
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    process.exitCode = exitCode;
  } catch (error) {
    const message = String(error?.message ?? error).split(/\r?\n/)[0];
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await runCli();

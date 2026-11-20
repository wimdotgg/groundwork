// Pushes the branch, rewrites the PR `## State` and posts the journal comment (spec 6.5, 13).
// Run under `token.mjs exec` so git and the GitHub writes act as the agent App.
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CONFIG_DIR, ConfigError, loadConfig, repoRoot } from '../lib/config.mjs';
import { apiPath, currentRepo, createClient, GitHubError } from '../lib/github.mjs';
import { isValidSessionId, parseFooter } from '../lib/issue-model.mjs';
import {
  fillTemplate, parseSections, parseStateSection, replaceSection, templatePlaceholders,
} from '../lib/markdown.mjs';
import { assertNode24 } from './token.mjs';

assertNode24(import.meta);

const EXIT_ERROR = 1;
const EXIT_HELD = 3;
const STDIN_TIMEOUT_MS = 2000;
const DEFAULT_INPUT = '.artifacts/checkpoint.json';
const BRANCH_PATTERN = /^issue\/(\d+)$/;
const FOOTER_BREAK = '---';
const STATE_FIELDS = ['Done', 'In progress', 'Next', 'Proven', 'Unproven', 'Rejected', 'Gotchas', 'Open'];

export class CheckpointError extends Error {
  constructor(message, exitCode = EXIT_ERROR) {
    super(message);
    this.exitCode = exitCode;
  }
}

function parseInput(text) {
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    throw new CheckpointError('input file is not valid JSON');
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new CheckpointError('input file must hold a JSON object');
  }
  const fields = input.fields ?? {};
  const missing = STATE_FIELDS.filter((name) => typeof fields[name] !== 'string' || fields[name].trim() === '');
  if (missing.length > 0) throw new CheckpointError(`input fields missing or empty: ${missing.join(', ')}`);
  if (typeof input.journal !== 'string' || input.journal.trim() === '') {
    throw new CheckpointError('input journal missing or empty');
  }
  const splitters = STATE_FIELDS.filter((name) => fields[name].split(/\r?\n/).some((line) => line === FOOTER_BREAK || line.startsWith('## ')));
  if (splitters.length > 0) throw new CheckpointError(`input fields would split the State section: ${splitters.join(', ')}`);
  return { fields, journal: input.journal.trim() };
}

function currentCheckpointNumber(body) {
  const state = parseSections(body).sections.find((section) => section.name === 'State');
  const raw = state ? parseStateSection(state).header.checkpoint : null;
  if (!/^\d+$/.test(raw ?? '')) throw new CheckpointError('PR body has no State checkpoint number');
  return Number(raw);
}

const lineCount = (text) => text.trimEnd().split('\n').length;

/**
 * Renders the State section and journal comment, refusing placeholders and over-limit text.
 * @returns {{ state: string, comment: string }}
 */
function render({ input, header, templates, limits }) {
  const keys = { ...header };
  for (const name of STATE_FIELDS) keys[name.toLowerCase()] = input.fields[name];
  const state = fillTemplate(templates.state, keys).text.trimEnd();
  const comment = fillTemplate(templates.comment, { ...header, journal: input.journal });
  if (comment.unfilled.length > 0) throw new CheckpointError(`journal comment has unfilled ${comment.unfilled.join(', ')}`);
  if (templatePlaceholders(state).length > 0) throw new CheckpointError('State still has a <...> placeholder');
  if (lineCount(state) > limits.stateLines) throw new CheckpointError(`State is over ${limits.stateLines} lines`);
  if (lineCount(input.journal) > limits.journalLines) {
    throw new CheckpointError(`journal is over ${limits.journalLines} lines`);
  }
  return { state, comment: comment.text };
}

async function findPullRequest({ client, repo, branch }) {
  const pulls = await client.request('GET', apiPath('/repos/{owner}/{repo}/pulls', repo), {
    query: { head: `${repo.owner}:${branch}`, state: 'open' },
  });
  return pulls.data[0] ?? null;
}

async function push({ git, branch }) {
  const { code, stderr } = await git(['push', 'origin', branch]);
  if (code === 0) return;
  throw new CheckpointError(`push of ${branch} was rejected: ${stderr.trim().split('\n')[0] || `git exit ${code}`}`);
}

async function readInput(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new CheckpointError(`cannot read ${file}: ${error.code}`);
  }
}

async function removeInput(file) {
  try {
    await rm(file);
  } catch (error) {
    throw new CheckpointError(`journal posted but cannot delete ${file}: ${error.code}`);
  }
}

async function loadTemplates(root) {
  const read = async (name) => {
    try {
      return await readFile(path.join(root, CONFIG_DIR, 'templates', name), 'utf8');
    } catch (error) {
      throw new CheckpointError(`cannot read template ${name}: ${error.code}`);
    }
  };
  return { state: await read('state-section.md'), comment: await read('checkpoint-comment.md') };
}

async function postState({ client, repo, pr, body, state }) {
  const route = apiPath('/repos/{owner}/{repo}/pulls/{number}', { ...repo, number: pr.number });
  await client.request('PATCH', route, { body: { body: replaceSection(body, 'State', state) } });
}

async function postJournal({ client, repo, pr, comment }) {
  const route = apiPath('/repos/{owner}/{repo}/issues/{number}/comments', { ...repo, number: pr.number });
  await client.request('POST', route, { body: { body: comment } });
}

/**
 * @param {{ options: { session: string, input: string, auto: boolean }, root: string, client: object,
 *   repo: { owner: string, repo: string }, git: (args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>,
 *   now?: () => Date }} context
 * @returns {Promise<object>} the `--json` success object
 */
export async function runCheckpoint({ options, root, client, repo, git, now = () => new Date() }) {
  const { session, auto } = options;
  if (!isValidSessionId(session)) throw new CheckpointError('session id required');
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const number = Number(BRANCH_PATTERN.exec(branch)?.[1]);
  if (!Number.isInteger(number)) {
    if (auto) return { ok: true, skipped: 'not on an issue/N branch' };
    throw new CheckpointError(`not on an issue/N branch (on ${branch})`);
  }
  const pr = await findPullRequest({ client, repo, branch });
  if (pr === null && auto) return { ok: true, skipped: `no open PR for ${branch}` };
  if (pr === null) throw new CheckpointError(`no open PR for ${branch}`);
  if (auto && !pr.draft) return { ok: true, skipped: 'PR is not a draft' };

  const footer = parseFooter(pr.body ?? '');
  if (footer === null) throw new CheckpointError('PR body has no Agent footer');
  if (footer.session !== session) {
    throw new CheckpointError(`PR footer names session ${footer.session}`, EXIT_HELD);
  }
  const inputText = await readInput(path.resolve(root, options.input));
  if (inputText === null && !auto) throw new CheckpointError(`input file ${options.input} not found`);
  const current = currentCheckpointNumber(pr.body);
  if (inputText === null) {
    await push({ git, branch });
    return { ok: true, number, pr: pr.number, checkpoint: current };
  }

  const checkpoint = current + 1;
  const header = {
    checkpoint, time: now().toISOString().slice(0, 16).replace('T', ' '), agent: footer.agent, session,
  };
  const config = await loadConfig({ root });
  const rendered = render({
    input: parseInput(inputText), header, templates: await loadTemplates(root), limits: config.limits,
  });
  await push({ git, branch });
  await postState({ client, repo, pr, body: pr.body, state: rendered.state });
  await postJournal({ client, repo, pr, comment: rendered.comment });
  await removeInput(path.resolve(root, options.input));
  return { ok: true, number, pr: pr.number, checkpoint };
}

const gitIn = (cwd) => (args) => {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new CheckpointError(`cannot run git: ${error.code ?? 'spawn failed'}`)));
    child.on('close', (code) => resolve({ code: code ?? EXIT_ERROR, stdout, stderr }));
  });
};

/**
 * Claude Code hooks pass a JSON object on stdin; `session_id` names the session.
 * @param {string} text
 * @returns {string} the session id, or '' when the text holds none
 */
export function sessionFromHookInput(text) {
  try {
    const sessionId = JSON.parse(text)?.session_id;
    return isValidSessionId(sessionId) ? sessionId : '';
  } catch {
    return '';
  }
}

/**
 * The configured session (flag or env) wins; the hook input is read only when there is none.
 * @param {string} configuredSession
 * @param {() => Promise<string>} readHookInput
 * @returns {Promise<string>} '' when neither gives a session
 */
export async function resolveSession(configuredSession, readHookInput) {
  if (configuredSession !== '') return configuredSession;
  return sessionFromHookInput(await readHookInput());
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const read = (async () => {
    let text = '';
    for await (const chunk of process.stdin.setEncoding('utf8')) text += chunk;
    return text;
  })();
  const timeout = new Promise((resolve) => { setTimeout(resolve, STDIN_TIMEOUT_MS, '').unref(); });
  const text = await Promise.race([read, timeout]);
  process.stdin.destroy();
  return text;
}

function parseOptions(argv, env) {
  const flags = { session: { type: 'string' }, input: { type: 'string' }, auto: { type: 'boolean' }, json: { type: 'boolean' } };
  const { values } = parseArgs({ args: argv, options: flags, strict: true });
  return {
    session: values.session ?? env.GROUNDWORK_SESSION ?? '',
    input: values.input ?? DEFAULT_INPUT,
    auto: values.auto ?? false,
    json: values.json ?? false,
  };
}

function report(result, json) {
  if (json) return `${JSON.stringify(result)}\n`;
  if (result.skipped) return `checkpoint skipped: ${result.skipped}\n`;
  return `checkpoint ${result.checkpoint} done on PR #${result.pr}\n`;
}

async function main(argv, env) {
  const options = parseOptions(argv, env);
  if (options.auto) options.session = await resolveSession(options.session, readStdin);
  if (options.session === '' && options.auto) {
    process.stdout.write(report({ ok: true, skipped: 'no session id' }, options.json));
    return 0;
  }
  const root = repoRoot(import.meta.url);
  const result = await runCheckpoint({
    options, root, client: createClient({ env }), repo: await currentRepo(), git: gitIn(root),
  });
  process.stdout.write(report(result, options.json));
  return 0;
}

if (import.meta.main) {
  const wantsJson = process.argv.includes('--json');
  try {
    process.exitCode = await main(process.argv.slice(2), process.env);
  } catch (error) {
    const known = [CheckpointError, GitHubError, ConfigError].some((type) => error instanceof type);
    const reason = known || String(error.code).startsWith('ERR_PARSE_ARGS')
      ? error.message.split(/\r?\n/)[0] : 'checkpoint: failed';
    process.exitCode = error.exitCode ?? EXIT_ERROR;
    if (wantsJson) process.stdout.write(`${JSON.stringify({ ok: false, reason })}\n`);
    else console.error(reason);
  }
}

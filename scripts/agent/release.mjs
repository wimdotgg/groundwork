import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, repoRoot, CONFIG_DIR } from '../lib/config.mjs';
import { apiPath, createClient, currentRepo, repoFromEnv } from '../lib/github.mjs';
import { isValidSessionId, parseFooter } from '../lib/issue-model.mjs';
import {
  addMarker, fillTemplate, findFooterBreak, hasMarker, parseSections, parseStateSection, replaceSection, templateSection,
} from '../lib/markdown.mjs';
import { sameLogin } from '../lib/trust.mjs';
import './token.mjs'; // exits on an unsupported Node before the script runs

/** @typedef {import('../lib/github.mjs').GitHubClient} GitHubClient */
/** @typedef {{ client: GitHubClient, repo: { owner: string, repo: string }, config: { accounts: { agent: string } }, handoverTemplate: string }} ReleaseContext */

const EXIT_REFUSED = 1;
const EXIT_HELD_BY_OTHER = 3;
const NOT_FOUND = 404;
const REPO_PATH = '/repos/{owner}/{repo}';
const SESSION_VARIABLE = 'GROUNDWORK_SESSION';
const RELEASED_MARKER = 'released';
const HANDOVER_MARKER = 'handover';
const HANDOVER_TEMPLATE_FILE = 'templates/handover-comment.md';
const ALLOWED_FLAGS = ['--decision', '--merged', '--json'];
const CONVERT_TO_DRAFT = 'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { id } } }';
const DECISION_FILE = (number) => new RegExp(`^docs/decisions/${number}-[A-Za-z0-9._-]+\\.md$`);
const USAGE = 'usage: release.mjs <N> --decision|--merged [--session <id>] [--json]';

export class ReleaseRefusal extends Error {
  /**
   * @param {string} message one line
   * @param {{ exitCode?: number, session?: string|null }} [fields]
   */
  constructor(message, { exitCode = EXIT_REFUSED, session } = {}) {
    super(message);
    this.name = 'ReleaseRefusal';
    this.exitCode = exitCode;
    this.session = session;
  }
}

const newestFirst = (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at);

async function findPull(client, repoRef, number) {
  const pulls = await client.paginate(apiPath(`${REPO_PATH}/pulls`, repoRef), {
    query: { head: `${repoRef.owner}:issue/${number}`, state: 'all' },
  });
  const candidates = pulls.filter((pull) => pull.head?.ref === `issue/${number}`).sort(newestFirst);
  const pull = candidates.find((candidate) => candidate.state === 'open') ?? candidates[0];
  if (!pull) throw new ReleaseRefusal(`no pull request for issue/${number}`);
  return pull;
}

/** Puts the marker above the `---` footer break so the footer stays the last line. */
function markBeforeFooter(body, marker) {
  const lines = body.replace(/\r\n/g, '\n').trimEnd().split('\n');
  const breakIndex = findFooterBreak(lines);
  if (breakIndex === -1) return addMarker(body, marker);
  const head = addMarker(lines.slice(0, breakIndex).join('\n'), marker);
  return `${head}\n${lines.slice(breakIndex).join('\n')}\n`;
}

async function releaseDecision(context, number, session) {
  const { client, repo } = context;
  const pull = await findPull(client, repo, number);
  const holder = parseFooter(pull.body)?.session ?? null;
  if (holder !== session) {
    throw new ReleaseRefusal(`PR #${pull.number} footer names session ${holder ?? 'none'}, not ${session}`, {
      exitCode: EXIT_HELD_BY_OTHER, session: holder,
    });
  }
  if (pull.state !== 'open') throw new ReleaseRefusal(`PR #${pull.number} is not open`);
  const convert = pull.draft !== true;
  if (convert) await client.graphql(CONVERT_TO_DRAFT, { id: pull.node_id });
  if (hasMarker(pull.body ?? '', RELEASED_MARKER)) return convert;
  const body = markBeforeFooter(pull.body ?? '', RELEASED_MARKER);
  await client.request('PATCH', apiPath(`${REPO_PATH}/pulls/{number}`, { ...repo, number: pull.number }), { body: { body } });
  return true;
}

function singleLine(text) {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

function renderHandover(context, { number, pull, session }) {
  const sections = parseSections(pull.body ?? '').sections;
  const stateSection = sections.find((section) => section.name === 'State');
  if (!stateSection) throw new ReleaseRefusal(`PR #${pull.number} has no ## State section`);
  const { fields } = parseStateSection(stateSection);
  const { text, unfilled } = fillTemplate(context.handoverTemplate, {
    issue: number,
    pr: pull.number,
    done: fields.Done && singleLine(fields.Done),
    'follow-ups': fields.Open && singleLine(fields.Open),
    gotchas: fields.Gotchas && singleLine(fields.Gotchas),
    session,
  });
  if (unfilled.length > 0) throw new ReleaseRefusal(`handover not filled: ${unfilled.join(' ')}`);
  return text.trimEnd();
}

async function postHandover(context, handover, number) {
  const { client, repo, config } = context;
  const commentsPath = apiPath(`${REPO_PATH}/issues/{number}/comments`, { ...repo, number });
  const comments = await client.paginate(commentsPath);
  const posted = comments.some((comment) => sameLogin(comment.user?.login, config.accounts.agent)
    && hasMarker(comment.body ?? '', HANDOVER_MARKER));
  if (posted) return false;
  await client.request('POST', commentsPath, { body: { body: handover } });
  return true;
}

async function findParentEpic(client, repo, number) {
  const response = await client.request('GET', apiPath(`${REPO_PATH}/issues/{number}/parent`, { ...repo, number }), {
    okStatuses: [NOT_FOUND],
  });
  if (response.status === NOT_FOUND) throw new ReleaseRefusal(`spike #${number} has no parent epic`);
  const epic = response.data;
  if (!String(epic.repository_url ?? '').toLowerCase().endsWith(`/repos/${repo.owner}/${repo.repo}`.toLowerCase())) {
    throw new ReleaseRefusal(`parent #${epic.number} is not in ${repo.owner}/${repo.repo}`);
  }
  if (epic.type?.name !== 'Epic') throw new ReleaseRefusal(`parent #${epic.number} is not an Epic`);
  return epic;
}

async function findDecisionFile(client, repo, { number, pullNumber }) {
  const files = await client.paginate(apiPath(`${REPO_PATH}/pulls/{pullNumber}/files`, { ...repo, pullNumber }));
  const match = files.map((file) => file.filename).find((name) => DECISION_FILE(number).test(name));
  if (!match) throw new ReleaseRefusal(`PR #${pullNumber} has no docs/decisions/${number}-<slug>.md`);
  return match;
}

async function planSpikeDecision(context, { number, pull }) {
  const { client, repo } = context;
  const epic = await findParentEpic(client, repo, number);
  const decisionFile = await findDecisionFile(client, repo, { number, pullNumber: pull.number });
  return { epic, decisionFile };
}

async function appendSpikeDecision(context, { number, pull, plan }) {
  const { epic, decisionFile } = plan;
  const { repo } = context;
  const decisions = templateSection(epic.body ?? '', 'Decisions') ?? '';
  if (decisions.includes(decisionFile)) return false;
  const url = `https://github.com/${repo.owner}/${repo.repo}/blob/${pull.merge_commit_sha}/${decisionFile}`;
  const line = `- ${pull.merged_at.slice(0, 10)}: Spike #${number} decided in [${decisionFile}](${url}) (PR #${pull.number}).`;
  const body = replaceSection(epic.body ?? '', 'Decisions', decisions === '' ? line : `${decisions}\n${line}`);
  const epicPath = apiPath(`${REPO_PATH}/issues/{number}`, { ...repo, number: epic.number });
  await context.client.request('PATCH', epicPath, { body: { body } });
  return true;
}

async function releaseMerged(context, number, session) {
  const { client, repo } = context;
  const pull = await findPull(client, repo, number);
  if (!pull.merged_at) throw new ReleaseRefusal(`PR #${pull.number} is not merged`);
  const handover = renderHandover(context, { number, pull, session });
  const issue = (await client.request('GET', apiPath(`${REPO_PATH}/issues/{number}`, { ...repo, number }))).data;
  const plan = issue.type?.name === 'Spike' ? await planSpikeDecision(context, { number, pull }) : null;
  const posted = await postHandover(context, handover, number);
  const appended = plan !== null && await appendSpikeDecision(context, { number, pull, plan });
  return posted || appended;
}

/**
 * @param {ReleaseContext} context
 * @param {{ number: number, mode: 'decision'|'merged', session: string }} request
 * @throws {ReleaseRefusal|GitHubError}
 */
export async function release(context, { number, mode, session }) {
  const changed = mode === 'decision'
    ? await releaseDecision(context, number, session)
    : await releaseMerged(context, number, session);
  return { ok: true, number, mode, changed };
}

/**
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} env
 * @returns {{ number: number, mode: 'decision'|'merged', session: string, json: boolean }}
 * @throws {ReleaseRefusal}
 */
export function parseArguments(argv, env) {
  const flags = new Set();
  const positional = [];
  let session = env[SESSION_VARIABLE];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--session') {
      session = argv[index + 1];
      if (session === undefined || session.startsWith('--')) throw new ReleaseRefusal('--session needs a value');
      index += 1;
    } else if (argument.startsWith('--')) {
      if (!ALLOWED_FLAGS.includes(argument)) throw new ReleaseRefusal(`unknown flag ${argument}; ${USAGE}`);
      flags.add(argument);
    } else {
      positional.push(argument);
    }
  }
  const number = Number(positional[0]);
  if (positional.length !== 1 || !Number.isInteger(number) || number <= 0) throw new ReleaseRefusal(USAGE);
  if (flags.has('--decision') === flags.has('--merged')) throw new ReleaseRefusal(`choose exactly one of --decision or --merged; ${USAGE}`);
  if (!session) throw new ReleaseRefusal('session id required');
  if (!isValidSessionId(session)) throw new ReleaseRefusal(`invalid session id: ${session}`);
  return { number, mode: flags.has('--decision') ? 'decision' : 'merged', session, json: flags.has('--json') };
}

function report({ json, exitCode, payload }) {
  if (json) console.log(JSON.stringify(payload));
  else if (payload.ok) console.log(`#${payload.number} ${payload.mode}: ${payload.changed ? 'done' : 'already done'}`);
  else console.error(payload.reason);
  return exitCode;
}

async function main(argv, env) {
  const json = argv.includes('--json');
  try {
    const request = parseArguments(argv, env);
    const root = repoRoot(import.meta.url);
    const config = await loadConfig({ root });
    const handoverTemplate = await readFile(path.join(root, CONFIG_DIR, HANDOVER_TEMPLATE_FILE), 'utf8');
    const repo = env.GITHUB_REPOSITORY ? repoFromEnv(env) : await currentRepo();
    const result = await release({ client: createClient({ env }), repo, config, handoverTemplate }, request);
    return report({ json, exitCode: 0, payload: result });
  } catch (error) {
    const payload = { ok: false, reason: error.message, ...(error.session === undefined ? {} : { session: error.session }) };
    return report({ json, exitCode: error.exitCode ?? EXIT_REFUSED, payload });
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env);

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CONFIG_DIR, loadConfig, loadHotspots, repoRoot } from '../lib/config.mjs';
import { GitHubError, apiPath, createClient, currentRepo, repoFromEnv } from '../lib/github.mjs';
import { ISSUE_TYPES, normalizeIssueBody } from '../lib/issue-model.mjs';
import { criterionIds, fillTemplate, hasMarker, parseSections, removeMarker } from '../lib/markdown.mjs';
import { sameLogin } from '../lib/trust.mjs';
import './token.mjs'; // exits on an unsupported Node before the script runs

/** @typedef {import('../lib/github.mjs').GitHubClient} GitHubClient */
/** @typedef {{ number: number, title: string, type: string|null, state: 'open'|'closed', body: string,
 *   parent: number, level: number, blockedBy: number[] }} PlanNode   level: the epic is 1, its sub-issues 2 */
/** @typedef {{ code: string, task: number|null, message: string }} Failure */
/** @typedef {{ client: GitHubClient, repo: { owner: string, repo: string }, config: object,
 *   hotspots: Array<{ name: string, paths: string[] }>, template: string }} PlanLintContext */

const REPO_PATH = '/repos/{owner}/{repo}';
const PLAN_MARKER = 'plan-lint';
const TEMPLATE_FILE = 'templates/plan-comment.md';
const USAGE = 'usage: plan-lint.mjs <epic> [--post] [--json]';
const FIRST_TASK_LEVEL = 2;
const SERVES_ID = /\bE\d+\b/;
const BACKTICKED = /`([^`\n]+)`/g;

export class PlanLintError extends Error {}

const openOrClosed = (state) => (state === 'closed' ? 'closed' : 'open');

async function collectNodes({ client, repoRef }, { parent, level }, nodes) {
  const children = await client.paginate(apiPath(`${REPO_PATH}/issues/{number}/sub_issues`, { ...repoRef, number: parent }));
  for (const issue of children) {
    const blockedByPath = apiPath(`${REPO_PATH}/issues/{number}/dependencies/blocked_by`, { ...repoRef, number: issue.number });
    const blockers = await client.paginate(blockedByPath);
    nodes.push({
      number: issue.number,
      title: issue.title ?? '',
      type: issue.type?.name ?? null,
      state: openOrClosed(issue.state),
      body: issue.body ?? '',
      parent,
      level,
      blockedBy: blockers.map((blocker) => blocker.number),
    });
    if (issue.sub_issues_summary?.total > 0) await collectNodes({ client, repoRef }, { parent: issue.number, level: level + 1 }, nodes);
  }
}

/**
 * Every sub-issue below the epic, closed ones included, depth first in sub-issue order.
 * @param {GitHubClient} client
 * @param {{ owner: string, repo: string }} repoRef
 * @param {number} epic
 * @returns {Promise<PlanNode[]>}
 * @throws {PlanLintError|GitHubError}
 */
export async function loadPlan(client, repoRef, epic) {
  const issue = (await client.request('GET', apiPath(`${REPO_PATH}/issues/{number}`, { ...repoRef, number: epic }))).data;
  if (issue.type?.name !== 'Epic') throw new PlanLintError(`#${epic} is not an epic`);
  const nodes = [];
  await collectNodes({ client, repoRef }, { parent: epic, level: FIRST_TASK_LEVEL }, nodes);
  return nodes;
}

// Tasks are the leaves: an issue with sub-issues only groups them (6.2, depth 3).
const leavesOf = (nodes) => nodes.filter((node) => !nodes.some((other) => other.parent === node.number));

// A blocker outside the plan cannot make a cycle or order a lane, and one on a grouping issue is ignored.
function blockerGraph(tasks) {
  const known = new Set(tasks.map((task) => task.number));
  return new Map(tasks.map((task) => [task.number, task.blockedBy.filter((number) => known.has(number))]));
}

function findCycles(graph) {
  const state = new Map();
  const stack = [];
  const cycles = [];
  const visit = (number) => {
    state.set(number, 'visiting');
    stack.push(number);
    for (const blocker of graph.get(number)) {
      if (state.get(blocker) === 'visiting') cycles.push([...stack.slice(stack.indexOf(blocker)), blocker]);
      else if (!state.has(blocker)) visit(blocker);
    }
    stack.pop();
    state.set(number, 'done');
  };
  for (const number of graph.keys()) {
    if (!state.has(number)) visit(number);
  }
  return cycles;
}

/** Every task that must finish before `number`, however indirectly. */
function transitiveBlockers(graph, number) {
  const found = new Set();
  const pending = [...graph.get(number)];
  while (pending.length > 0) {
    const next = pending.pop();
    if (found.has(next)) continue;
    found.add(next);
    pending.push(...graph.get(next));
  }
  return found;
}

function cycleFailures(graph) {
  return findCycles(graph).map((cycle) => ({
    code: 'cycle',
    task: cycle[0],
    message: `dependency cycle: ${cycle.map((number) => `#${number}`).join(' blocked by ')}`,
  }));
}

function integrationFailures(tasks, graph) {
  if (tasks.length === 0) return [{ code: 'no-integration-task', task: null, message: 'the epic has no sub-issues, so no integration task' }];
  const isIntegration = (task) => {
    const blockers = transitiveBlockers(graph, task.number);
    return tasks.every((other) => other === task || blockers.has(other.number));
  };
  if (tasks.some(isIntegration)) return [];
  return [{ code: 'no-integration-task', task: null, message: 'no task is blocked by every other task (the integration task)' }];
}

function sizeFailures(nodes, limits) {
  return [...Map.groupBy(nodes, (node) => node.parent)]
    .filter(([, children]) => children.length > limits.subIssuesPerParent)
    .map(([parent, children]) => ({
      code: 'too-many-sub-issues',
      task: parent,
      message: `#${parent} has ${children.length} sub-issues; the limit is ${limits.subIssuesPerParent}`,
    }));
}

function depthFailures(nodes, limits) {
  const taskCount = leavesOf(nodes).length;
  const allowed = taskCount > limits.subIssuesPerParent ? limits.hierarchyDepthWithIntermediate : limits.hierarchyDepth;
  return nodes
    .filter((node) => node.level > allowed)
    .map((node) => ({
      code: 'depth',
      task: node.number,
      message: `#${node.number} is at depth ${node.level}; the limit is ${allowed} for ${taskCount} tasks`,
    }));
}

// A typeless task is read as a Feature; the issue-format workflow owns the type check.
function sectionsOf(task) {
  const type = ISSUE_TYPES.includes(task.type) ? task.type : 'Feature';
  return parseSections(normalizeIssueBody(type, task.body)).byName;
}

function contentFailures(task) {
  const byName = sectionsOf(task);
  const failures = [];
  if (task.type !== 'Spike' && criterionIds(byName['Acceptance criteria'] ?? '', 'AC').length === 0) {
    failures.push({ code: 'missing-ac', task: task.number, message: `#${task.number} has no acceptance criterion (AC<n>)` });
  }
  if (!SERVES_ID.test(byName.Serves ?? '')) {
    failures.push({ code: 'missing-serves', task: task.number, message: `#${task.number} has no epic criterion in ## Serves` });
  }
  return failures;
}

const trimSlashes = (value) => value.replace(/\/+$/, '');

/** Paths a task names in `## Touches`; a hotspot name stands for its paths. */
function touchedPaths(task, hotspots) {
  const section = sectionsOf(task).Touches ?? '';
  const quoted = [...section.matchAll(BACKTICKED)].map((match) => match[1]);
  const tokens = quoted.length > 0 ? quoted : section.split(/[,\n]/).map((token) => token.replace(/^\s*[-*]\s*/, ''));
  return tokens
    .map((token) => trimSlashes(token.trim()))
    .filter((token) => token !== '')
    .flatMap((token) => hotspots.find((hotspot) => hotspot.name === token)?.paths.map(trimSlashes) ?? [token]);
}

const pathsOverlap = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

function sharedPath(pathsA, pathsB) {
  return pathsA.find((a) => pathsB.some((b) => pathsOverlap(a, b))) ?? null;
}

function overlapFailure(first, second, { graph, touches }) {
  const shared = sharedPath(touches.get(first.number), touches.get(second.number));
  const linked = transitiveBlockers(graph, first.number).has(second.number)
    || transitiveBlockers(graph, second.number).has(first.number);
  if (shared === null || linked) return null;
  return {
    code: 'touches-overlap',
    task: first.number,
    message: `#${first.number} and #${second.number} both touch ${shared} with no blocked-by link`,
  };
}

function overlapFailures(tasks, { graph, hotspots }) {
  const open = tasks.filter((task) => task.state === 'open');
  const touches = new Map(open.map((task) => [task.number, touchedPaths(task, hotspots)]));
  return open
    .flatMap((first, index) => open.slice(index + 1).map((second) => overlapFailure(first, second, { graph, touches })))
    .filter((failure) => failure !== null);
}

/**
 * The 6.2 failures of a plan.
 * @param {PlanNode[]} nodes
 * @param {{ limits: { hierarchyDepth: number, hierarchyDepthWithIntermediate: number, subIssuesPerParent: number },
 *   hotspots: Array<{ name: string, paths: string[] }> }} rules
 * @returns {Failure[]}
 */
export function lintPlan(nodes, { limits, hotspots }) {
  const tasks = leavesOf(nodes);
  const graph = blockerGraph(tasks);
  return [
    ...sizeFailures(nodes, limits),
    ...depthFailures(nodes, limits),
    ...tasks.flatMap(contentFailures),
    ...cycleFailures(graph),
    ...integrationFailures(tasks, graph),
    ...overlapFailures(tasks, { graph, hotspots }),
  ];
}

/**
 * Tasks grouped by the longest blocker chain below them: lane 1 has no blockers, lane 2 waits on lane 1, and so on.
 * Width is the most open tasks in one lane. Null while a cycle leaves the order undefined.
 * @param {PlanNode[]} nodes
 * @returns {{ lanes: PlanNode[][], width: number }|null}
 */
export function laneWidth(nodes) {
  const tasks = leavesOf(nodes);
  const graph = blockerGraph(tasks);
  if (findCycles(graph).length > 0) return null;
  const laneOf = new Map();
  const place = (task) => {
    if (laneOf.has(task.number)) return laneOf.get(task.number);
    const blockerLanes = graph.get(task.number).map((number) => place(tasks.find((other) => other.number === number)));
    laneOf.set(task.number, Math.max(-1, ...blockerLanes) + 1);
    return laneOf.get(task.number);
  };
  const lanes = [];
  for (const task of tasks) {
    const lane = place(task);
    lanes[lane] = [...(lanes[lane] ?? []), task];
  }
  const width = Math.max(0, ...lanes.map((lane) => lane.filter((task) => task.state === 'open').length));
  return { lanes, width };
}

const describeTask = (task) => `#${task.number} ${task.title}${task.state === 'closed' ? ' (closed)' : ''}`;

/**
 * @param {{ epic: number, nodes: PlanNode[], failures: Failure[] }} plan
 * @param {string} template plan-comment.md
 * @returns {string} the comment body, marker included
 * @throws {PlanLintError} when the template has a placeholder this function does not fill
 */
export function renderReport({ epic, nodes, failures }, template) {
  const lanes = laneWidth(nodes);
  const laneLines = (lanes?.lanes ?? []).map((lane, index) => `- Lane ${index + 1}: ${lane.map(describeTask).join('; ')}`);
  const failureLines = failures.map((failure) => `- ${failure.code}: ${failure.message}`);
  const { text, unfilled } = fillTemplate(template, {
    epic,
    result: failures.length === 0 ? 'pass' : `fail (${failures.length})`,
    width: lanes === null ? 'unknown (dependency cycle)' : lanes.width,
    lanes: laneLines.length > 0 ? laneLines.join('\n') : 'none',
    failures: failureLines.length > 0 ? failureLines.join('\n') : 'none',
  });
  if (unfilled.length > 0) throw new PlanLintError(`plan comment template not filled: ${unfilled.join(' ')}`);
  return `${text.trimEnd()}\n`;
}

/**
 * Creates the one marked comment on the epic, or updates it; an identical body writes nothing.
 * @param {PlanLintContext} context
 * @param {{ epic: number, body: string }} report
 * @returns {Promise<'created'|'updated'|'unchanged'>}
 */
export async function upsertReport({ client, repo, config }, { epic, body }) {
  const commentsPath = apiPath(`${REPO_PATH}/issues/{number}/comments`, { ...repo, number: epic });
  const comments = await client.paginate(commentsPath);
  const existing = comments.findLast((comment) => sameLogin(comment.user?.login, config.accounts.agent)
    && hasMarker(comment.body ?? '', PLAN_MARKER));
  if (!existing) {
    await client.request('POST', commentsPath, { body: { body } });
    return 'created';
  }
  if (existing.body.trim() === body.trim()) return 'unchanged';
  await client.request('PATCH', apiPath(`${REPO_PATH}/issues/comments/{id}`, { ...repo, id: existing.id }), { body: { body } });
  return 'updated';
}

/**
 * @param {PlanLintContext} context
 * @param {{ epic: number, post: boolean }} request
 * @returns {Promise<{ epic: number, tasks: number, width: number|null, failures: Failure[], report: string, posted: string|null }>}
 */
export async function planLint(context, { epic, post }) {
  const { client, repo, config, hotspots, template } = context;
  const nodes = await loadPlan(client, repo, epic);
  const failures = lintPlan(nodes, { limits: config.limits, hotspots });
  const report = renderReport({ epic, nodes, failures }, template);
  const posted = post ? await upsertReport(context, { epic, body: report }) : null;
  return { epic, tasks: leavesOf(nodes).length, width: laneWidth(nodes)?.width ?? null, failures, report, posted };
}

/**
 * @param {string[]} argv
 * @returns {{ epic: number, post: boolean, json: boolean }}
 * @throws {PlanLintError}
 */
export function parseArguments(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { post: { type: 'boolean' }, json: { type: 'boolean' } }, allowPositionals: true });
  } catch (error) {
    throw new PlanLintError(`${error.message.split('\n')[0]}; ${USAGE}`);
  }
  const epic = Number(parsed.positionals[0]);
  if (parsed.positionals.length !== 1 || !Number.isInteger(epic) || epic <= 0) throw new PlanLintError(USAGE);
  return { epic, post: parsed.values.post === true, json: parsed.values.json === true };
}

function reportResult({ report, posted, ...fields }, { json }) {
  const count = fields.failures.length;
  const reason = `${count} planning failure${count === 1 ? '' : 's'}`;
  if (json) console.log(JSON.stringify({ ok: count === 0, ...(count === 0 ? {} : { reason }), ...fields, posted }));
  else console.log(removeMarker(report, PLAN_MARKER).trimEnd());
  if (count > 0) console.error(reason);
}

function reportError(reason, { json }) {
  if (json) console.log(JSON.stringify({ ok: false, reason }));
  console.error(reason);
}

async function main(argv, env) {
  const json = argv.includes('--json');
  try {
    const request = parseArguments(argv);
    const root = repoRoot(import.meta.url);
    const context = {
      client: createClient({ env }),
      repo: env.GITHUB_REPOSITORY ? repoFromEnv(env) : await currentRepo(),
      config: await loadConfig({ root }),
      hotspots: await loadHotspots({ root }),
      template: await readFile(path.join(root, CONFIG_DIR, TEMPLATE_FILE), 'utf8'),
    };
    const result = await planLint(context, request);
    reportResult(result, { json });
    return result.failures.length === 0 ? 0 : 1;
  } catch (error) {
    const known = error instanceof PlanLintError || error instanceof GitHubError;
    reportError(known ? error.message.split(/\r?\n/)[0] : 'plan-lint: failed', { json });
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env);

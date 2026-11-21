import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CONFIG_DIR, loadConfig, loadHotspots, repoRoot } from '../lib/config.mjs';
import { apiPath, createClient, currentRepo, repoFromEnv } from '../lib/github.mjs';
import { ISSUE_TYPES, normalizeIssueBody } from '../lib/issue-model.mjs';
import { criterionIds, fillTemplate, hasMarker, parseSections, parseTable, removeMarker } from '../lib/markdown.mjs';
import { isTrustedAuthor, sameLogin } from '../lib/trust.mjs';
import { isUnder, namesHotspot } from './next.mjs';
import './token.mjs'; // exits on an unsupported Node before the script runs

/** @typedef {import('../lib/github.mjs').GitHubClient} GitHubClient */
/** @typedef {{ number: number, title: string, type: string|null, state: 'open'|'closed', body: string,
 *   stateReason: string|null, parent: number, level: number, blockedBy: Array<number|string> }} PlanNode
 *   level: the epic is 1, its sub-issues 2. title is empty for an author that is not trusted (6.7).
 *   blockedBy: a bare number for this repository, `<repository url>#<number>` for another one */
/** @typedef {{ code: string, task: number|null, message: string }} Failure */
/** @typedef {{ nodes: PlanNode[], tasks: PlanNode[], graph: Map<number, number[]>, cycles: number[][],
 *   lanes: { lanes: PlanNode[][], width: number }|null }} Plan */
/** @typedef {{ client: GitHubClient, repo: { owner: string, repo: string }, config: object,
 *   hotspots: Array<{ name: string, paths: string[] }>, template: string }} PlanLintContext */

const REPO_PATH = '/repos/{owner}/{repo}';
const PLAN_MARKER = 'plan-lint';
const ACCEPTANCE_MARKER = 'acceptance';
const NOT_PLANNED = 'not_planned';
const TEMPLATE_FILE = 'templates/plan-comment.md';
const USAGE = 'usage: plan-lint.mjs <epic> [--post | --close] [--json]';
const FIRST_TASK_LEVEL = 2;
const PATH_LIKE = /\/|\.[A-Za-z0-9]{2,}$/;
const NOT_A_PATH = /^n\/a$/i;

export class PlanLintError extends Error {}

const openOrClosed = (state) => (state === 'closed' ? 'closed' : 'open');

function blockerKey(blocker, repo) {
  const localSuffix = `/repos/${repo.owner}/${repo.repo}`.toLowerCase();
  const url = String(blocker.repository_url ?? '');
  return url === '' || url.toLowerCase().endsWith(localSuffix) ? blocker.number : `${url}#${blocker.number}`;
}

async function loadBlockers({ client, repo }, issue) {
  if (issue.issue_dependencies_summary?.total_blocked_by === 0) return [];
  const blockers = await client.paginate(apiPath(`${REPO_PATH}/issues/{number}/dependencies/blocked_by`, { ...repo, number: issue.number }));
  return blockers.map((blocker) => blockerKey(blocker, repo));
}

async function collectNodes(context, { parent, level }, nodes) {
  const { client, repo, config } = context;
  const children = await client.paginate(apiPath(`${REPO_PATH}/issues/{number}/sub_issues`, { ...repo, number: parent }));
  for (const issue of children) {
    const trusted = isTrustedAuthor({ login: issue.user?.login, kind: 'issue' }, config);
    nodes.push({
      number: issue.number,
      title: trusted ? issue.title ?? '' : '',
      type: issue.type?.name ?? null,
      state: openOrClosed(issue.state),
      stateReason: issue.state_reason ?? null,
      body: issue.body ?? '',
      parent,
      level,
      blockedBy: await loadBlockers(context, issue),
    });
    if (issue.sub_issues_summary?.total > 0) await collectNodes(context, { parent: issue.number, level: level + 1 }, nodes);
  }
}

/**
 * Every sub-issue below the epic, closed ones included, depth first in sub-issue order, the epic's criterion IDs
 * and its `## Decisions` text.
 * @param {{ client: GitHubClient, repo: { owner: string, repo: string }, config: object }} context
 * @param {number} epic
 * @returns {Promise<{ nodes: PlanNode[], epicCriteria: string[], decisions: string }>}
 * @throws {PlanLintError|import('../lib/github.mjs').GitHubError}
 */
export async function loadPlan(context, epic) {
  const { client, repo } = context;
  const issue = (await client.request('GET', apiPath(`${REPO_PATH}/issues/{number}`, { ...repo, number: epic }))).data;
  if (issue.type?.name !== 'Epic') throw new PlanLintError(`#${epic} is not an epic`);
  const nodes = [];
  await collectNodes(context, { parent: epic, level: FIRST_TASK_LEVEL }, nodes);
  const byName = parseSections(normalizeIssueBody('Epic', issue.body ?? '')).byName;
  return { nodes, epicCriteria: criterionIds(byName['Success criteria'] ?? '', 'E'), decisions: byName.Decisions ?? '' };
}

// Tasks are the leaves: an issue with sub-issues only groups them (6.2, depth 3).
const leavesOf = (nodes) => nodes.filter((node) => !nodes.some((other) => other.parent === node.number));

// A blocker outside the plan cannot make a cycle or order a lane.
function blockerGraph(tasks) {
  const known = new Set(tasks.map((task) => task.number));
  return new Map(tasks.map((task) => [task.number, task.blockedBy.filter((blocker) => known.has(blocker))]));
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

/**
 * Lane 1 holds the open tasks with no open blocker, so it is what can start now; lane 2 waits on lane 1, and so on.
 * A closed blocker is satisfied. Width is the most tasks in one lane.
 */
function buildLanes(tasks) {
  const open = tasks.filter((task) => task.state === 'open');
  const graph = blockerGraph(open);
  const laneOf = new Map();
  const place = (task) => {
    if (laneOf.has(task.number)) return laneOf.get(task.number);
    const blockerLanes = graph.get(task.number).map((number) => place(open.find((other) => other.number === number)));
    laneOf.set(task.number, Math.max(-1, ...blockerLanes) + 1);
    return laneOf.get(task.number);
  };
  const lanes = [];
  for (const task of open) {
    const lane = place(task);
    lanes[lane] = [...(lanes[lane] ?? []), task];
  }
  return { lanes, width: Math.max(0, ...lanes.map((lane) => lane.length)) };
}

/**
 * The task graph, its cycles and its lanes, computed once. Lanes are null while a cycle leaves the order undefined.
 * @param {PlanNode[]} nodes
 * @returns {Plan}
 */
export function analyzePlan(nodes) {
  const tasks = leavesOf(nodes);
  const graph = blockerGraph(tasks);
  const cycles = findCycles(graph);
  return { nodes, tasks, graph, cycles, lanes: cycles.length > 0 ? null : buildLanes(tasks) };
}

function cycleFailures({ cycles }) {
  return cycles.map((cycle) => ({
    code: 'cycle',
    task: cycle[0],
    message: `dependency cycle: ${cycle.map((number) => `#${number}`).join(' blocked by ')}`,
  }));
}

function integrationFailures({ tasks, graph }) {
  if (tasks.length === 0) return [{ code: 'no-integration-task', task: null, message: 'the epic has no sub-issues, so no integration task' }];
  const isIntegration = (task) => {
    const blockers = transitiveBlockers(graph, task.number);
    return tasks.every((other) => other === task || blockers.has(other.number));
  };
  if (tasks.some(isIntegration)) return [];
  return [{ code: 'no-integration-task', task: null, message: 'no task is blocked by every other task (the integration task)' }];
}

function groupLinkFailures({ nodes, tasks }) {
  const groups = new Set(nodes.filter((node) => !tasks.includes(node)).map((node) => node.number));
  const linksGroup = (node) => (groups.has(node.number) ? node.blockedBy.length > 0 : node.blockedBy.some((blocker) => groups.has(blocker)));
  return nodes.filter(linksGroup).map((node) => ({
    code: 'link-on-group',
    task: node.number,
    message: `#${node.number} has a blocked-by link on a grouping issue; links must sit on leaf tasks`,
  }));
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

function depthFailures({ nodes, tasks }, limits) {
  const allowed = tasks.length > limits.subIssuesPerParent ? limits.hierarchyDepthWithIntermediate : limits.hierarchyDepth;
  return nodes
    .filter((node) => node.level > allowed)
    .map((node) => ({
      code: 'depth',
      task: node.number,
      message: `#${node.number} is at depth ${node.level}; the limit is ${allowed} for ${tasks.length} tasks`,
    }));
}

// A typeless task is read as a Feature; the issue-format workflow owns the type check.
function sectionsOf(task) {
  const type = ISSUE_TYPES.includes(task.type) ? task.type : 'Feature';
  return parseSections(normalizeIssueBody(type, task.body)).byName;
}

function contentFailures(task, epicCriteria) {
  const byName = sectionsOf(task);
  const failures = [];
  if (task.type !== 'Spike' && criterionIds(byName['Acceptance criteria'] ?? '', 'AC').length === 0) {
    failures.push({ code: 'missing-ac', task: task.number, message: `#${task.number} has no acceptance criterion (AC<n>)` });
  }
  const served = (byName.Serves ?? '').split(/[\s,]+/).filter((token) => token !== '');
  if (served.length === 0 || !served.every((id) => epicCriteria.includes(id))) {
    failures.push({
      code: 'missing-serves',
      task: task.number,
      message: `#${task.number} ## Serves must name epic criteria that exist (${epicCriteria.join(', ') || 'none found'})`,
    });
  }
  return failures;
}

// Words such as `none` or `protected` are not paths, so only a token with a `/` or a file extension counts.
function pathTokens(text) {
  return text
    .split(/[\s,;`()]+/)
    .map((token) => token.replace(/:\d+$/, '').replace(/[.:;]+$/, '').replace(/\/+$/, ''))
    .filter((token) => PATH_LIKE.test(token) && !NOT_A_PATH.test(token));
}

/** What a task claims in `## Touches`: path tokens, and the hotspots held by `next.mjs` semantics. */
function touchesOf(task, hotspots) {
  const text = sectionsOf(task).Touches ?? '';
  const paths = pathTokens(text);
  const held = hotspots
    .filter((hotspot) => namesHotspot(text, hotspot) || paths.some((token) => hotspot.paths.some((hotspotPath) => isUnder(token, hotspotPath))))
    .map((hotspot) => hotspot.name);
  return { paths, held };
}

function sharedTouch(first, second) {
  const hotspot = first.held.find((name) => second.held.includes(name));
  if (hotspot !== undefined) return `hotspot ${hotspot}`;
  return first.paths.find((a) => second.paths.some((b) => isUnder(a, b) || isUnder(b, a))) ?? null;
}

function overlapFailure(first, second, { graph, touches }) {
  const shared = sharedTouch(touches.get(first.number), touches.get(second.number));
  const linked = transitiveBlockers(graph, first.number).has(second.number)
    || transitiveBlockers(graph, second.number).has(first.number);
  if (shared === null || linked) return null;
  return {
    code: 'touches-overlap',
    task: first.number,
    message: `#${first.number} and #${second.number} both touch ${shared} with no blocked-by link`,
  };
}

function overlapFailures({ tasks, graph }, hotspots) {
  const open = tasks.filter((task) => task.state === 'open');
  const touches = new Map(open.map((task) => [task.number, touchesOf(task, hotspots)]));
  return open
    .flatMap((first, index) => open.slice(index + 1).map((second) => overlapFailure(first, second, { graph, touches })))
    .filter((failure) => failure !== null);
}

/**
 * The 6.2 failures of a plan.
 * @param {Plan} plan
 * @param {{ limits: { hierarchyDepth: number, hierarchyDepthWithIntermediate: number, subIssuesPerParent: number },
 *   hotspots: Array<{ name: string, paths: string[] }>, epicCriteria: string[] }} rules
 * @returns {Failure[]}
 */
export function lintPlan(plan, { limits, hotspots, epicCriteria }) {
  return [
    ...sizeFailures(plan.nodes, limits),
    ...depthFailures(plan, limits),
    ...groupLinkFailures(plan),
    ...plan.tasks.flatMap((task) => contentFailures(task, epicCriteria)),
    ...cycleFailures(plan),
    ...integrationFailures(plan),
    ...overlapFailures(plan, hotspots),
  ];
}

const describeTask = (task) => (task.title === '' ? `#${task.number}` : `#${task.number} ${task.title}`);

/**
 * @param {{ epic: number, plan: Plan, failures: Failure[] }} report
 * @param {string} template plan-comment.md
 * @returns {string} the comment body, marker included
 * @throws {PlanLintError} when the template has a placeholder this function does not fill
 */
export function renderReport({ epic, plan, failures }, template) {
  const laneLines = (plan.lanes?.lanes ?? []).map((lane, index) => `- Lane ${index + 1}: ${lane.map(describeTask).join('; ')}`);
  const failureLines = failures.map((failure) => `- ${failure.code}: ${failure.message}`);
  const { text, unfilled } = fillTemplate(template, {
    epic,
    result: failures.length === 0 ? 'pass' : `fail (${failures.length})`,
    width: plan.lanes === null ? 'unknown (dependency cycle)' : plan.lanes.width,
    lanes: laneLines.length > 0 ? laneLines.join('\n') : 'none',
    failures: failureLines.length > 0 ? failureLines.join('\n') : 'none',
  });
  if (unfilled.length > 0) throw new PlanLintError(`plan comment template not filled: ${unfilled.join(' ')}`);
  return `${text.trimEnd()}\n`;
}

const findAgentComment = (comments, marker, config) => comments.findLast((comment) => sameLogin(comment.user?.login, config.accounts.agent)
  && hasMarker(comment.body ?? '', marker));

/**
 * Creates the one marked comment on the epic, or updates the newest one; an identical body writes nothing.
 * @param {PlanLintContext} context
 * @param {{ epic: number, body: string }} report
 * @returns {Promise<'created'|'updated'|'unchanged'>}
 */
export async function upsertReport({ client, repo, config }, { epic, body }) {
  const commentsPath = apiPath(`${REPO_PATH}/issues/{number}/comments`, { ...repo, number: epic });
  const existing = findAgentComment(await client.paginate(commentsPath), PLAN_MARKER, config);
  if (!existing) {
    await client.request('POST', commentsPath, { body: { body } });
    return 'created';
  }
  if (existing.body.trim() === body.trim()) return 'unchanged';
  await client.request('PATCH', apiPath(`${REPO_PATH}/issues/comments/{id}`, { ...repo, id: existing.id }), { body: { body } });
  return 'updated';
}

// A decision line names its issue as `#N`, or a spike by its `docs/decisions/N-<slug>.md` file.
const namesIssue = (text, number) => new RegExp(`(?<![\\w/])#${number}(?!\\d)|docs/decisions/${number}-`).test(text);

const closeFailure = (code, task, message) => ({ code, task, message });

function subIssueCloseFailures({ number, state, stateReason, type }, decisions) {
  if (state === 'open') return [closeFailure('open-sub-issue', number, `#${number} is still open`)];
  if (namesIssue(decisions, number)) return [];
  if (stateReason === NOT_PLANNED) {
    return [closeFailure('not-planned-without-reason', number, `#${number} is closed as not planned and no line in the epic's ## Decisions gives the reason`)];
  }
  if (type === 'Spike') {
    return [closeFailure('spike-without-decision', number, `spike #${number} has no line in the epic's ## Decisions naming it or docs/decisions/${number}-<slug>.md`)];
  }
  return [];
}

/** Epic criteria that have a row with evidence in the acceptance table. */
function mappedCriteria(acceptance) {
  const rows = parseTable(acceptance).filter((row) => (row.Evidence ?? '') !== '');
  return new Set(rows.map((row) => /^E\d+/.exec(row.Criterion ?? '')?.[0]).filter(Boolean));
}

function acceptanceFailures(acceptance, epicCriteria) {
  if (acceptance === null) return [closeFailure('no-acceptance-comment', null, 'no acceptance comment from the agent account on the epic')];
  const mapped = mappedCriteria(acceptance.body);
  return epicCriteria
    .filter((id) => !mapped.has(id))
    .map((id) => closeFailure('unmapped-criterion', null, `epic criterion ${id} has no evidence row in the acceptance comment`));
}

/**
 * The 4.5 epic close failures: every sub-issue closed (not planned only with a reason in `## Decisions`), every
 * closed spike recorded there, every epic criterion mapped to evidence in the acceptance comment.
 * @param {{ nodes: PlanNode[], epicCriteria: string[], decisions: string }} plan
 * @param {{ body: string }|null} acceptance the newest acceptance comment
 * @returns {Failure[]}
 */
export function lintClose({ nodes, epicCriteria, decisions }, acceptance) {
  return [
    ...nodes.flatMap((node) => subIssueCloseFailures(node, decisions)),
    ...acceptanceFailures(acceptance, epicCriteria),
  ];
}

/**
 * Checks an epic against the close list. Reads only; closing stays with the owner.
 * @param {PlanLintContext} context
 * @param {{ epic: number }} request
 * @returns {Promise<{ epic: number, tasks: number, failures: Failure[], report: string }>}
 */
export async function closeLint(context, { epic }) {
  const { client, repo, config } = context;
  const plan = await loadPlan(context, epic);
  const comments = await client.paginate(apiPath(`${REPO_PATH}/issues/{number}/comments`, { ...repo, number: epic }));
  const failures = lintClose(plan, findAgentComment(comments, ACCEPTANCE_MARKER, config) ?? null);
  const result = failures.length === 0 ? 'pass' : `fail (${failures.length})`;
  const lines = failures.map((failure) => `- ${failure.code}: ${failure.message}`);
  return { epic, tasks: plan.nodes.length, failures, report: [`Epic close #${epic}: ${result}`, ...lines].join('\n') };
}

/**
 * @param {PlanLintContext} context
 * @param {{ epic: number, post: boolean }} request
 * @returns {Promise<{ epic: number, tasks: number, width: number|null, failures: Failure[], report: string, posted: string|null }>}
 */
export async function planLint(context, { epic, post }) {
  const { config, hotspots, template } = context;
  const { nodes, epicCriteria } = await loadPlan(context, epic);
  const plan = analyzePlan(nodes);
  const failures = lintPlan(plan, { limits: config.limits, hotspots, epicCriteria });
  const report = renderReport({ epic, plan, failures }, template);
  const posted = post ? await upsertReport(context, { epic, body: report }) : null;
  return { epic, tasks: plan.tasks.length, width: plan.lanes?.width ?? null, failures, report, posted };
}

/**
 * @param {string[]} argv
 * @returns {{ epic: number, post: boolean, close: boolean, json: boolean }}
 * @throws {PlanLintError}
 */
export function parseArguments(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { post: { type: 'boolean' }, close: { type: 'boolean' }, json: { type: 'boolean' } },
      allowPositionals: true,
    });
  } catch {
    throw new PlanLintError(USAGE);
  }
  const epic = Number(parsed.positionals[0]);
  if (parsed.positionals.length !== 1 || !Number.isInteger(epic) || epic <= 0) throw new PlanLintError(USAGE);
  if (parsed.values.post && parsed.values.close) throw new PlanLintError(USAGE);
  return { epic, post: parsed.values.post === true, close: parsed.values.close === true, json: parsed.values.json === true };
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

async function createContext(env) {
  const root = repoRoot(import.meta.url);
  return {
    client: createClient({ env }),
    repo: env.GITHUB_REPOSITORY ? repoFromEnv(env) : await currentRepo(),
    config: await loadConfig({ root }),
    hotspots: await loadHotspots({ root }),
    template: await readFile(path.join(root, CONFIG_DIR, TEMPLATE_FILE), 'utf8'),
  };
}

/**
 * Exit 0 on a clean plan; 1 on a lint failure (`--json` carries `failures`) or on an error (it does not).
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} env
 * @param {(env: Record<string, string|undefined>) => Promise<PlanLintContext>} [buildContext]
 * @returns {Promise<number>}
 */
export async function main(argv, env, buildContext = createContext) {
  const json = argv.includes('--json');
  try {
    const request = parseArguments(argv);
    const context = await buildContext(env);
    const result = request.close ? await closeLint(context, request) : await planLint(context, request);
    reportResult(result, { json });
    return result.failures.length === 0 ? 0 : 1;
  } catch (error) {
    reportError(error instanceof Error ? error.message.split(/\r?\n/)[0] : 'plan-lint: failed', { json });
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env);

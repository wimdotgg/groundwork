import { apiPath } from '../lib/github.mjs';
import { ISSUE_TYPES } from '../lib/issue-model.mjs';
import { SettingsError } from '../lib/settings.mjs';

/** @typedef {import('../lib/github.mjs').GitHubClient} GitHubClient */
/** @typedef {{ number: string, title: string, type: string, size: string, body: string, blockedBy: string[] }} SetupTask */
/** @typedef {{ epic: { title: string, body: string }, tasks: SetupTask[] }} SetupTemplates */

export const SETUP_EPIC_MARKER = '<!-- groundwork:setup-epic -->';

const EPIC_FILE = 'epic.md';
const TASK_FILE_PATTERN = /^(\d+)-[^/]+\.md$/;
const TITLE_PATTERN = /^#\s+(\S.*)$/;
const DIRECTIVE_PATTERN = /^<!--\s*(type|size|blocked-by):\s*(.*?)\s*-->$/;
const DEFAULT_TYPE = 'Feature';
const TASK_TYPES = ISSUE_TYPES.filter((type) => type !== 'Epic');
const SIZES = ['S', 'M'];
const PLACEHOLDER_PATTERN = /__(ORG|REPO|DESCRIPTION)__/g;

const taskMarker = (number) => `<!-- groundwork:setup-task ${number} -->`;

/** One pass, so a description that itself holds `__ORG__` is not expanded again. */
function fillPlaceholders(text, { org, repo, description }) {
  const values = { ORG: org, REPO: repo, DESCRIPTION: description };
  return text.replace(PLACEHOLDER_PATTERN, (_match, name) => values[name]);
}

/**
 * @param {string} text file text with placeholders already filled
 * @param {string} file path relative to setup/, for messages
 * @returns {{ title: string, directives: Record<string, string>, body: string }}
 */
function splitTemplate(text, file) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const title = TITLE_PATTERN.exec(lines[0])?.[1].trim();
  if (title === undefined) throw new SettingsError(`${file}: first line must be "# <title>"`, file);
  const directives = {};
  for (const line of lines.slice(1)) {
    const directive = DIRECTIVE_PATTERN.exec(line.trim());
    if (directive) directives[directive[1]] = directive[2];
    else if (line.trim() !== '') break;
  }
  return { title, directives, body: lines.slice(1).join('\n').trim() };
}

function withMarker(body, marker) {
  return body.includes(marker) ? body : `${body}\n\n${marker}`;
}

function parseTask(file, number, text) {
  const { title, directives, body } = splitTemplate(text, file);
  const type = directives.type ?? DEFAULT_TYPE;
  if (!TASK_TYPES.includes(type)) throw new SettingsError(`${file}: unknown type "${type}"`, file);
  if (!SIZES.includes(directives.size)) {
    throw new SettingsError(`${file}: size must be one of ${SIZES.join(', ')}`, file);
  }
  const blockedBy = (directives['blocked-by'] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  return { number, title, type, size: directives.size, body: withMarker(body, taskMarker(number)), blockedBy };
}

/**
 * Pure. Reads `epic.md` and `NN-<slug>.md` from `files` (paths relative to `setup/`),
 * fills `__ORG__`, `__REPO__` and `__DESCRIPTION__`, and checks every task.
 * @param {Record<string, string>} files
 * @param {{ org: string, repo: string, description: string }} values
 * @returns {SetupTemplates}
 * @throws {SettingsError} missing epic or title, unknown type, missing or invalid size, dangling blocker
 */
export function parseSetupTemplates(files, values) {
  if (typeof files[EPIC_FILE] !== 'string') throw new SettingsError(`${EPIC_FILE}: missing`, EPIC_FILE);
  const epic = splitTemplate(fillPlaceholders(files[EPIC_FILE], values), EPIC_FILE);
  const tasks = Object.keys(files)
    .map((file) => ({ file, number: TASK_FILE_PATTERN.exec(file)?.[1] }))
    .filter(({ number }) => number !== undefined)
    .sort((a, b) => a.file.localeCompare(b.file))
    .map(({ file, number }) => parseTask(file, number, fillPlaceholders(files[file], values)));
  const numbers = new Set(tasks.map((task) => task.number));
  for (const task of tasks) {
    const dangling = task.blockedBy.find((blocker) => !numbers.has(blocker));
    if (dangling !== undefined) {
      throw new SettingsError(`task ${task.number}: blocked-by ${dangling} names no task`, task.number);
    }
  }
  return { epic: { title: epic.title, body: withMarker(epic.body, SETUP_EPIC_MARKER) }, tasks };
}

async function createIssue(client, issuesPath, fields) {
  const { data } = await client.request('POST', issuesPath, { body: fields });
  return { number: data.number, id: data.id };
}

async function addBlocker(client, blockedByPath, blocker) {
  await client.request('POST', blockedByPath, { body: { issue_id: blocker.id } });
}

/**
 * Opens the "Project setup" epic and one sub-issue per task, each typed and linked.
 * Existing issues are found by marker and left alone; a link is added when either end is new.
 * Only `size:*` labels are applied, and `accepted` never.
 * @param {{ client: GitHubClient, org: string, repo: string, templates: SetupTemplates }} options
 * @returns {Promise<{ epic: number, created: number[] }>} the epic number and the numbers created now
 */
export async function openSetupEpic({ client, org, repo, templates }) {
  const issuesPath = apiPath('/repos/{org}/{repo}/issues', { org, repo });
  const existing = (await client.paginate(issuesPath, { query: { state: 'all' } }))
    .filter((issue) => issue.pull_request === undefined);
  const findByMarker = (marker) => existing.find((issue) => typeof issue.body === 'string' && issue.body.includes(marker));
  const created = [];

  let epic = findByMarker(SETUP_EPIC_MARKER);
  if (epic === undefined) {
    epic = await createIssue(client, issuesPath, { ...templates.epic, type: 'Epic' });
    created.push(epic.number);
  }

  const issues = new Map();
  const isNew = new Set();
  for (const task of templates.tasks) {
    const found = findByMarker(taskMarker(task.number));
    if (found !== undefined) {
      issues.set(task.number, found);
      continue;
    }
    const { title, body, type, size } = task;
    const issue = await createIssue(client, issuesPath, { title, body, type, labels: [`size:${size}`] });
    issues.set(task.number, issue);
    isNew.add(task.number);
    created.push(issue.number);
  }

  const subIssuesPath = apiPath('/repos/{org}/{repo}/issues/{number}/sub_issues', { org, repo, number: epic.number });
  for (const task of templates.tasks.filter(({ number }) => isNew.has(number))) {
    await client.request('POST', subIssuesPath, { body: { sub_issue_id: issues.get(task.number).id } });
  }
  for (const task of templates.tasks) {
    const newBlockers = task.blockedBy.filter((blocker) => isNew.has(task.number) || isNew.has(blocker));
    const blockedByPath = apiPath('/repos/{org}/{repo}/issues/{number}/dependencies/blocked_by', {
      org,
      repo,
      number: issues.get(task.number).number,
    });
    for (const blocker of newBlockers) await addBlocker(client, blockedByPath, issues.get(blocker));
  }
  return { epic: epic.number, created };
}

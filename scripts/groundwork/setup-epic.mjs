import { apiPath } from '../lib/github.mjs';
import { ISSUE_TYPES } from '../lib/issue-model.mjs';
import { SettingsError } from '../lib/settings.mjs';
import { sameLogin } from '../lib/trust.mjs';

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

// AGENTS.md caps issue creation at 5 per minute.
const CREATION_SPACING_MS = 12_000;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const taskMarker =(number) => `<!-- groundwork:setup-task ${number} -->`;

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

function checkTaskNumbers(tasks) {
  const numbers = new Set();
  for (const { number } of tasks) {
    if (numbers.has(number)) throw new SettingsError(`task ${number}: number used by more than one file`, number);
    numbers.add(number);
  }
  for (const task of tasks) {
    const dangling = task.blockedBy.find((blocker) => !numbers.has(blocker));
    if (dangling !== undefined) {
      throw new SettingsError(`task ${task.number}: blocked-by ${dangling} names no task`, task.number);
    }
    if (task.blockedBy.includes(task.number)) {
      throw new SettingsError(`task ${task.number}: blocked-by names the task itself`, task.number);
    }
  }
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
  checkTaskNumbers(tasks);
  return { epic: { title: epic.title, body: withMarker(epic.body, SETUP_EPIC_MARKER) }, tasks };
}

/**
 * Marker match by the admin bot only: the repository is public, so any account can plant a marker.
 * @throws {SettingsError} a marked issue written by someone else
 */
function findMarkedIssue(existing, marker, adminBot) {
  const marked = existing.filter((issue) => typeof issue.body === 'string' && issue.body.includes(marker));
  const stranger = marked.find((issue) => !sameLogin(issue.user?.login, adminBot));
  if (stranger !== undefined) {
    throw new SettingsError(`issue #${stranger.number} carries ${marker} but was not written by ${adminBot}`);
  }
  return marked[0];
}

/** Creates issues one at a time, `sleep`ing between them to stay under the creation rate cap. */
function pacedIssueCreator({ client, issuesPath, sleep }) {
  let creations = 0;
  return async (fields) => {
    if (creations > 0) await sleep(CREATION_SPACING_MS);
    creations += 1;
    const { data } = await client.request('POST', issuesPath, { body: fields });
    return { number: data.number, id: data.id };
  };
}

/** POSTs a link for each id the live list lacks; `listExists` is false for an issue made in this run. */
async function addMissingLinks(client, { path, field, ids, listExists }) {
  const live = listExists ? new Set((await client.paginate(path)).map((item) => item.id)) : new Set();
  for (const id of ids.filter((candidate) => !live.has(candidate))) {
    await client.request('POST', path, { body: { [field]: id } });
  }
}

/**
 * Opens the "Project setup" epic and one sub-issue per task, each typed and linked.
 * Issues are found by marker (admin bot only) and left alone; links are read live and only
 * the missing ones are posted, so a run that died mid-way resumes. Only `size:*` labels are
 * applied, and `accepted` never.
 * @param {{ client: GitHubClient, org: string, repo: string, templates: SetupTemplates, adminBot: string, sleep?: (ms: number) => Promise<void> }} options
 * @returns {Promise<{ epic: number, created: number[] }>} the epic number and the numbers created now
 * @throws {SettingsError} a marker on an issue the admin bot did not write
 */
export async function openSetupEpic({ client, org, repo, templates, adminBot, sleep = defaultSleep }) {
  const issuesPath = apiPath('/repos/{org}/{repo}/issues', { org, repo });
  const existing = (await client.paginate(issuesPath, { query: { state: 'all' } }))
    .filter((issue) => issue.pull_request === undefined);
  const createIssue = pacedIssueCreator({ client, issuesPath, sleep });
  const created = [];

  let epic = findMarkedIssue(existing, SETUP_EPIC_MARKER, adminBot);
  const epicExisted = epic !== undefined;
  if (!epicExisted) {
    epic = await createIssue({ ...templates.epic, type: 'Epic' });
    created.push(epic.number);
  }

  const issues = new Map();
  const createdNow = new Set();
  for (const task of templates.tasks) {
    const found = findMarkedIssue(existing, taskMarker(task.number), adminBot);
    if (found !== undefined) {
      issues.set(task.number, found);
      continue;
    }
    const { title, body, type, size } = task;
    const issue = await createIssue({ title, body, type, labels: [`size:${size}`] });
    issues.set(task.number, issue);
    createdNow.add(task.number);
    created.push(issue.number);
  }

  await addMissingLinks(client, {
    path: apiPath('/repos/{org}/{repo}/issues/{number}/sub_issues', { org, repo, number: epic.number }),
    field: 'sub_issue_id',
    ids: templates.tasks.map((task) => issues.get(task.number).id),
    listExists: epicExisted,
  });
  for (const task of templates.tasks.filter(({ blockedBy }) => blockedBy.length > 0)) {
    await addMissingLinks(client, {
      path: apiPath('/repos/{org}/{repo}/issues/{number}/dependencies/blocked_by', {
        org,
        repo,
        number: issues.get(task.number).number,
      }),
      field: 'issue_id',
      ids: task.blockedBy.map((blocker) => issues.get(blocker).id),
      listExists: !createdNow.has(task.number),
    });
  }
  return { epic: epic.number, created };
}

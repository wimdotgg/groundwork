import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubError, createFixtureClient } from '../lib/github.mjs';
import { SettingsError } from '../lib/settings.mjs';
import { SETUP_EPIC_MARKER, openSetupEpic, parseSetupTemplates } from './setup-epic.mjs';

const VALUES = { org: 'acme', repo: 'widgets', description: 'Widgets: for __ORG__ # fun' };
const ISSUES_KEY = 'GET /repos/acme/widgets/issues?per_page=100&state=all';

const EPIC_FILE = '# Set up __REPO__\n\n## Goal\n\nBuild __DESCRIPTION__ at __ORG__.\n';
const TASK_ONE = '# Pick the stack\n<!-- size: M -->\n\n## Outcome\n\nStack for __ORG__/__REPO__.\n';
const TASK_TWO = '# Declare ecosystems\n<!-- type: Chore -->\n<!-- size: S -->\n<!-- blocked-by: 01 -->\n\n## Outcome\n\nDone.\n';
const TASK_THREE = '# Request pass 2\n<!-- size: S -->\n<!-- blocked-by: 01, 02 -->\n\n## Outcome\n\nDone.\n';

function fixtureFiles(overrides = {}) {
  return {
    'epic.md': EPIC_FILE,
    '01-stack.md': TASK_ONE,
    '02-ecosystems.md': TASK_TWO,
    '03-pass2.md': TASK_THREE,
    ...overrides,
  };
}

function parse(overrides) {
  return parseSetupTemplates(fixtureFiles(overrides), VALUES);
}

function assertSettingsError(overrides, pattern) {
  assert.throws(() => parse(overrides), (error) => error instanceof SettingsError && pattern.test(error.message));
}

// The fixture transport's onCall never sees a body, so record request bodies here.
function recordingClient(routes) {
  const inner = createFixtureClient(routes);
  const calls = [];
  const request = async (method, path, options = {}) => {
    calls.push({ method, path, body: options.body });
    return inner.request(method, path, options);
  };
  return { client: { ...inner, request }, calls };
}

const writes = (calls) => calls.filter((call) => call.method === 'POST');

test('parseSetupTemplates fills placeholders and returns epic and tasks (AC1)', () => {
  const { epic, tasks } = parse();
  assert.equal(epic.title, 'Set up widgets');
  assert.match(epic.body, /Build Widgets: for __ORG__ # fun at acme\./);
  assert.ok(epic.body.includes(SETUP_EPIC_MARKER));
  assert.deepEqual(
    tasks.map(({ number, title, type, size, blockedBy }) => ({ number, title, type, size, blockedBy })),
    [
      { number: '01', title: 'Pick the stack', type: 'Feature', size: 'M', blockedBy: [] },
      { number: '02', title: 'Declare ecosystems', type: 'Chore', size: 'S', blockedBy: ['01'] },
      { number: '03', title: 'Request pass 2', type: 'Feature', size: 'S', blockedBy: ['01', '02'] },
    ],
  );
  assert.ok(tasks[0].body.includes('Stack for acme/widgets.'));
  assert.ok(tasks[1].body.includes('<!-- groundwork:setup-task 02 -->'));
  assert.ok(tasks[1].body.includes('<!-- type: Chore -->'));
  assert.equal(tasks[0].body.startsWith('<!-- size: M -->'), true);
});

test('parseSetupTemplates leaves no placeholder from the templates behind (AC1)', () => {
  const { epic, tasks } = parseSetupTemplates(fixtureFiles(), { ...VALUES, description: 'Plain text' });
  const everything = [epic.title, epic.body, ...tasks.flatMap((task) => [task.title, task.body])].join('\n');
  assert.doesNotMatch(everything, /__(ORG|REPO|DESCRIPTION)__/);
});

test('parseSetupTemplates rejects a missing epic title (AC1)', () => {
  assertSettingsError({ 'epic.md': 'no heading here\n' }, /epic\.md.*# <title>/);
});

test('parseSetupTemplates rejects a missing title on a task (AC1)', () => {
  assertSettingsError({ '01-stack.md': '<!-- size: M -->\n' }, /01-stack\.md.*# <title>/);
});

test('parseSetupTemplates rejects an unknown type (AC1)', () => {
  assertSettingsError({ '01-stack.md': '# T\n<!-- type: Story -->\n<!-- size: S -->\n' }, /unknown type "Story"/);
});

test('parseSetupTemplates rejects a missing size (AC1)', () => {
  assertSettingsError({ '01-stack.md': '# T\n\n## Outcome\n' }, /size must be one of S, M/);
});

test('parseSetupTemplates rejects an invalid size (AC1)', () => {
  assertSettingsError({ '01-stack.md': '# T\n<!-- size: L -->\n' }, /size must be one of S, M/);
});

test('parseSetupTemplates rejects a blocker that names no task (AC1)', () => {
  assertSettingsError({ '02-ecosystems.md': '# T\n<!-- size: S -->\n<!-- blocked-by: 09 -->\n' }, /blocked-by 09 names no task/);
});

test('parseSetupTemplates rejects a missing epic file', () => {
  const files = fixtureFiles();
  delete files['epic.md'];
  assert.throws(() => parseSetupTemplates(files, VALUES), SettingsError);
});

test('parseSetupTemplates accepts CRLF text', () => {
  const { tasks } = parse({ '01-stack.md': TASK_ONE.replace(/\n/g, '\r\n') });
  assert.equal(tasks[0].size, 'M');
});


test('parseSetupTemplates rejects two files with the same task number', () => {
  assertSettingsError({ '01-other.md': TASK_ONE }, /task 01.*more than one file/);
});

test('parseSetupTemplates rejects a task that blocks itself', () => {
  assertSettingsError({ '02-ecosystems.md': '# T\n<!-- size: S -->\n<!-- blocked-by: 02 -->\n' }, /task 02.*the task itself/);
});

const ADMIN_BOT = 'acme-admin[bot]';
const CREATED = { status: 201, data: {} };
const ISSUES_POST = 'POST /repos/acme/widgets/issues';
const SUB_ISSUES = (epic) => `/repos/acme/widgets/issues/${epic}/sub_issues`;
const BLOCKED_BY = (task) => `/repos/acme/widgets/issues/${task}/dependencies/blocked_by`;
const issue = (number, id, body, login = ADMIN_BOT) => ({ number, id, body, user: { login } });
const listing = (...items) => ({ status: 200, data: items });
const creation = (number, id) => ({ status: 201, data: { number, id } });

async function open(client, templates, sleeps = []) {
  const sleep = async (ms) => { sleeps.push(ms); };
  return openSetupEpic({ client, org: 'acme', repo: 'widgets', templates, adminBot: ADMIN_BOT, sleep });
}

// Epic 10 (id 100) and tasks 01 to 03 at numbers 11 to 13 (ids 101 to 103).
function existingIssues(templates, { without = [] } = {}) {
  const all = [
    issue(10, 100, templates.epic.body),
    ...templates.tasks.map((task, index) => issue(11 + index, 101 + index, task.body)),
  ];
  return all.filter((item) => !without.includes(item.number));
}

const postPaths = (calls) => writes(calls).map((call) => call.path);

const FRESH_ROUTES = {
  [ISSUES_KEY]: listing(),
  [ISSUES_POST]: [creation(10, 100), creation(11, 101), creation(12, 102), creation(13, 103)],
  [`POST ${SUB_ISSUES(10)}`]: [CREATED, CREATED, CREATED],
  [`POST ${BLOCKED_BY(12)}`]: CREATED,
  [`POST ${BLOCKED_BY(13)}`]: [CREATED, CREATED],
};

const ALL_LINKS_LIVE = {
  [`GET ${SUB_ISSUES(10)}?per_page=100`]: listing({ id: 101 }, { id: 102 }, { id: 103 }),
  [`GET ${BLOCKED_BY(12)}?per_page=100`]: listing({ id: 101 }),
  [`GET ${BLOCKED_BY(13)}?per_page=100`]: listing({ id: 101 }, { id: 102 }),
};

const NO_LINKS_LIVE = {
  [`GET ${SUB_ISSUES(10)}?per_page=100`]: listing(),
  [`GET ${BLOCKED_BY(12)}?per_page=100`]: listing(),
  [`GET ${BLOCKED_BY(13)}?per_page=100`]: listing(),
  [`POST ${SUB_ISSUES(10)}`]: [CREATED, CREATED, CREATED],
  [`POST ${BLOCKED_BY(12)}`]: CREATED,
  [`POST ${BLOCKED_BY(13)}`]: [CREATED, CREATED],
};

test('openSetupEpic creates the epic, typed tasks, links and blockers on a fresh repo (AC2, AC4)', async () => {
  const { client, calls } = recordingClient({
    ...FRESH_ROUTES,
    [ISSUES_KEY]: listing(issue(1, 11, 'unrelated', 'someone'), { ...issue(2, 12, SETUP_EPIC_MARKER, 'someone'), pull_request: {} }),
  });
  const result = await open(client, parse());
  assert.deepEqual(result, { epic: 10, created: [10, 11, 12, 13] });

  const created = writes(calls).filter((call) => call.path === '/repos/acme/widgets/issues');
  assert.equal(created[0].body.type, 'Epic');
  assert.equal(created[0].body.labels, undefined);
  assert.deepEqual(created.slice(1).map(({ body }) => [body.type, body.labels]), [
    ['Feature', ['size:M']],
    ['Chore', ['size:S']],
    ['Feature', ['size:S']],
  ]);
  assert.deepEqual(
    writes(calls).filter((call) => call.path === SUB_ISSUES(10)).map((call) => call.body),
    [{ sub_issue_id: 101 }, { sub_issue_id: 102 }, { sub_issue_id: 103 }],
  );
  const blockers = writes(calls).filter((call) => call.path.endsWith('/blocked_by')).map((call) => [call.path, call.body]);
  assert.deepEqual(blockers, [
    [BLOCKED_BY(12), { issue_id: 101 }],
    [BLOCKED_BY(13), { issue_id: 101 }],
    [BLOCKED_BY(13), { issue_id: 102 }],
  ]);
  assert.equal(calls.some((call) => call.method === 'GET' && call.path.includes('/sub_issues')), false);
});

test('openSetupEpic pauses 12 seconds between creations (R3)', async () => {
  const sleeps = [];
  const { client } = recordingClient(FRESH_ROUTES);
  await open(client, parse(), sleeps);
  assert.deepEqual(sleeps, [12_000, 12_000, 12_000]);
});

test('openSetupEpic on a rerun creates only the missing task and the links it lacks (AC3)', async () => {
  const templates = parse();
  const sleeps = [];
  const { client, calls } = recordingClient({
    [ISSUES_KEY]: listing(...existingIssues(templates, { without: [13] })),
    [ISSUES_POST]: creation(13, 103),
    [`GET ${SUB_ISSUES(10)}?per_page=100`]: listing({ id: 101 }, { id: 102 }),
    [`POST ${SUB_ISSUES(10)}`]: CREATED,
    [`GET ${BLOCKED_BY(12)}?per_page=100`]: listing({ id: 101 }),
    [`POST ${BLOCKED_BY(13)}`]: [CREATED, CREATED],
  });
  const result = await open(client, templates, sleeps);
  assert.deepEqual(result, { epic: 10, created: [13] });
  assert.deepEqual(postPaths(calls), ['/repos/acme/widgets/issues', SUB_ISSUES(10), BLOCKED_BY(13), BLOCKED_BY(13)]);
  assert.deepEqual(writes(calls)[1].body, { sub_issue_id: 103 });
  assert.deepEqual(sleeps, []);
});

test('openSetupEpic links issues that exist without links, as after a failed first link (R1)', async () => {
  const templates = parse();
  const { client, calls } = recordingClient({ [ISSUES_KEY]: listing(...existingIssues(templates)), ...NO_LINKS_LIVE });
  const result = await open(client, templates);
  assert.deepEqual(result, { epic: 10, created: [] });
  assert.deepEqual(postPaths(calls), [
    SUB_ISSUES(10), SUB_ISSUES(10), SUB_ISSUES(10), BLOCKED_BY(12), BLOCKED_BY(13), BLOCKED_BY(13),
  ]);
});

test('openSetupEpic resumes after the first link request failed (R1)', async () => {
  const templates = parse();
  const { client: failing } = recordingClient({
    ...FRESH_ROUTES,
    [`POST ${SUB_ISSUES(10)}`]: { status: 502, data: { message: 'bad gateway' } },
  });
  await assert.rejects(open(failing, templates), GitHubError);

  const { client, calls } = recordingClient({ [ISSUES_KEY]: listing(...existingIssues(templates)), ...NO_LINKS_LIVE });
  await open(client, templates);
  assert.equal(writes(calls).filter((call) => call.path === SUB_ISSUES(10)).length, 3);
});

test('openSetupEpic adds a blocker link to an existing task when the blocker is new (R1)', async () => {
  const templates = parse();
  const { client, calls } = recordingClient({
    [ISSUES_KEY]: listing(...existingIssues(templates, { without: [11] })),
    [ISSUES_POST]: creation(14, 104),
    [`GET ${SUB_ISSUES(10)}?per_page=100`]: listing({ id: 102 }, { id: 103 }),
    [`POST ${SUB_ISSUES(10)}`]: CREATED,
    [`GET ${BLOCKED_BY(12)}?per_page=100`]: listing(),
    [`GET ${BLOCKED_BY(13)}?per_page=100`]: listing({ id: 102 }),
    [`POST ${BLOCKED_BY(12)}`]: CREATED,
    [`POST ${BLOCKED_BY(13)}`]: CREATED,
  });
  await open(client, templates);
  const blockers = writes(calls).filter((call) => call.path.endsWith('/blocked_by')).map((call) => call.body);
  assert.deepEqual(blockers, [{ issue_id: 104 }, { issue_id: 104 }]);
});

test('openSetupEpic writes nothing when every issue and link exists (AC3)', async () => {
  const templates = parse();
  const { client, calls } = recordingClient({ [ISSUES_KEY]: listing(...existingIssues(templates)), ...ALL_LINKS_LIVE });
  const result = await open(client, templates);
  assert.deepEqual(result, { epic: 10, created: [] });
  assert.equal(writes(calls).length, 0);
});

test('openSetupEpic refuses an epic marker written by another author (R2)', async () => {
  const { client, calls } = recordingClient({
    [ISSUES_KEY]: listing(issue(5, 50, SETUP_EPIC_MARKER, 'stranger')),
  });
  await assert.rejects(
    open(client, parse()),
    (error) => error instanceof SettingsError && /#5 .*not written by acme-admin\[bot\]/.test(error.message),
  );
  assert.equal(writes(calls).length, 0);
});

test('openSetupEpic refuses a task marker written by another author (R2)', async () => {
  const templates = parse();
  const { client, calls } = recordingClient({
    [ISSUES_KEY]: listing(issue(10, 100, templates.epic.body), issue(6, 60, templates.tasks[0].body, 'stranger')),
  });
  await assert.rejects(open(client, templates), SettingsError);
  assert.equal(writes(calls).length, 0);
});

test('openSetupEpic compares the admin bot login case-insensitively (R2)', async () => {
  const templates = parse();
  const mixedCase = existingIssues(templates).map((item) => ({ ...item, user: { login: 'ACME-Admin[bot]' } }));
  const { client } = recordingClient({ [ISSUES_KEY]: listing(...mixedCase), ...ALL_LINKS_LIVE });
  assert.deepEqual(await open(client, templates), { epic: 10, created: [] });
});

test('openSetupEpic applies no label other than size:S or size:M (AC4)', async () => {
  const { client, calls } = recordingClient(FRESH_ROUTES);
  await open(client, parse());
  const labels = calls.flatMap((call) => call.body?.labels ?? []);
  assert.deepEqual([...new Set(labels)].sort(), ['size:M', 'size:S']);
  assert.equal(calls.some((call) => call.path.includes('/labels')), false);
});

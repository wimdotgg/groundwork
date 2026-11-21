import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureClient } from '../lib/github.mjs';
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

test('openSetupEpic creates the epic, typed tasks, links and blockers on a fresh repo (AC2, AC4)', async () => {
  const templates = parse();
  const { client, calls } = recordingClient({
    [ISSUES_KEY]: { status: 200, data: [{ number: 1, id: 11, body: 'unrelated' }, { number: 2, id: 12, pull_request: {}, body: SETUP_EPIC_MARKER }] },
    'POST /repos/acme/widgets/issues': [
      { status: 201, data: { number: 10, id: 100 } },
      { status: 201, data: { number: 11, id: 101 } },
      { status: 201, data: { number: 12, id: 102 } },
      { status: 201, data: { number: 13, id: 103 } },
    ],
    'POST /repos/acme/widgets/issues/10/sub_issues': [{ status: 201, data: {} }, { status: 201, data: {} }, { status: 201, data: {} }],
    'POST /repos/acme/widgets/issues/12/dependencies/blocked_by': { status: 201, data: {} },
    'POST /repos/acme/widgets/issues/13/dependencies/blocked_by': [{ status: 201, data: {} }, { status: 201, data: {} }],
  });
  const result = await openSetupEpic({ client, org: 'acme', repo: 'widgets', templates });
  assert.deepEqual(result, { epic: 10, created: [10, 11, 12, 13] });

  const created = writes(calls).filter((call) => call.path === '/repos/acme/widgets/issues');
  assert.equal(created[0].body.type, 'Epic');
  assert.equal(created[0].body.labels, undefined);
  assert.deepEqual(created.slice(1).map(({ body }) => [body.type, body.labels]), [
    ['Feature', ['size:M']],
    ['Chore', ['size:S']],
    ['Feature', ['size:S']],
  ]);
  const links = writes(calls).filter((call) => call.path.endsWith('/sub_issues')).map((call) => call.body);
  assert.deepEqual(links, [{ sub_issue_id: 101 }, { sub_issue_id: 102 }, { sub_issue_id: 103 }]);
  const blockers = writes(calls).filter((call) => call.path.endsWith('/blocked_by')).map((call) => [call.path, call.body]);
  assert.deepEqual(blockers, [
    ['/repos/acme/widgets/issues/12/dependencies/blocked_by', { issue_id: 101 }],
    ['/repos/acme/widgets/issues/13/dependencies/blocked_by', { issue_id: 101 }],
    ['/repos/acme/widgets/issues/13/dependencies/blocked_by', { issue_id: 102 }],
  ]);
});

test('openSetupEpic on a rerun creates only the missing tasks and their links (AC3)', async () => {
  const templates = parse();
  const { client, calls } = recordingClient({
    [ISSUES_KEY]: {
      status: 200,
      data: [
        { number: 10, id: 100, body: templates.epic.body },
        { number: 11, id: 101, body: templates.tasks[0].body },
        { number: 12, id: 102, body: templates.tasks[1].body },
      ],
    },
    'POST /repos/acme/widgets/issues': { status: 201, data: { number: 13, id: 103 } },
    'POST /repos/acme/widgets/issues/10/sub_issues': { status: 201, data: {} },
    'POST /repos/acme/widgets/issues/13/dependencies/blocked_by': [{ status: 201, data: {} }, { status: 201, data: {} }],
  });
  const result = await openSetupEpic({ client, org: 'acme', repo: 'widgets', templates });
  assert.deepEqual(result, { epic: 10, created: [13] });
  assert.deepEqual(writes(calls).map((call) => call.path), [
    '/repos/acme/widgets/issues',
    '/repos/acme/widgets/issues/10/sub_issues',
    '/repos/acme/widgets/issues/13/dependencies/blocked_by',
    '/repos/acme/widgets/issues/13/dependencies/blocked_by',
  ]);
  assert.deepEqual(writes(calls)[1].body, { sub_issue_id: 103 });
});

test('openSetupEpic links an existing task to a new blocker (AC3)', async () => {
  const templates = parse();
  const { client, calls } = recordingClient({
    [ISSUES_KEY]: {
      status: 200,
      data: [
        { number: 10, id: 100, body: templates.epic.body },
        { number: 12, id: 102, body: templates.tasks[1].body },
        { number: 13, id: 103, body: templates.tasks[2].body },
      ],
    },
    'POST /repos/acme/widgets/issues': { status: 201, data: { number: 14, id: 104 } },
    'POST /repos/acme/widgets/issues/10/sub_issues': { status: 201, data: {} },
    'POST /repos/acme/widgets/issues/12/dependencies/blocked_by': { status: 201, data: {} },
    'POST /repos/acme/widgets/issues/13/dependencies/blocked_by': { status: 201, data: {} },
  });
  await openSetupEpic({ client, org: 'acme', repo: 'widgets', templates });
  const blockers = writes(calls).filter((call) => call.path.endsWith('/blocked_by')).map((call) => call.body);
  assert.deepEqual(blockers, [{ issue_id: 104 }, { issue_id: 104 }]);
});

test('openSetupEpic creates nothing when everything exists (AC3)', async () => {
  const templates = parse();
  const { client, calls } = recordingClient({
    [ISSUES_KEY]: {
      status: 200,
      data: [
        { number: 10, id: 100, body: templates.epic.body },
        ...templates.tasks.map((task, index) => ({ number: 11 + index, id: 101 + index, body: task.body })),
      ],
    },
  });
  const result = await openSetupEpic({ client, org: 'acme', repo: 'widgets', templates });
  assert.deepEqual(result, { epic: 10, created: [] });
  assert.equal(writes(calls).length, 0);
});

test('openSetupEpic applies no label other than size:S or size:M (AC4)', async () => {
  const templates = parse();
  const { client, calls } = recordingClient({
    [ISSUES_KEY]: { status: 200, data: [] },
    'POST /repos/acme/widgets/issues': [
      { status: 201, data: { number: 10, id: 100 } },
      { status: 201, data: { number: 11, id: 101 } },
      { status: 201, data: { number: 12, id: 102 } },
      { status: 201, data: { number: 13, id: 103 } },
    ],
    'POST /repos/acme/widgets/issues/10/sub_issues': [{ status: 201, data: {} }, { status: 201, data: {} }, { status: 201, data: {} }],
    'POST /repos/acme/widgets/issues/12/dependencies/blocked_by': { status: 201, data: {} },
    'POST /repos/acme/widgets/issues/13/dependencies/blocked_by': [{ status: 201, data: {} }, { status: 201, data: {} }],
  });
  await openSetupEpic({ client, org: 'acme', repo: 'widgets', templates });
  const labels = calls.flatMap((call) => call.body?.labels ?? []);
  assert.deepEqual([...new Set(labels)].sort(), ['size:M', 'size:S']);
  assert.equal(calls.some((call) => call.path.includes('/labels')), false);
});

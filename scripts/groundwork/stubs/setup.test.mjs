import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyzePlan, lintPlan } from '../../agent/plan-lint.mjs';
import { REQUIRED_HEADINGS, validateIssueBody } from '../../lib/issue-model.mjs';
import { criterionIds, parseSections } from '../../lib/markdown.mjs';

const STUBS_DIR = fileURLToPath(new URL('./', import.meta.url));
const SETUP_DIR = `${STUBS_DIR}setup/`;
const EPIC_FILE = 'epic.md';
const TASK_FILE_PATTERN = /^(\d+)-[^/]+\.md$/;
const DIRECTIVE_PATTERN = /^<!--\s*(type|size|blocked-by):\s*(.*?)\s*-->$/;
const TASK_TYPES = ['Feature', 'Chore'];
const SIZES = ['S', 'M'];
const ALLOWED_PLACEHOLDERS = ['__ORG__', '__REPO__', '__DESCRIPTION__'];
const LIMITS = { hierarchyDepth: 2, hierarchyDepthWithIntermediate: 3, subIssuesPerParent: 12 };
const EPIC_NUMBER = 100;
const TASK_NUMBER_OFFSET = EPIC_NUMBER;

const readText = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? listFiles(`${directory}${entry.name}/`) : [`${directory}${entry.name}`]
  ));
}

function readDirectives(lines) {
  const directives = {};
  for (const line of lines) {
    const match = DIRECTIVE_PATTERN.exec(line.trim());
    if (!match) {
      if (line.trim() === '') continue;
      break;
    }
    directives[match[1]] = match[2];
  }
  return directives;
}

const templateFiles = readdirSync(SETUP_DIR).sort();
const taskFiles = templateFiles.filter((file) => TASK_FILE_PATTERN.test(file));
const templates = Object.fromEntries(templateFiles.map((file) => {
  const lines = readText(`${SETUP_DIR}${file}`).split('\n');
  return [file, { lines, directives: readDirectives(lines.slice(1)), body: lines.slice(1).join('\n') }];
}));
const typeOf = (file) => templates[file].directives.type ?? 'Feature';

test('setup holds an epic and task files named NN-slug.md only', () => {
  assert.ok(templateFiles.includes(EPIC_FILE));
  assert.deepEqual(templateFiles.filter((file) => file !== EPIC_FILE && !TASK_FILE_PATTERN.test(file)), []);
  assert.ok(taskFiles.length > 0);
});

test('every template starts with a "# title" line (AC1)', () => {
  for (const file of templateFiles) assert.match(templates[file].lines[0], /^#\s+\S/, file);
});

test('every task has a size of S or M and a Feature or Chore type (AC1)', () => {
  for (const file of taskFiles) {
    assert.ok(SIZES.includes(templates[file].directives.size), `${file}: size`);
    assert.ok(TASK_TYPES.includes(typeOf(file)), `${file}: type`);
  }
});

test('every template has its required 4.3 headings and passes validateIssueBody (AC1)', () => {
  for (const file of templateFiles) {
    const type = file === EPIC_FILE ? 'Epic' : typeOf(file);
    const names = parseSections(templates[file].body).sections.map((section) => section.name);
    for (const heading of REQUIRED_HEADINGS[type]) assert.ok(names.includes(heading), `${file}: ## ${heading}`);
    assert.deepEqual(validateIssueBody({ type, body: templates[file].body }), { ok: true, errors: [] }, file);
  }
});

test('lintPlan reports no failure on the templates as a plan (AC2)', () => {
  const epicCriteria = criterionIds(parseSections(templates[EPIC_FILE].body).byName['Success criteria'], 'E');
  const numberOf = (file) => TASK_NUMBER_OFFSET + Number(TASK_FILE_PATTERN.exec(file)[1]);
  const nodes = taskFiles.map((file) => ({
    number: numberOf(file),
    title: templates[file].lines[0],
    type: typeOf(file),
    state: 'open',
    stateReason: null,
    body: templates[file].body,
    parent: EPIC_NUMBER,
    level: 2,
    blockedBy: (templates[file].directives['blocked-by'] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => TASK_NUMBER_OFFSET + Number(entry)),
  }));
  const taskNumbers = nodes.map((node) => node.number);
  for (const node of nodes) assert.ok(node.blockedBy.every((blocker) => taskNumbers.includes(blocker)), `blocker of ${node.number}`);
  const failures = lintPlan(analyzePlan(nodes), { limits: LIMITS, hotspots: [], epicCriteria });
  assert.deepEqual(failures, []);
});

test('stubs and templates carry no org or owner value, only the three placeholders (AC3)', () => {
  for (const path of listFiles(STUBS_DIR).filter((file) => !file.endsWith('.test.mjs'))) {
    const text = readText(path);
    assert.doesNotMatch(text, /wimdotgg|wianvdm/i, path);
    const placeholders = text.match(/__[A-Z]+__/g) ?? [];
    assert.deepEqual(placeholders.filter((token) => !ALLOWED_PLACEHOLDERS.includes(token)), [], path);
  }
});

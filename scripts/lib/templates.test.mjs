import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  fillTemplate, formFieldLabels, hasMarker, parseSections, parseStateSection, templatePlaceholders, templateSection,
} from './markdown.mjs';
import { ISSUE_TYPES, REQUIRED_HEADINGS, validateIssueBody } from './issue-model.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const readRepoFile = (path) => readFileSync(`${repoRoot}${path}`, 'utf8');
const SAMPLE_TEXT = 'E1';
const PLACEHOLDER = /<[^<>\s!/][^<>\n]*>/g;
const STATE_FIELDS = ['Done', 'In progress', 'Next', 'Proven', 'Unproven', 'Rejected', 'Gotchas', 'Open'];

for (const type of ISSUE_TYPES) {
  const file = type.toLowerCase();
  const form = readRepoFile(`.github/ISSUE_TEMPLATE/${file}.yml`);
  const twin = readRepoFile(`.github/groundwork/templates/${file}.md`);

  test(`${type}: form labels, twin headings and REQUIRED_HEADINGS agree`, () => {
    const twinHeadings = parseSections(twin).sections.map((section) => section.name);
    assert.deepEqual(formFieldLabels(form), REQUIRED_HEADINGS[type]);
    assert.deepEqual(twinHeadings, REQUIRED_HEADINGS[type]);
  });

  test(`${type}: twin with placeholders filled passes validateIssueBody`, () => {
    const body = twin.replace(PLACEHOLDER, SAMPLE_TEXT);
    assert.deepEqual(validateIssueBody({ type, body }), { ok: true, errors: [] });
  });
}

test('state-section.md has placeholders and the eight State fields', () => {
  const state = readRepoFile('.github/groundwork/templates/state-section.md');
  assert.ok(templatePlaceholders(state).length > 0);
  assert.deepEqual(Object.keys(parseStateSection(state).fields), STATE_FIELDS);
});

const readTemplate = (name) => readRepoFile(`.github/groundwork/templates/${name}.md`);
const FILL_VALUES = {
  n: 82, 'session id': 'w82-a1', 'previous session id': 'w82-a0', 'date time': '2026-11-20 10:00',
  agent: 'sonnet/claude-code', journal: 'line', 'pr number': 91, 'ACs delivered, with evidence': 'AC1',
  'issues opened, or none': 'none', 'traps for the next worker, or none': 'none',
};

test('claim-comment.md holds the pointer, PR claim and takeover comments with their markers', () => {
  const file = readTemplate('claim-comment');
  const expected = { 'Issue pointer': 'claim', 'PR claim': 'claim', 'PR takeover': 'takeover' };
  for (const [name, marker] of Object.entries(expected)) {
    const section = templateSection(file, name);
    assert.ok(section, name);
    assert.equal(hasMarker(section, marker), true, name);
    assert.deepEqual(fillTemplate(section, FILL_VALUES).unfilled, [], name);
  }
  assert.deepEqual(parseSections(file).sections.map((section) => section.name), Object.keys(expected));
});

test('checkpoint and handover templates fill completely and carry their marker', () => {
  for (const [name, marker] of [['checkpoint-comment', 'checkpoint'], ['handover-comment', 'handover']]) {
    const { text, unfilled } = fillTemplate(readTemplate(name), FILL_VALUES);
    assert.deepEqual(unfilled, [], name);
    assert.deepEqual(templatePlaceholders(text), [], name);
    assert.equal(hasMarker(text, marker), true, name);
  }
});

test('the checkpoint comment header reads like the State header', () => {
  const { text } = fillTemplate(readTemplate('checkpoint-comment'), FILL_VALUES);
  assert.equal(text.split('\n')[0], 'Checkpoint 82 · 2026-11-20 10:00 · sonnet/claude-code · session w82-a1');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formFieldLabels, parseSections, parseStateSection, templatePlaceholders } from './markdown.mjs';
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

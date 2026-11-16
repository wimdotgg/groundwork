import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripCommentsAndFences, parseSections, findClosingRefs, criterionIds, parseTable,
  parseStateSection, templatePlaceholders, replaceSection, hasMarker, addMarker,
  removeMarker, formFieldLabels,
} from './markdown.mjs';

test('stripCommentsAndFences removes backtick and tilde fences and multi-line comments', () => {
  const text = ['a', '```js', 'x', '```', 'b', '~~~~', 'y', '~~~~', 'c <!-- one', 'two --> d'].join('\n');
  assert.equal(stripCommentsAndFences(text), ['a', 'b', 'c  d'].join('\n'));
});

test('stripCommentsAndFences: a shorter or different fence does not close', () => {
  const text = ['```', '~~~', '``', 'inside', '```', 'out'].join('\n');
  assert.equal(stripCommentsAndFences(text), 'out');
});

test('stripCommentsAndFences: unclosed fence runs to the end', () => {
  assert.equal(stripCommentsAndFences('a\n```\nb\nc'), 'a');
});

test('parseSections strips the trailing group, reports duplicates, ignores fenced headings', () => {
  const body = [
    '## Goal', 'one', '',
    '## State  (checkpoint 3 · 2026-11-16 14:20 · m/h · session a1b2)', 'Done: AC1', '',
    '```', '## Hidden', '```',
    '<!--', '## Commented', '-->',
    '### Sub', 'stays in State',
    '## Goal', 'again',
  ].join('\n');
  const result = parseSections(body);
  assert.deepEqual(result.sections.map((s) => s.name), ['Goal', 'State', 'Goal']);
  assert.equal(result.sections[1].line, '## State  (checkpoint 3 · 2026-11-16 14:20 · m/h · session a1b2)');
  assert.deepEqual(result.duplicates, ['Goal']);
  assert.equal(result.byName.Goal, 'one');
  assert.match(result.byName.State, /^Done: AC1/);
  assert.match(result.byName.State, /### Sub/);
  assert.equal('Hidden' in result.byName, false);
  assert.equal('Commented' in result.byName, false);
});

test('findClosingRefs handles all nine keywords in mixed case', () => {
  const words = ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved'];
  const body = words.map((w, i) => `${i % 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)} #${i + 1}`).join('\n');
  const refs = findClosingRefs(body);
  assert.deepEqual(refs.map((r) => r.keyword), words);
  assert.deepEqual(refs.map((r) => r.number), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(refs.every((r) => r.owner === null && r.repo === null));
});

test('findClosingRefs reads cross-repo refs and skips comments, fences and non-keywords', () => {
  const body = [
    'Fixes wimdotgg/groundwork#12',
    '<!-- Closes #5 -->',
    '```', 'Resolves #6', '```',
    'prefixes #7 and unfixed #8 and see #9',
    'Closes: #10',
  ].join('\n');
  assert.deepEqual(findClosingRefs(body), [
    { keyword: 'fixes', owner: 'wimdotgg', repo: 'groundwork', number: 12 },
    { keyword: 'closes', owner: null, repo: null, number: 10 },
  ]);
});

test('criterionIds keeps order and duplicates for [ ] and [x]', () => {
  const content = ['- [ ] E1 first', '- [x] E2 second', '- [ ] E1 again', '- [ ] AC3 other prefix', 'E4 not a checklist', '- [ ] E10 ten'].join('\n');
  assert.deepEqual(criterionIds(content, 'E'), ['E1', 'E2', 'E1', 'E10']);
  assert.deepEqual(criterionIds(content, 'AC'), ['AC3']);
});

test('parseTable returns the first table with trimmed cells', () => {
  const content = ['intro', '| Name | Value |', '|:--|--:|', '|  a  |  1 |', '| b | 2 |', '', '| X |', '|---|', '| z |'].join('\n');
  assert.deepEqual(parseTable(content), [{ Name: 'a', Value: '1' }, { Name: 'b', Value: '2' }]);
  assert.deepEqual(parseTable('no table'), []);
});

const STATE = [
  '## State  (checkpoint 3 · 2026-11-16 14:20 · <model>/<harness> · session a1b2)',
  'Done:        AC1, AC2 (tests: handler.test.ts › rejects empty input)',
  'In progress: AC3, validation error mapping in src/api/errors.ts',
  'Next:        wire error codes into the form; then AC4',
  'Proven:      AC1, AC2 (CI run #482)',
  'Unproven:    AC3, AC4',
  'Rejected:    zod .refine for cross-field check, error path lost in nested arrays',
  'Gotchas:     test DB needs `npm run db:reset` after pulling main',
  'Open:        none',
].join('\n');

test('parseStateSection parses the 6.5 example', () => {
  const { header, fields } = parseStateSection(STATE);
  assert.deepEqual(header, { checkpoint: '3', at: '2026-11-16 14:20', agent: '<model>/<harness>', session: 'a1b2' });
  assert.equal(fields.Done, 'AC1, AC2 (tests: handler.test.ts › rejects empty input)');
  assert.equal(fields['In progress'], 'AC3, validation error mapping in src/api/errors.ts');
  assert.equal(fields.Open, 'none');
  assert.equal(Object.keys(fields).length, 8);
});

test('parseStateSection gives null for missing header parts', () => {
  const partial = parseStateSection('## State  (checkpoint 2 · 2026-11-16 09:00)\nOpen: none');
  assert.deepEqual(partial.header, { checkpoint: '2', at: '2026-11-16 09:00', agent: null, session: null });
  const bare = parseStateSection('## State\nOpen: none');
  assert.deepEqual(bare.header, { checkpoint: null, at: null, agent: null, session: null });
  assert.equal(bare.fields.Open, 'none');
});

test('templatePlaceholders lists unique tokens and ignores comments and fences', () => {
  const template = ['## State  (checkpoint <n> · <date> · <model>/<harness> · session <id>)', '<!-- <hidden> -->', '```', '<fenced>', '```', 'Done: <ids>', 'Next: <model>'].join('\n');
  assert.deepEqual(templatePlaceholders(template), ['<n>', '<date>', '<model>', '<harness>', '<id>', '<ids>']);
  assert.deepEqual(templatePlaceholders('all filled'), []);
});

test('replaceSection replaces content and keeps the heading and neighbours', () => {
  const body = '## A\nold\n\n## B  (x)\nkeep\n';
  assert.equal(replaceSection(body, 'A', 'new'), '## A\nnew\n\n## B  (x)\nkeep\n');
  assert.equal(replaceSection(body, 'B', 'fresh\n'), '## A\nold\n\n## B  (x)\nfresh\n');
});

test('replaceSection appends a missing section and replaces the heading when content has one', () => {
  assert.equal(replaceSection('## A\nx\n', 'State', 'Open: none'), '## A\nx\n\n## State\nOpen: none\n');
  assert.equal(replaceSection('', 'State', 'Open: none'), '## State\nOpen: none\n');
  assert.equal(replaceSection('## State  (checkpoint 1)\nold\n\n## Z\nz', 'State', '## State  (checkpoint 2)\nnew'), '## State  (checkpoint 2)\nnew\n\n## Z\nz');
});

test('replaceSection ignores headings in fences and comments', () => {
  const body = '```\n## A\n```\n<!--\n## A\n-->\n## A\nreal\n';
  assert.equal(replaceSection(body, 'A', 'x'), '```\n## A\n```\n<!--\n## A\n-->\n## A\nx\n');
});

test('markers: has, add (idempotent), remove', () => {
  assert.equal(hasMarker('x', 'claim'), false);
  const added = addMarker('body text\n', 'claim');
  assert.equal(added, 'body text\n\n<!-- groundwork:claim -->\n');
  assert.equal(hasMarker(added, 'claim'), true);
  assert.equal(addMarker(added, 'claim'), added);
  assert.equal(removeMarker(added, 'claim'), 'body text\n');
  assert.equal(removeMarker('a\n<!-- groundwork:x -->\nb\n', 'x'), 'a\nb\n');
  assert.equal(removeMarker('a', 'x'), 'a');
  assert.equal(hasMarker('<!-- groundwork:alert:.github/workflows/ci.yml -->', 'alert:.github/workflows/ci.yml'), true);
  assert.equal(hasMarker('<!-- groundwork:released -->', 'claim'), false);
});

test('formFieldLabels reads label values by regex', () => {
  const yaml = [
    'name: Feature', 'body:', '  - type: textarea', '    attributes:', '      label: Outcome',
    '      description: "label: not this"', '  - type: textarea', '    attributes:',
    '      label: "Acceptance criteria"', '  - type: dropdown', '    attributes:', "      label: 'Risk'",
  ].join('\n');
  assert.deepEqual(formFieldLabels(yaml), ['Outcome', 'Acceptance criteria', 'Risk']);
});

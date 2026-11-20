import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripCommentsAndFences, parseSections, findClosingRefs, criterionIds, parseTable,
  parseStateSection, templatePlaceholders, replaceSection, hasMarker, addMarker,
  removeMarker, formFieldLabels, fillTemplate, templateSection,
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
  assert.equal(stripCommentsAndFences('a\n```\nb\nc'), 'a\n');
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
  assert.equal(replaceSection('## State  (checkpoint 1)\nold\n\n## Z\nz', 'State', '## State  (checkpoint 2)\nnew'), '## State  (checkpoint 2)\nnew\n\n## Z\nz\n');
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

const crlf = (text) => text.replace(/\n/g, '\r\n');

test('CRLF input: sections, fences, State fields, labels, tables, ids, markers', () => {
  const body = crlf('## Goal\none\n```\n## Hidden\n```\n## State  (checkpoint 1 · 2026-11-16 09:00 · m/h · session s1)\nDone: AC1\nOpen: none\n');
  const parsed = parseSections(body);
  assert.deepEqual(parsed.sections.map((s) => s.name), ['Goal', 'State']);
  assert.equal(parsed.byName.Goal, 'one');
  const state = parseStateSection(parsed.sections[1]);
  assert.deepEqual(state.fields, { Done: 'AC1', Open: 'none' });
  assert.equal(state.header.session, 's1');
  assert.equal(stripCommentsAndFences(crlf('a\n```\nx\n```\nb')), 'a\nb');
  assert.deepEqual(formFieldLabels(crlf('label: One\nlabel: "Two"')), ['One', 'Two']);
  assert.deepEqual(parseTable(crlf('| A |\n|---|\n| 1 |')), [{ A: '1' }]);
  assert.deepEqual(criterionIds(crlf('- [ ] E1 x\n- [x] E2 y'), 'E'), ['E1', 'E2']);
  assert.deepEqual(findClosingRefs(crlf('<!--\nCloses #1\n-->\nCloses #2')).map((r) => r.number), [2]);
  assert.equal(addMarker(crlf('x\n'), 'claim'), 'x\n\n<!-- groundwork:claim -->\n');
  assert.equal(replaceSection(crlf('## A\nold\n'), 'A', 'new'), '## A\nnew\n');
});

test('findClosingRefs matches full URLs after a keyword', () => {
  const refs = findClosingRefs('Closes #5\nFixes https://github.com/wimdotgg/groundwork/issues/6\nResolves https://github.com/o/r/pull/7');
  assert.deepEqual(refs, [
    { keyword: 'closes', owner: null, repo: null, number: 5 },
    { keyword: 'fixes', owner: 'wimdotgg', repo: 'groundwork', number: 6 },
    { keyword: 'resolves', owner: 'o', repo: 'r', number: 7 },
  ]);
});

test('parseStateSection accepts a parseSections entry', () => {
  const { sections } = parseSections(STATE);
  const fromEntry = parseStateSection(sections[0]);
  assert.deepEqual(fromEntry, parseStateSection(STATE));
  assert.equal(fromEntry.header.checkpoint, '3');
});

test('a fence marker inside a comment does not hide a later closing ref', () => {
  const body = '<!--\n```\n-->\nCloses #6\n';
  assert.deepEqual(findClosingRefs(body).map((r) => r.number), [6]);
  assert.equal(stripCommentsAndFences('```\n<!--\n```\nlive\n-->'), 'live\n-->');
});

test('parseStateSection header without the agent part', () => {
  const { header } = parseStateSection('## State  (checkpoint 4 · 2026-11-16 10:00 · session zz9)\nOpen: none');
  assert.deepEqual(header, { checkpoint: '4', at: '2026-11-16 10:00', agent: null, session: 'zz9' });
});

test('formFieldLabels skips checkbox option labels', () => {
  const yaml = '      label: Confirm\n      options:\n        - label: I agree\n        - label: "Me too"\n';
  assert.deepEqual(formFieldLabels(yaml), ['Confirm']);
});

test('parseSections handles a "constructor" heading', () => {
  const result = parseSections('## constructor\nx\n## Other\ny');
  assert.equal(result.byName.constructor, 'x');
  assert.deepEqual(result.duplicates, []);
});

test('replaceSection treats an unclosed comment as live text, like the strip scan', () => {
  const body = '<!-- never closed\n## A\nold\n';
  assert.equal(stripCommentsAndFences(body), body);
  assert.equal(replaceSection(body, 'A', 'new'), '<!-- never closed\n## A\nnew\n');
});

test('parseStateSection appends continuation lines to the previous field', () => {
  const { fields } = parseStateSection('## State\nNext: first step\n  then the second\nOpen: none');
  assert.equal(fields.Next, 'first step\nthen the second');
  assert.equal(fields.Open, 'none');
});

test('replaceSection ends with exactly one newline', () => {
  assert.equal(replaceSection('## A\nx\n\n\n', 'A', 'y\n\n'), '## A\ny\n');
  assert.equal(replaceSection('## A\nx', 'B', 'y'), '## A\nx\n\n## B\ny\n');
});

test('findClosingRefs ignores inline code spans', () => {
  const body = 'Use `Closes #1` here, also ``Fixes #2``\nCloses #3';
  assert.deepEqual(findClosingRefs(body).map((r) => r.number), [3]);
});

test('replaceSection stops at a --- footer line', () => {
  const body = '## State\nold\n---\nfooter text\n';
  assert.equal(replaceSection(body, 'State', 'new'), '## State\nnew\n\n---\nfooter text\n');
  assert.equal(replaceSection('```\n---\n```\n## S\nold', 'S', 'n'), '```\n---\n```\n## S\nn\n');
});

test('fillTemplate fills every occurrence and leaves comments and fences alone', () => {
  const template = ['<a> and <a>, <b c>', '<!-- <a> -->', '```', '<a>', '```'].join('\n');
  const result = fillTemplate(template, { a: 'X', 'b c': 2 });
  assert.equal(result.text, ['X and X, 2', '<!-- <a> -->', '```', '<a>', '```'].join('\n'));
  assert.deepEqual(result.unfilled, []);
});

test('fillTemplate reports unfilled placeholders once and keeps them in the text', () => {
  const result = fillTemplate('<a> <b> <b>', { a: 'X', unused: 'Y' });
  assert.equal(result.text, 'X <b> <b>');
  assert.deepEqual(result.unfilled, ['<b>']);
});

test('fillTemplate does not fill a placeholder that a value introduces', () => {
  const result = fillTemplate('<a> <b>', { a: '<b>', b: 'Z' });
  assert.equal(result.text, '<b> Z');
  assert.deepEqual(result.unfilled, []);
});

test('fillTemplate counts null and undefined values as unfilled and accepts null values', () => {
  const result = fillTemplate('#<a> <b> <c>', { a: undefined, b: null, c: 0 });
  assert.equal(result.text, '#<a> <b> 0');
  assert.deepEqual(result.unfilled, ['<a>', '<b>']);
  assert.deepEqual(fillTemplate('<a>', null), { text: '<a>', unfilled: ['<a>'] });
  assert.deepEqual(fillTemplate('<a>', undefined), { text: '<a>', unfilled: ['<a>'] });
});

test('templateSection handles CRLF and ignores a heading inside a fence', () => {
  const file = '## One\r\nfirst\r\n```\r\n## Two\r\n```\r\n<!-- groundwork:claim -->\r\n\r\n## Three\r\nthird\r\n';
  assert.equal(templateSection(file, 'One'), 'first\n```\n## Two\n```\n<!-- groundwork:claim -->');
  assert.equal(templateSection(file, 'Two'), null);
  assert.equal(templateSection(file, 'Three'), 'third');
});

test('templateSection returns the raw section with markers, or null', () => {
  const file = '## One\nfirst <n>\n<!-- groundwork:claim -->\n\n## Two\n<!-- ## Three -->\nsecond\n';
  assert.equal(templateSection(file, 'One'), 'first <n>\n<!-- groundwork:claim -->');
  assert.equal(templateSection(file, 'Two'), '<!-- ## Three -->\nsecond');
  assert.equal(templateSection(file, 'Three'), null);
});

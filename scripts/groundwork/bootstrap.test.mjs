import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTROL_READ_PERMISSIONS, DESCRIPTION_MAX_LENGTH, OP, TOKEN_SCOPE, run, validateArgs } from './bootstrap.mjs';

test('bootstrap identity', () => {
  assert.equal(OP, 'bootstrap');
  assert.equal(TOKEN_SCOPE, 'deferred');
});

test('validateArgs accepts a printable description up to the limit', () => {
  assert.deepEqual(validateArgs({ description: 'd' }), []);
  assert.deepEqual(validateArgs({ description: 'x'.repeat(DESCRIPTION_MAX_LENGTH) }), []);
});

for (const [name, args, errors] of [
  ['missing description', {}, ['description is required: a non-empty string']],
  ['empty description', { description: '' }, ['description is required: a non-empty string']],
  ['non-string description', { description: 7 }, ['description is required: a non-empty string']],
  ['over-long description', { description: 'x'.repeat(DESCRIPTION_MAX_LENGTH + 1) }, [`description must be at most ${DESCRIPTION_MAX_LENGTH} characters`]],
  ['newline in description', { description: 'a\nb' }, ['description must be printable ASCII']],
  ['DEL in description', { description: 'a\x7fb' }, ['description must be printable ASCII']],
  ['non-ASCII description', { description: 'café' }, ['description must be printable ASCII']],
  ['unknown key', { description: 'd', extra: 1 }, ['unknown argument "extra"']],
  ['array args', [], ['args must be a JSON object']],
  ['null args', null, ['args must be a JSON object']],
]) {
  test(`validateArgs rejects ${name}`, () => {
    assert.deepEqual(validateArgs(args), errors);
  });
}

test('CONTROL_READ_PERMISSIONS is a contents read grant', () => {
  assert.deepEqual(CONTROL_READ_PERMISSIONS, { contents: 'read' });
});

test('run is a skeleton', async () => {
  assert.deepEqual(await run(), { ok: false, summary: 'not implemented' });
});

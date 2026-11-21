import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DESCRIPTION_MAX_LENGTH, OP, TOKEN_SCOPE, run, validateArgs } from './bootstrap.mjs';

test('bootstrap identity', () => {
  assert.equal(OP, 'bootstrap');
  assert.equal(TOKEN_SCOPE, 'deferred');
});

test('validateArgs accepts a printable description up to the limit', () => {
  assert.deepEqual(validateArgs({ description: 'd' }), []);
  assert.deepEqual(validateArgs({ description: 'x'.repeat(DESCRIPTION_MAX_LENGTH) }), []);
});

for (const [name, args] of [
  ['missing description', {}],
  ['empty description', { description: '' }],
  ['non-string description', { description: 7 }],
  ['over-long description', { description: 'x'.repeat(DESCRIPTION_MAX_LENGTH + 1) }],
  ['non-printable description', { description: 'a\nb' }],
  ['unknown key', { description: 'd', extra: 1 }],
  ['array args', []],
  ['null args', null],
]) {
  test(`validateArgs rejects ${name}`, () => {
    assert.notDeepEqual(validateArgs(args), []);
  });
}

test('run is a skeleton', async () => {
  assert.deepEqual(await run(), { ok: false, summary: 'not implemented' });
});

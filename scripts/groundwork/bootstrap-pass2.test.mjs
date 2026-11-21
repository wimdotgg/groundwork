import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OP, TOKEN_SCOPE, run, validateArgs } from './bootstrap-pass2.mjs';

test('bootstrap-pass2 identity', () => {
  assert.equal(OP, 'bootstrap-pass2');
  assert.equal(TOKEN_SCOPE, 'target');
});

test('validateArgs accepts an empty object', () => {
  assert.deepEqual(validateArgs({}), []);
});

test('validateArgs rejects any key and non-objects', () => {
  assert.deepEqual(validateArgs({ deploy: 'none' }), ['unknown argument "deploy"']);
  assert.notDeepEqual(validateArgs([]), []);
  assert.notDeepEqual(validateArgs(null), []);
});

test('run is a skeleton', async () => {
  assert.deepEqual(await run(), { ok: false, summary: 'not implemented' });
});

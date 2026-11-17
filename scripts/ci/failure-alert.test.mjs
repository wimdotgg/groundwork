import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFixtureClient } from '../lib/github.mjs';
import { collect, evaluate } from './failure-alert.mjs';

const cases = JSON.parse(await readFile(new URL('./fixtures/failure-alert.json', import.meta.url), 'utf8'));
const REPO = { owner: 'wimdotgg', repo: 'groundwork' };

async function factsFor(testCase) {
  if (testCase.facts) return testCase.facts;
  const client = testCase.routes ? createFixtureClient(testCase.routes) : undefined;
  const { eventName, payload } = testCase;
  return collect({ eventName, payload, repo: REPO, client });
}

for (const testCase of cases) {
  test(testCase.description, async () => {
    if (testCase.expected.throws) {
      await assert.rejects(factsFor(testCase), (error) => error.message.includes(testCase.expected.throws));
      return;
    }
    const result = evaluate(await factsFor(testCase));
    assert.equal(result.conclusion, testCase.expected.conclusion);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.actions, testCase.expected.actions);
  });
}

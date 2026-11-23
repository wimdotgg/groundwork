import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFixtureClient } from '../lib/github.mjs';
import { loadConfig, repoRoot } from '../lib/config.mjs';
import { collect, evaluate } from './test-integrity.mjs';

const root = repoRoot(import.meta.url);
const configRoot = fileURLToPath(new URL('../lib/fixtures/config-root/', import.meta.url));
// Fixtures escape suppression tokens (- etc.) so the fixture file does not trip test-integrity on its own PRs.
const cases = JSON.parse(await readFile(new URL('./fixtures/test-integrity.json', import.meta.url), 'utf8'));
const config = await loadConfig({ root: configRoot });
const REPO = { owner: 'wimdotgg', repo: 'groundwork' };

async function factsFor(testCase) {
  if (testCase.facts) return testCase.facts;
  const client = testCase.routes ? createFixtureClient(testCase.routes) : undefined;
  const { eventName, payload, env } = testCase;
  return collect({ eventName, payload, env, repo: REPO, client, config, root });
}

for (const testCase of cases) {
  test(testCase.description, async () => {
    const result = evaluate(await factsFor(testCase), config);
    assert.equal(result.conclusion, testCase.expected.conclusion);
    for (const text of testCase.expected.errorsInclude) {
      assert.ok(result.errors.some((error) => error.includes(text)), `no error includes ${text}: ${result.errors.join(' | ')}`);
    }
    for (const text of testCase.expected.warningsInclude ?? []) {
      assert.ok(result.warnings.some((warning) => warning.includes(text)), `no warning includes ${text}: ${result.warnings.join(' | ')}`);
    }
    if (testCase.expected.conclusion !== 'fail') assert.deepEqual(result.errors, []);
    assert.deepEqual(result.actions, testCase.expected.actions);
  });
}

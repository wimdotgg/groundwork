import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFixtureClient } from '../lib/github.mjs';
import { loadConfig, repoRoot } from '../lib/config.mjs';
import { collect, dependabotUpdateType, evaluate } from './pr-metadata.mjs';

const root = repoRoot(import.meta.url);
const cases = JSON.parse(await readFile(new URL('./fixtures/pr-metadata.json', import.meta.url), 'utf8'));
const config = await loadConfig({ root });
const REPO = { owner: 'wimdotgg', repo: 'groundwork' };

async function factsFor(testCase) {
  if (testCase.facts) return testCase.facts;
  const client = testCase.routes ? createFixtureClient(testCase.routes) : undefined;
  const { eventName, payload, env } = testCase;
  return collect({ eventName, payload, env, repo: REPO, client, config, root });
}

for (const testCase of cases) {
  test(testCase.description, async () => {
    if (testCase.expected.throws) {
      await assert.rejects(factsFor(testCase), (error) => error.message.includes(testCase.expected.throws));
      return;
    }
    const result = evaluate(await factsFor(testCase), config);
    assert.equal(result.conclusion, testCase.expected.conclusion);
    for (const text of testCase.expected.errorsInclude) {
      assert.ok(result.errors.some((error) => error.includes(text)), `no error includes ${text}: ${result.errors.join(' | ')}`);
    }
    for (const text of testCase.expected.warningsInclude ?? []) {
      assert.ok(result.warnings.some((warning) => warning.includes(text)), `no warning includes ${text}: ${result.warnings.join(' | ')}`);
    }
    if (!testCase.expected.warningsInclude) assert.deepEqual(result.warnings, []);
    if (testCase.expected.conclusion !== 'fail') assert.deepEqual(result.errors, []);
    assert.deepEqual(result.actions, testCase.expected.actions);
  });
}

const UPDATE_TYPE_CASES = [
  ['single patch pair', 'Bump a from 1.2.3 to 1.2.4', '', 'patch'],
  ['single minor pair', 'Bump a from 1.2.3 to 1.3.0', '', 'minor'],
  ['single major pair', 'Bump a from 1.2.3 to 2.0.0', '', 'major'],
  ['largest pair wins across title and body', 'Bump a from 1.0.0 to 1.0.1', 'Updates `b` from 3.1.0 to 4.0.0.', 'major'],
  ['v prefix, code spans and a trailing period', 'Bump a', 'Bumps a from `v1.2.3` to `v1.4.0`.', 'minor'],
  ['two-part versions', 'Bump a from 2.1 to 3.0', '', 'major'],
  ['prerelease suffix', 'Bump a from 1.2.3-beta.1 to 1.2.3', '', 'patch'],
  ['pairs that are not versions are ignored', 'Bump a from 1.0.0 to 1.1.0', 'migrate from express to fastify', 'minor'],
  ['no version pair is unknown and fails closed', 'Bump a', 'no pairs here', 'major'],
];

for (const [description, title, body, expected] of UPDATE_TYPE_CASES) {
  test(`dependabotUpdateType: ${description}`, () => {
    assert.equal(dependabotUpdateType(title, body), expected);
  });
}

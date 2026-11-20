import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFixtureClient } from '../lib/github.mjs';
import { loadConfig, repoRoot } from '../lib/config.mjs';
import { collect, dependabotUpdateType, evaluate } from './pr-metadata.mjs';

const root = repoRoot(import.meta.url);
const cases = JSON.parse(await readFile(new URL('./fixtures/pr-metadata.json', import.meta.url), 'utf8'));
const loadedConfig = await loadConfig({ root });
// Fixtures predate the App identity and name the old agent login as author.
const config = { ...loadedConfig, accounts: { ...loadedConfig.accounts, agent: 'wianvdm-agent' } };
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
  ['link syntax around versions', 'Bump a', 'Updates [a](https://x.test) from [1.0.0](https://y.test) to [1.2.0](https://z.test)', 'minor'],
  ['From/To table rows', 'Bump the group', '| Package | From | To |\n| --- | --- | --- |\n| [a](https://x.test) | `1.0.0` | `1.0.1` |\n| b | `2.0.0` | `3.0.0` |', 'major'],
  ['table rows without a From/To header are not read', 'Bump a from 1.0.0 to 1.0.1', '| a | 1.0.0 | 9.0.0 |', 'patch'],
  ['a digit-led pair that does not parse is major', 'Bump a from 1.0.0 to 1.0.1', 'from 2fa to 3ds', 'major'],
  ['HTML tags around versions', 'Bump a', 'from <code>1.0.0</code> to <code>1.1.0</code>', 'minor'],
];

for (const [description, title, body, expected] of UPDATE_TYPE_CASES) {
  test(`dependabotUpdateType: ${description}`, () => {
    assert.equal(dependabotUpdateType(title, body), expected);
  });
}

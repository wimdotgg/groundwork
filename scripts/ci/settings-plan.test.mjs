import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFixtureClient } from '../lib/github.mjs';
import { loadConfig, repoRoot } from '../lib/config.mjs';
import { collect, evaluate } from './settings-plan.mjs';

const root = repoRoot(import.meta.url);
const configRoot = fileURLToPath(new URL('../lib/fixtures/config-root/', import.meta.url));
const cases = JSON.parse(await readFile(new URL('./fixtures/settings-plan.json', import.meta.url), 'utf8'));
const config = await loadConfig({ root: configRoot });
const REPO = { owner: 'wimdotgg', repo: 'groundwork' };
const TEMP_ROOT_TOKEN = '$TEMP_ROOT';

async function writePrFiles(directory, prFiles) {
  for (const [relativePath, content] of Object.entries(prFiles)) {
    const file = path.join(directory, '.github', 'groundwork', relativePath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(content));
  }
}

async function factsFor(testCase, tempRoot) {
  if (testCase.facts) return testCase.facts;
  const client = testCase.routes ? createFixtureClient(testCase.routes) : undefined;
  const { eventName, payload } = testCase;
  const env = Object.fromEntries(Object.entries(testCase.env).map(([key, value]) => [key, value === TEMP_ROOT_TOKEN ? tempRoot : value]));
  return collect({ eventName, payload, env, repo: REPO, client, config, root });
}

async function runCase(testCase, tempRoot) {
  if (testCase.expected.throws) {
    await assert.rejects(factsFor(testCase, tempRoot), (error) => error.message.includes(testCase.expected.throws));
    return;
  }
  const result = evaluate(await factsFor(testCase, tempRoot), config);
  assert.equal(result.conclusion, testCase.expected.conclusion);
  for (const text of testCase.expected.errorsInclude) {
    assert.ok(result.errors.some((error) => error.includes(text)), `no error includes ${text}: ${result.errors.join(' | ')}`);
  }
  for (const text of testCase.expected.detailsInclude ?? []) {
    assert.ok(result.details.includes(text), `details lack ${text}:\n${result.details}`);
  }
  for (const text of testCase.expected.detailsExclude ?? []) {
    assert.ok(!result.details.includes(text), `details include ${JSON.stringify(text)}:\n${result.details}`);
  }
  if (testCase.expected.log) assert.deepEqual(result.log, testCase.expected.log);
  if (testCase.expected.conclusion !== 'fail') assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.actions, testCase.expected.actions ?? []);
}

for (const testCase of cases) {
  test(testCase.description, async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'settings-plan-'));
    try {
      await writePrFiles(tempRoot, testCase.prFiles ?? {});
      await runCase(testCase, tempRoot);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
}

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
    if (testCase.expected.warningsInclude === undefined) assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.actions, testCase.expected.actions);
  });
}

// The pull_request success rule in evaluate holds only while the closed run carries just the notifier job.
const RELEASE_WORKFLOW_URL = new URL('../../.github/workflows/release-please.yml', import.meta.url);
const NOTIFIER_JOB = 'dispatch-on-main';
const RELEASE_JOB = 'release-please';
const DISPATCH_ONLY_TERM = "github.event_name == 'workflow_dispatch'";

function jobConditions(workflowText) {
  const jobsText = workflowText.split(/^jobs:\s*$/m)[1] ?? '';
  const jobs = new Map();
  let current = null;
  for (const line of jobsText.split(/\r?\n/)) {
    const jobHeader = /^ {2}([\w-]+):\s*(#.*)?$/.exec(line);
    // Fails closed: a job key this parser cannot read (quoted, flow mapping) would otherwise merge into the job above it.
    if (!jobHeader && /^ {2}[^\s#]/.test(line)) throw new Error(`unreadable job line in release-please.yml: ${line}`);
    if (jobHeader) {
      current = { condition: '', inCondition: false };
      jobs.set(jobHeader[1], current);
      continue;
    }
    if (current !== null) readConditionLine(current, line);
  }
  return new Map([...jobs].map(([job, state]) => [job, state.condition.trim()]));
}

function readConditionLine(state, line) {
  const condition = /^ {4}if:\s*(.*)$/.exec(line);
  if (condition) {
    state.inCondition = true;
    state.condition = condition[1].replace(/^>-?\s*$/, '');
    return;
  }
  if (state.inCondition && /^ {6,}\S/.test(line)) state.condition += ` ${line.trim()}`;
  else if (line.trim() !== '') state.inCondition = false;
}

function runsOnlyOnDispatch(condition) {
  if (condition.includes('||')) return false;
  return condition.split('&&').map((term) => term.trim()).includes(DISPATCH_ONLY_TERM);
}

test('release-please.yml: the release job runs only on workflow_dispatch and only the notifier can run on pull_request', async () => {
  const conditions = jobConditions(await readFile(RELEASE_WORKFLOW_URL, 'utf8'));
  assert.ok(conditions.has(NOTIFIER_JOB), `no ${NOTIFIER_JOB} job`);
  assert.ok(runsOnlyOnDispatch(conditions.get(RELEASE_JOB) ?? ''), `${RELEASE_JOB} job can run on an event other than workflow_dispatch`);
  const otherJobs = [...conditions].filter(([job, condition]) => job !== NOTIFIER_JOB && !runsOnlyOnDispatch(condition)).map(([job]) => job);
  assert.deepEqual(otherJobs, [], 'jobs besides the notifier that can run on pull_request');
});

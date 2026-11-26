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
const JOB_HEADER = /^ {2}([\w-]+):\s*(#.*)?$/;
const JOB_HEADER_INDENT = 2;
const JOB_KEY_INDENT = 4;
const CONDITION_CONTINUATION_INDENT = 6;

// Fails closed: the parser reads job headers at 2 spaces, job keys at 4 and `if` continuations at 6 or more. A quoted
// or flow-mapping header, or a line at 1, 3 or 5 spaces, is valid YAML it would misread, so the test refuses it.
function assertReadableJobLine(line) {
  const content = line.trimStart();
  if (content === '' || content.startsWith('#')) return;
  const indent = line.length - content.length;
  const misreadIndent = indent < CONDITION_CONTINUATION_INDENT && indent % 2 === 1;
  if (misreadIndent || (indent === JOB_HEADER_INDENT && !JOB_HEADER.test(line))) throw new Error(`unreadable job line in release-please.yml: ${line}`);
}

function jobConditions(workflowText) {
  const jobsText = workflowText.split(/^jobs:\s*$/m)[1] ?? '';
  const jobs = new Map();
  let current = null;
  for (const line of jobsText.split(/\r?\n/)) {
    assertReadableJobLine(line);
    const jobHeader = JOB_HEADER.exec(line);
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
  const content = line.trim();
  const indent = line.length - line.trimStart().length;
  const condition = /^if:\s*(.*)$/.exec(content);
  if (condition && indent === JOB_KEY_INDENT) {
    state.inCondition = true;
    state.condition = condition[1].replace(/^>-?\s*$/, '');
    return;
  }
  if (state.inCondition && content !== '' && indent >= CONDITION_CONTINUATION_INDENT) state.condition += ` ${content}`;
  else if (content !== '') state.inCondition = false;
}

// Grouping or negation could wrap the dispatch term, as in `!(a && <term> && b)`, so the condition must be a flat AND.
function runsOnlyOnDispatch(condition) {
  if (condition.includes('||') || /[()]|!(?!=)/.test(condition)) return false;
  return condition.split('&&').map((term) => term.trim()).includes(DISPATCH_ONLY_TERM);
}

test('release-please.yml: the release job runs only on workflow_dispatch and only the notifier can run on pull_request', async () => {
  const conditions = jobConditions(await readFile(RELEASE_WORKFLOW_URL, 'utf8'));
  assert.ok(conditions.has(NOTIFIER_JOB), `no ${NOTIFIER_JOB} job`);
  assert.ok(runsOnlyOnDispatch(conditions.get(RELEASE_JOB) ?? ''), `${RELEASE_JOB} job can run on an event other than workflow_dispatch`);
  const otherJobs = [...conditions].filter(([job, condition]) => job !== NOTIFIER_JOB && !runsOnlyOnDispatch(condition)).map(([job]) => job);
  assert.deepEqual(otherJobs, [], 'jobs besides the notifier that can run on pull_request');
});

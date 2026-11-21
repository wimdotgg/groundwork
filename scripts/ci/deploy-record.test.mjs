import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { repoRoot } from '../lib/config.mjs';
import { createFixtureClient } from '../lib/github.mjs';
import { previousTag, renderRecord, upsertRecord, validateRecordInput, writeRecord } from './deploy-record.mjs';

const WORKFLOW_FILE = path.join(repoRoot(import.meta.url), '.github', 'workflows', 'deploy.yml');
const REPO = { owner: 'wimdotgg', repo: 'groundwork' };
const RUN_URL = 'https://github.com/wimdotgg/groundwork/actions/runs/42';
const release = (tag, flags = {}) => ({ tag_name: tag, draft: false, prerelease: false, ...flags });
const input = (overrides = {}) => ({ result: 'deployed', tag: 'v1.2.0', previous: 'v1.1.0', runUrl: RUN_URL, ...overrides });

test('previousTag returns null when no earlier release exists', () => {
  assert.equal(previousTag({ releases: [], tag: 'v1.0.0' }), null);
  assert.equal(previousTag({ releases: [release('v1.0.0'), release('v1.1.0')], tag: 'v1.0.0' }), null);
});

test('previousTag picks the highest lower version, compared numerically', () => {
  const releases = [release('v1.9.0'), release('v1.10.0'), release('v1.2.0'), release('v1.11.0')];
  assert.equal(previousTag({ releases, tag: 'v1.11.0' }), 'v1.10.0');
});

test('previousTag skips prereleases, drafts and tags that are not vX.Y.Z', () => {
  const releases = [
    release('v1.1.0', { prerelease: true }),
    release('v1.0.5', { draft: true }),
    release('v1.0.4-rc.1'),
    release('nightly'),
    release('v1.0.3'),
  ];
  assert.equal(previousTag({ releases, tag: 'v1.2.0' }), 'v1.0.3');
});

test('previousTag rejects a deployed tag that is not vX.Y.Z', () => {
  assert.throws(() => previousTag({ releases: [], tag: 'main' }), /not a vX\.Y\.Z tag/);
});

test('renderRecord writes the 8.5 block ending with a newline', () => {
  assert.equal(renderRecord(input()), [
    '<!-- groundwork:deploy -->',
    '### Deploy',
    'Result: deployed',
    'Tag: v1.2.0',
    'Previous: v1.1.0',
    `Run: ${RUN_URL}`,
    '',
  ].join('\n'));
  assert.match(renderRecord(input({ result: 'failed', previous: 'none' })), /Previous: none\n/);
});

test('upsertRecord appends the record after a blank line', () => {
  const record = renderRecord(input());
  assert.equal(upsertRecord({ notes: '## Notes\n\n- a change\n', record }), `## Notes\n\n- a change\n\n${record}`);
  assert.equal(upsertRecord({ notes: '', record }), record);
});

test('upsertRecord replaces an existing block on a rerun and keeps the rest', () => {
  const first = renderRecord(input({ result: 'failed' }));
  const second = renderRecord(input({ result: 'deployed' }));
  const once = upsertRecord({ notes: '## Notes\n', record: first });
  assert.equal(upsertRecord({ notes: once, record: second }), `## Notes\n\n${second}`);
  const withTail = `${first}\nFooter text\n`;
  assert.equal(upsertRecord({ notes: withTail, record: second }), `${second}\nFooter text\n`);
});

test('upsertRecord ignores a marker quoted inside a changelog line', () => {
  const notes = '- fix: mention <!-- groundwork:deploy -->\n- next line\n\nmore text\n';
  const record = renderRecord(input());
  assert.equal(upsertRecord({ notes, record }), `${notes.trimEnd()}\n\n${record}`);
});

test('writeRecord looks up the release by tag and patches its notes', async () => {
  const paths = [];
  const client = createFixtureClient({
    'GET /repos/wimdotgg/groundwork/releases/tags/v1.2.0': { status: 200, data: { id: 7, body: '## Notes\n' } },
    'PATCH /repos/wimdotgg/groundwork/releases/7': { status: 200, data: {} },
  }, { onCall: ({ method, path: calledPath }) => paths.push(`${method} ${calledPath}`) });
  await writeRecord({ client, repo: REPO, input: input() });
  assert.deepEqual(paths, [
    'GET /repos/wimdotgg/groundwork/releases/tags/v1.2.0',
    'PATCH /repos/wimdotgg/groundwork/releases/7',
  ]);
});

const validValues = () => ({ tag: 'v1.2.0', result: 'rolled-back', previous: 'none', 'run-url': RUN_URL });

test('validateRecordInput maps valid flags to the record input', () => {
  assert.deepEqual(validateRecordInput(validValues()), { result: 'rolled-back', tag: 'v1.2.0', previous: 'none', runUrl: RUN_URL });
});

for (const [flag, bad] of [
  ['tag', 'v1.2'], ['tag', undefined], ['result', 'ok'], ['result', 'deployed\n- injected'],
  ['previous', 'v2'], ['previous', 'None'], ['run-url', 'http://example.com'], ['run-url', 'https://a b'],
]) {
  test(`validateRecordInput rejects --${flag} ${JSON.stringify(bad)}`, () => {
    assert.throws(() => validateRecordInput({ ...validValues(), [flag]: bad }), new RegExp(`--${flag} is missing or malformed`));
  });
}

const workflow = await readFile(WORKFLOW_FILE, 'utf8');
const lineOf = (text) => {
  const index = workflow.split(/\r?\n/).findIndex((line) => line.includes(text));
  assert.notEqual(index, -1, `deploy.yml has no line with ${text}`);
  return index;
};

test('deploy.yml triggers on published releases and keeps the name deploy', () => {
  assert.match(workflow, /^name: deploy$/m);
  assert.match(workflow, /^on:\n {2}release:\n {4}types: \[published\]$/m);
});

test('deploy.yml gates the job on DEPLOY_ENABLED, prereleases and the production environment', () => {
  assert.match(workflow, /^ {4}if: vars\.DEPLOY_ENABLED == 'true' && !github\.event\.release\.prerelease$/m);
  assert.match(workflow, /^ {4}environment: production$/m);
});

test('deploy.yml serializes on the production group and never cancels', () => {
  assert.match(workflow, /^concurrency:\n {2}group: production\n {2}cancel-in-progress: false$/m);
});

test('deploy.yml grants contents read by default and write only to the job', () => {
  assert.match(workflow, /^permissions:\n {2}contents: read$/m);
  assert.match(workflow, /^ {4}permissions:\n {6}contents: write$/m);
  assert.equal(workflow.match(/contents: write/g).length, 1);
});

test('deploy.yml checks out without persisting credentials and pins every action to a SHA', () => {
  assert.match(workflow, /persist-credentials: false/);
  const uses = workflow.match(/^\s*- uses: .+$/gm);
  for (const line of uses) assert.match(line, /@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
});

const steps = workflow.split(/\r?\n {6}- /).slice(1).map((step) => `- ${step}`);
const stepNamed = (name) => steps.find((step) => step.includes(`name: ${name}\n`));

test('deploy.yml gives GITHUB_TOKEN only to the previous-tag and record steps', () => {
  const withToken = steps.filter((step) => step.includes('GITHUB_TOKEN')).map((step) => /name: (.+)/.exec(step)[1]);
  assert.deepEqual(withToken, ['Find previous tag', 'Record deploy']);
  assert.equal(workflow.match(/GITHUB_TOKEN/g).length, 2);
});

test('deploy.yml never expands an expression inside a run block', () => {
  const runBlocks = steps.filter((step) => step.includes('run:')).map((step) => step.slice(step.indexOf('run:')));
  assert.equal(runBlocks.length, 7);
  for (const block of runBlocks) assert.doesNotMatch(block, /\$\{\{/);
});

test('deploy.yml runs Smoke only after a successful deploy and stops before deploy when previous-tag fails', () => {
  assert.match(stepNamed('Smoke'), /if: steps\.deploy\.outcome == 'success'/);
  assert.match(stepNamed('Find previous tag'), /previous=\$\(node scripts\/ci\/deploy-record\.mjs previous-tag "\$TAG"\)\n\s+echo "tag=\$previous"/);
  assert.doesNotMatch(stepNamed('Find previous tag'), /continue-on-error|if:/);
});

test('deploy.yml runs deploy, smoke, rollback on failure, smoke again, then fails the job', () => {
  const order = [
    'run: ./scripts/deploy "$TAG"',
    'run: ./scripts/smoke',
    'run: ./scripts/rollback "$PREVIOUS_TAG"',
    'if: steps.rollback.outcome == \'success\'',
    'name: Record deploy',
    'name: Fail the job',
  ].map(lineOf);
  assert.deepEqual(order, [...order].sort((left, right) => left - right));
  assert.match(workflow, /id: rollback\n {8}if: always\(\) && steps\.previous\.outputs\.tag != '' && \(steps\.deploy\.outcome == 'failure' \|\| steps\.smoke\.outcome == 'failure'\)/);
  assert.match(workflow, /name: Record deploy\n {8}if: always\(\)/);
  assert.match(workflow, /name: Fail the job\n {8}if: always\(\) && \(steps\.deploy\.outcome != 'success' \|\| steps\.smoke\.outcome != 'success'\)/);
});

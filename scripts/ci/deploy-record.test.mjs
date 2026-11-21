import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { repoRoot } from '../lib/config.mjs';
import { previousTag, renderRecord, upsertRecord, writeRecord } from './deploy-record.mjs';

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

test('writeRecord patches the release notes found by tag', async () => {
  const calls = [];
  const client = {
    request: async (method, requestPath, options) => {
      calls.push({ method, requestPath, body: options?.body });
      return { status: 200, data: { id: 7, body: '## Notes\n' } };
    },
  };
  await writeRecord({ client, repo: REPO, input: input() });
  assert.deepEqual(calls.map(({ method, requestPath }) => `${method} ${requestPath}`), [
    'GET /repos/wimdotgg/groundwork/releases/tags/v1.2.0',
    'PATCH /repos/wimdotgg/groundwork/releases/7',
  ]);
  assert.equal(calls[1].body.body, `## Notes\n\n${renderRecord(input())}`);
});

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

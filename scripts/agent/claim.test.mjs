import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFixtureClient } from '../lib/github.mjs';
import { parseSections } from '../lib/markdown.mjs';
import { EXIT_CLAIMED, EXIT_ERROR, EXIT_HELD, runClaim } from './claim.mjs';

const REPO = { owner: 'o', repo: 'r' };
const SESSION = 'w85-a1';
const AGENT = 'sonnet/claude-code';
const AGENT_LOGIN = 'wimdotgg-agent[bot]';
const CONFIG = { accounts: { agent: AGENT_LOGIN } };
const NOW = new Date('2026-11-20T10:05:30Z');
const templates = {
  claimComment: await readFile(new URL('../../.github/groundwork/templates/claim-comment.md', import.meta.url), 'utf8'),
  pullRequest: await readFile(new URL('../../.github/pull_request_template.md', import.meta.url), 'utf8'),
};
const FOOTER = `---\nAgent: ${AGENT} · session ${SESSION}`;
const MARKED_COMMENT = [{ user: { login: AGENT_LOGIN }, body: 'x\n<!-- groundwork:claim -->' }];

const ok = (data, status = 200) => ({ status, data, headers: {} });
const OPEN_PULLS = 'GET /repos/o/r/pulls?per_page=100&state=open';
const ISSUE_PULLS = 'GET /repos/o/r/pulls?head=o%3Aissue%2F7&per_page=100&state=open';
const REF = 'GET /repos/o/r/git/ref/heads/issue/7';
const ISSUE_COMMENTS = 'GET /repos/o/r/issues/7/comments?per_page=100';
const PR_COMMENTS = 'GET /repos/o/r/issues/12/comments?per_page=100';
const POST_COMMIT = 'POST /repos/o/r/git/commits';
const POST_REF = 'POST /repos/o/r/git/refs';
const POST_ISSUE_COMMENT = 'POST /repos/o/r/issues/7/comments';
const POST_PULL = 'POST /repos/o/r/pulls';
const POST_PR_COMMENT = 'POST /repos/o/r/issues/12/comments';

const creationRoutes = {
  [OPEN_PULLS]: ok([]),
  [REF]: ok({}, 404),
  'GET /repos/o/r/git/ref/heads/main': ok({ object: { sha: 'main-sha' } }),
  'GET /repos/o/r/git/commits/main-sha': ok({ tree: { sha: 'tree-sha' } }),
  [POST_COMMIT]: ok({ sha: 'claim-sha' }, 201),
  [POST_REF]: ok({}, 201),
  [ISSUE_COMMENTS]: ok([]),
  [POST_ISSUE_COMMENT]: ok({}, 201),
  'GET /repos/o/r/issues/7': ok({ number: 7, title: 'Build the thing', type: { name: 'Feature' } }),
  [POST_PULL]: ok({ number: 12 }, 201),
  [POST_PR_COMMENT]: ok({}, 201),
};

/** Fixture client that also records every request body, which `onCall` never sees. */
function recordingClient(routes) {
  const inner = createFixtureClient(routes);
  const calls = [];
  const client = {
    ...inner,
    async request(method, path, options) {
      calls.push({ key: `${method} ${path}`, body: options?.body });
      return inner.request(method, path, options);
    },
  };
  return { client, calls };
}

const run = (client) => runClaim({
  client, repo: REPO, config: CONFIG, number: 7, session: SESSION, agent: AGENT, templates, now: NOW,
});
const writeKeys = (calls) => calls.filter((call) => call.key.startsWith('POST ')).map((call) => call.key);
const bodyOf = (calls, key) => calls.find((call) => call.key === key).body;

test('AC1: the claim commit has main tree and parent and no author, committer or dates', async () => {
  const { client, calls } = recordingClient(creationRoutes);
  await run(client);
  const commit = bodyOf(calls, POST_COMMIT);
  assert.deepEqual(commit, { message: 'chore(claim): #7 [session w85-a1]', tree: 'tree-sha', parents: ['main-sha'] });
});

test('AC2: a 422 on the ref exits 3 and makes no further call', async () => {
  const { client, calls } = recordingClient({ ...creationRoutes, [POST_REF]: ok({ message: 'Reference already exists' }, 422) });
  assert.equal((await run(client)).exitCode, EXIT_HELD);
  assert.equal(calls.at(-1).key, POST_REF);
});

test('AC2: any other rejected ref response (403) exits 3 and makes no further call', async () => {
  const { client, calls } = recordingClient({ ...creationRoutes, [POST_REF]: ok({ message: 'forbidden' }, 403) });
  assert.equal((await run(client)).exitCode, EXIT_HELD);
  assert.equal(calls.at(-1).key, POST_REF);
});

test('AC3: pointer comment, draft PR and PR claim comment follow in order, from the templates', async () => {
  const { client, calls } = recordingClient(creationRoutes);
  assert.deepEqual(await run(client), { exitCode: EXIT_CLAIMED, pr: 12 });
  assert.deepEqual(writeKeys(calls), [POST_COMMIT, POST_REF, POST_ISSUE_COMMENT, POST_PULL, POST_PR_COMMENT]);
  assert.equal(bodyOf(calls, POST_ISSUE_COMMENT).body, 'Claimed on `issue/7` by session w85-a1.\n<!-- groundwork:claim -->');
  assert.equal(bodyOf(calls, POST_PR_COMMENT).body, 'Claim: #7, session w85-a1.\n<!-- groundwork:claim -->');
  const pull = bodyOf(calls, POST_PULL);
  assert.deepEqual([pull.draft, pull.head, pull.base, pull.title], [true, 'issue/7', 'main', 'feat: Build the thing']);
  assert.match(pull.body, /^Closes #7$/m);
  assert.match(pull.body, /^## State {2}\(checkpoint 0 · 2026-11-20 10:05 · sonnet\/claude-code · session w85-a1\)$/m);
  assert.match(pull.body, /^In progress: claimed, nothing built yet$/m);
  assert.match(pull.body, /\n---\nAgent: sonnet\/claude-code · session w85-a1\n?$/);
  assert.equal(parseSections(pull.body).byName.State.includes('<'), false);
  assert.match(pull.body, /<command>/, 'worker-owned placeholders stay for the worker');
});

test('AC4: a rerun after a failed PR creation completes the missing steps with no second commit or ref', async () => {
  const { client, calls } = recordingClient({
    ...creationRoutes,
    [REF]: ok({ object: { sha: 'claim-sha' } }),
    [ISSUE_PULLS]: ok([]),
    'GET /repos/o/r/git/commits/claim-sha': ok({ message: 'chore(claim): #7 [session w85-a1]' }),
    [ISSUE_COMMENTS]: ok(MARKED_COMMENT),
  });
  assert.deepEqual(await run(client), { exitCode: EXIT_CLAIMED, pr: 12 });
  assert.deepEqual(writeKeys(calls), [POST_PULL, POST_PR_COMMENT]);
});

test('AC4: a rerun with everything in place, head moved past the claim commit, writes nothing', async () => {
  const pull = { number: 12, head: { ref: 'issue/7' }, body: `body\n\n${FOOTER}\n` };
  const { client, calls } = recordingClient({
    ...creationRoutes,
    [REF]: ok({ object: { sha: 'later-sha' } }),
    [ISSUE_PULLS]: ok([pull]),
    [ISSUE_COMMENTS]: ok(MARKED_COMMENT),
    [PR_COMMENTS]: ok(MARKED_COMMENT),
  });
  assert.deepEqual(await run(client), { exitCode: EXIT_CLAIMED, pr: 12 });
  assert.deepEqual(writeKeys(calls), []);
});

test('an existing ref claimed by another session is held (exit 3) with no write', async () => {
  const { client, calls } = recordingClient({
    ...creationRoutes,
    [REF]: ok({ object: { sha: 'other-sha' } }),
    [ISSUE_PULLS]: ok([]),
    'GET /repos/o/r/git/commits/other-sha': ok({ message: 'chore(claim): #7 [session someone-else]' }),
  });
  assert.equal((await run(client)).exitCode, EXIT_HELD);
  assert.deepEqual(writeKeys(calls), []);
});

test('AC5: a session holding a draft PR on another issue is refused with exit 1 before any other call', async () => {
  const held = { number: 20, draft: true, head: { ref: 'issue/9' }, user: { login: AGENT_LOGIN }, body: `x\n\n${FOOTER}\n` };
  const { client, calls } = recordingClient({ [OPEN_PULLS]: ok([held]) });
  const outcome = await run(client);
  assert.equal(outcome.exitCode, EXIT_ERROR);
  assert.match(outcome.reason, /already holds a draft PR/);
  assert.deepEqual(calls, [], 'no request beyond the draft PR listing (paginate)');
});

test('AC5: another session\'s draft PR and this session\'s ready PR do not block the claim', async () => {
  const others = [
    { number: 20, draft: true, head: { ref: 'issue/9' }, user: { login: AGENT_LOGIN }, body: 'x\n\n---\nAgent: a/b · session other\n' },
    { number: 21, draft: false, head: { ref: 'issue/8' }, user: { login: AGENT_LOGIN }, body: `x\n\n${FOOTER}\n` },
  ];
  const { client } = recordingClient({ ...creationRoutes, [OPEN_PULLS]: ok(others) });
  assert.equal((await run(client)).exitCode, EXIT_CLAIMED);
});

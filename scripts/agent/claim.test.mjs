import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GitHubError, createFixtureClient } from '../lib/github.mjs';
import { parseSections } from '../lib/markdown.mjs';
import { EXIT_CLAIMED, EXIT_ERROR, EXIT_HELD, runClaim } from './claim.mjs';

const REPO = { owner: 'o', repo: 'r' };
const SESSION = 'w85-a1';
const AGENT = 'sonnet/claude-code';
const AGENT_LOGIN = 'wimdotgg-agent[bot]';
const CONFIG = { accounts: { agent: AGENT_LOGIN }, limits: { tasksPerWorker: 1, draftLeaseMinutes: 240 } };
const NOW = new Date('2026-11-20T10:05:30Z');
const templates = {
  claimComment: await readFile(new URL('../../.github/groundwork/templates/claim-comment.md', import.meta.url), 'utf8'),
  pullRequest: await readFile(new URL('../../.github/pull_request_template.md', import.meta.url), 'utf8'),
};
const FOOTER = `---\nAgent: ${AGENT} · session ${SESSION}`;
const comment = (body) => [{ user: { login: AGENT_LOGIN }, body }];
const POINTER = comment('Claimed on `issue/7` by session w85-a1.\n<!-- groundwork:claim -->');
const OTHER_POINTER = comment('Claimed on `issue/7` by session other.\n<!-- groundwork:claim -->');
const PR_CLAIM = comment('Claim: #7, session w85-a1.\n<!-- groundwork:claim -->');
const pullOf = (fields) => ({
  number: 12, draft: true, created_at: '2026-11-20T09:00:00Z', head: { ref: 'issue/7', repo: { full_name: 'o/r' } }, user: { login: AGENT_LOGIN }, body: `body\n\n${FOOTER}\n`, ...fields,
});
const foreignFooter = '---\nAgent: a/b · session other';

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
    [ISSUE_COMMENTS]: ok(POINTER),
  });
  assert.deepEqual(await run(client), { exitCode: EXIT_CLAIMED, pr: 12 });
  assert.deepEqual(writeKeys(calls), [POST_PULL, POST_PR_COMMENT]);
});

test('AC4: a rerun with everything in place, head moved past the claim commit, writes nothing', async () => {
  const { client, calls } = recordingClient({
    ...creationRoutes,
    [REF]: ok({ object: { sha: 'later-sha' } }),
    [ISSUE_PULLS]: ok([pullOf()]),
    [ISSUE_COMMENTS]: ok(POINTER),
    [PR_COMMENTS]: ok(PR_CLAIM),
  });
  assert.deepEqual(await run(client), { exitCode: EXIT_CLAIMED, pr: 12 });
  assert.deepEqual(writeKeys(calls), []);
});

test('a rerun where only the PR claim comment is missing posts just that', async () => {
  const { client, calls } = recordingClient({
    ...creationRoutes,
    [REF]: ok({ object: { sha: 'later-sha' } }),
    [ISSUE_PULLS]: ok([pullOf()]),
    [ISSUE_COMMENTS]: ok(POINTER),
    [PR_COMMENTS]: ok([]),
  });
  assert.deepEqual(await run(client), { exitCode: EXIT_CLAIMED, pr: 12 });
  assert.deepEqual(writeKeys(calls), [POST_PR_COMMENT]);
});

test('a fresh claim posts a new pointer even when an older claim left one', async () => {
  const { client, calls } = recordingClient({ ...creationRoutes, [ISSUE_COMMENTS]: ok(POINTER) });
  await run(client);
  assert.deepEqual(writeKeys(calls), [POST_COMMIT, POST_REF, POST_ISSUE_COMMENT, POST_PULL, POST_PR_COMMENT]);
});

test('a rerun posts the pointer unless it names this session', async () => {
  const rerun = {
    ...creationRoutes,
    [REF]: ok({ object: { sha: 'claim-sha' } }),
    [ISSUE_PULLS]: ok([]),
    'GET /repos/o/r/git/commits/claim-sha': ok({ message: 'chore(claim): #7 [session w85-a1]' }),
  };
  const other = recordingClient({ ...rerun, [ISSUE_COMMENTS]: ok(OTHER_POINTER) });
  await run(other.client);
  assert.equal(writeKeys(other.calls)[0], POST_ISSUE_COMMENT);
});

test('an Epic, an untyped issue, a closed issue or a PR number exits 3 before any write', async () => {
  const targets = [{ type: { name: 'Epic' } }, { type: null }, { type: { name: 'Feature' }, state: 'closed' }, { type: { name: 'Feature' }, pull_request: {} }];
  for (const fields of targets) {
    const issue = { number: 7, title: 'T', ...fields };
    const { client, calls } = recordingClient({ ...creationRoutes, 'GET /repos/o/r/issues/7': ok(issue) });
    assert.equal((await run(client)).exitCode, EXIT_HELD);
    assert.deepEqual(writeKeys(calls), []);
  }
});

test('a PR with this session\'s footer by another author or from another repo is not ours (exit 3)', async () => {
  const spoofs = [pullOf({ user: { login: 'mallory' } }), pullOf({ head: { ref: 'issue/7', repo: { full_name: 'mallory/r' } } })];
  for (const spoof of spoofs) {
    const { client, calls } = recordingClient({
      ...creationRoutes,
      [REF]: ok({ object: { sha: 'other-sha' } }),
      [ISSUE_PULLS]: ok([spoof]),
      'GET /repos/o/r/git/commits/other-sha': ok({ message: 'chore(claim): #7 [session someone-else]' }),
    });
    assert.equal((await run(client)).exitCode, EXIT_HELD);
    assert.deepEqual(writeKeys(calls), []);
  }
});

test('another session\'s footer over a moved head is held (exit 3)', async () => {
  const { client, calls } = recordingClient({
    ...creationRoutes,
    [REF]: ok({ object: { sha: 'later-sha' } }),
    [ISSUE_PULLS]: ok([pullOf({ body: `body\n\n${foreignFooter}\n` })]),
    [PR_COMMENTS]: ok([]),
  });
  assert.equal((await run(client)).exitCode, EXIT_HELD);
  assert.deepEqual(writeKeys(calls), []);
});

test('a transport failure on the ref POST propagates (exit 1), with nothing written after it', async () => {
  const { client, calls } = recordingClient(creationRoutes);
  const failing = {
    ...client,
    request: (method, path, options) => (path.endsWith('/git/refs')
      ? Promise.reject(new GitHubError('network down'))
      : client.request(method, path, options)),
  };
  await assert.rejects(run(failing), GitHubError);
  assert.deepEqual(writeKeys(calls), [POST_COMMIT]);
});

test('a comment template with an unknown placeholder or a missing section refuses before any write', async () => {
  const unknown = { ...templates, claimComment: templates.claimComment.replace('<session>.', '<session> <pr>.') };
  const missing = { ...templates, claimComment: templates.claimComment.replace('## PR claim', '## Renamed') };
  for (const broken of [unknown, missing]) {
    const { client, calls } = recordingClient(creationRoutes);
    await assert.rejects(runClaim({ client, repo: REPO, config: CONFIG, number: 7, session: SESSION, agent: AGENT, templates: broken, now: NOW }), GitHubError);
    assert.deepEqual(writeKeys(calls), []);
  }
});

test('an issue title with a closing reference becomes a fixed PR summary', async () => {
  const issue = { number: 7, title: 'Fix #45 and resolves wimdotgg/groundwork#3', type: { name: 'Bug' } };
  const { client, calls } = recordingClient({ ...creationRoutes, 'GET /repos/o/r/issues/7': ok(issue) });
  await run(client);
  assert.equal(bodyOf(calls, POST_PULL).title, 'fix: work on #7');
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
  const held = pullOf({ number: 20, head: { ref: 'issue/9', repo: { full_name: 'o/r' } } });
  const { client, calls } = recordingClient({ [OPEN_PULLS]: ok([held]) });
  const outcome = await run(client);
  assert.equal(outcome.exitCode, EXIT_ERROR);
  assert.match(outcome.reason, /already holds draft PR #20/);
  assert.deepEqual(calls, [], 'no request beyond the draft PR listing (paginate)');
});

test('AC5: another session\'s draft PR and this session\'s ready PR do not block the claim', async () => {
  const others = [
    pullOf({ number: 20, head: { ref: 'issue/9', repo: { full_name: 'o/r' } }, body: `x\n\n${foreignFooter}\n` }),
    pullOf({ number: 21, draft: false, head: { ref: 'issue/8', repo: { full_name: 'o/r' } } }),
  ];
  const { client } = recordingClient({ ...creationRoutes, [OPEN_PULLS]: ok(others) });
  assert.equal((await run(client)).exitCode, EXIT_CLAIMED);
});

test('a released draft with this session\'s footer does not block the claim', async () => {
  const released = pullOf({ number: 20, head: { ref: 'issue/9', repo: { full_name: 'o/r' } }, body: `x\n<!-- groundwork:released -->\n\n${FOOTER}\n` });
  const { client } = recordingClient({ ...creationRoutes, [OPEN_PULLS]: ok([released]) });
  assert.equal((await run(client)).exitCode, EXIT_CLAIMED);
});

test('the limit comes from config.limits.tasksPerWorker', async () => {
  const held = pullOf({ number: 20, head: { ref: 'issue/9', repo: { full_name: 'o/r' } } });
  const { client } = recordingClient({ ...creationRoutes, [OPEN_PULLS]: ok([held]) });
  const roomy = { ...CONFIG, limits: { tasksPerWorker: 2 } };
  const outcome = await runClaim({ client, repo: REPO, config: roomy, number: 7, session: SESSION, agent: AGENT, templates, now: NOW });
  assert.equal(outcome.exitCode, EXIT_CLAIMED);
});

const PATCH_REF = 'PATCH /repos/o/r/git/refs/heads/issue/7';
const PATCH_PULL = 'PATCH /repos/o/r/pulls/12';
const OLD_FOOTER = '---\nAgent: a/b · session old-1';
const STALE_PULL = pullOf({ created_at: '2026-11-20T05:00:00Z', body: `body\n\n${OLD_FOOTER}\n` });
const mutationKeys = (calls) => calls.filter((call) => !call.key.startsWith('GET ')).map((call) => call.key);

const takeoverRoutes = {
  [OPEN_PULLS]: ok([]),
  'GET /repos/o/r/issues/7': ok({ number: 7, title: 'Build the thing', type: { name: 'Feature' } }),
  [REF]: ok({ object: { sha: 'head-sha' } }),
  [ISSUE_PULLS]: ok([STALE_PULL]),
  [PR_COMMENTS]: ok([{ user: { login: AGENT_LOGIN }, created_at: '2026-11-20T05:10:00Z', body: 'Claim: #7, session old-1.' }]),
  'GET /repos/o/r/git/commits/head-sha': ok({ tree: { sha: 'head-tree' } }),
  [POST_COMMIT]: ok({ sha: 'takeover-sha' }, 201),
  [PATCH_REF]: ok({}, 200),
  [PATCH_PULL]: ok({}, 200),
  [POST_PR_COMMENT]: ok({}, 201),
};

test('AC1: an expired draft is taken over: commit on the observed head, then the ref update, body and comment', async () => {
  const { client, calls } = recordingClient(takeoverRoutes);
  assert.deepEqual(await run(client), { exitCode: EXIT_CLAIMED, pr: 12, mode: 'takeover' });
  assert.deepEqual(mutationKeys(calls), [POST_COMMIT, PATCH_REF, PATCH_PULL, POST_PR_COMMENT]);
  assert.deepEqual(bodyOf(calls, POST_COMMIT), { message: 'chore(claim): #7 takeover [session w85-a1]', tree: 'head-tree', parents: ['head-sha'] });
  assert.deepEqual(bodyOf(calls, PATCH_REF), { sha: 'takeover-sha', force: false });
});

test('AC1: a draft with the released marker is taken over although its lease is fresh', async () => {
  const released = pullOf({ body: `body\n<!-- groundwork:released -->\n\n${OLD_FOOTER}\n` });
  const { client } = recordingClient({ ...takeoverRoutes, [ISSUE_PULLS]: ok([released]), [PR_COMMENTS]: ok([]) });
  assert.equal((await run(client)).mode, 'takeover');
});

test('AC1: a released PR carrying this session\'s own footer is still taken over', async () => {
  const released = pullOf({ body: `body\n<!-- groundwork:released -->\n\n${FOOTER}\n` });
  const { client } = recordingClient({ ...takeoverRoutes, [ISSUE_PULLS]: ok([released]), [PR_COMMENTS]: ok([]) });
  assert.equal((await run(client)).mode, 'takeover');
});

test('AC1: a non-candidate exits 3 with no write', async () => {
  const freshAgentComment = [{ user: { login: AGENT_LOGIN }, created_at: '2026-11-20T09:30:00Z', body: 'Checkpoint 1' }];
  const outsiderComment = [{ user: { login: 'mallory' }, created_at: '2026-11-20T10:00:00Z', body: 'bump' }];
  const releasedBody = `x\n<!-- groundwork:released -->\n\n${OLD_FOOTER}\n`;
  const cases = {
    'ready PR': { pulls: [{ ...STALE_PULL, draft: false }] },
    'needs-decision label': { pulls: [{ ...STALE_PULL, labels: [{ name: 'needs-decision' }] }] },
    'released but needs-decision': { pulls: [{ ...STALE_PULL, body: releasedBody, labels: [{ name: 'needs-decision' }] }] },
    'fresh lease from a recent agent comment': { pulls: [STALE_PULL], comments: freshAgentComment },
    'no PR on the branch': { pulls: [] },
  };
  for (const [name, { pulls, comments }] of Object.entries(cases)) {
    const { client, calls } = recordingClient({ ...takeoverRoutes, [ISSUE_PULLS]: ok(pulls), ...(comments && { [PR_COMMENTS]: ok(comments) }) });
    assert.equal((await run(client)).exitCode, EXIT_HELD, name);
    assert.deepEqual(mutationKeys(calls), [], name);
  }
  const outsider = recordingClient({ ...takeoverRoutes, [PR_COMMENTS]: ok(outsiderComment) });
  assert.equal((await run(outsider.client)).mode, 'takeover', 'a comment by another author does not renew the lease');
});

test('AC2: a rejected ref update (422, 403 or a non-200 success) exits 3, posts nothing and changes no PR', async () => {
  for (const response of [ok({ message: 'Update is not a fast forward' }, 422), ok({ message: 'forbidden' }, 403), ok({}, 201)]) {
    const { client, calls } = recordingClient({ ...takeoverRoutes, [PATCH_REF]: response });
    assert.equal((await run(client)).exitCode, EXIT_HELD, String(response.status));
    assert.deepEqual(mutationKeys(calls), [POST_COMMIT, PATCH_REF], String(response.status));
  }
});

test('AC2: a transport failure on the ref update propagates (exit 1) with nothing posted', async () => {
  const { client, calls } = recordingClient(takeoverRoutes);
  const failing = {
    ...client,
    request: (method, path, options) => (method === 'PATCH' && path.includes('/git/refs/')
      ? Promise.reject(new GitHubError('network down'))
      : client.request(method, path, options)),
  };
  await assert.rejects(run(failing), GitHubError);
  assert.deepEqual(mutationKeys(calls), [POST_COMMIT]);
});

test('AC3: the winner drops the released marker, owns the footer as the last line and posts the takeover comment', async () => {
  const released = pullOf({ body: `Closes #7\n\n## State\nDone: x\n<!-- groundwork:released -->\n\n${OLD_FOOTER}\n` });
  const { client, calls } = recordingClient({ ...takeoverRoutes, [ISSUE_PULLS]: ok([released]), [PR_COMMENTS]: ok([]) });
  await run(client);
  const { body } = bodyOf(calls, PATCH_PULL);
  assert.equal(body.includes('groundwork:released'), false);
  assert.equal(body, `Closes #7\n\n## State\nDone: x\n\n---\nAgent: ${AGENT} · session ${SESSION}\n`);
  assert.equal(bodyOf(calls, POST_PR_COMMENT).body, 'Takeover: #7, session w85-a1, previous session old-1.\n<!-- groundwork:takeover -->');
});

test('AC3: a body without a footer gets one appended, and an unreadable previous session reads as unknown', async () => {
  const bare = pullOf({ created_at: '2026-11-20T05:00:00Z', body: 'Closes #7' });
  const { client, calls } = recordingClient({ ...takeoverRoutes, [ISSUE_PULLS]: ok([bare]), [PR_COMMENTS]: ok([]) });
  await run(client);
  assert.equal(bodyOf(calls, PATCH_PULL).body, `Closes #7\n\n${FOOTER}\n`);
  assert.match(bodyOf(calls, POST_PR_COMMENT).body, /previous session unknown\./);
});

test('AC4: no request in the takeover path sends force true, and the ref update sends force false', async () => {
  const { client, calls } = recordingClient(takeoverRoutes);
  await run(client);
  for (const call of calls) assert.equal(JSON.stringify(call.body ?? {}).includes('"force":true'), false, call.key);
  assert.equal(calls.filter((call) => call.body && 'force' in call.body).length, 1);
  assert.equal(bodyOf(calls, PATCH_REF).force, false);
});

test('a takeover comment template without its section refuses before the lock is taken', async () => {
  const broken = { ...templates, claimComment: templates.claimComment.replace('## PR takeover', '## Renamed') };
  const { client, calls } = recordingClient(takeoverRoutes);
  await assert.rejects(runClaim({ client, repo: REPO, config: CONFIG, number: 7, session: SESSION, agent: AGENT, templates: broken, now: NOW }), GitHubError);
  assert.deepEqual(mutationKeys(calls), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureClient } from '../lib/github.mjs';
import { formatOutput, isMinorOrPatchBump, parseCliArguments, reviewQueue } from './review-queue.mjs';

const REPO = '/repos/acme/app';
const REPO_REF = { owner: 'acme', repo: 'app' };
const config = { accounts: { owner: 'owner1', agent: 'agent-bot[bot]' } };
const found = (data) => ({ status: 200, data, headers: {} });
const footer = (session) => `Closes #1\n\n---\nAgent: a/b · session ${session}`;
const agentPull = (number, session, overrides = {}) => ({
  number, title: `feat: change ${number}`, draft: false, user: { login: 'agent-bot[bot]' }, body: footer(session), head: { sha: `sha${number}` }, ...overrides,
});
const dependabotPull = (number, title, overrides = {}) => ({
  number, title, draft: false, user: { login: 'dependabot[bot]' }, body: '', head: { sha: `sha${number}` }, auto_merge: null, ...overrides,
});
const review = (body, overrides = {}) => ({ state: 'COMMENTED', user: { login: 'agent-bot[bot]' }, commit_id: 'sha7', body, ...overrides });
const reviewsRoute = (number, reviews) => ({ [`GET ${REPO}/pulls/${number}/reviews?per_page=100`]: found(reviews) });
const checksRoute = (number, runs) => ({ [`GET ${REPO}/commits/sha${number}/check-runs?per_page=100`]: found({ check_runs: runs }) });
const passing = { id: 1, name: 'Check', status: 'completed', conclusion: 'success' };

const run = (pulls, routes = {}) => reviewQueue(
  createFixtureClient({ [`GET ${REPO}/pulls?per_page=100&state=open`]: found(pulls), ...routes }), REPO_REF, { config },
);

test('AC1: a ready PR reviewed only by its own session is listed', async () => {
  const { review: listed } = await run([agentPull(7, 's1')], reviewsRoute(7, [review('looks fine\n\nReviewer: a/b · session s1')]));
  assert.deepEqual(listed, [{ number: 7, title: 'feat: change 7', session: 's1' }]);
});

test('AC1: a ready PR with no review is listed', async () => {
  const { review: listed } = await run([agentPull(7, 's1')], reviewsRoute(7, []));
  assert.deepEqual(listed.map((entry) => entry.number), [7]);
});

test('AC1: a ready PR reviewed by another session is not listed', async () => {
  const { review: listed } = await run([agentPull(7, 's1')], reviewsRoute(7, [review('ok\n\nReviewer: c/d · session s2\n')]));
  assert.deepEqual(listed, []);
});

test('AC1: a review without the closing Reviewer line, from another login, pending or dismissed does not count', async () => {
  const reviews = [
    review('Reviewer: c/d · session s2 and more words'),
    review('intro\nReviewer: c/d · session s2\ntrailing prose'),
    review('Reviewer: c/d · session s2', { user: { login: 'intruder' } }),
    review('Reviewer: c/d · session s2', { state: 'PENDING' }),
    review('Reviewer: c/d · session s2', { state: 'DISMISSED' }),
  ];
  const { review: listed } = await run([agentPull(7, 's1')], reviewsRoute(7, reviews));
  assert.deepEqual(listed.map((entry) => entry.number), [7]);
});

test('AC1: the Reviewer line on the first line counts, as in the live reviews on PRs #124 and #129', async () => {
  const live = review('Reviewer: fable/claude-code · session r124-20261121\n\nReviewed df0f080. Suite 1021 pass.');
  const { review: listed } = await run([agentPull(7, 's1')], reviewsRoute(7, [live]));
  assert.deepEqual(listed, []);
});

test('AC1: a push after the review puts the PR back in the queue', async () => {
  const stale = review('Reviewer: c/d · session s2', { commit_id: 'sha-before-push' });
  const { review: listed } = await run([agentPull(7, 's1')], reviewsRoute(7, [stale]));
  assert.deepEqual(listed.map((entry) => entry.number), [7]);
});

test('AC1: a PR without a footer counts any Reviewer session as another session', async () => {
  const pulls = [agentPull(7, 's1', { body: 'no footer' }), agentPull(8, 's1', { body: 'no footer' })];
  const routes = { ...reviewsRoute(7, [review('Reviewer: c/d · session s2')]), ...reviewsRoute(8, []) };
  const { review: listed } = await run(pulls, routes);
  assert.deepEqual(listed.map((entry) => entry.number), [8]);
});

test('AC2: draft PRs are in neither list', async () => {
  const pulls = [agentPull(7, 's1', { draft: true }), dependabotPull(8, 'build(deps): bump x from 1.0.0 to 1.0.1', { draft: true })];
  assert.deepEqual(await run(pulls), { review: [], dependabot: [] });
});

test('AC3: Dependabot minor and patch PRs with green checks are listed apart from the review list', async () => {
  const pulls = [dependabotPull(9, 'build(deps): bump x from 1.2.3 to 1.3.0'), dependabotPull(10, 'build(deps): bump the minor-and-patch group with 3 updates')];
  const routes = { ...checksRoute(9, [passing]), ...checksRoute(10, [passing]) };
  const result = await run(pulls, routes);
  assert.deepEqual(result.review, []);
  assert.deepEqual(result.dependabot.map((entry) => entry.number), [9, 10]);
});

test('AC3: a major bump is not listed', async () => {
  const { dependabot } = await run([dependabotPull(9, 'build(deps): bump x from 1.9.0 to 2.0.0')], checksRoute(9, [passing]));
  assert.deepEqual(dependabot, []);
});

test('AC3: failing, pending, missing or superseded check runs keep a Dependabot PR out', async () => {
  const pulls = [1, 2, 3, 4].map((number) => dependabotPull(number, 'build(deps): bump x from 1.0.0 to 1.0.1'));
  const routes = {
    ...checksRoute(1, [{ ...passing, conclusion: 'failure' }]),
    ...checksRoute(2, [{ ...passing, status: 'in_progress', conclusion: null }]),
    ...checksRoute(3, []),
    ...checksRoute(4, [{ ...passing, id: 1, conclusion: 'success' }, { ...passing, id: 2, conclusion: 'failure' }]),
  };
  assert.deepEqual((await run(pulls, routes)).dependabot, []);
});

test('AC3: a rerun that passes replaces an older failure', async () => {
  const runs = [{ ...passing, id: 1, conclusion: 'failure' }, { ...passing, id: 2 }];
  const { dependabot } = await run([dependabotPull(9, 'build(deps): bump x from 1.0.0 to 1.0.1')], checksRoute(9, runs));
  assert.deepEqual(dependabot.map((entry) => entry.number), [9]);
});

test('AC3: a Dependabot PR already queued for auto-merge is not listed', async () => {
  const pull = dependabotPull(9, 'build(deps): bump x from 1.0.0 to 1.0.1', { auto_merge: { merge_method: 'squash' } });
  assert.deepEqual((await run([pull])).dependabot, []);
});

test('isMinorOrPatchBump reads version bumps and group titles', () => {
  assert.equal(isMinorOrPatchBump('bump actions/checkout from v4.1.0 to v4.2.2'), true);
  assert.equal(isMinorOrPatchBump('bump actions/checkout from 3 to 4'), false);
  assert.equal(isMinorOrPatchBump('bump the minor-and-patch group across 1 directory with 2 updates'), true);
  assert.equal(isMinorOrPatchBump('bump the major group with 2 updates'), false);
  assert.equal(isMinorOrPatchBump('bump actions/checkout from 3d3c42e to 3fa1b0c'), false);
  assert.equal(isMinorOrPatchBump('bump actions/checkout from 3d3c42e1f0a9 to 3fa1b0c7d2e4'), false);
  assert.equal(isMinorOrPatchBump('update something'), false);
});

test('formatOutput: text lines, JSON and the empty case', () => {
  const queue = { review: [{ number: 7, title: 'feat: x', session: 's1' }], dependabot: [{ number: 9, title: 'bump y' }] };
  assert.equal(formatOutput(queue, { json: false }), 'review #7: feat: x [session s1]\nenqueue #9: bump y');
  assert.deepEqual(JSON.parse(formatOutput(queue, { json: true })), { ok: true, ...queue });
  assert.equal(formatOutput({ review: [], dependabot: [] }, { json: false }), 'nothing to review');
});

test('parseCliArguments accepts --json and rejects anything else', () => {
  assert.deepEqual(parseCliArguments(['--json']), { json: true });
  assert.deepEqual(parseCliArguments([]), { json: false });
  assert.throws(() => parseCliArguments(['7']), /usage/);
  assert.throws(() => parseCliArguments(['--bogus']));
});

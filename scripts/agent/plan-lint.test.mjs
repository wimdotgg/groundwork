import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFixtureClient } from '../lib/github.mjs';
import { hasMarker } from '../lib/markdown.mjs';
import {
  PlanLintError, laneWidth, lintPlan, loadPlan, parseArguments, planLint, renderReport, upsertReport,
} from './plan-lint.mjs';

const REPO = { owner: 'o', repo: 'r' };
const AGENT = 'o-agent[bot]';
const EPIC = 500;
const LIMITS = { hierarchyDepth: 2, hierarchyDepthWithIntermediate: 3, subIssuesPerParent: 12 };
const config = { accounts: { agent: AGENT }, limits: LIMITS };
const template = await readFile(new URL('../../.github/groundwork/templates/plan-comment.md', import.meta.url), 'utf8');
const ok = (data) => ({ status: 200, data, headers: {} });
const created = { status: 201, data: {}, headers: {} };

function body({ ac = '- [ ] AC1 works', serves = 'E1', touches = '`src/a.mjs`' } = {}) {
  return `## Outcome\nx\n\n## Serves\n${serves}\n\n## Scope\nx\n\n## Touches\n${touches}\n\n## Acceptance criteria\n${ac}\n\n## Verification plan\nx\n\n## Risk\nlow\n\n## Context\nx\n`;
}

/** A leaf task under the epic, with its own distinct touched path unless `bodyOptions` says otherwise. */
function task(number, { blockedBy = [], state = 'open', type = 'Feature', parent = EPIC, level = 2, ...bodyOptions } = {}) {
  const touches = bodyOptions.touches ?? `\`src/file-${number}.mjs\``;
  return { number, title: `task ${number}`, type, state, body: body({ ...bodyOptions, touches }), parent, level, blockedBy };
}

const codes = (failures) => failures.map((failure) => failure.code);
const lint = (nodes, hotspots = []) => lintPlan(nodes, { limits: LIMITS, hotspots });

/** Contract 1, lanes 2 and 3, integration 4: a plan that passes every rule. */
const healthyPlan = () => [
  task(1), task(2, { blockedBy: [1] }), task(3, { blockedBy: [1] }), task(4, { blockedBy: [2, 3] }),
];

test('a healthy plan has no failures', () => {
  assert.deepEqual(lint(healthyPlan()), []);
});

test('cycle: fails on a blocked-by loop, passes on the same tasks without it', () => {
  const looped = [task(1, { blockedBy: [2] }), task(2, { blockedBy: [1] })];
  const failures = lint(looped).filter((failure) => failure.code === 'cycle');
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /#1 blocked by #2 blocked by #1/);
  assert.equal(codes(lint([task(1), task(2, { blockedBy: [1] })])).includes('cycle'), false);
});

test('missing-ac: fails without an AC id, passes with one, and a Spike is exempt', () => {
  const failures = lint([task(1, { ac: 'works' }), task(2, { blockedBy: [1] })]);
  assert.deepEqual(failures.map((failure) => [failure.code, failure.task]), [['missing-ac', 1]]);
  assert.deepEqual(lint([task(1, { type: 'Spike', ac: '' }), task(2, { blockedBy: [1] })]), []);
});

test('missing-serves: fails on an empty or non-epic Serves, passes with E<n>', () => {
  const failures = lint([task(1, { serves: '_No response_' }), task(2, { blockedBy: [1], serves: 'later' })]);
  assert.deepEqual(failures.map((failure) => [failure.code, failure.task]), [['missing-serves', 1], ['missing-serves', 2]]);
  assert.deepEqual(lint([task(1, { serves: 'E1, E2' }), task(2, { blockedBy: [1] })]), []);
});

test('no-integration-task: fails when no task waits on all the others, passes when one does', () => {
  const parallel = [task(1), task(2)];
  assert.deepEqual(codes(lint(parallel)), ['no-integration-task']);
  assert.deepEqual(lint([task(1), task(2, { blockedBy: [1] })]), []);
});

test('no-integration-task: a transitive chain counts, an epic with no sub-issues fails', () => {
  assert.deepEqual(lint([task(1), task(2, { blockedBy: [1] }), task(3, { blockedBy: [2] })]), []);
  const [failure] = lint([]);
  assert.equal(failure.code, 'no-integration-task');
});

test('too-many-sub-issues: 13 under one parent fails, 12 passes', () => {
  const chain = (count) => Array.from({ length: count }, (_, index) => task(index + 1, { blockedBy: index === 0 ? [] : [index] }));
  assert.deepEqual(lint(chain(12)), []);
  const failures = lint(chain(13));
  assert.deepEqual(failures.map((failure) => failure.code), ['too-many-sub-issues']);
  assert.equal(failures[0].task, EPIC);
});

test('depth: level 3 fails up to 12 tasks, passes past 12, and level 4 always fails', () => {
  const group = task(1, { type: 'Feature' });
  const nested = (count, level) => [
    group,
    ...Array.from({ length: count }, (_, index) => task(index + 2, { parent: 1, level, blockedBy: index === 0 ? [] : [index + 1] })),
  ];
  const failures = lint(nested(2, 3));
  assert.equal(failures.filter((failure) => failure.code === 'depth').length, 2);
  assert.deepEqual(lint(nested(13, 3)).filter((failure) => failure.code === 'depth'), []);
  assert.equal(lint(nested(13, 4)).filter((failure) => failure.code === 'depth').length, 13);
});

test('touches-overlap: unlinked tasks on one path fail, a blocked-by link passes', () => {
  const unlinked = [task(1, { touches: '`src/a.mjs`' }), task(2, { touches: '`src/a.mjs`' }), task(3, { blockedBy: [1, 2] })];
  const failures = lint(unlinked);
  assert.deepEqual(failures.map((failure) => failure.code), ['touches-overlap']);
  assert.match(failures[0].message, /#1 and #2 both touch src\/a\.mjs/);
  const linked = [task(1, { touches: '`src/a.mjs`' }), task(2, { touches: '`src/a.mjs`', blockedBy: [1] }), task(3, { blockedBy: [2] })];
  assert.deepEqual(lint(linked), []);
});

test('touches-overlap: a directory prefix overlaps, a sibling path and a closed task do not', () => {
  const tasks = (second, state = 'open') => [
    task(1, { touches: '`scripts/agent/`' }), task(2, { touches: second, state }), task(3, { blockedBy: [1, 2] }),
  ];
  assert.deepEqual(codes(lint(tasks('`scripts/agent/next.mjs`'))), ['touches-overlap']);
  assert.deepEqual(lint(tasks('`scripts/agents/next.mjs`')), []);
  assert.deepEqual(lint(tasks('`scripts/agent/next.mjs`', 'closed')), []);
});

test('touches-overlap: a link through a third task counts, plain-text Touches are read', () => {
  const viaThird = [
    task(1, { touches: '`a`' }), task(2, { touches: '`b`', blockedBy: [1] }), task(3, { touches: '`a`', blockedBy: [2] }),
  ];
  assert.deepEqual(lint(viaThird), []);
  const plain = [task(1, { touches: 'docs, scripts' }), task(2, { touches: '- scripts' }), task(3, { blockedBy: [1, 2] })];
  assert.deepEqual(codes(lint(plain)), ['touches-overlap']);
});

test('touches-overlap: a hotspot name stands for its paths', () => {
  const hotspots = [{ name: 'spec', paths: ['docs/spec.md'] }];
  const tasks = [task(1, { touches: '`spec`' }), task(2, { touches: '`docs/spec.md`' }), task(3, { blockedBy: [1, 2] })];
  assert.deepEqual(codes(lint(tasks, hotspots)), ['touches-overlap']);
  assert.deepEqual(lint(tasks), []);
});

test('lane width: the healthy plan has three lanes and width 2', () => {
  const { lanes, width } = laneWidth(healthyPlan());
  assert.deepEqual(lanes.map((lane) => lane.map((entry) => entry.number)), [[1], [2, 3], [4]]);
  assert.equal(width, 2);
});

test('lane width: closed tasks do not count, a cycle gives null', () => {
  const plan = [task(1), task(2, { blockedBy: [1], state: 'closed' }), task(3, { blockedBy: [1] }), task(4, { blockedBy: [2, 3] })];
  assert.equal(laneWidth(plan).width, 1);
  assert.equal(laneWidth([task(1, { blockedBy: [2] }), task(2, { blockedBy: [1] })]), null);
});

test('report: states the lane width, the lanes and each failure', () => {
  const nodes = [task(1), task(2, { ac: '', blockedBy: [1] })];
  const report = renderReport({ epic: EPIC, nodes, failures: lint(nodes) }, template);
  assert.match(report, /^Plan lint #500: fail \(\d\)\nLane width: 1\n/);
  assert.match(report, /- Lane 1: #1 task 1/);
  assert.match(report, /- missing-ac: #2/);
  assert.ok(hasMarker(report, 'plan-lint'));
  assert.doesNotMatch(report, /<(epic|result|width|lanes|failures)>/);
});

test('report: a passing plan says pass, a cycle says the width is unknown', () => {
  const pass = renderReport({ epic: EPIC, nodes: healthyPlan(), failures: [] }, template);
  assert.match(pass, /^Plan lint #500: pass\nLane width: 2\n/);
  assert.match(pass, /## Failures\nnone\n/);
  const looped = [task(1, { blockedBy: [2] }), task(2, { blockedBy: [1] })];
  assert.match(renderReport({ epic: EPIC, nodes: looped, failures: lint(looped) }, template), /Lane width: unknown \(dependency cycle\)/);
});

test('report: an unknown template placeholder throws', () => {
  assert.throws(() => renderReport({ epic: EPIC, nodes: [], failures: [] }, `${template}<other>`), PlanLintError);
});

const COMMENTS = 'GET /repos/o/r/issues/500/comments?per_page=100';
const POST_COMMENT = 'POST /repos/o/r/issues/500/comments';
const PATCH_COMMENT = 'PATCH /repos/o/r/issues/comments/55';

/** Fixture client that also keeps every write. */
function recordingClient(routes) {
  const writes = [];
  const client = createFixtureClient(routes);
  const { request } = client;
  client.request = async (method, path, options) => {
    if (method !== 'GET') writes.push({ method, path, body: options?.body?.body });
    return request(method, path, options);
  };
  return { client, writes };
}

const upsert = (client, text) => upsertReport({ client, repo: REPO, config }, { epic: EPIC, body: text });
const marked = (text, login = AGENT, id = 55) => ({ id, user: { login }, body: `${text}\n<!-- groundwork:plan-lint -->\n` });

test('post: creates one marked comment when none exists', async () => {
  const { client, writes } = recordingClient({ [COMMENTS]: ok([]), [POST_COMMENT]: created });
  assert.equal(await upsert(client, 'report\n<!-- groundwork:plan-lint -->\n'), 'created');
  assert.deepEqual(writes.map((write) => write.method), ['POST']);
  assert.ok(hasMarker(writes[0].body, 'plan-lint'));
});

test('post: a rerun with a new report updates the same comment', async () => {
  const { client, writes } = recordingClient({ [COMMENTS]: ok([marked('old')]), [PATCH_COMMENT]: ok({}) });
  assert.equal(await upsert(client, 'new\n<!-- groundwork:plan-lint -->\n'), 'updated');
  assert.deepEqual(writes.map((write) => [write.method, write.path]), [['PATCH', '/repos/o/r/issues/comments/55']]);
});

test('post: an identical report writes nothing', async () => {
  const { client, writes } = recordingClient({ [COMMENTS]: ok([marked('same')]) });
  assert.equal(await upsert(client, 'same\n<!-- groundwork:plan-lint -->\n'), 'unchanged');
  assert.deepEqual(writes, []);
});

test('post: a marker from another author is ignored, so a new comment is created', async () => {
  const { client, writes } = recordingClient({ [COMMENTS]: ok([marked('forged', 'someone')]), [POST_COMMENT]: created });
  assert.equal(await upsert(client, 'report\n<!-- groundwork:plan-lint -->\n'), 'created');
  assert.deepEqual(writes.map((write) => write.method), ['POST']);
});

const issueRoute = (number) => `GET /repos/o/r/issues/${number}`;
const subIssuesRoute = (number) => `GET /repos/o/r/issues/${number}/sub_issues?per_page=100`;
const blockedByRoute = (number) => `GET /repos/o/r/issues/${number}/dependencies/blocked_by?per_page=100`;
const issueFor = (node, extra = {}) => ({
  number: node.number, title: node.title, type: { name: node.type }, state: node.state, body: node.body, ...extra,
});

/** Routes for an epic whose direct sub-issues are `nodes`; blockers come from each node. */
function planRoutes(nodes, epicType = 'Epic') {
  const routes = { [issueRoute(EPIC)]: ok({ number: EPIC, type: { name: epicType } }), [subIssuesRoute(EPIC)]: ok(nodes.map((node) => issueFor(node))) };
  for (const node of nodes) routes[blockedByRoute(node.number)] = ok(node.blockedBy.map((number) => ({ number })));
  return routes;
}

test('loadPlan: reads sub-issues, blockers and nested groups', async () => {
  const group = task(1);
  const child = task(2, { parent: 1, level: 3 });
  const routes = {
    ...planRoutes([group]),
    [subIssuesRoute(EPIC)]: ok([issueFor(group, { sub_issues_summary: { total: 1 } })]),
    [subIssuesRoute(1)]: ok([issueFor(child)]),
    [blockedByRoute(2)]: ok([{ number: 9 }]),
  };
  const nodes = await loadPlan(createFixtureClient(routes), REPO, EPIC);
  assert.deepEqual(nodes.map((node) => [node.number, node.parent, node.level, node.blockedBy]), [[1, EPIC, 2, []], [2, 1, 3, [9]]]);
});

test('loadPlan: refuses an issue that is not an epic', async () => {
  await assert.rejects(loadPlan(createFixtureClient(planRoutes([], 'Feature')), REPO, EPIC), /#500 is not an epic/);
});

test('planLint: lints the loaded plan and posts only with post set', async () => {
  const nodes = healthyPlan();
  const { client, writes } = recordingClient({ ...planRoutes(nodes), [COMMENTS]: ok([]), [POST_COMMENT]: created });
  const context = { client, repo: REPO, config, hotspots: [], template };
  const dry = await planLint(context, { epic: EPIC, post: false });
  assert.deepEqual([dry.failures, dry.tasks, dry.width, dry.posted, writes.length], [[], 4, 2, null, 0]);
  const posted = await planLint(context, { epic: EPIC, post: true });
  assert.equal(posted.posted, 'created');
  assert.equal(writes.length, 1);
});

test('planLint: reports failures from the loaded plan', async () => {
  const nodes = [task(1), task(2)];
  const context = { client: createFixtureClient(planRoutes(nodes)), repo: REPO, config, hotspots: [], template };
  const result = await planLint(context, { epic: EPIC, post: false });
  assert.deepEqual(codes(result.failures), ['no-integration-task']);
});

test('arguments: epic number, --post and --json; anything else is refused with usage', () => {
  assert.deepEqual(parseArguments(['75', '--post', '--json']), { epic: 75, post: true, json: true });
  assert.deepEqual(parseArguments(['75']), { epic: 75, post: false, json: false });
  for (const argv of [[], ['x'], ['0'], ['1', '2'], ['75', '--close'], ['75', '--bogus']]) {
    assert.throws(() => parseArguments(argv), (error) => error instanceof PlanLintError && /usage: plan-lint\.mjs/.test(error.message), argv.join(' '));
  }
});

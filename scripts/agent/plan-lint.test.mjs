import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFixtureClient } from '../lib/github.mjs';
import { hasMarker } from '../lib/markdown.mjs';
import {
  PlanLintError, analyzePlan, lintPlan, loadPlan, main, parseArguments, planLint, renderReport, upsertReport,
} from './plan-lint.mjs';

const REPO = { owner: 'o', repo: 'r' };
const AGENT = 'o-agent[bot]';
const EPIC = 500;
const LIMITS = { hierarchyDepth: 2, hierarchyDepthWithIntermediate: 3, subIssuesPerParent: 12 };
const OWNER = 'o-owner';
const config = {
  accounts: { owner: OWNER, agent: AGENT },
  trustedAuthors: [{ actor: 'owner', scope: 'any' }],
  limits: LIMITS,
};
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
const EPIC_CRITERIA = ['E1', 'E2'];
const lint = (nodes, hotspots = []) => lintPlan(analyzePlan(nodes), { limits: LIMITS, hotspots, epicCriteria: EPIC_CRITERIA });

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


test('touches-overlap: a link through a third task counts', () => {
  const viaThird = [
    task(1, { touches: '`a.mjs`' }), task(2, { touches: '`b.mjs`', blockedBy: [1] }), task(3, { touches: '`a.mjs`', blockedBy: [2] }),
  ];
  assert.deepEqual(lint(viaThird), []);
});

test('touches-overlap: empty markers and words that are no path never overlap', () => {
  const pair = (touches) => [task(1, { touches }), task(2, { touches }), task(3, { blockedBy: [1, 2] })];
  assert.deepEqual(lint(pair('none')), []);
  assert.deepEqual(lint(pair('_No response_')), []);
  assert.deepEqual(lint(pair('n/a')), []);
  const shared = [task(1, { touches: '`a.mjs` (`protected`)' }), task(2, { touches: '`b.mjs` (`protected`)' }), task(3, { blockedBy: [1, 2] })];
  assert.deepEqual(lint(shared), []);
});

test('touches-overlap: paths are read from the whole section, backticked or not', () => {
  const mixed = [task(1, { touches: '`a.mjs` and docs/spec.md' }), task(2, { touches: 'docs/spec.md' }), task(3, { blockedBy: [1, 2] })];
  assert.deepEqual(codes(lint(mixed)), ['touches-overlap']);
  const prose = [task(1, { touches: 'scripts/agent/next.mjs (hotspot)' }), task(2, { touches: '`scripts/agent/next.mjs:166`' }), task(3, { blockedBy: [1, 2] })];
  assert.deepEqual(codes(lint(prose)), ['touches-overlap']);
});

test('touches-overlap: hotspots follow next.mjs, by name or path in the text, or a path under a hotspot path', () => {
  const hotspots = [{ name: 'spec', paths: ['docs/spec.md'] }, { name: 'lib', paths: ['scripts/lib'] }];
  const withThird = (first, second) => [task(1, { touches: first }), task(2, { touches: second }), task(3, { blockedBy: [1, 2] })];
  const byName = lint(withThird('the spec hotspot', '`docs/spec.md`'), hotspots);
  assert.match(byName[0].message, /both touch hotspot spec/);
  const underPath = lint(withThird('`scripts/lib/a.mjs`', '`scripts/lib/b.mjs`'), hotspots);
  assert.match(underPath[0].message, /both touch hotspot lib/);
  assert.deepEqual(lint(withThird('`scripts/lib/a.mjs`', '`scripts/lib/b.mjs`')), []);
});

test('lane width: the healthy plan has three lanes and width 2', () => {
  const { lanes, width } = analyzePlan(healthyPlan()).lanes;
  assert.deepEqual(lanes.map((lane) => lane.map((entry) => entry.number)), [[1], [2, 3], [4]]);
  assert.equal(width, 2);
});

test('lane width: a closed blocker is satisfied, so its dependants start in lane 1', () => {
  const plan = [task(1, { state: 'closed' }), task(2, { blockedBy: [1] }), task(3, { blockedBy: [1] }), task(4, { blockedBy: [2, 3] })];
  const { lanes, width } = analyzePlan(plan).lanes;
  assert.deepEqual(lanes.map((lane) => lane.map((entry) => entry.number)), [[2, 3], [4]]);
  assert.equal(width, 2);
});

test('lane width: a cycle gives no lanes', () => {
  assert.equal(analyzePlan([task(1, { blockedBy: [2] }), task(2, { blockedBy: [1] })]).lanes, null);
});

test('blocked-by links: a link on a grouping parent, or to one, fails; a cross-repo blocker is not a local task', () => {
  const group = task(1);
  const child = task(2, { parent: 1, level: 3 });
  const nodes = (groupBlockers, taskBlockers) => [
    { ...group, blockedBy: groupBlockers }, child, task(3, { blockedBy: taskBlockers }),
  ];
  const onGroup = lint(nodes([3], [2]), []).filter((failure) => failure.code === 'link-on-group');
  assert.deepEqual(onGroup.map((failure) => failure.task), [1]);
  const toGroup = lint(nodes([], [1, 2])).filter((failure) => failure.code === 'link-on-group');
  assert.deepEqual(toGroup.map((failure) => failure.task), [3]);
  assert.match(toGroup[0].message, /links must sit on leaf tasks/);
  assert.deepEqual(codes(lint(nodes([], [2]))).filter((code) => code === 'link-on-group'), []);
  const foreign = [task(1), task(2, { blockedBy: ['https://api.github.com/repos/x/y#1', 1] })];
  assert.deepEqual(codes(lint(foreign)), []);
});

test('report: states the lane width, the lanes and each failure', () => {
  const nodes = [task(1), task(2, { ac: '', blockedBy: [1] })];
  const report = renderReport({ epic: EPIC, plan: analyzePlan(nodes), failures: lint(nodes) }, template);
  assert.match(report, /^Plan lint #500: fail \(1\)\nLane width: 1 \(most open tasks in one lane; lane 1 can start now\)\n/);
  assert.match(report, /- Lane 1: #1 task 1/);
  assert.match(report, /- missing-ac: #2/);
  assert.ok(hasMarker(report, 'plan-lint'));
  assert.doesNotMatch(report, /<(epic|result|width|lanes|failures)>/);
});

test('report: a passing plan says pass, a cycle says the width is unknown', () => {
  const pass = renderReport({ epic: EPIC, plan: analyzePlan(healthyPlan()), failures: [] }, template);
  assert.match(pass, /^Plan lint #500: pass\nLane width: 2 /);
  assert.match(pass, /## Failures\nnone\n/);
  const looped = analyzePlan([task(1, { blockedBy: [2] }), task(2, { blockedBy: [1] })]);
  assert.match(renderReport({ epic: EPIC, plan: looped, failures: [] }, template), /Lane width: unknown \(dependency cycle\)/);
});

test('report: an unknown template placeholder throws', () => {
  assert.throws(() => renderReport({ epic: EPIC, plan: analyzePlan([]), failures: [] }, `${template}<other>`), PlanLintError);
});

test('report: a task title appears only for a trusted author', () => {
  const trusted = task(1);
  const outsider = { ...task(2, { blockedBy: [1] }), title: '' };
  const report = renderReport({ epic: EPIC, plan: analyzePlan([trusted, outsider]), failures: [] }, template);
  assert.match(report, /- Lane 1: #1 task 1\n/);
  assert.match(report, /- Lane 2: #2\n/);
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
const EPIC_BODY = '## Success criteria\n- [ ] E1 first\n- [ ] E2 second\n';
const issueFor = (node, extra = {}) => ({
  number: node.number, title: node.title, type: { name: node.type }, state: node.state, body: node.body, user: { login: OWNER }, ...extra,
});

/** Routes for an epic whose direct sub-issues are `nodes`; blockers come from each node. */
function planRoutes(nodes, epicType = 'Epic') {
  const epic = { number: EPIC, type: { name: epicType }, body: EPIC_BODY };
  const routes = { [issueRoute(EPIC)]: ok(epic), [subIssuesRoute(EPIC)]: ok(nodes.map((node) => issueFor(node))) };
  for (const node of nodes) routes[blockedByRoute(node.number)] = ok(node.blockedBy.map((number) => ({ number })));
  return routes;
}

const loadContext = (routes) => ({ client: createFixtureClient(routes), repo: REPO, config });

test('loadPlan: reads sub-issues, blockers, nested groups and the epic criteria', async () => {
  const group = task(1);
  const child = task(2, { parent: 1, level: 3 });
  const routes = {
    ...planRoutes([group]),
    [subIssuesRoute(EPIC)]: ok([issueFor(group, { sub_issues_summary: { total: 1 } })]),
    [subIssuesRoute(1)]: ok([issueFor(child)]),
    [blockedByRoute(2)]: ok([{ number: 9 }, { number: 4, repository_url: 'https://api.github.com/repos/x/y' }]),
  };
  const { nodes, epicCriteria } = await loadPlan(loadContext(routes), EPIC);
  assert.deepEqual(nodes.map((node) => [node.number, node.parent, node.level, node.blockedBy]), [
    [1, EPIC, 2, []], [2, 1, 3, [9, 'https://api.github.com/repos/x/y#4']],
  ]);
  assert.deepEqual(epicCriteria, ['E1', 'E2']);
});

test('loadPlan: refuses an issue that is not an epic', async () => {
  await assert.rejects(loadPlan(loadContext(planRoutes([], 'Feature')), EPIC), /#500 is not an epic/);
});

test('loadPlan: skips the blocked_by request when the summary says zero, and blanks an untrusted title', async () => {
  const first = task(1);
  const routes = {
    ...planRoutes([first]),
    [subIssuesRoute(EPIC)]: ok([issueFor(first, { issue_dependencies_summary: { total_blocked_by: 0 }, user: { login: 'stranger' } })]),
  };
  delete routes[blockedByRoute(1)];
  const { nodes } = await loadPlan(loadContext(routes), EPIC);
  assert.deepEqual([nodes[0].blockedBy, nodes[0].title], [[], '']);
});

test('serves: an ID missing from the epic criteria fails, as does text around a valid ID', () => {
  const failures = lint([task(1, { serves: 'E99' }), task(2, { blockedBy: [1], serves: 'later than E1' })]);
  assert.deepEqual(failures.map((failure) => [failure.code, failure.task]), [['missing-serves', 1], ['missing-serves', 2]]);
  assert.match(failures[0].message, /E1, E2/);
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

test('arguments: epic number, --post and --json; anything else is refused with the usage line only', () => {
  assert.deepEqual(parseArguments(['75', '--post', '--json']), { epic: 75, post: true, json: true });
  assert.deepEqual(parseArguments(['75']), { epic: 75, post: false, json: false });
  for (const argv of [[], ['x'], ['0'], ['1', '2'], ['75', '--close'], ['75', '--bogus']]) {
    const refused = (error) => error instanceof PlanLintError && error.message === 'usage: plan-lint.mjs <epic> [--post] [--json]';
    assert.throws(() => parseArguments(argv), refused, argv.join(' '));
  }
});

/** Runs `main` against fixtures and returns the exit code with everything it printed. */
async function runMain(argv, routes) {
  const out = [];
  const err = [];
  const { log, error } = console;
  console.log = (line) => out.push(line);
  console.error = (line) => err.push(line);
  try {
    const exitCode = await main(argv, {}, async () => ({ client: createFixtureClient(routes), repo: REPO, config, hotspots: [], template }));
    return { exitCode, out, err };
  } finally {
    Object.assign(console, { log, error });
  }
}

test('main: a clean plan exits 0 and --json says ok with the lane width', async () => {
  const { exitCode, out, err } = await runMain([String(EPIC), '--json'], planRoutes(healthyPlan()));
  assert.equal(exitCode, 0);
  assert.deepEqual(err, []);
  const payload = JSON.parse(out[0]);
  assert.deepEqual([payload.ok, payload.width, payload.tasks, payload.failures, 'reason' in payload], [true, 2, 4, [], false]);
});

test('main: a lint failure exits 1; --json says not ok, with a reason and the failures', async () => {
  const { exitCode, out, err } = await runMain([String(EPIC), '--json'], planRoutes([task(1), task(2)]));
  assert.equal(exitCode, 1);
  const payload = JSON.parse(out[0]);
  assert.deepEqual([payload.ok, payload.reason, codes(payload.failures)], [false, '1 planning failure', ['no-integration-task']]);
  assert.deepEqual(err, ['1 planning failure']);
});

test('main: an API error exits 1; --json carries ok and reason but no failures', async () => {
  const { exitCode, out, err } = await runMain([String(EPIC), '--json'], {});
  assert.equal(exitCode, 1);
  const payload = JSON.parse(out[0]);
  assert.deepEqual([payload.ok, 'failures' in payload], [false, false]);
  assert.match(payload.reason, /no fixture for GET \/repos\/o\/r\/issues\/500/);
  assert.equal(err.length, 1);
});

test('main: a plain Error prints its first line, and a usage error prints the usage line only', async () => {
  const boom = async () => { throw new Error('config broke\nstack detail'); };
  const stderr = [];
  const { error } = console;
  console.error = (line) => stderr.push(line);
  try {
    assert.equal(await main([String(EPIC)], {}, boom), 1);
    assert.equal(await main([String(EPIC), '--close'], {}, boom), 1);
  } finally {
    console.error = error;
  }
  assert.deepEqual(stderr, ['config broke', 'usage: plan-lint.mjs <epic> [--post] [--json]']);
});

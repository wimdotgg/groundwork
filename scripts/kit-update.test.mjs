import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createFixtureClient } from './lib/github.mjs';
import { repoRoot } from './lib/config.mjs';
import { KIT_PATHS, UNMODIFIED_ONLY_PATHS, isKitPath, main, mergeConfig, rewritePins, run } from './kit-update.mjs';

const execFileAsync = promisify(execFile);
const realConfigText = await readFile(path.join(repoRoot(import.meta.url), '.github/groundwork/config.json'), 'utf8');
const realConfig = JSON.parse(realConfigText);
const CONTROL_API = `/repos/${realConfig.org}/${realConfig.controlRepo}`;
const OLD_TAG = 'v1.0.0';
const NEW_TAG = 'v1.1.0';
const COMMITS = { [OLD_TAG]: 'c'.repeat(40), [NEW_TAG]: 'd'.repeat(40) };
const NO_NETWORK_CLIENT = createFixtureClient({});

function blobSha(text) {
  const content = Buffer.from(text);
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

function reply(status, data = {}) {
  return { status, data, headers: {} };
}

/** @param {Record<string, string | { text: string, mode: string }>} files */
function tagRoutes(tag, files) {
  const entries = Object.entries(files).map(([filePath, file]) => [filePath, typeof file === 'string' ? { text: file, mode: '100644' } : file]);
  const routes = {
    [`GET ${CONTROL_API}/git/ref/tags/${tag}`]: reply(200, { object: { type: 'commit', sha: COMMITS[tag] } }),
    [`GET ${CONTROL_API}/git/trees/${COMMITS[tag]}?recursive=1`]: reply(200, {
      truncated: false,
      tree: entries.map(([filePath, { text, mode }]) => ({ path: filePath, mode, type: 'blob', sha: blobSha(text) })),
    }),
  };
  for (const [, { text }] of entries) {
    routes[`GET ${CONTROL_API}/git/blobs/${blobSha(text)}`] = reply(200, { content: Buffer.from(text).toString('base64') });
  }
  return routes;
}

function releasesClient(oldFiles, newFiles) {
  return createFixtureClient({ ...tagRoutes(OLD_TAG, oldFiles), ...tagRoutes(NEW_TAG, newFiles) });
}

async function createProject(files, { branch = 'issue/5', kitVersion = OLD_TAG } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kit-update-'));
  const all = { '.github/groundwork/config.json': realConfigText, '.github/groundwork/kit-version.txt': `${kitVersion}\n`, ...files };
  for (const [filePath, text] of Object.entries(all)) {
    await mkdir(path.dirname(path.join(root, filePath)), { recursive: true });
    await writeFile(path.join(root, filePath), text);
  }
  const git = async (args) => (await execFileAsync('git', args, { cwd: root })).stdout;
  await git(['init', '-q', '-b', branch]);
  await git(['add', '-A']);
  await git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'project']);
  const remote = `${root}-remote`;
  await execFileAsync('git', ['init', '-q', '--bare', remote]);
  await git(['remote', 'add', 'origin', remote]);
  await git(['push', '-q', 'origin', branch]);
  const project = {
    root,
    remote,
    git,
    published: [],
    failPublishWhen: () => false,
    async publish(args) {
      if (this.failPublishWhen(args)) throw new Error(`${args[1]} failed`);
      this.published.push(args);
      if (args[1] === 'commit') await git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args.slice(1)]);
      return '';
    },
  };
  return project;
}

async function withProject(files, options, body) {
  const project = await createProject(files, options);
  try {
    await body(project);
  } finally {
    await rm(project.root, { recursive: true, force: true });
    await rm(project.remote, { recursive: true, force: true });
  }
}

const readProject = (project, filePath) => readFile(path.join(project.root, filePath), 'utf8');
const execute = (project, client, tag = NEW_TAG) => run({
  root: project.root,
  tag,
  client,
  git: project.git,
  publish: (args) => project.publish(args),
});

const OLD_TREE = {
  'scripts/lib/a.mjs': 'a-old\n',
  'scripts/lib/gone.mjs': 'gone\n',
  'scripts/verify': 'old verify\n',
  'AGENTS.md': 'agents old\n',
  'CLAUDE.md': 'claude old\n',
  '.claude/settings.json': 'settings old\n',
  '.github/groundwork/config.json': realConfigText,
};

function configWith(edit) {
  const copy = structuredClone(realConfig);
  edit(copy);
  return `${JSON.stringify(copy, null, 2)}\n`;
}

const NEW_TREE = {
  'scripts/lib/a.mjs': 'a-new\n',
  'scripts/agent/fresh.mjs': { text: 'fresh\n', mode: '100755' },
  'scripts/verify': 'new verify\n',
  'AGENTS.md': 'agents new\n',
  'CLAUDE.md': 'claude new\n',
  '.claude/settings.json': 'settings new\n',
  '.github/groundwork/config.json': configWith((config) => {
    config.limits.reviewRounds += 10;
    config.limits.ciReruns += 1;
    config.limits.newLimit = 7;
  }),
};

const PROJECT_FILES = {
  'scripts/lib/a.mjs': 'a-old\n',
  'scripts/lib/gone.mjs': 'gone\n',
  'scripts/lib/project-only.mjs': 'mine\n',
  'scripts/verify': 'project verify\n',
  'AGENTS.md': 'agents old\n',
  'CLAUDE.md': 'claude edited by the project\n',
  '.claude/settings.json': 'settings old\n',
  '.github/groundwork/config.json': configWith((config) => {
    config.limits.reviewRounds += 2;
  }),
};

test('AC1 run updates kit files, keeps project files and merges config.json by key', async () => {
  await withProject(PROJECT_FILES, {}, async (project) => {
    const result = await execute(project, releasesClient(OLD_TREE, NEW_TREE));
    const config = JSON.parse(await readProject(project, '.github/groundwork/config.json'));

    assert.deepEqual(result.changed, [
      '.claude/settings.json',
      '.github/groundwork/config.json',
      '.github/groundwork/kit-version.txt',
      'AGENTS.md',
      'scripts/agent/fresh.mjs',
      'scripts/lib/a.mjs',
      'scripts/lib/gone.mjs',
    ]);
    assert.deepEqual(result.skipped, ['CLAUDE.md']);
    assert.equal(await readProject(project, 'scripts/lib/a.mjs'), 'a-new\n');
    assert.equal(await readProject(project, 'scripts/agent/fresh.mjs'), 'fresh\n');
    await assert.rejects(readProject(project, 'scripts/lib/gone.mjs'), { code: 'ENOENT' });
    assert.equal(await readProject(project, 'scripts/lib/project-only.mjs'), 'mine\n');
    assert.equal(await readProject(project, 'scripts/verify'), 'project verify\n');
    assert.equal(await readProject(project, 'AGENTS.md'), 'agents new\n');
    assert.equal(await readProject(project, 'CLAUDE.md'), 'claude edited by the project\n');
    assert.equal(await readProject(project, '.github/groundwork/kit-version.txt'), `${NEW_TAG}\n`);
    assert.equal(config.limits.reviewRounds, realConfig.limits.reviewRounds + 2);
    assert.equal(config.limits.ciReruns, realConfig.limits.ciReruns + 1);
    assert.equal(config.limits.newLimit, 7);
    assert.deepEqual(project.published, [
      ['git', 'commit', '-m', `chore(kit): update to ${NEW_TAG}`],
      ['git', 'push', 'origin', 'issue/5'],
    ]);
    assert.equal(await project.git(['diff', '--name-only']), '', 'every change is staged');
  });
});

test('run on the tag in kit-version.txt changes nothing and reads no release', async () => {
  await withProject(PROJECT_FILES, { kitVersion: NEW_TAG }, async (project) => {
    assert.deepEqual(await execute(project, NO_NETWORK_CLIENT), { ok: true, tag: NEW_TAG, changed: [], skipped: [] });
    assert.deepEqual(project.published, []);
  });
});

async function assertRefusedWithoutWrites({ project, client, tag, reason }) {
  const before = await readProject(project, '.github/groundwork/kit-version.txt');
  await assert.rejects(execute(project, client, tag), reason);
  assert.equal(await readProject(project, '.github/groundwork/kit-version.txt'), before);
  assert.equal(await readProject(project, 'scripts/lib/a.mjs'), 'a-old\n');
  assert.deepEqual(project.published, []);
}

test('AC2 run refuses a malformed tag before any write', async () => {
  await withProject(PROJECT_FILES, {}, async (project) => {
    for (const tag of ['1.1.0', 'v1.1', 'v1.1.0-rc1', null]) {
      await assertRefusedWithoutWrites({ project, client: NO_NETWORK_CLIENT, tag, reason: /not a vX\.Y\.Z tag/ });
    }
  });
});

test('AC2 run refuses a tag that does not exist in the control repository before any write', async () => {
  await withProject(PROJECT_FILES, {}, async (project) => {
    const client = createFixtureClient({
      ...tagRoutes(OLD_TAG, OLD_TREE),
      [`GET ${CONTROL_API}/git/ref/tags/${NEW_TAG}`]: reply(404, { message: 'Not Found' }),
    });
    await assertRefusedWithoutWrites({ project, client, tag: NEW_TAG, reason: /v1\.1\.0 does not exist/ });
  });
});

test('AC2 run refuses a dirty working tree before any write', async () => {
  await withProject(PROJECT_FILES, {}, async (project) => {
    await writeFile(path.join(project.root, 'notes.txt'), 'uncommitted\n');
    await assertRefusedWithoutWrites({ project, client: NO_NETWORK_CLIENT, tag: NEW_TAG, reason: /uncommitted changes/ });
  });
});

test('run refuses a tag lower than kit-version.txt and a branch other than issue/N', async () => {
  await withProject(PROJECT_FILES, { kitVersion: 'v1.2.0' }, async (project) => {
    await assertRefusedWithoutWrites({ project, client: NO_NETWORK_CLIENT, tag: NEW_TAG, reason: /lower than v1\.2\.0/ });
  });
  await withProject(PROJECT_FILES, { branch: 'main' }, async (project) => {
    await assertRefusedWithoutWrites({ project, client: NO_NETWORK_CLIENT, tag: NEW_TAG, reason: /issue\/N branch/ });
  });
});

test('AC3 main --json prints one object with ok on failure and on success', async () => {
  await withProject(PROJECT_FILES, {}, async (project) => {
    const scriptUrl = pathToFileURL(path.join(project.root, 'scripts', 'kit-update.mjs')).href;
    const lines = [];
    const log = console.log;
    console.log = (line) => lines.push(line);
    try {
      assert.equal(await main({ argv: ['nonsense', '--json'], env: {}, scriptUrl }), 1);
      assert.equal(await main({ argv: [OLD_TAG, '--json'], env: {}, scriptUrl }), 0);
    } finally {
      console.log = log;
    }
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).ok, false);
    assert.match(JSON.parse(lines[0]).reason, /not a vX\.Y\.Z tag/);
    assert.deepEqual(JSON.parse(lines[1]), { ok: true, tag: OLD_TAG, changed: [], skipped: [] });
  });
});

test('mergeConfig takes theirs for unchanged keys, keeps ours for changed or deleted keys and adds new keys', () => {
  const base = { a: 1, b: 2, c: 3, d: [1], nested: { x: 1, y: 2 }, gone: 'g' };
  const ours = { a: 1, b: 20, d: [1], nested: { x: 1, y: 22 }, mine: true, gone: 'g' };
  const theirs = { a: 10, b: 200, c: 30, d: [2], nested: { x: 10, y: 2 }, added: 'new' };
  assert.deepEqual(mergeConfig({ base, ours, theirs }), { a: 10, b: 20, d: [2], nested: { x: 10, y: 22 }, mine: true, added: 'new' });
});

test('mergeConfig keeps a project change to an array and a project deletion', () => {
  const base = { list: [1], dropped: 1 };
  assert.deepEqual(mergeConfig({ base, ours: { list: [1, 2] }, theirs: { list: [3], dropped: 2 } }), { list: [1, 2] });
});

test('KIT_PATHS match the kit and never the project, stub or deploy paths', () => {
  const kitFiles = [
    'scripts/agent/next.mjs',
    '.claude/skills/groundwork-worker/SKILL.md',
    '.github/workflows/plan-lint.yml',
    'scripts/kit-update.mjs',
  ];
  for (const kitPath of kitFiles) {
    assert.ok(isKitPath(kitPath), kitPath);
  }
  const otherFiles = [
    'scripts/verify',
    'scripts/stubs/deploy/deploy',
    '.github/workflows/deploy.yml',
    '.github/workflows/ci.yml',
    '.claude/skills/mine/SKILL.md',
    'scripts/groundwork/check.mjs',
  ];
  for (const other of otherFiles) {
    assert.ok(!isKitPath(other), other);
  }
  assert.ok(KIT_PATHS.length > 0 && UNMODIFIED_ONLY_PATHS.every((file) => !isKitPath(file)));
});

test('mergeConfig recurses into an object key that both sides added', () => {
  assert.deepEqual(mergeConfig({ base: {}, ours: { x: { a: 1 } }, theirs: { x: { b: 2 } } }), { x: { a: 1, b: 2 } });
});

test('R1 a failed commit restores the tree so the run can be repeated', async () => {
  await withProject(PROJECT_FILES, {}, async (project) => {
    const client = releasesClient(OLD_TREE, NEW_TREE);
    project.failPublishWhen = ([, subcommand]) => subcommand === 'commit';
    await assert.rejects(execute(project, client), /commit failed/);
    assert.equal(await project.git(['status', '--porcelain']), '');
    assert.equal((await readProject(project, '.github/groundwork/kit-version.txt')).trim(), OLD_TAG);
    project.failPublishWhen = () => false;
    assert.equal((await execute(project, client)).tag, NEW_TAG);
  });
});

test('R1 a rerun after a failed push pushes the local commit', async () => {
  await withProject(PROJECT_FILES, {}, async (project) => {
    const client = releasesClient(OLD_TREE, { ...NEW_TREE, '.github/groundwork/config.json': realConfigText });
    project.failPublishWhen = ([, subcommand]) => subcommand === 'push';
    await assert.rejects(execute(project, client), /push failed/);
    project.failPublishWhen = () => false;
    project.published.splice(0);
    assert.deepEqual(await execute(project, NO_NETWORK_CLIENT), { ok: true, tag: NEW_TAG, changed: [], skipped: [] });
    assert.deepEqual(project.published, [['git', 'push', 'origin', 'issue/5']]);
  });
});

test('R4 symlink entries are dropped and a path that leaves the project is refused', async () => {
  const newFiles = { ...NEW_TREE, 'scripts/lib/link.mjs': { text: 'a-new\n', mode: '120000' } };
  await withProject(PROJECT_FILES, {}, async (project) => {
    const result = await execute(project, releasesClient(OLD_TREE, newFiles));
    assert.ok(!result.changed.includes('scripts/lib/link.mjs'));
  });
  await withProject(PROJECT_FILES, {}, async (project) => {
    const escaping = { ...NEW_TREE, 'scripts/lib/../../../outside.mjs': 'x\n' };
    await assertRefusedWithoutWrites({ project, client: releasesClient(OLD_TREE, escaping), tag: NEW_TAG, reason: /leaves the project/ });
  });
});

test('R8 untracked files are seen when status.showUntrackedFiles is no and survive the refusal', async () => {
  await withProject(PROJECT_FILES, {}, async (project) => {
    await project.git(['config', 'status.showUntrackedFiles', 'no']);
    await writeFile(path.join(project.root, 'notes.txt'), 'mine\n');
    await assertRefusedWithoutWrites({ project, client: NO_NETWORK_CLIENT, tag: NEW_TAG, reason: /uncommitted changes/ });
    assert.equal(await readProject(project, 'notes.txt'), 'mine\n');
  });
});

test('R9 the equal-tag path succeeds and pushes when the remote-tracking ref is missing', async () => {
  await withProject(PROJECT_FILES, { kitVersion: NEW_TAG }, async (project) => {
    await project.git(['update-ref', '-d', 'refs/remotes/origin/issue/5']);
    assert.deepEqual(await execute(project, NO_NETWORK_CLIENT), { ok: true, tag: NEW_TAG, changed: [], skipped: [] });
    assert.deepEqual(project.published, [['git', 'push', 'origin', 'issue/5']]);
  });
});

test('R10 a failed restore keeps the original failure in the message', async () => {
  await withProject(PROJECT_FILES, {}, async (project) => {
    project.failPublishWhen = ([, subcommand]) => subcommand === 'commit';
    const git = (args) => (args[0] === 'reset' ? Promise.reject(new Error('reset broke')) : project.git(args));
    const client = releasesClient(OLD_TREE, NEW_TREE);
    const publish = (args) => project.publish(args);
    await assert.rejects(run({ root: project.root, tag: NEW_TAG, client, git, publish }), /commit failed.*reset broke/);
  });
});

const REUSABLE = `${realConfig.org}/${realConfig.controlRepo}/.github/workflows`;
const OLD_SHA = 'a'.repeat(40);
const CI_BEFORE = [
  'jobs:',
  '  verify:',
  `    uses: ${REUSABLE}/reusable-verify.yml@${OLD_SHA} # ${OLD_TAG}`,
  '  security:',
  `    uses: ${REUSABLE}/reusable-security.yml@${OLD_SHA} # ${OLD_TAG}`,
  '  steps:',
  '    - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
  '',
].join('\n');
const CI_AFTER = CI_BEFORE.replaceAll(OLD_SHA, COMMITS[NEW_TAG]).replaceAll(`# ${OLD_TAG}`, `# ${NEW_TAG}`);

test('AC1 rewritePins moves the reusable-workflow pins and leaves other uses lines unchanged', () => {
  const options = { org: realConfig.org, controlRepo: realConfig.controlRepo, tag: NEW_TAG, tagSha: COMMITS[NEW_TAG] };
  assert.equal(rewritePins({ text: CI_BEFORE, ...options }), CI_AFTER);
  const bare = `uses: ${REUSABLE}/reusable-verify.yml@${OLD_SHA}\n`;
  assert.equal(rewritePins({ text: bare, ...options }), `uses: ${REUSABLE}/reusable-verify.yml@${COMMITS[NEW_TAG]} # ${NEW_TAG}\n`);
  const foreign = `uses: other/groundwork/.github/workflows/reusable-verify.yml@${OLD_SHA} # v0.1.0\n`;
  assert.equal(rewritePins({ text: foreign, ...options }), foreign);
});

test('AC1 AC3 run rewrites the pins in the project workflows to the tag in kit-version.txt', async () => {
  const files = { ...PROJECT_FILES, '.github/workflows/ci.yml': CI_BEFORE };
  await withProject(files, {}, async (project) => {
    const result = await execute(project, releasesClient(OLD_TREE, NEW_TREE));
    assert.equal(await readProject(project, '.github/workflows/ci.yml'), CI_AFTER);
    assert.ok(result.changed.includes('.github/workflows/ci.yml'));
    assert.match(await project.git(['show', '--name-only', '--format=', 'HEAD']), /\.github\/workflows\/ci\.yml/);
  });
});

test('AC2 an annotated tag resolves to its commit, not the tag object', async () => {
  const tagObjectSha = 'e'.repeat(40);
  const client = createFixtureClient({
    ...tagRoutes(OLD_TAG, OLD_TREE),
    ...tagRoutes(NEW_TAG, NEW_TREE),
    [`GET ${CONTROL_API}/git/ref/tags/${NEW_TAG}`]: reply(200, { object: { type: 'tag', sha: tagObjectSha } }),
    [`GET ${CONTROL_API}/git/tags/${tagObjectSha}`]: reply(200, { object: { type: 'commit', sha: COMMITS[NEW_TAG] } }),
  });
  await withProject({ ...PROJECT_FILES, '.github/workflows/ci.yml': CI_BEFORE }, {}, async (project) => {
    await execute(project, client);
    const pinned = await readProject(project, '.github/workflows/ci.yml');
    assert.ok(pinned.includes(`@${COMMITS[NEW_TAG]} # ${NEW_TAG}`));
    assert.ok(!pinned.includes(tagObjectSha));
  });
});

test('a plan path the project gitignores is still committed', async () => {
  const files = { ...PROJECT_FILES, '.gitignore': 'scripts/agent/\n' };
  await withProject(files, {}, async (project) => {
    await execute(project, releasesClient(OLD_TREE, NEW_TREE));
    assert.match(await project.git(['show', '--name-only', '--format=', 'HEAD']), /scripts\/agent\/fresh\.mjs/);
  });
});

test('a failed commit removes an ignored file the plan created and keeps other ignored files', async () => {
  const files = { ...PROJECT_FILES, '.gitignore': 'scripts/agent/\nscratch/\n' };
  await withProject(files, {}, async (project) => {
    await mkdir(path.join(project.root, 'scratch'));
    await writeFile(path.join(project.root, 'scratch/keep.txt'), 'mine\n');
    project.failPublishWhen = ([, subcommand]) => subcommand === 'commit';
    await assert.rejects(execute(project, releasesClient(OLD_TREE, NEW_TREE)), /commit failed/);
    await assert.rejects(readProject(project, 'scripts/agent/fresh.mjs'), { code: 'ENOENT' });
    assert.equal(await readProject(project, 'scratch/keep.txt'), 'mine\n');
  });
});

test('rewritePins keeps the quotes around a quoted pin', () => {
  const options = { org: realConfig.org, controlRepo: realConfig.controlRepo, tag: NEW_TAG, tagSha: COMMITS[NEW_TAG] };
  const pinned = `${REUSABLE}/reusable-verify.yml@${COMMITS[NEW_TAG]}`;
  assert.equal(rewritePins({ text: `uses: "${REUSABLE}/reusable-verify.yml@${OLD_SHA}" # ${OLD_TAG}\n`, ...options }), `uses: "${pinned}" # ${NEW_TAG}\n`);
  assert.equal(rewritePins({ text: `uses: '${REUSABLE}/reusable-verify.yml@${OLD_SHA}'\n`, ...options }), `uses: '${pinned}' # ${NEW_TAG}\n`);
});

test('R6 run leaves a project workflow that calls its own local reusable workflow unchanged', async () => {
  const own = 'jobs:\n  build:\n    uses: ./.github/workflows/reusable-build.yml\n';
  await withProject({ ...PROJECT_FILES, '.github/workflows/build.yml': own }, {}, async (project) => {
    const result = await execute(project, releasesClient(OLD_TREE, NEW_TREE));
    assert.equal(await readProject(project, '.github/workflows/build.yml'), own);
    assert.ok(!result.changed.includes('.github/workflows/build.yml'));
  });
});

test('R1 run copies the new tag ci.yml with its local reusable-workflow references pinned', async () => {
  const localReference = './.github/workflows/reusable-verify.yml # zizmor: ignore[self-repository] bootstrap rewrites it';
  const tagCi = `jobs:\n  verify:\n    uses: ${localReference}\n  extra:\n    runs-on: ubuntu-latest\n`;
  const expected = `jobs:\n  verify:\n    uses: ${REUSABLE}/reusable-verify.yml@${COMMITS[NEW_TAG]} # ${NEW_TAG}\n  extra:\n    runs-on: ubuntu-latest\n`;
  await withProject({ ...PROJECT_FILES, '.github/workflows/ci.yml': CI_BEFORE }, {}, async (project) => {
    const result = await execute(project, releasesClient(OLD_TREE, { ...NEW_TREE, '.github/workflows/ci.yml': tagCi }));
    assert.equal(await readProject(project, '.github/workflows/ci.yml'), expected);
    assert.ok(result.changed.includes('.github/workflows/ci.yml'));
  });
});

test('AC6 run copies deploy.yml into a project that has none', async () => {
  const tagDeploy = 'name: deploy\non: release\n';
  await withProject(PROJECT_FILES, {}, async (project) => {
    const result = await execute(project, releasesClient(OLD_TREE, { ...NEW_TREE, '.github/workflows/deploy.yml': tagDeploy }));
    assert.equal(await readProject(project, '.github/workflows/deploy.yml'), tagDeploy);
    assert.ok(result.changed.includes('.github/workflows/deploy.yml'));
  });
});

test('AC6 run leaves an existing deploy.yml untouched', async () => {
  const projectDeploy = 'name: deploy\non: release\n# project edit\n';
  const files = { ...PROJECT_FILES, '.github/workflows/deploy.yml': projectDeploy };
  await withProject(files, {}, async (project) => {
    const result = await execute(project, releasesClient(OLD_TREE, { ...NEW_TREE, '.github/workflows/deploy.yml': 'name: deploy\n' }));
    assert.equal(await readProject(project, '.github/workflows/deploy.yml'), projectDeploy);
    assert.ok(!result.changed.includes('.github/workflows/deploy.yml'));
  });
});

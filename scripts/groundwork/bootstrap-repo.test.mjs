import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubError, createFixtureClient } from '../lib/github.mjs';
import { SettingsError } from '../lib/settings.mjs';
import {
  readBlobContents,
  commitBootstrapTree,
  createRepo,
  inspectRepo,
  latestReleaseTag,
  readBlobTexts,
  readKitVersion,
  readReleaseTree,
} from './bootstrap-repo.mjs';

const ORG = 'acme';
const CONTROL = 'groundwork';
const REPO = 'shop';
const ADMIN_BOT = 'acme-admin[bot]';
const REPO_PATH = `/repos/${ORG}/${REPO}`;
const KIT_PATH = `${REPO_PATH}/contents/.github/groundwork/kit-version.txt`;
const KIT_ON_MAIN = `GET ${KIT_PATH}?ref=main`;
const TAGS_KEY = `GET /repos/${ORG}/${CONTROL}/git/matching-refs/tags/v?per_page=100`;

function reply(status, data = {}) {
  return { status, data, headers: {} };
}

function base64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

// Fixture client hides request bodies; this wrapper records them.
function recordingClient(routes) {
  const calls = [];
  const bodies = [];
  const fixture = createFixtureClient(routes, { onCall: ({ method, path, status }) => calls.push({ method, path, status }) });
  const client = {
    ...fixture,
    request(method, path, options) {
      const record = { method, path: path.split('?')[0], body: options?.body };
      return fixture.request(method, path, options).finally(() => { bodies.push(record); });
    },
  };
  return { client, calls, bodies };
}

function tagRefs(...tags) {
  return reply(200, tags.map((tag) => ({ ref: `refs/tags/${tag}` })));
}

test('AC1 latestReleaseTag throws without a v* tag and makes no write call', async () => {
  const { client, calls } = recordingClient({ [TAGS_KEY]: reply(200, []) });
  await assert.rejects(latestReleaseTag({ client, org: ORG, controlRepo: CONTROL }), GitHubError);
  assert.deepEqual(calls.filter(({ method }) => method !== 'GET'), []);
});

test('AC1 latestReleaseTag compares tags numerically and ignores other refs', async () => {
  const { client } = recordingClient({
    [TAGS_KEY]: tagRefs('v0.4.0', 'v0.10.0', 'v0.9.1', 'v1.0.0-rc1', 'vnext'),
  });
  assert.equal(await latestReleaseTag({ client, org: ORG, controlRepo: CONTROL }), 'v0.10.0');
});

test('readReleaseTree keeps blobs and throws on a truncated tree', async () => {
  const treeKey = `GET /repos/${ORG}/${CONTROL}/git/trees/v0.4.0?recursive=1`;
  const tree = [
    { path: 'a.txt', mode: '100644', type: 'blob', sha: 's1', size: 3 },
    { path: 'dir', mode: '040000', type: 'tree', sha: 's2' },
  ];
  const ok = recordingClient({ [treeKey]: reply(200, { tree, truncated: false }) });
  assert.deepEqual(
    await readReleaseTree({ client: ok.client, org: ORG, controlRepo: CONTROL, tag: 'v0.4.0' }),
    [{ path: 'a.txt', mode: '100644', sha: 's1' }],
  );
  const cut = recordingClient({ [treeKey]: reply(200, { tree, truncated: true }) });
  await assert.rejects(readReleaseTree({ client: cut.client, org: ORG, controlRepo: CONTROL, tag: 'v0.4.0' }), /truncated/);
});

test('readBlobTexts decodes UTF-8 blobs and rejects a path outside the tree', async () => {
  const { client } = recordingClient({
    [`GET /repos/${ORG}/${CONTROL}/git/blobs/s1`]: reply(200, { content: base64('héllo\n'), encoding: 'base64' }),
  });
  const entries = [{ path: 'a.txt', mode: '100644', sha: 's1' }];
  const args = { client, org: ORG, controlRepo: CONTROL, entries };
  assert.deepEqual(await readBlobTexts({ ...args, paths: ['a.txt'] }), { 'a.txt': 'héllo\n' });
  await assert.rejects(readBlobTexts({ ...args, paths: ['missing.txt'] }), /not in the release tree/);
});

const REPO_OK = { default_branch: 'main' };
const ONE_ADMIN_COMMIT = [{ sha: 'c1', author: { login: ADMIN_BOT } }];
const README_ONLY = [{ name: 'README.md', type: 'file' }];

function inspectRoutes({ repository = reply(200, REPO_OK), kit = reply(404), commits = reply(200, ONE_ADMIN_COMMIT), root = reply(200, README_ONLY) } = {}) {
  return {
    [`GET ${REPO_PATH}`]: repository,
    [`GET ${KIT_PATH}`]: kit,
    [`GET ${REPO_PATH}/commits?per_page=2`]: commits,
    [`GET ${REPO_PATH}/contents/`]: root,
  };
}

async function inspect(routes) {
  const { client } = recordingClient(routes);
  return inspectRepo({ client, org: ORG, repo: REPO, adminBot: ADMIN_BOT });
}

test('AC2 inspectRepo returns absent on 404', async () => {
  assert.equal(await inspect(inspectRoutes({ repository: reply(404) })), 'absent');
});

test('AC2 inspectRepo returns fresh for the one-commit auto_init state by the admin bot', async () => {
  assert.equal(await inspect(inspectRoutes()), 'fresh');
});

test('AC2 inspectRepo compares the commit author through sameLogin', async () => {
  const commits = reply(200, [{ sha: 'c1', author: { login: 'ACME-Admin[bot]' } }]);
  assert.equal(await inspect(inspectRoutes({ commits })), 'fresh');
});

test('AC2 inspectRepo returns ours when kit-version.txt exists, even off main', async () => {
  const kit = reply(200, { content: base64('v0.4.0\n') });
  assert.equal(await inspect(inspectRoutes({ kit, repository: reply(200, { default_branch: 'trunk' }) })), 'ours');
});

const FOREIGN_CASES = {
  'two commits': { commits: reply(200, [...ONE_ADMIN_COMMIT, { sha: 'c0', author: { login: ADMIN_BOT } }]) },
  'a commit by another author': { commits: reply(200, [{ sha: 'c1', author: { login: 'someone' } }]) },
  'a commit with no linked author': { commits: reply(200, [{ sha: 'c1', author: null }]) },
  'a root file besides README.md': { root: reply(200, [...README_ONLY, { name: 'src', type: 'dir' }]) },
  'an empty repository (409)': { commits: reply(409, { message: 'Git Repository is empty.' }), kit: reply(404) },
  'an empty repository with a 409 kit read': { commits: reply(409, { message: 'Git Repository is empty.' }), kit: reply(409) },
  'a non-main default branch': { repository: reply(200, { default_branch: 'trunk' }) },
};

for (const [name, overrides] of Object.entries(FOREIGN_CASES)) {
  test(`AC2 inspectRepo returns foreign for ${name}`, async () => {
    assert.equal(await inspect(inspectRoutes(overrides)), 'foreign');
  });
}

test('AC2 readKitVersion returns the pinned tag and rejects other content', async () => {
  const good = recordingClient({ [KIT_ON_MAIN]: reply(200, { content: base64('v0.4.0\n') }) });
  assert.equal(await readKitVersion({ client: good.client, org: ORG, repo: REPO }), 'v0.4.0');
  const bad = recordingClient({ [KIT_ON_MAIN]: reply(200, { content: base64('latest\n') }) });
  await assert.rejects(readKitVersion({ client: bad.client, org: ORG, repo: REPO }), /vX\.Y\.Z/);
});

const CREATE_PERMISSIONS = { administration: 'write' };

// Stubbed 12.1 hook: logs mint and revoke, answers the create call from `answers`.
function stubWithToken(answers) {
  const log = [];
  const withToken = async (scope, callback) => {
    log.push(`mint ${JSON.stringify(scope)}`);
    const answer = answers.shift();
    const client = {
      request: async (method, path, options) => {
        log.push(`${method} ${path} ${JSON.stringify(options.body)}`);
        if (answer instanceof Error) throw answer;
        if (answer !== 'ok') throw new GitHubError(`${method} ${path}: ${answer}`, { status: answer });
        return reply(201);
      },
    };
    try {
      return await callback({ client, token: 'tok' });
    } finally {
      log.push('revoke');
    }
  };
  return { withToken, log };
}

function createRepoArgs(withToken) {
  return { withToken, org: ORG, controlRepo: CONTROL, repo: REPO, description: 'A shop', permissions: CREATE_PERMISSIONS };
}

const CREATE_BODY = '{"name":"shop","description":"A shop","private":false,"auto_init":true}';

test('AC3 createRepo makes one call with the restricted token when it succeeds', async () => {
  const { withToken, log } = stubWithToken(['ok']);
  await createRepo(createRepoArgs(withToken));
  assert.deepEqual(log, [
    'mint {"repositories":["groundwork"],"permissions":{"administration":"write"}}',
    `POST /orgs/acme/repos ${CREATE_BODY}`,
    'revoke',
  ]);
});

async function assertSingleMintFailure(failure) {
  const { withToken, log } = stubWithToken([failure]);
  await assert.rejects(createRepo(createRepoArgs(withToken)), (error) => error === failure);
  assert.equal(log.filter((line) => line.startsWith('mint')).length, 1);
  assert.equal(log.at(-1), 'revoke');
}

test('AC5 createRepo throws a 403 after one mint, with no installation-wide retry', async () => {
  await assertSingleMintFailure(new GitHubError('forbidden', { status: 403 }));
});

test('AC5 createRepo throws a 404 after one mint, with no installation-wide retry', async () => {
  await assertSingleMintFailure(new GitHubError('not found', { status: 404 }));
});

test('AC5 createRepo throws a 422 after one mint', async () => {
  await assertSingleMintFailure(new GitHubError('unprocessable', { status: 422 }));
});

test('AC5 createRepo throws a non-GitHub error after one mint', async () => {
  await assertSingleMintFailure(new Error('boom'));
});

const TREE_ENTRIES = [
  { path: 'README.md', mode: '100644', content: '# shop\n' },
  { path: 'a.txt', mode: '100644', sha: 'ctl1' },
  { path: 'b.txt', mode: '100755', sha: 'ctl2' },
];
const BLOBS = new Map([['a.txt', 'QQ=='], ['b.txt', 'Qg==']]);

function commitRoutes({ kit = reply(404) } = {}) {
  return {
    [`GET ${REPO_PATH}/git/ref/heads/main`]: reply(200, { object: { sha: 'head1' } }),
    [KIT_ON_MAIN]: kit,
    [`POST ${REPO_PATH}/git/blobs`]: [reply(201, { sha: 'ctl1' }), reply(201, { sha: 'ctl2' })],
    [`POST ${REPO_PATH}/git/trees`]: reply(201, { sha: 'tree1' }),
    [`POST ${REPO_PATH}/git/commits`]: reply(201, { sha: 'commit1' }),
    [`PATCH ${REPO_PATH}/git/refs/heads/main`]: reply(200, {}),
  };
}

function commitArgs(client, sleep = async () => {}) {
  return { client, org: ORG, repo: REPO, tag: 'v0.4.0', treeEntries: TREE_ENTRIES, blobs: BLOBS, sleep };
}

test('readBlobContents reads control blobs for sha entries only, as base64 without line breaks', async () => {
  const { client, calls } = recordingClient({
    [`GET /repos/${ORG}/${CONTROL}/git/blobs/ctl1`]: reply(200, { content: 'QQ\n==\n', encoding: 'base64' }),
    [`GET /repos/${ORG}/${CONTROL}/git/blobs/ctl2`]: reply(200, { content: 'Qg==', encoding: 'base64' }),
  });
  const blobs = await readBlobContents({ client, org: ORG, controlRepo: CONTROL, entries: TREE_ENTRIES });
  assert.deepEqual([...blobs], [...BLOBS]);
  assert.equal(calls.length, 2);
});

test('AC4 commitBootstrapTree creates each kept blob in the target, paced by sleep', async () => {
  const { client, bodies } = recordingClient(commitRoutes());
  const sleeps = [];
  const result = await commitBootstrapTree(commitArgs(client, async (ms) => { sleeps.push(ms); }));
  assert.deepEqual(result, { sha: 'commit1', created: true });
  assert.deepEqual(sleeps, [1000]);
  assert.deepEqual(
    bodies.filter((call) => call.path === `${REPO_PATH}/git/blobs`).map((call) => call.body),
    [{ content: 'QQ==', encoding: 'base64' }, { content: 'Qg==', encoding: 'base64' }],
  );
  const bodyOf = (method, suffix) => bodies.find((call) => call.method === method && call.path === `${REPO_PATH}${suffix}`).body;
  assert.deepEqual(bodyOf('POST', '/git/trees'), {
    tree: [
      { path: 'README.md', mode: '100644', content: '# shop\n', type: 'blob' },
      { path: 'a.txt', mode: '100644', sha: 'ctl1', type: 'blob' },
      { path: 'b.txt', mode: '100755', sha: 'ctl2', type: 'blob' },
    ],
  });
  assert.deepEqual(bodyOf('POST', '/git/commits'), {
    message: 'chore: bootstrap from groundwork v0.4.0',
    tree: 'tree1',
    parents: ['head1'],
  });
  assert.deepEqual(bodyOf('PATCH', '/git/refs/heads/main'), { sha: 'commit1', force: false });
});

test('AC4 commitBootstrapTree writes nothing when kit-version.txt is already on main', async () => {
  const kit = reply(200, { content: base64('v0.4.0\n') });
  const { client, calls } = recordingClient(commitRoutes({ kit }));
  const result = await commitBootstrapTree(commitArgs(client));
  assert.deepEqual(result, { sha: 'head1', created: false });
  assert.deepEqual(calls.filter(({ method }) => method !== 'GET'), []);
});

test('commitBootstrapTree throws SettingsError when a created blob sha differs from the control sha, before any tree write', async () => {
  const routes = { ...commitRoutes(), [`POST ${REPO_PATH}/git/blobs`]: reply(201, { sha: 'other' }) };
  const { client, calls } = recordingClient(routes);
  await assert.rejects(commitBootstrapTree(commitArgs(client)), SettingsError);
  assert.equal(calls.some(({ path }) => path.endsWith('/git/trees')), false);
});

test('commitBootstrapTree throws SettingsError, not TypeError, when blobs is missing', async () => {
  const { client } = recordingClient(commitRoutes());
  await assert.rejects(commitBootstrapTree({ ...commitArgs(client), blobs: undefined }), SettingsError);
});

test('readBlobContents throws SettingsError for a control blob response without content', async () => {
  const { client } = recordingClient({ [`GET /repos/${ORG}/${CONTROL}/git/blobs/ctl1`]: reply(200, { encoding: 'base64' }) });
  const entries = [{ path: 'a.txt', mode: '100644', sha: 'ctl1' }];
  await assert.rejects(readBlobContents({ client, org: ORG, controlRepo: CONTROL, entries }), SettingsError);
});

test('commitBootstrapTree throws SettingsError for a sha entry without base64 and creates no tree', async () => {
  const { client, calls } = recordingClient(commitRoutes());
  const args = { ...commitArgs(client), blobs: new Map([['a.txt', 'QQ==']]) };
  await assert.rejects(commitBootstrapTree(args), SettingsError);
  assert.equal(calls.some(({ path }) => path.endsWith('/git/trees')), false);
});

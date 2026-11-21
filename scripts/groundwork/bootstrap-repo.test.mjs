import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubError, createFixtureClient } from '../lib/github.mjs';
import {
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
const TAGS_KEY = `GET /repos/${ORG}/${CONTROL}/git/matching-refs/tags/v?per_page=100`;

function reply(status, data = {}) {
  return { status, data, headers: {} };
}

function base64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

// The fixture client never exposes request bodies, so this wrapper records them next to the call order.
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
  'a non-main default branch': { repository: reply(200, { default_branch: 'trunk' }) },
};

for (const [name, overrides] of Object.entries(FOREIGN_CASES)) {
  test(`AC2 inspectRepo returns foreign for ${name}`, async () => {
    assert.equal(await inspect(inspectRoutes(overrides)), 'foreign');
  });
}

test('AC2 readKitVersion returns the pinned tag and rejects other content', async () => {
  const good = recordingClient({ [`GET ${KIT_PATH}`]: reply(200, { content: base64('v0.4.0\n') }) });
  assert.equal(await readKitVersion({ client: good.client, org: ORG, repo: REPO }), 'v0.4.0');
  const bad = recordingClient({ [`GET ${KIT_PATH}`]: reply(200, { content: base64('latest\n') }) });
  await assert.rejects(readKitVersion({ client: bad.client, org: ORG, repo: REPO }), /vX\.Y\.Z/);
});

const CREATE_PERMISSIONS = { administration: 'write' };

// Stubbed 12.1 hook: logs mint and end around the callback and answers the create call from `answers`.
function stubWithToken(answers) {
  const log = [];
  const withToken = async (scope, callback) => {
    log.push(`mint ${JSON.stringify(scope)}`);
    const answer = answers.shift();
    const client = {
      request: async (method, path, options) => {
        log.push(`${method} ${path} ${JSON.stringify(options.body)}`);
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

for (const status of [403, 404]) {
  test(`AC3 createRepo retries once with repositories "all" after ${status}, revoking first`, async () => {
    const { withToken, log } = stubWithToken([status, 'ok']);
    await createRepo(createRepoArgs(withToken));
    assert.deepEqual(log, [
      'mint {"repositories":["groundwork"],"permissions":{"administration":"write"}}',
      `POST /orgs/acme/repos ${CREATE_BODY}`,
      'revoke',
      'mint {"repositories":"all","permissions":{"administration":"write"}}',
      `POST /orgs/acme/repos ${CREATE_BODY}`,
      'revoke',
    ]);
  });
}

test('AC3 createRepo throws a 422 without a retry', async () => {
  const { withToken, log } = stubWithToken([422]);
  await assert.rejects(createRepo(createRepoArgs(withToken)), (error) => error.status === 422);
  assert.equal(log.filter((line) => line.startsWith('mint')).length, 1);
  assert.equal(log.at(-1), 'revoke');
});

const TREE_ENTRIES = [
  { path: 'README.md', mode: '100644', content: '# shop\n' },
  { path: 'a.txt', mode: '100644', sha: 'blob1' },
];

function commitRoutes({ kit = reply(404) } = {}) {
  return {
    [`GET ${REPO_PATH}/git/ref/heads/main`]: reply(200, { object: { sha: 'head1' } }),
    [`GET ${KIT_PATH}`]: kit,
    [`POST ${REPO_PATH}/git/trees`]: reply(201, { sha: 'tree1' }),
    [`POST ${REPO_PATH}/git/commits`]: reply(201, { sha: 'commit1' }),
    [`PATCH ${REPO_PATH}/git/refs/heads/main`]: reply(200, {}),
  };
}

test('AC4 commitBootstrapTree posts the tree without base_tree and a commit with no author or committer', async () => {
  const { client, bodies } = recordingClient(commitRoutes());
  const result = await commitBootstrapTree({ client, org: ORG, repo: REPO, tag: 'v0.4.0', treeEntries: TREE_ENTRIES });
  assert.deepEqual(result, { sha: 'commit1', created: true });
  const bodyOf = (method, suffix) => bodies.find((call) => call.method === method && call.path === `${REPO_PATH}${suffix}`).body;
  assert.deepEqual(bodyOf('POST', '/git/trees'), {
    tree: [
      { path: 'README.md', mode: '100644', content: '# shop\n', type: 'blob' },
      { path: 'a.txt', mode: '100644', sha: 'blob1', type: 'blob' },
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
  const result = await commitBootstrapTree({ client, org: ORG, repo: REPO, tag: 'v0.4.0', treeEntries: TREE_ENTRIES });
  assert.deepEqual(result, { sha: 'head1', created: false });
  assert.deepEqual(calls.filter(({ method }) => method !== 'GET'), []);
});

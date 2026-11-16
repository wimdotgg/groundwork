import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_DIR, ConfigError, loadConfig, loadHotspots, repoRoot } from './config.mjs';

const realRoot = repoRoot(import.meta.url);

function fixtureConfig() {
  return {
    schemaVersion: 1,
    org: 'acme',
    controlRepo: 'control',
    accounts: { owner: 'acme-owner', agent: 'acme-agent' },
    apps: { admin: 'acme-admin', release: 'acme-release' },
    trustedAuthors: [
      { actor: 'owner', scope: 'any' },
      { actor: 'agent', scope: 'any' },
      { actor: 'app:admin', scope: 'issues' },
      { actor: 'app:release', scope: 'pull-requests' },
      { actor: 'dependabot[bot]', scope: 'pull-requests' },
    ],
    labelActors: {
      accepted: 'owner',
      'priority:*': 'owner',
      dependencies: 'dependabot[bot]',
      automated: 'app:release',
    },
    deploy: 'scripts',
    limits: Object.fromEntries([
      'hierarchyDepth', 'hierarchyDepthWithIntermediate', 'subIssuesPerParent', 'prChangedLines',
      'prFiles', 'tasksPerWorker', 'activeWorkers', 'draftLeaseMinutes', 'claimWithoutPrMinutes',
      'reviewRounds', 'sameFailureAttempts', 'ciReruns', 'stateLines', 'journalLines', 'resumeLines',
    ].map((key) => [key, 1])),
    sizeExcludeGlobs: ['**/*.lock'],
    generatedGlobs: [],
    testIntegrity: {
      testGlobs: ['**/*.test.*'],
      testDeclarationPatterns: ['\\bit\\s*\\('],
      suppressionPatterns: ['eslint-disable'],
      thresholdGlobs: [],
    },
  };
}

const realConfigJson = async () => fixtureConfig();

async function withTempRoot(files, run) {
  const root = await mkdtemp(path.join(tmpdir(), 'groundwork-config-'));
  try {
    await mkdir(path.join(root, CONFIG_DIR), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(root, CONFIG_DIR, name), typeof content === 'string' ? content : JSON.stringify(content));
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertRejectsConfig(mutate, pattern) {
  const config = await realConfigJson();
  mutate(config);
  await withTempRoot({ 'config.json': config }, async (root) => {
    await assert.rejects(loadConfig({ root }), (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, pattern);
      assert.ok(error.file.endsWith('config.json'));
      assert.ok(!error.message.includes('\n'));
      return true;
    });
  });
}

test('CONFIG_DIR is the groundwork config directory', () => {
  assert.equal(CONFIG_DIR, '.github/groundwork');
});

test('loadConfig loads the real repository config with lower-cased logins', async () => {
  const config = await loadConfig({ root: realRoot });
  assert.equal(config.schemaVersion, 1);
  for (const login of [config.accounts.owner, config.accounts.agent, ...Object.values(config.apps)]) {
    assert.equal(login, login.toLowerCase());
  }
});

test('loadConfig loads a fixture config', async () => {
  await withTempRoot({ 'config.json': fixtureConfig() }, async (root) => {
    const config = await loadConfig({ root });
    assert.deepEqual(config.accounts, { owner: 'acme-owner', agent: 'acme-agent' });
    assert.equal(config.labelActors['priority:*'], 'owner');
  });
});

test('loadConfig lower-cases mixed-case logins, slugs and literal actors', async () => {
  const config = await realConfigJson();
  config.accounts = { owner: 'WianVDM', agent: 'WianVDM-Agent' };
  config.apps = { admin: 'Wimdotgg-Admin', release: 'wimdotgg-release' };
  config.trustedAuthors.push({ actor: 'Dependabot[bot]', scope: 'any' });
  await withTempRoot({ 'config.json': config }, async (root) => {
    const loaded = await loadConfig({ root });
    assert.deepEqual(loaded.accounts, { owner: 'wianvdm', agent: 'wianvdm-agent' });
    assert.equal(loaded.apps.admin, 'wimdotgg-admin');
    assert.equal(loaded.trustedAuthors.at(-1).actor, 'dependabot[bot]');
  });
});

test('loadConfig rejects an unknown top-level key', async () => {
  await assertRejectsConfig((config) => { config.extra = 1; }, /unknown top-level key "extra"/);
});

test('loadConfig rejects a missing top-level key', async () => {
  await assertRejectsConfig((config) => { delete config.limits; }, /missing top-level key "limits"/);
});

test('loadConfig rejects a schemaVersion other than 1', async () => {
  await assertRejectsConfig((config) => { config.schemaVersion = 2; }, /schemaVersion must be 1/);
});

test('loadConfig rejects a pattern that does not compile', async () => {
  await assertRejectsConfig(
    (config) => { config.testIntegrity.suppressionPatterns.push('(unclosed'); },
    /does not compile: \(unclosed/,
  );
});

test('loadConfig rejects an unknown app ref in trustedAuthors', async () => {
  await assertRejectsConfig(
    (config) => { config.trustedAuthors.push({ actor: 'app:nope', scope: 'any' }); },
    /unknown app "nope"/,
  );
});

test('loadConfig rejects an unknown app ref in labelActors', async () => {
  await assertRejectsConfig((config) => { config.labelActors.x = 'app:nope'; }, /unknown app "nope"/);
});

test('loadConfig rejects a labelActors key with * not at the end', async () => {
  await assertRejectsConfig((config) => { config.labelActors['pri*ority'] = 'owner'; }, /only use "\*" at the end/);
});

test('loadConfig rejects invalid JSON and a missing file with a one-line ConfigError', async () => {
  await withTempRoot({ 'config.json': '{\n"a": 1,\n not json' }, async (root) => {
    await assert.rejects(loadConfig({ root }), (error) => {
      assert.ok(error instanceof ConfigError);
      assert.ok(!/\s{2}|\n/.test(error.message));
      return true;
    });
  });
  await withTempRoot({}, async (root) => {
    await assert.rejects(loadConfig({ root }), ConfigError);
  });
});

test('loadHotspots returns [] when hotspots.json is absent', async () => {
  await withTempRoot({}, async (root) => {
    assert.deepEqual(await loadHotspots({ root }), []);
  });
  assert.deepEqual(await loadHotspots({ root: realRoot }), []);
});

test('loadHotspots reads a valid file and rejects a malformed one', async () => {
  const hotspots = [{ name: 'core', paths: ['src/core/**'] }];
  await withTempRoot({ 'hotspots.json': { schemaVersion: 1, hotspots } }, async (root) => {
    assert.deepEqual(await loadHotspots({ root }), hotspots);
  });
  await withTempRoot({ 'hotspots.json': { schemaVersion: 2, hotspots: [] } }, async (root) => {
    await assert.rejects(loadHotspots({ root }), ConfigError);
  });
  await withTempRoot({ 'hotspots.json': { schemaVersion: 1, hotspots: [{ name: 'x' }] } }, async (root) => {
    await assert.rejects(loadHotspots({ root }), ConfigError);
  });
});

test('repoRoot resolves from scripts/lib and scripts file URLs', () => {
  const base = path.resolve(path.sep, 'work', 'repo');
  const libUrl = pathToFileURL(path.join(base, 'scripts', 'lib', 'x.mjs')).href;
  const topUrl = pathToFileURL(path.join(base, 'scripts', 'kit-update.mjs')).href;
  assert.equal(repoRoot(libUrl), base);
  assert.equal(repoRoot(topUrl), base);
});

test('repoRoot uses the nearest scripts ancestor', () => {
  const base = path.resolve(path.sep, 'work', 'scripts', 'repo');
  const url = pathToFileURL(path.join(base, 'scripts', 'ci', 'y.mjs')).href;
  assert.equal(repoRoot(url), base);
});

test('repoRoot throws ConfigError without a scripts ancestor', () => {
  const url = pathToFileURL(path.resolve(path.sep, 'work', 'repo', 'x.mjs')).href;
  assert.throws(() => repoRoot(url), ConfigError);
});

test('loadConfig classifies actor refs case-insensitively after trimming', async () => {
  const config = fixtureConfig();
  config.trustedAuthors = [{ actor: ' Owner ', scope: 'any' }, { actor: ' APP:release ', scope: 'any' }];
  config.labelActors.automated = 'Agent';
  await withTempRoot({ 'config.json': config }, async (root) => {
    const loaded = await loadConfig({ root });
    assert.deepEqual(loaded.trustedAuthors.map((entry) => entry.actor), ['owner', 'app:release']);
    assert.equal(loaded.labelActors.automated, 'agent');
  });
});

test('loadConfig rejects an unknown app ref written with odd case or spacing', async () => {
  await assertRejectsConfig(
    (config) => { config.trustedAuthors.push({ actor: ' App:nope', scope: 'any' }); },
    /unknown app "nope"/,
  );
});

test('loadConfig rejects unknown keys in accounts and trustedAuthors entries', async () => {
  await assertRejectsConfig((config) => { config.accounts.extra = 'x'; }, /unknown accounts key "extra"/);
  await assertRejectsConfig(
    (config) => { config.trustedAuthors[0].extra = 'x'; },
    /trustedAuthors\[0\] has unknown key "extra"/,
  );
});

test('loadConfig requires limits to be non-negative integers', async () => {
  await assertRejectsConfig((config) => { config.limits.prFiles = 1.5; }, /limits.prFiles must be a non-negative integer/);
  await assertRejectsConfig((config) => { config.limits.prFiles = -1; }, /limits.prFiles must be a non-negative integer/);
});

test('loadConfig rejects labelActors keys that differ only by case', async () => {
  await assertRejectsConfig((config) => { config.labelActors.Accepted = 'agent'; }, /differs from another key only by case/);
});

test('repoRoot throws ConfigError for a non-file URL', () => {
  assert.throws(() => repoRoot('https://example.com/scripts/x.mjs'), ConfigError);
});

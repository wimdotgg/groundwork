import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SettingsError } from '../lib/settings.mjs';
import {
  CONTROL_PATHS,
  KIT_VERSION_PATH,
  buildBootstrapTree,
  contentPaths,
  settingsFiles,
} from './bootstrap-tree.mjs';

const DEPLOY_STUBS_DIR = fileURLToPath(new URL('./stubs/deploy/', import.meta.url));
const DEPLOY_STUB_NAMES = ['deploy', 'smoke', 'rollback'];
const TAG = 'v9.9.9';
const TAG_SHA = 'ab12'.repeat(10);
const OPTIONS = { org: 'acme', controlRepo: 'groundwork', repo: 'shop', description: 'Shop for $& "quotes" and \\ slashes', tag: TAG, tagSha: TAG_SHA };
const CI = [
  'jobs:',
  '  verify:',
  '    uses: ./.github/workflows/reusable-verify.yml # zizmor: ignore[self-repository] bootstrap rewrites it',
  '  security:',
  '    uses: ./.github/workflows/reusable-security.yml # zizmor: ignore[self-repository] bootstrap rewrites it',
  '',
].join('\n');

function blob(path, content, mode = '100644') {
  return { entry: { path, mode, sha: `sha-${path}` }, content };
}

function fixture({ omit = [] } = {}) {
  const blobs = [
    blob('.github/workflows/ci.yml', CI),
    blob('.github/workflows/reusable-verify.yml', 'verify'),
    blob('.github/workflows/reusable-security.yml', 'security'),
    blob('.github/workflows/admin-run.yml', 'admin'),
    blob('.github/groundwork/config.json', '{"org":"__ORG__"}\n'),
    blob('.github/groundwork/hotspots.json', '[]\n'),
    blob('.github/groundwork/kit-version.txt', 'old\n'),
    blob('.github/ISSUE_TEMPLATE/bug.md', 'Bug in __ORG__/__REPO__\n'),
    blob('scripts/groundwork/check.mjs', 'control'),
    blob('scripts/groundwork/stubs/verify', '#!/bin/sh\necho __REPO__\n', '100755'),
    blob('scripts/groundwork/stubs/verify.cmd', '@echo off\n'),
    blob('scripts/groundwork/stubs/README.md', '# __REPO__\n__DESCRIPTION__ by __ORG__\n'),
    blob('scripts/groundwork/stubs/docs/guide.md', 'Guide for __REPO__: __DESCRIPTION__\n'),
    blob('scripts/groundwork/stubs/docs/sub/more.md', 'more\n'),
    blob('scripts/groundwork/stubs/deploy/deploy', '#!/bin/sh\nexit 1\n', '100755'),
    blob('scripts/groundwork/stubs/deploy/deploy.cmd', '@echo off\n'),
    blob('admin-ops/op.json', '{}'),
    blob('scripts/verify', 'groundwork own verify', '100755'),
    blob('scripts/verify.cmd', 'groundwork own verify'),
    blob('README.md', 'groundwork readme'),
    blob('docs/spec.md', 'spec'),
    blob('version.txt', '1.2.3\n'),
    blob('CHANGELOG.md', 'old changelog'),
    blob('.release-please-manifest.json', '{".":"1.2.3"}\n'),
    blob('package.json', '{}'),
  ].filter(({ entry }) => !omit.includes(entry.path));
  const entries = blobs.map(({ entry }) => entry);
  const contents = Object.fromEntries(
    blobs.filter(({ entry }) => contentPaths(entries).includes(entry.path)).map(({ entry, content }) => [entry.path, content]),
  );
  return { entries, contents };
}

const build = (options = {}) => buildBootstrapTree({ ...fixture(), ...OPTIONS, ...options });
const find = (tree, path) => tree.find((entry) => entry.path === path);

test('AC1: output holds no CONTROL_PATHS path; contentPaths lists .github and stub blobs', () => {
  const { entries } = fixture();
  const tree = build();
  const underControl = tree.filter(({ path }) =>
    CONTROL_PATHS.some((control) => (control.endsWith('/') ? path.startsWith(control) : path === control)),
  );
  assert.deepEqual(underControl, []);
  const expected = entries
    .map(({ path }) => path)
    .filter((path) => path.startsWith('.github/') || path.startsWith('scripts/groundwork/stubs/'));
  assert.deepEqual(contentPaths(entries), expected);
  assert.ok(contentPaths(entries).includes('scripts/groundwork/stubs/docs/sub/more.md'));
});

test('AC10: ci.yml pins the control repo reusable workflows to the tag commit SHA with the tag as comment', () => {
  const ci = find(build(), '.github/workflows/ci.yml').content;
  assert.match(ci, new RegExp(`uses: acme/groundwork/\\.github/workflows/reusable-verify\\.yml@${TAG_SHA} # v9\\.9\\.9\\n`));
  assert.match(ci, new RegExp(`uses: acme/groundwork/\\.github/workflows/reusable-security\\.yml@${TAG_SHA} # v9\\.9\\.9\\n`));
  assert.match(TAG_SHA, /^[0-9a-f]{40}$/);
  assert.ok(!/@v\d/.test(ci), 'no tag ref is left');
  assert.ok(!ci.includes('./.github/workflows/reusable-'));
  assert.ok(!ci.includes('zizmor: ignore[self-repository]'));
});

test('AC10: buildBootstrapTree refuses a tagSha that is not a 40-character commit SHA', () => {
  for (const tagSha of [undefined, TAG, 'AB12'.repeat(10), 'ab12'.repeat(9)]) {
    assert.throws(() => build({ tagSha }), (error) => error instanceof SettingsError && /not a 40-character commit SHA/.test(error.message));
  }
});

test('AC3: generated files, stub verify with its mode, README and docs from stubs', () => {
  const tree = build();
  assert.equal(find(tree, KIT_VERSION_PATH).content, 'v9.9.9\n');
  assert.equal(find(tree, '.release-please-manifest.json').content, '{}\n');
  assert.equal(find(tree, 'version.txt').content, '0.0.0\n');
  assert.equal(find(tree, 'CHANGELOG.md').content, '');
  const verify = find(tree, 'scripts/verify');
  assert.equal(verify.mode, '100755');
  assert.equal(verify.content, '#!/bin/sh\necho shop\n');
  assert.equal(find(tree, 'scripts/verify.cmd').sha, 'sha-scripts/groundwork/stubs/verify.cmd');
  assert.equal(find(tree, 'README.md').content, `# shop\n${OPTIONS.description} by acme\n`);
  assert.equal(find(tree, 'docs/guide.md').content, `Guide for shop: ${OPTIONS.description}\n`);
  assert.equal(find(tree, 'docs/sub/more.md').sha, 'sha-scripts/groundwork/stubs/docs/sub/more.md');
  assert.equal(find(tree, 'docs/spec.md'), undefined);
});

test('AC2: deploy stubs land in scripts/stubs/deploy/ with their mode; no project deploy, smoke or rollback script', () => {
  const tree = build();
  const deploy = find(tree, 'scripts/stubs/deploy/deploy');
  assert.equal(deploy.mode, '100755');
  assert.equal(deploy.sha, 'sha-scripts/groundwork/stubs/deploy/deploy');
  assert.equal(find(tree, 'scripts/stubs/deploy/deploy.cmd').mode, '100644');
  const projectScripts = ['deploy', 'deploy.cmd', 'smoke', 'smoke.cmd', 'rollback', 'rollback.cmd'].map((name) => `scripts/${name}`);
  assert.deepEqual(tree.filter(({ path }) => projectScripts.includes(path)), []);
  assert.deepEqual(tree.filter(({ path }) => path.startsWith('scripts/groundwork/')), []);
});

test('AC1: each release deploy stub exits 1 with one GROUNDWORK_STUB line, and its shim is CRLF', () => {
  for (const name of DEPLOY_STUB_NAMES) {
    const run = spawnSync('sh', [`${DEPLOY_STUBS_DIR}${name}`, 'v1.0.0'], { encoding: 'utf8' });
    assert.equal(run.status, 1, name);
    assert.equal(run.stdout, '', name);
    assert.equal(run.stderr, `GROUNDWORK_STUB: scripts/${name} is the groundwork stub; replace it in the Project setup epic\n`, name);
    const shim = readFileSync(`${DEPLOY_STUBS_DIR}${name}.cmd`, 'utf8');
    assert.match(shim, new RegExp(`"%~dp0${name}"`), name);
    assert.ok(!shim.replace(/\r\n/g, '').match(/[\r\n]/), `${name}.cmd line endings`);
  }
});

test('AC4: placeholders replaced literally; __DESCRIPTION__ outside .md throws', () => {
  const tree = build();
  for (const entry of tree.filter((candidate) => candidate.content !== undefined && !candidate.path.startsWith('.github/groundwork/'))) {
    assert.ok(!entry.content.includes('__ORG__') && !entry.content.includes('__REPO__'), entry.path);
  }
  assert.equal(find(tree, '.github/ISSUE_TEMPLATE/bug.md').content, 'Bug in acme/shop\n');
  const { entries, contents } = fixture();
  const poisoned = { ...contents, '.github/workflows/ci.yml': `${CI}name: __DESCRIPTION__\n` };
  assert.throws(
    () => buildBootstrapTree({ entries, contents: poisoned, ...OPTIONS }),
    (error) => error instanceof SettingsError && error.file === '.github/workflows/ci.yml',
  );
});

test('AC5: config.json and hotspots.json keep their sha; settingsFiles returns the settings files as text', () => {
  const { entries, contents } = fixture();
  const tree = buildBootstrapTree({ entries, contents, ...OPTIONS });
  assert.deepEqual(find(tree, '.github/groundwork/config.json'), {
    path: '.github/groundwork/config.json',
    mode: '100644',
    sha: 'sha-.github/groundwork/config.json',
  });
  assert.equal(find(tree, '.github/groundwork/hotspots.json').sha, 'sha-.github/groundwork/hotspots.json');
  assert.deepEqual(settingsFiles(tree, contents), {
    '.github/groundwork/config.json': '{"org":"__ORG__"}\n',
    '.github/groundwork/hotspots.json': '[]\n',
    [KIT_VERSION_PATH]: 'v9.9.9\n',
  });
});

test('AC6: a missing stub throws a one-line SettingsError naming the path', () => {
  for (const stub of ['verify', 'verify.cmd', 'README.md']) {
    const path = `scripts/groundwork/stubs/${stub}`;
    assert.throws(
      () => build(fixture({ omit: [path] })),
      (error) => error instanceof SettingsError && error.message.includes(path) && !error.message.includes('\n'),
    );
  }
  const noDocs = fixture({ omit: ['scripts/groundwork/stubs/docs/guide.md', 'scripts/groundwork/stubs/docs/sub/more.md'] });
  assert.throws(
    () => buildBootstrapTree({ ...noDocs, ...OPTIONS }),
    (error) => error instanceof SettingsError && /stubs\/docs\//.test(error.message),
  );
});

test('a kept .github blob or a stub without release text throws SettingsError naming the path', () => {
  for (const path of ['.github/workflows/ci.yml', 'scripts/groundwork/stubs/verify']) {
    const { entries, contents } = fixture();
    const withoutText = { ...contents };
    delete withoutText[path];
    assert.throws(
      () => buildBootstrapTree({ entries, contents: withoutText, ...OPTIONS }),
      (error) => error instanceof SettingsError && error.message.includes(path),
    );
  }
});

test('a release blob named like an Object.prototype key throws SettingsError, not TypeError', () => {
  const { entries, contents } = fixture();
  const inherited = [...entries, { path: '.github/constructor', mode: '100644', sha: 'sha-constructor' }];
  assert.throws(
    () => buildBootstrapTree({ entries: inherited, contents, ...OPTIONS }),
    (error) => error instanceof SettingsError && error.message.includes('.github/constructor'),
  );
});

test('output is sorted by path and each entry has exactly one of sha and content', () => {
  const tree = build();
  const paths = tree.map(({ path }) => path);
  assert.deepEqual(paths, [...paths].sort());
  for (const entry of tree) assert.equal(Number('sha' in entry) + Number('content' in entry), 1, entry.path);
});

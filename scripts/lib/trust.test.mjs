import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CONFIG_DIR, ConfigError, loadConfig } from './config.mjs';
import {
  isTrustedAuthor,
  latestLabeledEvent,
  normalizeLabel,
  normalizeLogin,
  requiredLabelActor,
  resolveActor,
  sameLogin,
  untrustedBlock,
  validLabels,
} from './trust.mjs';

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

const tempRoot = await mkdtemp(path.join(tmpdir(), 'groundwork-trust-'));
await mkdir(path.join(tempRoot, CONFIG_DIR), { recursive: true });
await writeFile(path.join(tempRoot, CONFIG_DIR, 'config.json'), JSON.stringify(fixtureConfig()));
const config = await loadConfig({ root: tempRoot });
await rm(tempRoot, { recursive: true, force: true });


const labeled = (label, login, createdAt = '2026-01-01T00:00:00Z') => ({
  event: 'labeled',
  label: { name: label },
  actor: { login },
  created_at: createdAt,
});

test('normalizeLogin trims and lower-cases', () => {
  assert.equal(normalizeLogin('  Acme-Owner '), 'acme-owner');
});

test('sameLogin is case-insensitive and false on empty input', () => {
  assert.equal(sameLogin('Acme-Owner', 'acme-owner'), true);
  assert.equal(sameLogin('a', 'b'), false);
  assert.equal(sameLogin('', ''), false);
  assert.equal(sameLogin('a', ''), false);
  assert.equal(sameLogin(undefined, undefined), false);
});

test('resolveActor maps owner, agent, apps and literal logins', () => {
  assert.equal(resolveActor('owner', config), 'acme-owner');
  assert.equal(resolveActor('agent', config), 'acme-agent');
  assert.equal(resolveActor('app:release', config), 'acme-release[bot]');
  assert.equal(resolveActor('Dependabot[bot]', config), 'dependabot[bot]');
});

test('resolveActor throws ConfigError for an unknown app key', () => {
  assert.throws(() => resolveActor('app:nope', config), ConfigError);
});

test('isTrustedAuthor honours scopes per kind', () => {
  const trusted = (login, kind) => isTrustedAuthor({ login, kind }, config);
  for (const kind of ['issue', 'pull-request', 'comment']) {
    assert.equal(trusted('Acme-Owner', kind), true, `owner ${kind}`);
    assert.equal(trusted('acme-agent', kind), true, `agent ${kind}`);
  }
  assert.equal(trusted('acme-admin[bot]', 'issue'), true);
  assert.equal(trusted('acme-admin[bot]', 'pull-request'), false);
  assert.equal(trusted('acme-admin[bot]', 'comment'), false);
  assert.equal(trusted('acme-release[bot]', 'pull-request'), true);
  assert.equal(trusted('acme-release[bot]', 'issue'), false);
  assert.equal(trusted('dependabot[bot]', 'pull-request'), true);
  assert.equal(trusted('dependabot[bot]', 'comment'), false);
  assert.equal(trusted('stranger', 'issue'), false);
  assert.equal(trusted('', 'issue'), false);
  assert.equal(trusted('acme-owner', 'unknown-kind'), false);
});

test('requiredLabelActor prefers exact keys, then longest prefix, else null', () => {
  assert.equal(requiredLabelActor('accepted', config), 'acme-owner');
  assert.equal(requiredLabelActor('dependencies', config), 'dependabot[bot]');
  assert.equal(requiredLabelActor('automated', config), 'acme-release[bot]');
  assert.equal(requiredLabelActor('priority:high', config), 'acme-owner');
  assert.equal(requiredLabelActor('bug', config), null);

  const custom = {
    ...config,
    labelActors: { 'p*': 'agent', 'priority:*': 'owner', 'priority:high': 'app:admin' },
  };
  assert.equal(requiredLabelActor('priority:high', custom), 'acme-admin[bot]');
  assert.equal(requiredLabelActor('priority:low', custom), 'acme-owner');
  assert.equal(requiredLabelActor('pizza', custom), 'acme-agent');
});

test('latestLabeledEvent returns the last labeled event for the label', () => {
  const timeline = [
    labeled('accepted', 'A', '2026-01-01T00:00:00Z'),
    { event: 'unlabeled', label: { name: 'accepted' }, actor: { login: 'A' }, created_at: '2026-01-02T00:00:00Z' },
    labeled('accepted', 'Acme-Owner', '2026-01-03T00:00:00Z'),
    labeled('other', 'B', '2026-01-04T00:00:00Z'),
    { event: 'commented', created_at: '2026-01-05T00:00:00Z' },
  ];
  assert.deepEqual(latestLabeledEvent(timeline, 'accepted'), { actor: 'acme-owner', createdAt: '2026-01-03T00:00:00Z' });
  assert.equal(latestLabeledEvent(timeline, 'missing'), null);
  assert.equal(latestLabeledEvent([], 'accepted'), null);
});

test('validLabels drops protected labels from the wrong or missing actor', () => {
  const labels = ['accepted', 'priority:high', 'bug', 'dependencies'];
  const timeline = [
    labeled('accepted', 'someone-else'),
    labeled('priority:high', 'ACME-OWNER'),
    labeled('bug', 'anyone'),
  ];
  assert.deepEqual(validLabels({ labels, timeline }, config), ['priority:high', 'bug']);
});

test('validLabels uses the latest labeled event and compares actors case-insensitively', () => {
  const timeline = [labeled('accepted', 'acme-owner', '2026-01-01T00:00:00Z'), labeled('accepted', 'intruder', '2026-01-02T00:00:00Z')];
  assert.deepEqual(validLabels({ labels: ['accepted'], timeline }, config), []);
  const rightActor = [labeled('accepted', 'intruder'), labeled('accepted', 'Acme-Owner')];
  assert.deepEqual(validLabels({ labels: ['accepted'], timeline: rightActor }, config), ['accepted']);
});

test('validLabels keeps a protected label applied by an app bot', () => {
  const timeline = [labeled('automated', 'Acme-Release[bot]')];
  assert.deepEqual(validLabels({ labels: ['automated'], timeline }, config), ['automated']);
});

test('untrustedBlock fence is longer than any backtick run in the text', () => {
  assert.equal(untrustedBlock('hi', 'bob'), '```untrusted bob\nhi\n```');
  const text = 'a ```` b `` c';
  const block = untrustedBlock(text, 'bob');
  assert.equal(block, `\`\`\`\`\`untrusted bob\n${text}\n\`\`\`\`\``);
  const fence = block.match(/^`+/)[0];
  assert.ok(fence.length > 4);
});

test('untrustedBlock keeps the info string on one line', () => {
  const block = untrustedBlock('x', 'bob\nevil');
  assert.equal(block.split('\n')[0], '```untrusted bobevil');
});

test('resolveActor classifies refs case-insensitively after trimming', () => {
  assert.equal(resolveActor('Owner', config), 'acme-owner');
  assert.equal(resolveActor(' AGENT ', config), 'acme-agent');
  assert.equal(resolveActor(' App:release', config), 'acme-release[bot]');
  assert.throws(() => resolveActor(' App:nope', config), ConfigError);
});

test('isTrustedAuthor rejects prototype property names as kind', () => {
  assert.equal(isTrustedAuthor({ login: 'acme-owner', kind: 'constructor' }, config), false);
  assert.equal(isTrustedAuthor({ login: 'acme-owner', kind: 'toString' }, config), false);
});

test('normalizeLabel lower-cases without trimming', () => {
  assert.equal(normalizeLabel('Accepted'), 'accepted');
  assert.equal(normalizeLabel(' A '), ' a ');
});

test('label lookups ignore case', () => {
  assert.equal(requiredLabelActor('Accepted', config), 'acme-owner');
  assert.equal(requiredLabelActor('PRIORITY:High', config), 'acme-owner');
  const timeline = [labeled('ACCEPTED', 'acme-owner')];
  assert.equal(latestLabeledEvent(timeline, 'accepted')?.actor, 'acme-owner');
  assert.deepEqual(validLabels({ labels: ['Accepted'], timeline }, config), ['Accepted']);
});

test('validLabels drops a protected label whose latest event has no actor', () => {
  const timeline = [{ event: 'labeled', label: { name: 'accepted' }, created_at: '2026-01-01T00:00:00Z' }];
  assert.deepEqual(validLabels({ labels: ['accepted'], timeline }, config), []);
});

test('untrustedBlock strips unsafe characters from the author', () => {
  const block = untrustedBlock('x', 'bo`b <evil>');
  assert.equal(block.split('\n')[0], '```untrusted bobevil');
});

test('untrustedBlock tolerates null text and author', () => {
  assert.equal(untrustedBlock(null, undefined), '```untrusted \n\n```');
});

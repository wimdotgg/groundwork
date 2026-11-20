import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from '../lib/config.mjs';
import { createFixtureClient } from '../lib/github.mjs';
import { parseSections, parseStateSection } from '../lib/markdown.mjs';
import { CheckpointError, resolveSession, runCheckpoint, sessionFromHookInput } from './checkpoint.mjs';

const root = repoRoot(import.meta.url);
const repo = { owner: 'o', repo: 'r' };
const FOOTER = '---\nAgent: sonnet/claude-code · session w87-a1';
const PR_BODY = `Closes #87\n\n## Summary\n- Problem: x\n\n## State  (checkpoint 2 · 2026-11-20 10:00 · sonnet/claude-code · session w87-a1)\nDone:        none\nOpen:        none\n\n${FOOTER}\n`;
const FIELDS = {
  Done: 'AC1', 'In progress': 'AC2', Next: 'AC3', Proven: 'AC1', Unproven: 'AC2', Rejected: 'none', Gotchas: 'none', Open: 'none',
};
const NOW = () => new Date('2026-11-20T12:34:56Z');

function setup({ branch = 'issue/87', pr = { number: 5, draft: true, body: PR_BODY }, pushCode = 0, commentStatus = 201 } = {}) {
  const calls = [];
  const gitCalls = [];
  const routes = {
    'GET /repos/o/r/pulls?head=o%3Aissue%2F87&state=open': { status: 200, data: pr ? [pr] : [], headers: {} },
    'PATCH /repos/o/r/pulls/5': { status: 200, data: {}, headers: {} },
    'POST /repos/o/r/issues/5/comments': { status: commentStatus, data: {}, headers: {} },
  };
  const bodies = [];
  const client = createFixtureClient(routes, { onCall: (record) => calls.push(`${record.method} ${record.path}`) });
  const request = client.request.bind(client);
  client.request = (method, route, options) => {
    if (options?.body) bodies.push({ method, route, body: options.body });
    return request(method, route, options);
  };
  const git = async (args) => {
    gitCalls.push(args.join(' '));
    if (args[0] === 'rev-parse') return { code: 0, stdout: `${branch}\n`, stderr: '' };
    return { code: pushCode, stdout: '', stderr: pushCode === 0 ? '' : 'rejected: non-fast-forward\n' };
  };
  return { calls, gitCalls, bodies, client, git };
}

async function withInput(content, test_) {
  const dir = await mkdtemp(path.join(tmpdir(), 'checkpoint-'));
  const file = path.join(dir, 'checkpoint.json');
  if (content !== null) await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  try {
    await test_(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const options = (input, extra = {}) => ({ session: 'w87-a1', input, auto: false, ...extra });
const run = (env, opts) => runCheckpoint({ options: opts, root, client: env.client, repo, git: env.git, now: NOW });
const valid = { fields: FIELDS, journal: 'Built the push step.\nNo blockers.' };

test('AC3: --auto takes the session from the hook stdin JSON', () => {
  assert.equal(sessionFromHookInput('{"session_id":"abc-123","hook_event_name":"Stop"}'), 'abc-123');
  for (const text of ['', 'not json', '{}', '{"session_id":"a b"}', '[]', 'null']) assert.equal(sessionFromHookInput(text), '', text);
});

test('resolveSession prefers the configured session and reads the hook input only without one', async () => {
  const hook = async () => '{"session_id":"hook-1"}';
  const unused = async () => assert.fail('hook input read although a session was configured');
  assert.equal(await resolveSession('env-1', unused), 'env-1');
  assert.equal(await resolveSession('', hook), 'hook-1');
  assert.equal(await resolveSession('', async () => ''), '');
});

const SCRIPT =fileURLToPath(new URL('./checkpoint.mjs', import.meta.url));
const runScript = (input, session) => {
  const env = { ...process.env, GROUNDWORK_SESSION: session };
  if (session === undefined) delete env.GROUNDWORK_SESSION;
  return spawnSync(process.execPath, [SCRIPT, '--auto', '--json'], { input, env, encoding: 'utf8' });
};

test('AC3: --auto with no session in env or stdin exits 0 and writes nothing', () => {
  for (const input of ['', '{}', 'not json']) {
    const result = runScript(input);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, skipped: 'no session id' });
  }
});

test('AC1: pushes, rewrites State with the next checkpoint number, keeps the footer, posts the journal, deletes input', async () => {
  const env = setup();
  await withInput(valid, async (file) => {
    const result = await run(env, options(file));
    assert.deepEqual(result, { ok: true, number: 87, pr: 5, checkpoint: 3 });
    assert.deepEqual(env.gitCalls, ['rev-parse --abbrev-ref HEAD', 'push origin issue/87']);
    assert.deepEqual(env.calls.filter((call) => !call.startsWith('GET')), [
      'PATCH /repos/o/r/pulls/5', 'POST /repos/o/r/issues/5/comments',
    ]);
    const [edit, comment] = env.bodies;
    const state = parseSections(edit.body.body).sections.find((section) => section.name === 'State');
    const parsed = parseStateSection(state);
    assert.deepEqual(parsed.header, {
      checkpoint: '3', at: '2026-11-20 12:34', agent: 'sonnet/claude-code', session: 'w87-a1',
    });
    assert.equal(parsed.fields.Done, 'AC1');
    assert.ok(edit.body.body.endsWith(`${FOOTER}\n`));
    assert.ok(edit.body.body.startsWith('Closes #87'));
    assert.match(comment.body.body, /^Checkpoint 3 · 2026-11-20 12:34 · sonnet\/claude-code · session w87-a1\nBuilt the push step\.\nNo blockers\.\n/);
    assert.match(comment.body.body, /<!-- groundwork:checkpoint -->/);
    assert.equal(existsSync(file), false);
  });
});

test('AC2: placeholders and over-limit text are refused before any write', async () => {
  const cases = [
    ['State placeholder', { fields: { ...FIELDS, Next: 'do <thing>' }, journal: 'ok' }, /placeholder/],
    ['State over limit', { fields: { ...FIELDS, Done: Array.from({ length: 40 }, () => 'x').join('\n') }, journal: 'ok' }, /State is over 40/],
    ['journal over limit', { fields: FIELDS, journal: Array.from({ length: 11 }, () => 'x').join('\n') }, /journal is over 10/],
    ['empty field', { fields: { ...FIELDS, Open: ' ' }, journal: 'ok' }, /Open/],
    ['footer-like line', { fields: { ...FIELDS, Gotchas: 'a\n---\nb' }, journal: 'ok' }, /split.*Gotchas/],
    ['heading line', { fields: { ...FIELDS, Gotchas: 'a\n## Review log' }, journal: 'ok' }, /split.*Gotchas/],
    ['null input', 'null', /JSON object/],
  ];
  for (const [name, input, reason] of cases) {
    const env = setup();
    await withInput(input, async (file) => {
      await assert.rejects(run(env, options(file)), (error) => error instanceof CheckpointError && reason.test(error.message), name);
      assert.deepEqual(env.gitCalls, ['rev-parse --abbrev-ref HEAD'], name);
      assert.deepEqual(env.calls.filter((call) => !call.startsWith('GET')), [], name);
      assert.equal(existsSync(file), true, name);
    });
  }
});

test('journal text with angle brackets is not a placeholder', async () => {
  const env = setup();
  await withInput({ fields: FIELDS, journal: 'Added Map<string, number> cache' }, async (file) => {
    assert.equal((await run(env, options(file))).checkpoint, 3);
  });
});

test('AC3: a rejected push exits non-zero before the PR is edited', async () => {
  const env = setup({ pushCode: 1 });
  await withInput(valid, async (file) => {
    await assert.rejects(run(env, options(file)), /push of issue\/87 was rejected: rejected: non-fast-forward/);
    assert.deepEqual(env.calls.filter((call) => !call.startsWith('GET')), []);
    assert.equal(existsSync(file), true);
  });
});

test('AC4: --auto skips with no write off an issue branch, with no PR, or on a ready PR', async () => {
  const skipped = [
    [setup({ branch: 'main' }), /not on an issue/],
    [setup({ pr: null }), /no open PR/],
    [setup({ pr: { number: 5, draft: false, body: PR_BODY } }), /not a draft/],
  ];
  for (const [env, reason] of skipped) {
    const result = await run(env, options('unused.json', { auto: true }));
    assert.match(result.skipped, reason);
    assert.equal(env.gitCalls.some((call) => call.startsWith('push')), false);
    assert.deepEqual(env.calls.filter((call) => !call.startsWith('GET')), []);
  }
});

test('--auto without an input file pushes after the footer check and writes nothing else', async () => {
  const env = setup();
  await withInput(null, async (file) => {
    const result = await run(env, options(file, { auto: true }));
    assert.deepEqual(result, { ok: true, number: 87, pr: 5, checkpoint: 2 });
    assert.deepEqual(env.gitCalls, ['rev-parse --abbrev-ref HEAD', 'push origin issue/87']);
    assert.deepEqual(env.calls.filter((call) => !call.startsWith('GET')), []);
  });
});

test('footer naming another session exits 3 before any push, with and without --auto', async () => {
  for (const auto of [true, false]) {
    const env = setup({ pr: { number: 5, draft: true, body: PR_BODY.replace(FOOTER, FOOTER.replace('w87-a1', 'other')) } });
    await withInput(valid, async (file) => {
      await assert.rejects(
        run(env, options(file, { auto })),
        (error) => error.exitCode === 3 && /names session other/.test(error.message),
      );
      assert.equal(env.gitCalls.some((call) => call.startsWith('push')), false);
      assert.deepEqual(env.calls.filter((call) => !call.startsWith('GET')), []);
    });
  }
});

test('without --auto a missing input file or branch is an error', async () => {
  await withInput(null, async (file) => {
    await assert.rejects(run(setup(), options(file)), /not found/);
  });
  await assert.rejects(run(setup({ branch: 'main' }), options('x.json')), /not on an issue/);
});

test('invalid JSON input is refused', async () => {
  await withInput('{nope', async (file) => {
    await assert.rejects(run(setup(), options(file)), /not valid JSON/);
  });
});

test('session id is required', async () => {
  await assert.rejects(run(setup(), options('x', { session: '' })), /session id required/);
});

test('a State at exactly stateLines is accepted', async () => {
  const input = { fields: { ...FIELDS, Done: Array.from({ length: 32 }, () => 'x').join('\n') }, journal: 'ok' };
  await withInput(input, async (file) => {
    assert.equal((await run(setup(), options(file))).checkpoint, 3);
  });
});

test('a missing or malformed footer is refused before any push', async () => {
  for (const body of [PR_BODY.replace(FOOTER, ''), PR_BODY.replace('session w87-a1\n', 'session\n')]) {
    const env = setup({ pr: { number: 5, draft: true, body } });
    await withInput(valid, async (file) => {
      await assert.rejects(run(env, options(file)), (error) => error.exitCode === 1 && /no Agent footer/.test(error.message));
      assert.equal(env.gitCalls.some((call) => call.startsWith('push')), false);
    });
  }
});

test('a missing or non-numeric State checkpoint is refused, not read as 0', async () => {
  for (const header of ['## State', '## State  (checkpoint abc · t · a/b · session w87-a1)']) {
    const env = setup({ pr: { number: 5, draft: true, body: PR_BODY.replace(/## State.*\n/, `${header}\n`) } });
    await withInput(valid, async (file) => {
      await assert.rejects(run(env, options(file)), /no State checkpoint number/);
      assert.equal(env.gitCalls.some((call) => call.startsWith('push')), false);
    });
  }
});

test('--auto with an input file runs the full checkpoint', async () => {
  const env = setup();
  await withInput(valid, async (file) => {
    assert.deepEqual(await run(env, options(file, { auto: true })), { ok: true, number: 87, pr: 5, checkpoint: 3 });
    assert.equal(env.bodies.length, 2);
    assert.equal(existsSync(file), false);
  });
});

test('a failed journal post throws and keeps the input file', async () => {
  const env = setup({ commentStatus: 500 });
  await withInput(valid, async (file) => {
    await assert.rejects(run(env, options(file)), /500|POST/);
    assert.equal(existsSync(file), true);
  });
});

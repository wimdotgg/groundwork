import { GitHubError, apiPath } from '../lib/github.mjs';
import * as bootstrap from './bootstrap.mjs';
import { inspectRepo } from './bootstrap-repo.mjs';
import { runProbes } from './selftest-probes.mjs';

/** Op identity, read by admin-run (12.1). */
export const OP = 'selftest';

/** The throwaway repository does not exist at dispatch, so the op mints through `ctx.withToken` like `bootstrap`. */
export const TOKEN_SCOPE = 'deferred';

/** The op names its own repository; `target_repo` must be empty. */
export const TAKES_TARGET_REPO = false;

export const SELFTEST_REPO_PREFIX = 'selftest-';

/** The three grants are `bootstrap`'s (12.1). */
export const PERMISSIONS = bootstrap.PERMISSIONS;
export const CREATE_PERMISSIONS = bootstrap.CREATE_PERMISSIONS;
export const CONTROL_READ_PERMISSIONS = bootstrap.CONTROL_READ_PERMISSIONS;

const RUN_ID_PATTERN = /^[0-9]+$/;
const REPO_PATH = '/repos/{org}/{repo}';
const SKIPPED = 'skipped: bootstrap failed';

/**
 * @param {Record<string, string|undefined>} env
 * @returns {string} `selftest-<GITHUB_RUN_ID>`
 */
export function targetRepo(env) {
  const runId = env.GITHUB_RUN_ID ?? '';
  if (!RUN_ID_PATTERN.test(runId)) throw new GitHubError('GITHUB_RUN_ID must be digits');
  return `${SELFTEST_REPO_PREFIX}${runId}`;
}

/**
 * Keyed on the name `targetRepo` builds from `env`, never on a caller-supplied repository, so no grant can name an existing repository.
 * @returns {Array<{ repositories: string[], permissions: object, match: 'exact'|'subset' }>}
 */
export function grants({ env, controlRepo }) {
  return [
    { repositories: [controlRepo], permissions: CONTROL_READ_PERMISSIONS, match: 'exact' },
    { repositories: [controlRepo], permissions: CREATE_PERMISSIONS, match: 'exact' },
    { repositories: [targetRepo(env)], permissions: PERMISSIONS, match: 'subset' },
  ];
}

/** @returns {string[]} problems; the op takes no arguments */
export function validateArgs(args) {
  return Object.keys(args).map((key) => `unknown argument "${key}"`);
}

const CELL_MAX_LENGTH = 200;
const errorText = (error) => error?.message ?? String(error);

/** Detail text can carry API error text: printable ASCII, no code-span, tag or cell characters, bounded length. */
const cell = (text) => String(text ?? '').replace(/[^\x20-\x7e]+/g, ' ').replace(/[`<>|]/g, "'").trim().slice(0, CELL_MAX_LENGTH);

/** A thrown error becomes a failed row, so one failing step never skips the archive. */
async function attempt(id, step) {
  try {
    return await step();
  } catch (error) {
    return [{ id, ok: false, detail: errorText(error) }];
  }
}

const archive = (ctx) => ctx.withToken({ repositories: [ctx.repo], permissions: PERMISSIONS }, async ({ client }) => {
  await client.request('PATCH', apiPath(REPO_PATH, { org: ctx.org, repo: ctx.repo }), { body: { archived: true } });
  return [{ id: 'archive', ok: true, detail: 'archived' }];
});

function renderSummary({ org, repo }, rows, checkSummary) {
  const ok = rows.every((row) => row.ok);
  const lines = [
    `### selftest ${org}/${repo}`,
    '',
    `Result: **${ok ? 'pass' : 'fail'}**`,
    '',
    '| Step | Result | Detail |',
    '|---|---|---|',
    ...rows.map((row) => `| ${cell(row.id)} | ${row.ok ? 'pass' : 'fail'} | ${cell(row.detail)} |`),
  ];
  const checkRow = rows.find((row) => row.id === 'check');
  if (checkRow?.ok === false && checkSummary !== undefined) lines.push('', checkSummary);
  return lines.join('\n');
}

/** An existing repository this kit did not create must never be archived; an unreadable state counts as refused. */
async function refusalReason(ctx, inspect) {
  const read = { repositories: [ctx.config.controlRepo], permissions: CONTROL_READ_PERMISSIONS };
  try {
    const state = await ctx.withToken(read, ({ client }) => inspect({ client, org: ctx.org, repo: ctx.repo, adminBot: `${ctx.config.apps.admin}[bot]` }));
    return state === 'foreign' ? `${ctx.repo} exists and was not created by this kit` : undefined;
  } catch (error) {
    return `repository state unreadable: ${errorText(error)}`;
  }
}

/**
 * Bootstraps `selftest-<run id>`, checks it, runs the probes and archives it (12.1). The archive runs after any failed step
 * except a refusal of a repository this kit did not create.
 * @param {object} ctx admin-run context for a `deferred` op
 * @param {{ runBootstrap?: Function, probes?: Function, inspect?: Function }} [seams] tests only
 * @returns {Promise<{ ok: boolean, summary: string }>}
 */
export async function run(ctx, { runBootstrap = bootstrap.run, probes = runProbes, inspect = inspectRepo } = {}) {
  const repo = targetRepo(ctx.env);
  // Defence in depth: admin-run names the repository from the same function, but a mismatch must never reach a mint.
  if (ctx.repo !== repo || repo.toLowerCase() === ctx.config.controlRepo.toLowerCase()) {
    throw new GitHubError(`selftest refuses ${ctx.repo}: expected ${repo}`);
  }
  const refusal = await refusalReason(ctx, inspect);
  const bootstrapArgs = JSON.stringify({ description: `groundwork selftest ${ctx.env.GITHUB_RUN_ID}` });
  const bootstrapRows = refusal === undefined
    ? await attempt('bootstrap', async () => {
      await runBootstrap({ ...ctx, env: { ...ctx.env, INPUT_ARGS: bootstrapArgs } });
      return [{ id: 'bootstrap', ok: true, detail: 'pass 1 applied' }];
    })
    : [{ id: 'bootstrap', ok: false, detail: refusal }];
  const rows = [...bootstrapRows];
  let checkSummary;
  if (bootstrapRows[0].ok) {
    rows.push(...await attempt('check', async () => {
      const checked = await ctx.runCheck();
      checkSummary = checked.summary;
      return [{ id: 'check', ok: checked.ok, detail: checked.ok ? 'all rows match or deferred' : 'rows mismatch' }];
    }));
    rows.push(...await attempt('probes', () => ctx.withToken(
      { repositories: [repo], permissions: PERMISSIONS },
      ({ client }) => probes({ client, org: ctx.org, repo, log: ctx.log }),
    )));
  } else {
    rows.push({ id: 'check', ok: false, detail: SKIPPED }, { id: 'probes', ok: false, detail: SKIPPED });
  }
  rows.push(...(refusal === undefined ? await attempt('archive', () => archive(ctx)) : [{ id: 'archive', ok: false, detail: `not archived: ${refusal}` }]));
  return { ok: rows.every((row) => row.ok), summary: renderSummary({ org: ctx.org, repo }, rows, checkSummary) };
}

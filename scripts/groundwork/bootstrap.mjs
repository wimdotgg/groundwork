import { setTimeout as delay } from 'node:timers/promises';
import { SettingsError, repoKind } from '../lib/settings.mjs';
import { applySections, requireReleaseValues } from './apply-settings.mjs';
import {
  commitBootstrapTree, createRepo, inspectRepo, latestReleaseTag, readAdoptionGaps, readAdoptionReport, readBlobContents,
  readBlobTexts, readKitVersion, readReleaseTree, resolveTagCommit,
} from './bootstrap-repo.mjs';
import { buildBootstrapTree, contentPaths, settingsFiles } from './bootstrap-tree.mjs';
import { findSetupEpic, openSetupEpic, parseSetupTemplates } from './setup-epic.mjs';

const SETUP_TEMPLATES_DIR = 'scripts/groundwork/stubs/setup/';
const LABELS_PATH = '.github/groundwork/labels.json';

/** Op identity, read by admin-run (12.1). */
export const OP = 'bootstrap';

/** The repository does not exist when the run starts, so the op mints through `ctx.withToken` (12.1). */
export const TOKEN_SCOPE = 'deferred';

/** Token for everything after the repository exists; shown in `plan`. Keys are the snake_case names of 12.1. */
export const PERMISSIONS = {
  administration: 'write',
  contents: 'write',
  workflows: 'write',
  environments: 'write',
  actions_variables: 'write',
  issues: 'write',
  members: 'read',
  actions: 'read',
};

/** Token for the `POST /orgs/{org}/repos` call alone (2.4). */
export const CREATE_PERMISSIONS = { administration: 'write' };

/** Token for reading `groundwork` and the target's existence, both public data (12.1). */
export const CONTROL_READ_PERMISSIONS = { contents: 'read' };

export const DESCRIPTION_MAX_LENGTH = 350;

const ACCEPTED_LABEL = 'accepted';
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const ALLOWED_KEYS = new Set(['description', 'adopt']);
const NOTHING_TO_ADOPT = new Set(['absent', 'fresh']);
const STOPPED_AFTER_PREFLIGHT = 'adopt: stopped after the preflight: the kit merge (#274) is not built, so no write was made';

/**
 * @param {object} args parsed JSON object from the dispatch input
 * @returns {string[]} one error per problem; empty when valid
 */
export function validateArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return ['args must be a JSON object'];
  const unknown = Object.keys(args).filter((key) => !ALLOWED_KEYS.has(key)).map((key) => `unknown argument "${key}"`);
  // An adopt key with any value but true is reported beside the unknown keys.
  if (Object.hasOwn(args, 'adopt') && args.adopt !== true) unknown.push('adopt must be true when given');
  const { description } = args;
  if (typeof description !== 'string' || description === '') return [...unknown, 'description is required: a non-empty string'];
  if (description.length > DESCRIPTION_MAX_LENGTH) return [...unknown, `description must be at most ${DESCRIPTION_MAX_LENGTH} characters`];
  if (!PRINTABLE_ASCII.test(description)) return [...unknown, 'description must be printable ASCII'];
  return unknown;
}

/** @param {Record<string, string|undefined>} env the dispatch input, re-validated because `ctx` carries no args */
function readArgs(env) {
  let args;
  try {
    args = JSON.parse(env.INPUT_ARGS);
  } catch {
    throw new SettingsError('bootstrap: INPUT_ARGS is not valid JSON');
  }
  const problems = validateArgs(args);
  if (problems.length > 0) throw new SettingsError(`bootstrap: ${problems.join('; ')}`);
  return args;
}

function setupTemplateFiles(contents) {
  return Object.fromEntries(Object.entries(contents)
    .filter(([path]) => path.startsWith(SETUP_TEMPLATES_DIR))
    .map(([path, text]) => [path.slice(SETUP_TEMPLATES_DIR.length), text]));
}

/** @returns {string|undefined} why the target state rules the run out */
function refusal(state, { org, repo, adopt }) {
  // Both bootstrap tokens read public data only, so a private repository inspects as absent.
  if (adopt && NOTHING_TO_ADOPT.has(state)) return `adopt: ${org}/${repo} is ${state === 'absent' ? 'absent or private (these tokens read public data only)' : state}, nothing to adopt`;
  if (state === 'foreign' && !adopt) return `${org}/${repo} exists and is neither a groundwork project nor a fresh auto_init repository`;
  return undefined;
}

/** The built kit tree of 14.2 step 5 for `tag`. */
async function readKit({ client, org, controlRepo, repo, description, tag }) {
  const tagSha = await resolveTagCommit({ client, org, controlRepo, tag });
  const entries = await readReleaseTree({ client, org, controlRepo, commitSha: tagSha });
  const contents = await readBlobTexts({ client, org, controlRepo, entries, paths: contentPaths(entries) });
  const treeEntries = buildBootstrapTree({ entries, contents, org, controlRepo, repo, description, tag, tagSha });
  return { treeEntries, contents };
}

/** Steps 1 and 2 of 14.2 plus everything derived from the release tree, so a bad template fails before any write. */
async function readSource({ client, org, controlRepo, repo, args, adminBot }) {
  const { description } = args;
  const state = await inspectRepo({ client, org, repo, adminBot });
  const refused = refusal(state, { org, repo, adopt: args.adopt === true });
  if (refused !== undefined) throw new SettingsError(refused);
  if (state === 'ours') await refuseAfterSetupAcceptance({ client, org, repo, adminBot });
  const tag = state === 'ours'
    ? await readKitVersion({ client, org, repo })
    : await latestReleaseTag({ client, org, controlRepo });
  const { treeEntries, contents } = await readKit({ client, org, controlRepo, repo, description, tag });
  // Spec 14.4: apply repeats the failing rows before any write; an adopted repository never gets the full-tree commit.
  if (state === 'foreign') {
    const { rows, headSha } = await readAdoptionGaps({ client, org, repo, kitEntries: treeEntries });
    return { state, tag, gaps: rows, headSha };
  }
  const templates = parseSetupTemplates(setupTemplateFiles(contents), { org, repo, description });
  // An `ours` repository already holds the commit, which reads no blob.
  const blobs = state === 'ours' ? new Map() : await readBlobContents({ client, org, controlRepo, entries: treeEntries });
  return { state, tag, treeEntries, contents, templates, blobs };
}

const gapLine = ({ name, fail, detail }) => `${fail ? 'FAIL' : 'ok'} ${name}: ${detail}`;

/** Until the kit merge ships, an adopt run ends here: it refuses on a failing row and otherwise stops without a write. */
function stopAfterPreflight({ heading, source, log }) {
  for (const row of source.gaps) log(gapLine(row));
  const failing = source.gaps.filter((row) => row.fail);
  if (failing.length > 0) throw new SettingsError(`adopt preflight failed: ${failing.map((row) => row.name).join(', ')}`);
  const rows = source.gaps.map((row) => `- ${gapLine(row)}`);
  const lines = ['- inspect: foreign', `- release tag: ${source.tag}`, `- target head: ${source.headSha}`, ...rows, `- ${STOPPED_AFTER_PREFLIGHT}`];
  return { ok: false, summary: [heading, '', ...lines].join('\n') };
}

/**
 * Spec 14.4 preflight, printed in admin-run `plan` before the owner approves. GET calls only, with the `plan` job's
 * token; failing rows do not fail `plan`, because `apply` repeats them and stops.
 */
export async function plan({ client, org, controlRepo, request, config }) {
  if (request.args.adopt !== true) return {};
  try {
    return await adoptionPlan({ client, org, controlRepo, request, config });
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    return { problem: error.message };
  }
}

function kitLabelNames(kit) {
  const labels = JSON.parse(settingsFiles(kit.treeEntries, kit.contents)[LABELS_PATH] ?? 'null')?.labels;
  if (!Array.isArray(labels)) throw new SettingsError(`${LABELS_PATH} in the release tree is missing or not a label list`);
  return labels.map((label) => label.name);
}

async function adoptionPlan({ client, org, controlRepo, request, config }) {
  const { targetRepo: repo, args } = request;
  const state = await inspectRepo({ client, org, repo, adminBot: `${config.apps.admin}[bot]` });
  if (state === 'ours') return { facts: ['Adopt: the target is a groundwork project, so bootstrap resumes as usual'] };
  const refused = refusal(state, { org, repo, adopt: true });
  if (refused !== undefined) return { problem: refused };
  const tag = await latestReleaseTag({ client, org, controlRepo });
  const kit = await readKit({ client, org, controlRepo, repo, description: args.description, tag });
  const { rows, empty } = await readAdoptionGaps({ client, org, repo, kitEntries: kit.treeEntries });
  const report = await readAdoptionReport({ client, org, repo, kitLabels: kitLabelNames(kit), empty });
  const failing = rows.filter((row) => row.fail).length;
  const outcome = failing > 0 ? 'apply stops before any write'
    : 'if the target is still foreign when apply runs, apply stops after the preflight with no write until the kit merge (#274) ships';
  const heading = `Adoption preflight of ${org}/${repo} against ${tag}: ${failing} failing row(s); ${outcome}`;
  return { facts: [heading, ...rows.map(gapLine), ...report.map(({ name, detail }) => `report ${name}: ${detail}`)] };
}

/** @returns {string[]} the `- step: result` lines of an `applySections` summary */
const stepLines = ({ summary }) => summary.split('\n').filter((line) => line.startsWith('- '));

/** Owner decision on #167 (Q4): once the setup epic is accepted or closed, `apply-settings` is the repair path. */
async function refuseAfterSetupAcceptance({ client, org, repo, adminBot }) {
  const epic = await findSetupEpic({ client, org, repo, adminBot });
  if (epic === undefined) return;
  const accepted = (epic.labels ?? []).some((label) => (label.name ?? label) === ACCEPTED_LABEL);
  if (!accepted && epic.state !== 'closed') return;
  throw new SettingsError(`${org}/${repo} setup epic #${epic.number} is ${accepted ? 'accepted' : 'closed'}: bootstrap will not rerun, use apply-settings to repair settings`);
}

async function applyToTarget({ ctx, source, adminBot, minted, seams }) {
  const { client, token } = minted;
  const { sleep, settingsDependencies } = seams;
  const { org, repo } = ctx;
  const { settingsRoot, config } = await ctx.writeSettings(settingsFiles(source.treeEntries, source.contents));
  const targetContext = { ...ctx, client, token, settingsRoot, config };
  const sections = (groups) => applySections(targetContext, groups, settingsDependencies);
  const lines = [];

  lines.push(...stepLines(await sections(['labels'])));
  const commit = await commitBootstrapTree({
    client, org, repo, tag: source.tag, treeEntries: source.treeEntries, blobs: source.blobs, sleep,
  });
  lines.push(`- bootstrap commit: ${commit.created ? `pushed ${commit.sha}` : 'already on main'}`);
  for (const groups of [['settings'], ['rulesets'], ['variables']]) lines.push(...stepLines(await sections(groups)));
  const epic = await openSetupEpic({ client, org, repo, templates: source.templates, adminBot, sleep });
  lines.push(`- setup epic: #${epic.epic}, ${epic.created.length} issue(s) created`);
  // GitHub seeds its default labels asynchronously after the repository is created, possibly during the first pass.
  const cleanup = await sections(['labels']);
  lines.push(...stepLines(cleanup).map((line) => line.replace('- labels:', '- labels (final pass):')));
  return lines;
}

/**
 * Pass 1 of spec 14.2, steps 1 to 9; admin-run adds the closing `check`. Every step is idempotent, so a
 * rerun after a failure resumes.
 * @param {object} ctx admin-run context for a `deferred` op
 * @param {{ sleep?: (ms: number) => Promise<unknown>, settingsDependencies?: object }} [seams] tests only
 * @returns {Promise<{ ok: boolean, summary: string }>}
 */
export async function run(ctx, { sleep = delay, settingsDependencies } = {}) {
  const { org, repo } = ctx;
  const { controlRepo, apps } = ctx.config;
  if (repoKind(repo, ctx.config) === 'control') throw new SettingsError(`bootstrap must not target the control repository ${controlRepo}`);
  const args = readArgs(ctx.env);
  const { description } = args;
  // The settings group needs these after the repository and the commit exist; failing here leaves nothing half-made.
  requireReleaseValues(ctx.env);
  const adminBot = `${apps.admin}[bot]`;

  ctx.log('reading the release tree');
  const source = await ctx.withToken(
    { repositories: [controlRepo], permissions: CONTROL_READ_PERMISSIONS },
    ({ client }) => readSource({ client, org, controlRepo, repo, args, adminBot }),
  );
  if (source.state === 'foreign') return stopAfterPreflight({ heading: `### ${OP} ${org}/${repo}`, source, log: ctx.log });
  const lines = [`- inspect: ${source.state}`, `- release tag: ${source.tag}`];
  if (source.state === 'absent') {
    ctx.log('creating the repository');
    await createRepo({ withToken: ctx.withToken, org, controlRepo, repo, description, permissions: CREATE_PERMISSIONS });
  }
  lines.push(`- create repository: ${source.state === 'absent' ? 'created' : 'skipped'}`);
  const applied = await ctx.withToken(
    { repositories: [repo], permissions: PERMISSIONS },
    (minted) => applyToTarget({ ctx, source, adminBot, minted, seams: { sleep, settingsDependencies } }),
  );
  return { ok: true, summary: [`### ${OP} ${org}/${repo}`, '', ...lines, ...applied].join('\n') };
}

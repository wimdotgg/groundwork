import { pathToFileURL } from 'node:url';
import { runValidator } from '../lib/ci.mjs';
import { apiPath } from '../lib/github.mjs';
import { SettingsError, compareStates, loadDesiredState, readLiveState, readSignals, repoKind } from '../lib/settings.mjs';

/** @typedef {import('../lib/ci.mjs').ValidatorContext} ValidatorContext */
/** @typedef {import('../lib/ci.mjs').ValidatorResult} ValidatorResult */
/** @typedef {import('../lib/settings.mjs').DesiredState} DesiredState */
/** @typedef {import('../lib/settings.mjs').LiveSection} LiveSection */
/** @typedef {import('../lib/settings.mjs').Signals} Signals */
/** @typedef {{ eventName: string, touched: boolean, repoKind: 'control'|'project', desired: DesiredState|null, loadError: string|null,
 *   live: Record<string, LiveSection>, signals: Signals|null, baseSettings: object|null }} SettingsPlanFacts   loadError: the SettingsError message */

export const name = 'settings-plan';

const PULL_REQUEST_EVENT = 'pull_request';
const SETTINGS_DIRECTORY = '.github/groundwork/';
const FILES_PATH = '/repos/{owner}/{repo}/pulls/{number}/files';
const BASE_SETTINGS_PATH = '/repos/{owner}/{repo}/contents/.github/groundwork/settings.json';
const NOT_FOUND = 404;
const MAX_LEAF_LENGTH = 60;
const MAX_CELL_LENGTH = 80;
const MAX_DIFF_PATHS = 5;
const PLACEHOLDER_NOTE = 'plan-only: App ID placeholder unresolved';
const PLACEHOLDER_PATTERN = /^\{\{app-id:[^{}]*\}\}$/;
const BYPASS_ACTORS_SUFFIX = '.bypass_actors';
const INTEGRATION_ACTOR = 'Integration';
const ORGANIZATION_ADMIN = 'OrganizationAdmin';
const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '|': '&#124;', '`': '&#96;', '[': '&#91;', ']': '&#93;' };

const skipFacts = (eventName, kind) => ({
  eventName, touched: false, repoKind: kind, desired: null, loadError: null, live: {}, signals: null, baseSettings: null,
});

/** PR-controlled text reaches the job summary, so it never carries markup, table breaks or links. */
function sanitize(text) {
  return String(text).replace(/\s+/g, ' ').trim().replace(/[&<>|`[\]]/g, (character) => HTML_ENTITIES[character]);
}

function touchesSettings(file) {
  return [file.filename, file.previous_filename].some((filename) => typeof filename === 'string' && filename.startsWith(SETTINGS_DIRECTORY));
}

/** @returns {Promise<object|null>} null when the base file is missing, empty, corrupt or not an object */
async function readBaseSettings(client, repo, baseSha) {
  const response = await client.request('GET', apiPath(BASE_SETTINGS_PATH, repo), { query: { ref: baseSha }, okStatuses: [NOT_FOUND] });
  if (response.status === NOT_FOUND || typeof response.data?.content !== 'string') return null;
  try {
    const parsed = JSON.parse(Buffer.from(response.data.content, 'base64').toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function environmentNamesFor(settings, kind) {
  const applies = (repos) => repos === 'all' || (repos === 'projects' && kind === 'project') || (repos === 'control' && kind === 'control');
  return Object.entries(settings.environments ?? {}).filter(([, spec]) => applies(spec.repos)).map(([environmentName]) => environmentName);
}

async function loadDesired(root) {
  try {
    return { desired: await loadDesiredState({ root }), loadError: null };
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    return { desired: null, loadError: error.message };
  }
}

/**
 * @param {ValidatorContext} ctx
 * @returns {Promise<SettingsPlanFacts>}
 */
export async function collect(ctx) {
  const kind = repoKind(ctx.repo.repo, ctx.config);
  if (ctx.eventName !== PULL_REQUEST_EVENT) return skipFacts(ctx.eventName, kind);
  const pullRequest = ctx.payload.pull_request;
  if (!Number.isInteger(pullRequest.changed_files)) throw new Error('pull_request.changed_files is missing from the event payload');
  const files = await ctx.client.paginate(apiPath(FILES_PATH, { ...ctx.repo, number: pullRequest.number }));
  // A short list could hide a settings file and skip the plan.
  if (files.length < pullRequest.changed_files) {
    throw new Error(`PR file list is incomplete: ${files.length} listed, ${pullRequest.changed_files} changed`);
  }
  if (!files.some(touchesSettings)) return skipFacts(ctx.eventName, kind);
  if (!ctx.env.PR_ROOT) throw new Error('PR_ROOT is not set: settings-plan needs the PR head checkout');
  const { desired, loadError } = await loadDesired(ctx.env.PR_ROOT);
  const facts = { ...skipFacts(ctx.eventName, kind), touched: true, desired, loadError };
  if (loadError !== null) return facts;
  const environmentNames = environmentNamesFor(desired.settings, kind);
  return {
    ...facts,
    live: await readLiveState(ctx.client, ctx.repo, { environmentNames }),
    signals: await readSignals(ctx.client, ctx.repo, { repoKind: kind }),
    baseSettings: await readBaseSettings(ctx.client, ctx.repo, pullRequest.base.sha),
  };
}

const isContainer = (value) => value !== null && typeof value === 'object';

/** Flattens objects and arrays to path/value pairs; an empty container is a leaf. */
function flatten(value, prefix = '') {
  if (!isContainer(value) || Object.keys(value).length === 0) return [[prefix, value]];
  return Object.entries(value).flatMap(([key, child]) => flatten(child, prefix === '' ? key : `${prefix}.${key}`));
}

function leafText(value) {
  if (value === undefined) return 'unset';
  const text = JSON.stringify(value);
  return text.length > MAX_LEAF_LENGTH ? `${text.slice(0, MAX_LEAF_LENGTH)}...` : text;
}

function differingPaths(desired, live) {
  const desiredLeaves = new Map(flatten(desired));
  const liveLeaves = new Map(flatten(live));
  const paths = [...new Set([...desiredLeaves.keys(), ...liveLeaves.keys()])].sort();
  return paths
    .filter((leafPath) => JSON.stringify(desiredLeaves.get(leafPath)) !== JSON.stringify(liveLeaves.get(leafPath)))
    .map((leafPath) => ({ leafPath, desired: desiredLeaves.get(leafPath), live: liveLeaves.get(leafPath) }));
}

function limitPaths(entries) {
  const shown = entries.slice(0, MAX_DIFF_PATHS);
  const rest = entries.length - shown.length;
  return rest > 0 ? [...shown, `+${rest} more`] : shown;
}

function plainCell(value) {
  if (value === null || value === undefined) return '';
  const text = JSON.stringify(value);
  return sanitize(text.length > MAX_CELL_LENGTH ? `${text.slice(0, MAX_CELL_LENGTH)}...` : text);
}

function normalizeActor(actor) {
  return JSON.stringify([actor.actor_type, actor.actor_type === ORGANIZATION_ADMIN ? null : actor.actor_id ?? null, actor.bypass_mode]);
}

function isPlaceholderActor(actor) {
  return typeof actor?.actor_id === 'string' && PLACEHOLDER_PATTERN.test(actor.actor_id);
}

/** Plan-only only when the placeholder actors are the whole difference: everything else already matches. */
function isPlanOnlyBypassRow(row) {
  if (row.result !== 'differ' || !row.key.endsWith(BYPASS_ACTORS_SUFFIX)) return false;
  if (!Array.isArray(row.desired) || !Array.isArray(row.live) || !row.desired.some(isPlaceholderActor)) return false;
  const desiredRest = row.desired.filter((actor) => !isPlaceholderActor(actor)).map(normalizeActor).sort();
  const liveRest = row.live.filter((actor) => actor?.actor_type !== INTEGRATION_ACTOR).map(normalizeActor).sort();
  return JSON.stringify(desiredRest) === JSON.stringify(liveRest);
}

function resultLabel(row) {
  return isPlanOnlyBypassRow(row) ? `${row.result} (${PLACEHOLDER_NOTE})` : row.result;
}

/** A differing object or array shows only the paths that differ, so truncation cannot hide the difference. */
function differCells(row) {
  if (row.result !== 'differ' || !(isContainer(row.desired) || isContainer(row.live))) return [plainCell(row.desired), plainCell(row.live)];
  const entries = differingPaths(row.desired, row.live);
  const render = (side) => sanitize(limitPaths(entries.map((entry) => `${entry.leafPath}: ${leafText(entry[side])}`)).join('; '));
  return [render('desired'), render('live')];
}

function renderRow(row) {
  const [desired, live] = differCells(row);
  return `| ${sanitize(row.section)} | ${sanitize(row.key)} | ${desired} | ${live} | ${sanitize(resultLabel(row))} |`;
}

function renderTable(rows) {
  const header = '| Section | Key | Desired | Live | Result |\n|---|---|---|---|---|';
  return [header, ...rows.map(renderRow)].join('\n');
}

function actionsFileDiff(baseSettings, desiredSettings) {
  if (baseSettings === null) return ['No usable base settings.json (missing, empty or invalid) to compare: the whole actions section is shown as new.'];
  return differingPaths(desiredSettings.actions ?? {}, baseSettings.actions ?? {})
    .map((entry) => `\`actions.${sanitize(entry.leafPath)}\`: ${sanitize(leafText(entry.live))} -> ${sanitize(leafText(entry.desired))}`);
}

function renderDetails(facts, rows) {
  const diff = actionsFileDiff(facts.baseSettings, facts.desired.settings);
  const diffList = diff.length === 0 ? 'No changes to the actions section.' : diff.map((line) => `- ${line}`).join('\n');
  return [
    '### Desired vs. live',
    '',
    renderTable(rows),
    '',
    'Ruleset bypass App IDs are not resolved in the PR run (the PR token cannot read `/apps`); rows marked plan-only compare the placeholder.',
    '',
    '### Actions settings (file diff against base)',
    '',
    'The PR token cannot read live Actions settings, so they are shown as a diff of `settings.json` against the base commit.',
    '',
    diffList,
    '',
  ].join('\n');
}

/**
 * @param {SettingsPlanFacts} facts
 * @param {import('../lib/config.mjs').Config} config
 * @returns {ValidatorResult}
 */
export function evaluate(facts, config) {
  if (facts.eventName !== PULL_REQUEST_EVENT || !facts.touched) return { conclusion: 'skip', errors: [], warnings: [], details: '', actions: [] };
  if (facts.loadError !== null) return { conclusion: 'fail', errors: [sanitize(facts.loadError)], warnings: [], details: '', actions: [] };
  const rows = compareStates(facts.desired, facts.live, { repoKind: facts.repoKind, config, signals: facts.signals });
  return { conclusion: 'pass', errors: [], warnings: [], details: renderDetails(facts, rows), actions: [] };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runValidator({ name, collect, evaluate }, { argv: process.argv, env: process.env, scriptUrl: import.meta.url });
}

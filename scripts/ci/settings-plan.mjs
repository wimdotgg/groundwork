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
const MAX_CELL_LENGTH = 80;
const PLACEHOLDER_NOTE = 'plan-only: App ID placeholder unresolved';
const PLACEHOLDER_PATTERN = /^\{\{app-id:[^{}]*\}\}$/;

const skipFacts = (eventName, kind) => ({
  eventName, touched: false, repoKind: kind, desired: null, loadError: null, live: {}, signals: null, baseSettings: null,
});

function touchesSettings(file) {
  return [file.filename, file.previous_filename].some((filename) => typeof filename === 'string' && filename.startsWith(SETTINGS_DIRECTORY));
}

async function readBaseSettings(client, repo, baseSha) {
  const response = await client.request('GET', apiPath(BASE_SETTINGS_PATH, repo), { query: { ref: baseSha }, okStatuses: [NOT_FOUND] });
  if (response.status === NOT_FOUND) return null;
  return JSON.parse(Buffer.from(response.data.content, 'base64').toString('utf8'));
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

function cell(value) {
  if (value === null || value === undefined) return '';
  const text = JSON.stringify(value).replace(/\|/g, '\\|');
  return text.length > MAX_CELL_LENGTH ? `${text.slice(0, MAX_CELL_LENGTH)}...` : text;
}

function hasPlaceholder(value) {
  if (typeof value === 'string') return PLACEHOLDER_PATTERN.test(value);
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(hasPlaceholder);
}

function resultLabel(comparison) {
  const planOnly = comparison.section === 'rulesets' && comparison.result !== 'match' && hasPlaceholder(comparison.desired);
  return planOnly ? `${comparison.result} (${PLACEHOLDER_NOTE})` : comparison.result;
}

function renderTable(rows) {
  const header = '| Section | Key | Desired | Live | Result |\n|---|---|---|---|---|';
  const lines = rows.map((row) => `| ${row.section} | ${row.key} | ${cell(row.desired)} | ${cell(row.live)} | ${resultLabel(row)} |`);
  return [header, ...lines].join('\n');
}

function leaves(value, prefix = '') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [[prefix, value]];
  return Object.entries(value).flatMap(([key, child]) => leaves(child, prefix === '' ? key : `${prefix}.${key}`));
}

function actionsFileDiff(baseSettings, desiredSettings) {
  if (baseSettings === null) return ['No base settings.json to compare: the whole actions section is new.'];
  const baseLeaves = new Map(leaves(baseSettings.actions ?? {}));
  const desiredLeaves = new Map(leaves(desiredSettings.actions ?? {}));
  const keys = [...new Set([...baseLeaves.keys(), ...desiredLeaves.keys()])].sort();
  return keys
    .filter((key) => JSON.stringify(baseLeaves.get(key)) !== JSON.stringify(desiredLeaves.get(key)))
    .map((key) => `\`actions.${key}\`: ${cell(baseLeaves.get(key)) || 'unset'} -> ${cell(desiredLeaves.get(key)) || 'unset'}`);
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
  if (facts.loadError !== null) return { conclusion: 'fail', errors: [facts.loadError], warnings: [], details: '', actions: [] };
  const rows = compareStates(facts.desired, facts.live, { repoKind: facts.repoKind, config, signals: facts.signals });
  return { conclusion: 'pass', errors: [], warnings: [], details: renderDetails(facts, rows), actions: [] };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runValidator({ name, collect, evaluate }, { argv: process.argv, env: process.env, scriptUrl: import.meta.url });
}

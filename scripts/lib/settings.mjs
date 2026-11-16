import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR, ConfigError } from './config.mjs';
import { GitHubError, apiPath } from './github.mjs';
import { resolveActor, sameLogin } from './trust.mjs';

/** @typedef {import('./config.mjs').Config} Config */
/** @typedef {{ name: string, color: string, description: string }} Label */
/** @typedef {{ name: string, target: 'branch'|'tag', enforcement: string, conditions: object, bypass_actors: object[], rules: object[] }} Ruleset   no id */
/** @typedef {{ settings: object, labels: Label[], rulesets: Ruleset[] }} DesiredState   settings is settings.json as parsed */
/** @typedef {{ readable: true, value: any } | { readable: false, status: number }} LiveSection */
/** @typedef {{ kitInstalled: boolean, codeScanningConfigured: boolean|null, pass2Ran: boolean|null }} Signals   null when unreadable */
/** @typedef {{ section: string, key: string, desired: any, live: any, result: 'match'|'differ'|'missing'|'extra'|'unreadable'|'deferred' }} ComparisonRow */
/**
 * Live section values (`LiveSection.value`) that `compareStates` expects; `readLiveState` normalizes the REST
 * responses into these shapes.
 *   repository:   GET /repos/{o}/{r} body (object; only the keys named in settings.json are read)
 *   teamAccess:   Array<{ team: string, permission: string }>, one entry per team with access to the repo
 *   security:     { private_vulnerability_reporting: boolean, vulnerability_alerts: boolean,
 *                   automated_security_fixes: boolean, code_scanning_default_setup: { state: string } }
 *   actions:      { permissions: object, workflow: object, fork_pr_contributor_approval: object },
 *                 the bodies of the three /actions/permissions endpoints
 *   variables:    Array<{ name: string, value: string }>, GET /actions/variables `variables`
 *   environments: Array<{ name: string, can_admins_bypass: boolean, prevent_self_review: boolean,
 *                   reviewers: string[] (logins), deployment_refs: Array<{ name: string, type: 'branch'|'tag' }>,
 *                   secrets: string[] (names), variables: string[] (names) }>
 *   labels:       Array<{ name: string, color: string, description: string|null }>, GET /labels
 *   rulesets:     Array<object>, one full GET /rulesets/{id} body per ruleset
 */

const SETTINGS_FILE = 'settings.json';
const LABELS_FILE = 'labels.json';
const RULESETS_DIR = 'rulesets';
const PLACEHOLDER_OPEN = '{{';
const APP_PLACEHOLDER = /^\{\{app-id:([^{}]*)\}\}$/;
const SETTINGS_KEYS = [
  'schemaVersion', 'repository', 'controlRepository', 'teamAccess', 'security', 'actions', 'variables', 'environments',
];
const ASSERT_WHEN_VALUES = ['kitInstalled', 'deployReady'];
const CODE_SCANNING_RULE = 'code_scanning';
const CODE_SCANNING_SETUP_KEY = 'code_scanning_default_setup';
const ORGANIZATION_ADMIN = 'OrganizationAdmin';
const MAIN_RULESET = 'main';

export class SettingsError extends Error {
  /**
   * @param {string} message one-line description
   * @param {string} [file] path of the offending file
   */
  constructor(message, file) {
    super(String(message).replace(/\s+/g, ' ').trim());
    this.name = 'SettingsError';
    this.file = file;
  }
}

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

async function readJsonFile(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    const reason = error.code === 'ENOENT' ? 'file not found' : error.message;
    throw new SettingsError(`${path.basename(file)}: ${reason}`, file);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SettingsError(`${path.basename(file)}: invalid JSON (${error.message})`, file);
  }
}

function checkSettings(file, settings) {
  if (!isPlainObject(settings)) throw new SettingsError(`${SETTINGS_FILE}: must be a JSON object`, file);
  const unknown = Object.keys(settings).filter((key) => !SETTINGS_KEYS.includes(key));
  if (unknown.length > 0) throw new SettingsError(`${SETTINGS_FILE}: unknown top-level key "${unknown[0]}"`, file);
  for (const [name, variable] of Object.entries(settings.variables ?? {})) {
    if (!ASSERT_WHEN_VALUES.includes(variable?.assertWhen)) {
      throw new SettingsError(
        `${SETTINGS_FILE}: variable ${name} assertWhen must be ${ASSERT_WHEN_VALUES.join(' or ')}`,
        file,
      );
    }
  }
}

function checkLabels(file, labelsFile) {
  if (!isPlainObject(labelsFile) || !Array.isArray(labelsFile.labels)) {
    throw new SettingsError(`${LABELS_FILE}: "labels" must be an array`, file);
  }
  const seen = new Set();
  for (const label of labelsFile.labels) {
    const name = label?.name;
    if (typeof name !== 'string' || name === '') throw new SettingsError(`${LABELS_FILE}: label without a name`, file);
    if (seen.has(name.toLowerCase())) throw new SettingsError(`${LABELS_FILE}: duplicate label "${name}"`, file);
    seen.add(name.toLowerCase());
  }
}

function findStrayPlaceholder(value) {
  if (typeof value === 'string') return value.includes(PLACEHOLDER_OPEN) ? value : null;
  if (!value || typeof value !== 'object') return null;
  for (const child of Object.values(value)) {
    const found = findStrayPlaceholder(child);
    if (found !== null) return found;
  }
  return null;
}

function checkRuleset(file, ruleset, fileName) {
  const base = path.basename(fileName, '.json');
  if (!isPlainObject(ruleset)) throw new SettingsError(`${fileName}: must be a JSON object`, file);
  if (Object.hasOwn(ruleset, 'id')) throw new SettingsError(`${fileName}: ruleset files hold no id`, file);
  if (ruleset.name !== base) throw new SettingsError(`${fileName}: ruleset name "${ruleset.name}" must equal the file name`, file);
  const { bypass_actors: bypassActors = [], ...rest } = ruleset;
  const actorsWithoutIds = bypassActors.map(({ actor_id: _ignored, ...actor }) => actor);
  const stray = findStrayPlaceholder({ rest, actorsWithoutIds });
  if (stray !== null) throw new SettingsError(`${fileName}: placeholder "${stray}" is allowed only as bypass_actors[].actor_id`, file);
}

async function loadRulesets(directory) {
  let names;
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new SettingsError(`${RULESETS_DIR}: ${error.message}`, directory);
  }
  const rulesets = [];
  for (const fileName of names) {
    const file = path.join(directory, fileName);
    const ruleset = await readJsonFile(file);
    checkRuleset(file, ruleset, fileName);
    rulesets.push(ruleset);
  }
  return rulesets;
}

/**
 * Reads settings.json, labels.json and rulesets/*.json. Placeholders stay unresolved.
 * @param {{ root: string }} options
 * @returns {Promise<DesiredState>}
 */
export async function loadDesiredState({ root }) {
  const directory = path.join(root, CONFIG_DIR);
  const settingsFile = path.join(directory, SETTINGS_FILE);
  const labelsFile = path.join(directory, LABELS_FILE);
  const settings = await readJsonFile(settingsFile);
  checkSettings(settingsFile, settings);
  const labelsJson = await readJsonFile(labelsFile);
  checkLabels(labelsFile, labelsJson);
  const rulesets = await loadRulesets(path.join(directory, RULESETS_DIR));
  return { settings, labels: labelsJson.labels, rulesets };
}

async function lookupAppId(key, { client, config }) {
  if (!Object.hasOwn(config.apps, key)) throw new SettingsError(`placeholder {{app-id:${key}}}: unknown app key "${key}"`);
  const slug = config.apps[key];
  let response;
  try {
    response = await client.request('GET', apiPath('/apps/{slug}', { slug }));
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    throw new SettingsError(`placeholder {{app-id:${key}}}: lookup of app ${slug} failed: ${error.message}`);
  }
  const id = response.data?.id;
  if (!Number.isInteger(id)) throw new SettingsError(`placeholder {{app-id:${key}}}: app ${slug} returned no integer id`);
  return id;
}

/**
 * Returns a deep copy with every `{{app-id:<key>}}` bypass actor id replaced by the app's integer id.
 * @param {Ruleset} ruleset
 * @param {{ client: import('./github.mjs').GitHubClient, config: Config }} context
 * @returns {Promise<Ruleset>}
 */
export async function resolvePlaceholders(ruleset, { client, config }) {
  const copy = structuredClone(ruleset);
  const ids = new Map();
  for (const actor of copy.bypass_actors ?? []) {
    const match = typeof actor.actor_id === 'string' ? APP_PLACEHOLDER.exec(actor.actor_id) : null;
    if (!match) continue;
    const key = match[1];
    if (!ids.has(key)) ids.set(key, await lookupAppId(key, { client, config }));
    actor.actor_id = ids.get(key);
  }
  return copy;
}

/**
 * @param {string} repoName
 * @param {Config} config
 * @returns {'control'|'project'}
 */
export function repoKind(repoName, config) {
  return String(repoName).toLowerCase() === config.controlRepo.toLowerCase() ? 'control' : 'project';
}

const appliesToKind = (repos, kind) => repos === 'all' || (repos === 'projects' && kind === 'project') || (repos === 'control' && kind === 'control');

function row(section, key, desired, live, result) {
  return { section, key, desired, live, result };
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Objects: every desired key must be covered by live. Arrays: same length, each desired element covered by a distinct live element. */
function covers(live, desired) {
  if (Array.isArray(desired)) return Array.isArray(live) && live.length === desired.length && coversEach(live, desired);
  if (isPlainObject(desired)) {
    return isPlainObject(live) && Object.entries(desired).every(([key, value]) => covers(live[key], value));
  }
  return live === desired;
}

function coversEach(live, desired) {
  const unused = [...live];
  return desired.every((item) => {
    const index = unused.findIndex((candidate) => covers(candidate, item));
    if (index === -1) return false;
    unused.splice(index, 1);
    return true;
  });
}

function flattenLeaves(value, prefix = '') {
  if (!isPlainObject(value)) return [{ key: prefix, desired: value }];
  return Object.entries(value).flatMap(([name, child]) => flattenLeaves(child, prefix ? `${prefix}.${name}` : name));
}

function getPath(value, keyPath) {
  return keyPath.split('.').reduce((current, name) => (isPlainObject(current) ? current[name] : undefined), value);
}

/** @returns {{ value: any }|null} null when the section is absent or unreadable */
function readableSection(live, name) {
  const section = live?.[name];
  return section?.readable === true ? { value: section.value } : null;
}

function unreadableRows(section, items) {
  return items.map(({ key, desired }) => row(section, key, desired, null, 'unreadable'));
}

/**
 * Result for an item that is deferred until CodeQL default setup or pass 2 exists.
 * `differ` once either signal is true; `deferred` while both are false; `unreadable` otherwise.
 */
function codeScanningMismatch(signals) {
  if (signals.pass2Ran === true || signals.codeScanningConfigured === true) return 'differ';
  if (signals.pass2Ran === false && signals.codeScanningConfigured === false) return 'deferred';
  return 'unreadable';
}

function leafRow(section, item, liveValue, mismatch) {
  if (liveValue === undefined) return row(section, item.key, item.desired, null, mismatch === 'differ' ? 'missing' : mismatch);
  if (deepEqual(liveValue, item.desired)) return row(section, item.key, item.desired, liveValue, 'match');
  return row(section, item.key, item.desired, liveValue, mismatch);
}

function compareLeaves(section, desiredObject, live, signals) {
  const items = flattenLeaves(desiredObject ?? {}).filter((item) => item.key !== '');
  const read = readableSection(live, section);
  if (!read) return unreadableRows(section, items);
  return items.map((item) => {
    const deferrable = section === 'security' && item.key.startsWith(CODE_SCANNING_SETUP_KEY);
    return leafRow(section, item, getPath(read.value, item.key), deferrable ? codeScanningMismatch(signals) : 'differ');
  });
}

function compareRepository(settings, live, { repoKind: kind, signals }) {
  const desired = kind === 'control' ? { ...settings.repository, ...settings.controlRepository } : settings.repository;
  return compareLeaves('repository', desired, live, signals);
}

function compareTeamAccess(settings, live) {
  const items = (settings.teamAccess ?? []).map((entry) => ({ key: entry.team, desired: entry.permission }));
  const read = readableSection(live, 'teamAccess');
  if (!read) return unreadableRows('teamAccess', items);
  return items.map((item) => {
    const entry = read.value.find((candidate) => sameLogin(candidate.team, item.key));
    if (!entry) return row('teamAccess', item.key, item.desired, null, 'missing');
    return row('teamAccess', item.key, item.desired, entry.permission, entry.permission === item.desired ? 'match' : 'differ');
  });
}

/** @returns {'hold'|'deferred'|'unreadable'} */
function assertionState(assertWhen, { config, signals }) {
  if (assertWhen === 'kitInstalled') return signals.kitInstalled ? 'hold' : 'deferred';
  if (config.deploy === 'none') return 'deferred';
  if (signals.pass2Ran === true || signals.codeScanningConfigured === true) return 'hold';
  if (signals.pass2Ran === false && signals.codeScanningConfigured === false) return 'deferred';
  return 'unreadable';
}

function compareVariables(settings, live, context) {
  const items = Object.entries(settings.variables ?? {}).map(([name, spec]) => ({ key: name, desired: spec.value, spec }));
  const read = readableSection(live, 'variables');
  if (!read) return unreadableRows('variables', items);
  return items.map((item) => {
    const state = assertionState(item.spec.assertWhen, context);
    if (state !== 'hold') return row('variables', item.key, item.desired, null, state);
    const entry = read.value.find((candidate) => candidate.name === item.key);
    if (!entry) return row('variables', item.key, item.desired, null, 'missing');
    return row('variables', item.key, item.desired, entry.value, entry.value === item.desired ? 'match' : 'differ');
  });
}

function resolveReviewers(reviewers, config) {
  try {
    return reviewers.map((reviewer) => resolveActor(reviewer, config));
  } catch (error) {
    if (error instanceof ConfigError) return null;
    throw error;
  }
}

const refKey = (ref) => `${ref.type}:${ref.name}`;

function sameMembers(live, desired, same) {
  return live.length === desired.length && desired.every((item) => live.some((candidate) => same(candidate, item)));
}

function compareEnvironment(name, spec, liveEnvironment, config) {
  const rows = [];
  const add = (key, desired, live, matches) => rows.push(row('environments', `${name}.${key}`, desired, live, matches ? 'match' : 'differ'));
  add('can_admins_bypass', spec.can_admins_bypass, liveEnvironment.can_admins_bypass, liveEnvironment.can_admins_bypass === spec.can_admins_bypass);
  add('prevent_self_review', spec.prevent_self_review, liveEnvironment.prevent_self_review, liveEnvironment.prevent_self_review === spec.prevent_self_review);
  const reviewers = resolveReviewers(spec.reviewers ?? [], config);
  add('reviewers', reviewers ?? spec.reviewers, liveEnvironment.reviewers,
    reviewers !== null && sameMembers(liveEnvironment.reviewers ?? [], reviewers, sameLogin));
  const refs = spec.deployment_refs ?? [];
  add('deployment_refs', refs, liveEnvironment.deployment_refs,
    sameMembers(liveEnvironment.deployment_refs ?? [], refs, (a, b) => refKey(a) === refKey(b)));
  for (const kind of ['secrets', 'variables']) {
    for (const entry of spec[kind] ?? []) {
      const present = (liveEnvironment[kind] ?? []).includes(entry);
      rows.push(row('environments', `${name}.${kind}.${entry}`, entry, present ? entry : null, present ? 'match' : 'missing'));
    }
  }
  return rows;
}

function compareEnvironments(settings, live, { repoKind: kind, config }) {
  const selected = Object.entries(settings.environments ?? {}).filter(([, spec]) => appliesToKind(spec.repos, kind));
  const read = readableSection(live, 'environments');
  if (!read) return unreadableRows('environments', selected.map(([name, spec]) => ({ key: name, desired: spec })));
  return selected.flatMap(([name, spec]) => {
    const liveEnvironment = read.value.find((candidate) => candidate.name === name);
    if (!liveEnvironment) return [row('environments', name, spec, null, 'missing')];
    return compareEnvironment(name, spec, liveEnvironment, config);
  });
}

function compareLabels(labels, live) {
  const read = readableSection(live, 'labels');
  if (!read) return unreadableRows('labels', labels.map((label) => ({ key: label.name, desired: label })));
  const wanted = new Set(labels.map((label) => label.name.toLowerCase()));
  const rows = labels.map((label) => {
    const entry = read.value.find((candidate) => candidate.name.toLowerCase() === label.name.toLowerCase());
    if (!entry) return row('labels', label.name, label, null, 'missing');
    const normalized = { name: entry.name, color: entry.color, description: entry.description ?? '' };
    const same = normalized.color.toLowerCase() === label.color.toLowerCase() && normalized.description === label.description;
    return row('labels', label.name, label, normalized, same ? 'match' : 'differ');
  });
  const extras = read.value.filter((entry) => !wanted.has(entry.name.toLowerCase()));
  return [...rows, ...extras.map((entry) => row('labels', entry.name, null, entry, 'extra'))];
}

function normalizeBypassActors(actors) {
  return (actors ?? []).map((actor) => ({
    actor_type: actor.actor_type,
    actor_id: actor.actor_type === ORGANIZATION_ADMIN ? null : (actor.actor_id ?? null),
    bypass_mode: actor.bypass_mode,
  }));
}

function sameBypassActors(live, desired) {
  const left = normalizeBypassActors(live);
  const right = normalizeBypassActors(desired);
  return left.length === right.length && coversEach(left, right);
}

function compareRules(rulesetName, desiredRules, liveRules, signals) {
  const liveByType = new Map(liveRules.map((rule) => [rule.type, rule]));
  const desiredTypes = new Set(desiredRules.map((rule) => rule.type));
  const rows = desiredRules.map((rule) => {
    const key = `${rulesetName}.rules.${rule.type}`;
    const liveRule = liveByType.get(rule.type);
    const deferrable = rulesetName === MAIN_RULESET && rule.type === CODE_SCANNING_RULE;
    const mismatch = deferrable ? codeScanningMismatch(signals) : 'differ';
    if (!liveRule) return row('rulesets', key, rule, null, mismatch === 'differ' ? 'missing' : mismatch);
    return row('rulesets', key, rule, liveRule, covers(liveRule, rule) ? 'match' : mismatch);
  });
  const extras = liveRules.filter((rule) => !desiredTypes.has(rule.type));
  return [...rows, ...extras.map((rule) => row('rulesets', `${rulesetName}.rules.${rule.type}`, null, rule, 'extra'))];
}

function compareRuleset(desired, liveRuleset, signals) {
  const { name } = desired;
  const field = (key, matches) => row('rulesets', `${name}.${key}`, desired[key], liveRuleset[key], matches ? 'match' : 'differ');
  return [
    field('target', liveRuleset.target === desired.target),
    field('enforcement', liveRuleset.enforcement === desired.enforcement),
    field('conditions', covers(liveRuleset.conditions, desired.conditions)),
    field('bypass_actors', sameBypassActors(liveRuleset.bypass_actors, desired.bypass_actors)),
    ...compareRules(name, desired.rules ?? [], liveRuleset.rules ?? [], signals),
  ];
}

/** Desired rulesets must have placeholders resolved: an unresolved placeholder never equals a live actor id. */
function compareRulesets(rulesets, live, signals) {
  const read = readableSection(live, 'rulesets');
  if (!read) return unreadableRows('rulesets', rulesets.map((ruleset) => ({ key: ruleset.name, desired: ruleset })));
  const wanted = new Set(rulesets.map((ruleset) => ruleset.name));
  const rows = rulesets.flatMap((ruleset) => {
    const liveRuleset = read.value.find((candidate) => candidate.name === ruleset.name);
    if (!liveRuleset) return [row('rulesets', ruleset.name, ruleset, null, 'missing')];
    return compareRuleset(ruleset, liveRuleset, signals);
  });
  const extras = read.value.filter((entry) => !wanted.has(entry.name));
  return [...rows, ...extras.map((entry) => row('rulesets', entry.name, null, entry, 'extra'))];
}

/**
 * Pure comparison of desired state against live sections (shapes in the typedef block above).
 * `desired.rulesets` must already have their placeholders resolved.
 * @param {DesiredState} desired
 * @param {Record<string, LiveSection>} live
 * @param {{ repoKind: 'control'|'project', config: Config, signals: Signals }} context
 * @returns {ComparisonRow[]}
 */
export function compareStates(desired, live, context) {
  const { settings } = desired;
  return [
    ...compareRepository(settings, live, context),
    ...compareTeamAccess(settings, live),
    ...compareLeaves('security', settings.security, live, context.signals),
    ...compareLeaves('actions', settings.actions, live, context.signals),
    ...compareVariables(settings, live, context),
    ...compareEnvironments(settings, live, context),
    ...compareLabels(desired.labels, live),
    ...compareRulesets(desired.rulesets, live, context.signals),
  ];
}

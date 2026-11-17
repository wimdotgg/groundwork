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
 *                   reviewers: string[], deployment_refs: Array<{ name: string, type: 'branch'|'tag' }>,
 *                   secrets: string[] (names), variables: string[] (names) }>
 *                 reviewers are user logins; a non-User reviewer is encoded `team:<slug>` so it never matches a
 *                 login. prevent_self_review is false when the environment has no required_reviewers rule.
 *   labels:       Array<{ name: string, color: string, description: string|null }>, GET /labels
 *   rulesets:     Array<object>, one full GET /rulesets/{id} body per ruleset
 * Array sections whose value is not an array, and a ruleset whose bypass_actors is not an array, are unreadable.
 *
 * Notes for `readLiveState`: list rulesets with includes_parents=false; a 404 on vulnerability-alerts means
 * disabled; automated_security_fixes is `enabled && !paused`.
 */

const SETTINGS_FILE = 'settings.json';
const LABELS_FILE = 'labels.json';
const RULESETS_DIR = 'rulesets';
const PLACEHOLDER_OPEN = '{{';
const APP_PLACEHOLDER = /^\{\{app-id:([^{}]*)\}\}$/;
const SETTINGS_KEYS = [
  'schemaVersion', 'repository', 'controlRepository', 'teamAccess', 'security', 'actions', 'variables', 'environments',
];
const ARRAY_SECTIONS = ['teamAccess', 'variables', 'environments', 'labels', 'rulesets'];
const ENVIRONMENT_STRING_LISTS = ['reviewers', 'secrets', 'variables'];
const ENVIRONMENT_REPOS =['all', 'projects', 'control'];
const ASSERT_WHEN_VALUES =['kitInstalled', 'deployReady'];
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
  if (settings.teamAccess !== undefined && !Array.isArray(settings.teamAccess)) {
    throw new SettingsError(`${SETTINGS_FILE}: teamAccess must be an array`, file);
  }
  if (!(settings.teamAccess ?? []).every(isPlainObject)) {
    throw new SettingsError(`${SETTINGS_FILE}: teamAccess entries must be objects`, file);
  }
  for (const [name, variable] of Object.entries(settings.variables ?? {})) {
    if (!ASSERT_WHEN_VALUES.includes(variable?.assertWhen)) {
      throw new SettingsError(
        `${SETTINGS_FILE}: variable ${name} assertWhen must be ${ASSERT_WHEN_VALUES.join(' or ')}`,
        file,
      );
    }
  }
  for (const [name, environment] of Object.entries(settings.environments ?? {})) checkEnvironment(file, name, environment);
}

function checkEnvironment(file, name, environment) {
  if (!isPlainObject(environment)) throw new SettingsError(`${SETTINGS_FILE}: environment ${name} must be an object`, file);
  if (!ENVIRONMENT_REPOS.includes(environment.repos)) {
    throw new SettingsError(`${SETTINGS_FILE}: environment ${name} repos must be ${ENVIRONMENT_REPOS.join(', ')}`, file);
  }
  for (const field of ENVIRONMENT_STRING_LISTS) {
    const list = environment[field];
    if (list !== undefined && !(Array.isArray(list) && list.every((entry) => typeof entry === 'string'))) {
      throw new SettingsError(`${SETTINGS_FILE}: environment ${name} ${field} must be an array of strings`, file);
    }
  }
  const refs = environment.deployment_refs;
  if (refs !== undefined && !(Array.isArray(refs) && refs.every(isPlainObject))) {
    throw new SettingsError(`${SETTINGS_FILE}: environment ${name} deployment_refs must be an array of objects`, file);
  }
  for (const flag of ['can_admins_bypass', 'prevent_self_review']) {
    if (typeof environment[flag] !== 'boolean') {
      throw new SettingsError(`${SETTINGS_FILE}: environment ${name} ${flag} must be a boolean`, file);
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
    if (typeof label.color !== 'string' || typeof label.description !== 'string') {
      throw new SettingsError(`${LABELS_FILE}: label "${name}" needs string color and description`, file);
    }
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
  if (!Array.isArray(bypassActors) || !bypassActors.every(isPlainObject)) {
    throw new SettingsError(`${fileName}: bypass_actors must be an array of objects`, file);
  }
  if (!Array.isArray(ruleset.rules ?? []) || !(ruleset.rules ?? []).every(isPlainObject)) {
    throw new SettingsError(`${fileName}: rules must be an array of objects`, file);
  }
  for (const actor of bypassActors) {
    if (typeof actor.actor_id === 'string' && !APP_PLACEHOLDER.test(actor.actor_id)) {
      throw new SettingsError(`${fileName}: actor_id "${actor.actor_id}" is not a {{app-id:<key>}} placeholder`, file);
    }
  }
  const actorsWithoutIds = bypassActors.map(({ actor_id: _ignored, ...actor }) => actor);
  const stray = findStrayPlaceholder({ rest, actorsWithoutIds });
  if (stray !== null) throw new SettingsError(`${fileName}: placeholder "${stray}" is allowed only as bypass_actors[].actor_id`, file);
}

async function loadRulesets(directory) {
  let names;
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    const reason = error.code === 'ENOENT' ? 'directory not found' : error.message;
    throw new SettingsError(`${RULESETS_DIR}: ${reason}`, directory);
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
  if (section?.readable !== true) return null;
  const expectsArray = ARRAY_SECTIONS.includes(name);
  return Array.isArray(section.value) === expectsArray ? { value: section.value } : null;
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
    const deferrable = section === 'security'
      && (item.key === CODE_SCANNING_SETUP_KEY || item.key.startsWith(`${CODE_SCANNING_SETUP_KEY}.`));
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
    const entry = read.value.find((candidate) => sameLogin(candidate?.team, item.key));
    if (!entry) return row('teamAccess', item.key, item.desired, null, 'missing');
    return row('teamAccess', item.key, item.desired, entry.permission, entry.permission === item.desired ? 'match' : 'differ');
  });
}

/** @returns {'hold'|'deferred'|'unreadable'} */
function assertionState(assertWhen, { config, signals }) {
  if (assertWhen === 'kitInstalled') {
    if (typeof signals.kitInstalled !== 'boolean') return 'unreadable';
    return signals.kitInstalled ? 'hold' : 'deferred';
  }
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
    const entry = read.value.find((candidate) => candidate?.name === item.key);
    if (state !== 'hold') return row('variables', item.key, item.desired, entry?.value ?? null, state);
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
  add('prevent_self_review', spec.prevent_self_review, liveEnvironment.prevent_self_review, (liveEnvironment.prevent_self_review ?? false) === spec.prevent_self_review);
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
    const liveEnvironment = read.value.find((candidate) => candidate?.name === name);
    if (!liveEnvironment) return [row('environments', name, spec, null, 'missing')];
    return compareEnvironment(name, spec, liveEnvironment, config);
  });
}

function compareLabels(labels, live) {
  const read = readableSection(live, 'labels');
  if (!read) return unreadableRows('labels', labels.map((label) => ({ key: label.name, desired: label })));
  const wanted = new Set(labels.map((label) => label.name.toLowerCase()));
  const rows = labels.map((label) => {
    const entry = read.value.find((candidate) => String(candidate?.name).toLowerCase() === label.name.toLowerCase());
    if (!entry) return row('labels', label.name, label, null, 'missing');
    const normalized = { name: entry.name, color: entry.color, description: entry.description ?? '' };
    const same = String(normalized.color).toLowerCase() === label.color.toLowerCase() && normalized.description === label.description;
    return row('labels', label.name, label, normalized, same ? 'match' : 'differ');
  });
  const extras = read.value.filter((entry) => !wanted.has(String(entry?.name).toLowerCase()));
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

/**
 * A live-only rule type is `extra`, including `code_scanning` on a template `main` that lacks it: projects commit
 * the rule before pass 2 (spec 14.2 step 4). A live rule that exists but is weaker than desired is always `differ`.
 */
function compareRules(rulesetName, desiredRules, liveRules, signals) {
  const liveByType = new Map(liveRules.map((rule) => [rule.type, rule]));
  const desiredTypes = new Set(desiredRules.map((rule) => rule.type));
  const rows = desiredRules.map((rule) => {
    const key = `${rulesetName}.rules.${rule.type}`;
    const liveRule = liveByType.get(rule.type);
    const deferrable = rulesetName === MAIN_RULESET && rule.type === CODE_SCANNING_RULE;
    const mismatch = deferrable ? codeScanningMismatch(signals) : 'differ';
    if (!liveRule) return row('rulesets', key, rule, null, mismatch === 'differ' ? 'missing' : mismatch);
    return row('rulesets', key, rule, liveRule, covers(liveRule, rule) ? 'match' : 'differ');
  });
  const extras = liveRules.filter((rule) => !desiredTypes.has(rule.type));
  return [...rows, ...extras.map((rule) => row('rulesets', `${rulesetName}.rules.${rule.type}`, null, rule, 'extra'))];
}

function bypassActorsRow(desired, liveRuleset) {
  const key = `${desired.name}.bypass_actors`;
  const live = liveRuleset.bypass_actors;
  if (!Array.isArray(live) || !live.every(isPlainObject)) return row('rulesets', key, desired.bypass_actors, null, 'unreadable');
  return row('rulesets', key, desired.bypass_actors, live, sameBypassActors(live, desired.bypass_actors) ? 'match' : 'differ');
}

function compareRuleset(desired, liveRuleset, signals) {
  const { name } = desired;
  const field = (key, matches) => row('rulesets', `${name}.${key}`, desired[key], liveRuleset[key], matches ? 'match' : 'differ');
  return [
    field('target', liveRuleset.target === desired.target),
    field('enforcement', liveRuleset.enforcement === desired.enforcement),
    field('conditions', covers(liveRuleset.conditions, desired.conditions)),
    bypassActorsRow(desired, liveRuleset),
    ...compareRules(name, desired.rules ?? [], liveRuleset.rules ?? [], signals),
  ];
}

/** Desired rulesets must have placeholders resolved: an unresolved placeholder never equals a live actor id. */
function compareRulesets(rulesets, live, signals) {
  const read = readableSection(live, 'rulesets');
  if (!read) return unreadableRows('rulesets', rulesets.map((ruleset) => ({ key: ruleset.name, desired: ruleset })));
  const wanted = new Set(rulesets.map((ruleset) => ruleset.name));
  const rows = rulesets.flatMap((ruleset) => {
    const liveRuleset = read.value.find((candidate) => candidate?.name === ruleset.name);
    if (!liveRuleset) return [row('rulesets', ruleset.name, ruleset, null, 'missing')];
    return compareRuleset(ruleset, liveRuleset, signals);
  });
  const extras = read.value.filter((entry) => !wanted.has(entry?.name));
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

const REPO_PATH = '/repos/{owner}/{repo}';
const UNREADABLE_STATUSES = [403, 404];
const KIT_VERSION_PATH = '/repos/{owner}/{repo}/contents/.github/groundwork/kit-version.txt';
const TEAM_REVIEWER_PREFIX = 'team:';
const REQUIRED_REVIEWERS_RULE = 'required_reviewers';

const get = (client, template, repo, params = {}) => client.request('GET', apiPath(template, { ...repo, ...params }));
const list = (client, template, repo, options, params = {}) => client.paginate(apiPath(template, { ...repo, ...params }), options);

async function readRepository(client, repo) {
  return (await get(client, REPO_PATH, repo)).data;
}

async function readTeamAccess(client, repo) {
  const teams = await list(client, `${REPO_PATH}/teams`, repo);
  return teams.map((team) => ({ team: team.slug, permission: team.permission }));
}

async function readVulnerabilityAlerts(client, repo) {
  const response = await client.request('GET', apiPath(`${REPO_PATH}/vulnerability-alerts`, repo), { okStatuses: [404] });
  return response.status !== 404;
}

async function readSecurity(client, repo) {
  const reporting = await get(client, `${REPO_PATH}/private-vulnerability-reporting`, repo);
  const alerts = await readVulnerabilityAlerts(client, repo);
  const fixes = await client.request('GET', apiPath(`${REPO_PATH}/automated-security-fixes`, repo), { okStatuses: [404] });
  const setup = await client.request('GET', apiPath(`${REPO_PATH}/code-scanning/default-setup`, repo), { okStatuses: UNREADABLE_STATUSES });
  const setupReadable = !UNREADABLE_STATUSES.includes(setup.status);
  return {
    private_vulnerability_reporting: reporting.data?.enabled === true,
    vulnerability_alerts: alerts,
    automated_security_fixes: fixes.status !== 404 && fixes.data?.enabled === true && fixes.data?.paused !== true,
    code_scanning_default_setup: setupReadable ? { state: setup.data?.state } : {},
  };
}

async function readActions(client, repo) {
  const permissions = await get(client, `${REPO_PATH}/actions/permissions`, repo);
  const workflow = await get(client, `${REPO_PATH}/actions/permissions/workflow`, repo);
  const approval = await get(client, `${REPO_PATH}/actions/permissions/fork-pr-contributor-approval`, repo);
  return { permissions: permissions.data, workflow: workflow.data, fork_pr_contributor_approval: approval.data };
}

async function readVariables(client, repo) {
  const variables = await list(client, `${REPO_PATH}/actions/variables`, repo, { itemsKey: 'variables' });
  return variables.map((variable) => ({ name: variable.name, value: variable.value }));
}

function reviewerName({ type, reviewer }) {
  return type === 'User' ? reviewer?.login : `${TEAM_REVIEWER_PREFIX}${reviewer?.slug}`;
}

async function readDeploymentRefs(client, repo, environment) {
  if (environment.deployment_branch_policy?.custom_branch_policies !== true) return [];
  const path = `${REPO_PATH}/environments/{name}/deployment-branch-policies`;
  const refs = await list(client, path, repo, { itemsKey: 'branch_policies' }, { name: environment.name });
  return refs.map((ref) => ({ name: ref.name, type: ref.type }));
}

async function readEnvironment(client, repo, environment) {
  const params = { name: environment.name };
  const environmentPath = `${REPO_PATH}/environments/{name}`;
  const rule = (environment.protection_rules ?? []).find((candidate) => candidate.type === REQUIRED_REVIEWERS_RULE);
  const refs = await readDeploymentRefs(client, repo, environment);
  const secrets = await list(client, `${environmentPath}/secrets`, repo, { itemsKey: 'secrets' }, params);
  const variables = await list(client, `${environmentPath}/variables`, repo, { itemsKey: 'variables' }, params);
  return {
    name: environment.name,
    can_admins_bypass: environment.can_admins_bypass,
    prevent_self_review: rule?.prevent_self_review === true,
    reviewers: (rule?.reviewers ?? []).map(reviewerName),
    deployment_refs: refs,
    secrets: secrets.map((secret) => secret.name),
    variables: variables.map((variable) => variable.name),
  };
}

/** With `environmentNames`, only those environments are read in full; the rest are listed by name only. */
async function readEnvironments(client, repo, { environmentNames } = {}) {
  const environments = await list(client, `${REPO_PATH}/environments`, repo, { itemsKey: 'environments' });
  const detailed = environmentNames === undefined ? null : new Set(environmentNames);
  const result = [];
  for (const environment of environments) {
    const wanted = detailed === null || detailed.has(environment.name);
    result.push(wanted ? await readEnvironment(client, repo, environment) : { name: environment.name });
  }
  return result;
}

async function readLabels(client, repo) {
  const labels = await list(client, `${REPO_PATH}/labels`, repo);
  return labels.map((label) => ({ name: label.name, color: label.color, description: label.description ?? null }));
}

const listRulesetSummaries = (client, repo) => list(client, `${REPO_PATH}/rulesets`, repo, { query: { includes_parents: false } });
const getRuleset = async (client, repo, id) => (await get(client, `${REPO_PATH}/rulesets/{id}`, repo, { id })).data;

async function readRulesets(client, repo) {
  const summaries = await listRulesetSummaries(client, repo);
  const rulesets = [];
  for (const summary of summaries) rulesets.push(await getRuleset(client, repo, summary.id));
  return rulesets;
}

const SECTION_READERS = {
  repository: readRepository,
  teamAccess: readTeamAccess,
  security: readSecurity,
  actions: readActions,
  variables: readVariables,
  environments: readEnvironments,
  labels: readLabels,
  rulesets: readRulesets,
};

/** @returns {Promise<LiveSection>} */
async function readSection(reader, client, repo, options) {
  try {
    return { readable: true, value: await reader(client, repo, options) };
  } catch (error) {
    if (error instanceof GitHubError && UNREADABLE_STATUSES.includes(error.status)) return { readable: false, status: error.status };
    throw error;
  }
}

/**
 * Reads the named live sections (default: all) into the shapes in the typedef block at the top of this file.
 * 403 and 404 on any request of a section make that section unreadable; other errors throw.
 * @param {import('./github.mjs').GitHubClient} client
 * @param {import('./github.mjs').RepoRef} repo
 * @param {{ sections?: string[], environmentNames?: string[] }} [options] `environmentNames` limits the per-environment
 *   sub-requests (branch policies, secrets, variables) to those environments; others come back as `{ name }` only.
 * @returns {Promise<Record<string, LiveSection>>}
 */
export async function readLiveState(client, repo, { sections = Object.keys(SECTION_READERS), environmentNames } = {}) {
  const unknown = sections.find((name) => !Object.hasOwn(SECTION_READERS, name));
  if (unknown !== undefined) throw new SettingsError(`readLiveState: unknown section "${unknown}"`);
  const live = {};
  for (const name of sections) live[name] = await readSection(SECTION_READERS[name], client, repo, { environmentNames });
  return live;
}

async function readKitInstalled(client, repo, kind) {
  if (kind === 'control') return true;
  const response = await client.request('GET', apiPath(KIT_VERSION_PATH, repo), { okStatuses: [404] });
  return response.status !== 404;
}

/** @returns {Promise<any>} the callback's result, or null when the request is forbidden or missing */
async function nullWhenUnreadable(read) {
  try {
    return await read();
  } catch (error) {
    if (error instanceof GitHubError && UNREADABLE_STATUSES.includes(error.status)) return null;
    throw error;
  }
}

async function readPass2Ran(client, repo) {
  const summaries = await listRulesetSummaries(client, repo);
  const main = summaries.find((summary) => summary.name === MAIN_RULESET && summary.target === 'branch');
  if (!main) return false;
  const ruleset = await getRuleset(client, repo, main.id);
  return (ruleset.rules ?? []).some((rule) => rule.type === CODE_SCANNING_RULE);
}

/**
 * @param {import('./github.mjs').GitHubClient} client
 * @param {import('./github.mjs').RepoRef} repo
 * @param {{ repoKind: 'control'|'project' }} options
 * @returns {Promise<Signals>}
 */
export async function readSignals(client, repo, { repoKind: kind }) {
  const kitInstalled = await readKitInstalled(client, repo, kind);
  const codeScanningConfigured = await nullWhenUnreadable(async () => {
    const setup = await get(client, `${REPO_PATH}/code-scanning/default-setup`, repo);
    return setup.data?.state === 'configured';
  });
  const pass2Ran = await nullWhenUnreadable(() => readPass2Ran(client, repo));
  return { kitInstalled, codeScanningConfigured, pass2Ran };
}

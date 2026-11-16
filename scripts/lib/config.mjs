import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_DIR = '.github/groundwork';

const CONFIG_FILE = 'config.json';
const HOTSPOTS_FILE = 'hotspots.json';
const SCRIPTS_DIR_NAME = 'scripts';
const SUPPORTED_SCHEMA_VERSION = 1;
const APP_REF_PREFIX = 'app:';
const TOP_LEVEL_KEYS = [
  'schemaVersion', 'org', 'controlRepo', 'accounts', 'apps', 'trustedAuthors', 'labelActors',
  'deploy', 'limits', 'sizeExcludeGlobs', 'generatedGlobs', 'testIntegrity',
];
const LIMIT_KEYS = [
  'hierarchyDepth', 'hierarchyDepthWithIntermediate', 'subIssuesPerParent', 'prChangedLines',
  'prFiles', 'tasksPerWorker', 'activeWorkers', 'draftLeaseMinutes', 'claimWithoutPrMinutes',
  'reviewRounds', 'sameFailureAttempts', 'ciReruns', 'stateLines', 'journalLines', 'resumeLines',
];
const TEST_INTEGRITY_KEYS = ['testGlobs', 'testDeclarationPatterns', 'suppressionPatterns', 'thresholdGlobs'];
const REGEX_LISTS = ['testDeclarationPatterns', 'suppressionPatterns'];
const ACCOUNT_KEYS = ['owner', 'agent'];
const TRUSTED_AUTHOR_KEYS = ['actor', 'scope'];
const SCOPES = ['any', 'issues', 'pull-requests'];
const DEPLOY_MODES = ['scripts', 'none'];

/** @typedef {'owner'|'agent'|string} ActorRef   'owner', 'agent', 'app:<apps key>', or a literal login */
/** @typedef {{ actor: ActorRef, scope: 'any'|'issues'|'pull-requests' }} TrustedAuthor */
/** @typedef {{ hierarchyDepth: number, hierarchyDepthWithIntermediate: number, subIssuesPerParent: number,
 *   prChangedLines: number, prFiles: number, tasksPerWorker: number, activeWorkers: number,
 *   draftLeaseMinutes: number, claimWithoutPrMinutes: number, reviewRounds: number,
 *   sameFailureAttempts: number, ciReruns: number, stateLines: number, journalLines: number, resumeLines: number }} Limits */
/** @typedef {{ schemaVersion: 1, org: string, controlRepo: string,
 *   accounts: { owner: string, agent: string }, apps: Record<string, string>,
 *   trustedAuthors: TrustedAuthor[], labelActors: Record<string, ActorRef>,
 *   deploy: 'scripts'|'none', limits: Limits, sizeExcludeGlobs: string[], generatedGlobs: string[],
 *   testIntegrity: { testGlobs: string[], testDeclarationPatterns: string[], suppressionPatterns: string[], thresholdGlobs: string[] } }} Config */
/** @typedef {{ name: string, paths: string[] }} Hotspot */

export class ConfigError extends Error {
  /**
   * @param {string} message one-line description
   * @param {string} [file] path of the offending file
   */
  constructor(message, file) {
    super(message.replace(/\s+/g, ' ').trim());
    this.name = 'ConfigError';
    this.file = file;
  }
}

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

function fail(file, message) {
  throw new ConfigError(`${path.basename(file)}: ${message}`, file);
}

async function readJson(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new ConfigError(`${path.basename(file)}: cannot read file (${error.message})`, file);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${path.basename(file)}: invalid JSON (${error.message})`, file);
  }
}

function lowerLogin(login) {
  return login.trim().toLowerCase();
}

/** Trims, classifies `owner`, `agent` and `app:` case-insensitively, lower-cases literal logins; app keys keep their case. */
function canonicalActorRef(ref) {
  const trimmed = ref.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'owner' || lower === 'agent') return lower;
  if (lower.startsWith(APP_REF_PREFIX)) return APP_REF_PREFIX + trimmed.slice(APP_REF_PREFIX.length).trim();
  return lower;
}

function checkActorRef(file, ref, where, apps) {
  if (!isNonEmptyString(ref)) fail(file, `${where} must be a non-empty string`);
  const canonical = canonicalActorRef(ref);
  if (!canonical.startsWith(APP_REF_PREFIX)) return;
  const key = canonical.slice(APP_REF_PREFIX.length);
  if (!Object.hasOwn(apps, key)) fail(file, `${where} refers to unknown app "${key}"`);
}

function checkTopLevel(file, raw) {
  if (!isPlainObject(raw)) fail(file, 'top level must be an object');
  const unknown = Object.keys(raw).filter((key) => !TOP_LEVEL_KEYS.includes(key));
  if (unknown.length > 0) fail(file, `unknown top-level key "${unknown[0]}"`);
  const missing = TOP_LEVEL_KEYS.filter((key) => !Object.hasOwn(raw, key));
  if (missing.length > 0) fail(file, `missing top-level key "${missing[0]}"`);
  if (raw.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    fail(file, `schemaVersion must be ${SUPPORTED_SCHEMA_VERSION}`);
  }
}

function checkStrings(file, raw) {
  if (!isNonEmptyString(raw.org)) fail(file, 'org must be a non-empty string');
  if (!isNonEmptyString(raw.controlRepo)) fail(file, 'controlRepo must be a non-empty string');
  if (!DEPLOY_MODES.includes(raw.deploy)) fail(file, `deploy must be one of ${DEPLOY_MODES.join(', ')}`);
  for (const key of ['sizeExcludeGlobs', 'generatedGlobs']) {
    if (!isStringArray(raw[key])) fail(file, `${key} must be an array of strings`);
  }
}

function checkAccountsAndApps(file, raw) {
  if (!isPlainObject(raw.accounts)) fail(file, 'accounts must be an object');
  const unknownAccount = Object.keys(raw.accounts).filter((key) => !ACCOUNT_KEYS.includes(key));
  if (unknownAccount.length > 0) fail(file, `unknown accounts key "${unknownAccount[0]}"`);
  for (const key of ['owner', 'agent']) {
    if (!isNonEmptyString(raw.accounts[key])) fail(file, `accounts.${key} must be a non-empty string`);
  }
  if (!isPlainObject(raw.apps)) fail(file, 'apps must be an object');
  for (const [key, slug] of Object.entries(raw.apps)) {
    if (!isNonEmptyString(slug)) fail(file, `apps.${key} must be a non-empty string`);
  }
}

function checkTrustedAuthors(file, raw) {
  if (!Array.isArray(raw.trustedAuthors)) fail(file, 'trustedAuthors must be an array');
  raw.trustedAuthors.forEach((entry, index) => {
    const where = `trustedAuthors[${index}]`;
    if (!isPlainObject(entry)) fail(file, `${where} must be an object`);
    const unknown = Object.keys(entry).filter((key) => !TRUSTED_AUTHOR_KEYS.includes(key));
    if (unknown.length > 0) fail(file, `${where} has unknown key "${unknown[0]}"`);
    checkActorRef(file, entry.actor, `${where}.actor`, raw.apps);
    if (!SCOPES.includes(entry.scope)) fail(file, `${where}.scope must be one of ${SCOPES.join(', ')}`);
  });
}

function checkLabelActors(file, raw) {
  if (!isPlainObject(raw.labelActors)) fail(file, 'labelActors must be an object');
  const seen = new Set();
  for (const [label, actor] of Object.entries(raw.labelActors)) {
    const folded = label.toLowerCase();
    if (seen.has(folded)) fail(file, `labelActors key "${label}" differs from another key only by case`);
    seen.add(folded);
    const star = label.indexOf('*');
    if (star !== -1 && star !== label.length - 1) {
      fail(file, `labelActors key "${label}" may only use "*" at the end`);
    }
    checkActorRef(file, actor, `labelActors["${label}"]`, raw.apps);
  }
}

function checkLimits(file, raw) {
  if (!isPlainObject(raw.limits)) fail(file, 'limits must be an object');
  const unknown = Object.keys(raw.limits).filter((key) => !LIMIT_KEYS.includes(key));
  if (unknown.length > 0) fail(file, `unknown limits key "${unknown[0]}"`);
  for (const key of LIMIT_KEYS) {
    if (!Number.isInteger(raw.limits[key]) || raw.limits[key] < 0) {
      fail(file, `limits.${key} must be a non-negative integer`);
    }
  }
}

function checkTestIntegrity(file, raw) {
  const section = raw.testIntegrity;
  if (!isPlainObject(section)) fail(file, 'testIntegrity must be an object');
  const unknown = Object.keys(section).filter((key) => !TEST_INTEGRITY_KEYS.includes(key));
  if (unknown.length > 0) fail(file, `unknown testIntegrity key "${unknown[0]}"`);
  for (const key of TEST_INTEGRITY_KEYS) {
    if (!isStringArray(section[key])) fail(file, `testIntegrity.${key} must be an array of strings`);
  }
  for (const key of REGEX_LISTS) {
    for (const pattern of section[key]) {
      try {
        new RegExp(pattern);
      } catch {
        fail(file, `testIntegrity.${key} has a pattern that does not compile: ${pattern}`);
      }
    }
  }
}

function normalize(raw) {
  return {
    ...raw,
    accounts: { owner: lowerLogin(raw.accounts.owner), agent: lowerLogin(raw.accounts.agent) },
    apps: Object.fromEntries(Object.entries(raw.apps).map(([key, slug]) => [key, lowerLogin(slug)])),
    trustedAuthors: raw.trustedAuthors.map((entry) => ({ ...entry, actor: canonicalActorRef(entry.actor) })),
    labelActors: Object.fromEntries(
      Object.entries(raw.labelActors).map(([label, actor]) => [label, canonicalActorRef(actor)]),
    ),
  };
}

/**
 * @param {{ root: string }} options
 * @returns {Promise<Config>}
 */
export async function loadConfig({ root }) {
  const file = path.join(root, CONFIG_DIR, CONFIG_FILE);
  const raw = await readJson(file);
  if (raw === undefined) throw new ConfigError(`${CONFIG_FILE}: file not found`, file);
  checkTopLevel(file, raw);
  checkStrings(file, raw);
  checkAccountsAndApps(file, raw);
  checkTrustedAuthors(file, raw);
  checkLabelActors(file, raw);
  checkLimits(file, raw);
  checkTestIntegrity(file, raw);
  return normalize(raw);
}

/**
 * @param {{ root: string }} options
 * @returns {Promise<Hotspot[]>}
 */
export async function loadHotspots({ root }) {
  const file = path.join(root, CONFIG_DIR, HOTSPOTS_FILE);
  const raw = await readJson(file);
  if (raw === undefined) return [];
  if (!isPlainObject(raw) || raw.schemaVersion !== SUPPORTED_SCHEMA_VERSION || !Array.isArray(raw.hotspots)) {
    fail(file, `must be { "schemaVersion": ${SUPPORTED_SCHEMA_VERSION}, "hotspots": [...] }`);
  }
  raw.hotspots.forEach((hotspot, index) => {
    const valid = isPlainObject(hotspot) && isNonEmptyString(hotspot.name) && isStringArray(hotspot.paths);
    if (!valid) fail(file, `hotspots[${index}] must be { name: string, paths: string[] }`);
  });
  return raw.hotspots;
}

/**
 * Repository root for a module at `scripts/<dir>/<file>.mjs` or `scripts/<file>.mjs`.
 * @param {string} scriptUrl `import.meta.url` of the calling module
 * @returns {string}
 */
export function repoRoot(scriptUrl) {
  let directory;
  try {
    directory = path.dirname(fileURLToPath(scriptUrl));
  } catch {
    throw new ConfigError(`not a file: URL: ${scriptUrl}`);
  }
  while (path.basename(directory) !== SCRIPTS_DIR_NAME) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new ConfigError(`no "${SCRIPTS_DIR_NAME}" directory above ${scriptUrl}`);
    directory = parent;
  }
  return path.dirname(directory);
}

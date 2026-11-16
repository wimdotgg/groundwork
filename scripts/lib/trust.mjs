import { ConfigError } from './config.mjs';

const APP_REF_PREFIX = 'app:';
const BOT_SUFFIX = '[bot]';
const MIN_FENCE_LENGTH = 3;

/** @typedef {import('./config.mjs').Config} Config */
/** @typedef {{ event: string, actor?: { login: string }, label?: { name: string }, created_at: string }} TimelineEvent   subset of the REST timeline item */

const SCOPES_BY_KIND = {
  issue: ['any', 'issues'],
  'pull-request': ['any', 'pull-requests'],
  comment: ['any'],
};

/**
 * Label names compare lower-case only (no trim): GitHub label names are case-insensitive.
 * @param {string} label
 */
export function normalizeLabel(label) {
  return String(label ?? '').toLowerCase();
}

/** @param {string} login */
export function normalizeLogin(login) {
  return String(login ?? '').trim().toLowerCase();
}

/**
 * @param {string} a
 * @param {string} b
 */
export function sameLogin(a, b) {
  const left = normalizeLogin(a);
  return left !== '' && left === normalizeLogin(b);
}

/**
 * @param {string} ref
 * @param {Config} config
 * @returns {string}
 */
export function resolveActor(ref, config) {
  const trimmed = String(ref).trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'owner' || lower === 'agent') return normalizeLogin(config.accounts[lower]);
  if (!lower.startsWith(APP_REF_PREFIX)) return lower;
  const key = trimmed.slice(APP_REF_PREFIX.length).trim();
  if (!Object.hasOwn(config.apps, key)) throw new ConfigError(`unknown app "${key}" in actor ref "${ref}"`);
  return normalizeLogin(`${config.apps[key]}${BOT_SUFFIX}`);
}

/**
 * @param {{ login: string, kind: 'issue'|'pull-request'|'comment' }} author
 * @param {Config} config
 * @returns {boolean}
 */
export function isTrustedAuthor({ login, kind }, config) {
  if (!Object.hasOwn(SCOPES_BY_KIND, kind)) return false;
  const scopes = SCOPES_BY_KIND[kind];
  return config.trustedAuthors.some(
    (entry) => scopes.includes(entry.scope) && sameLogin(resolveActor(entry.actor, config), login),
  );
}

/**
 * Exact `labelActors` key first, then the longest matching `prefix*` key. Label names match case-insensitively.
 * @param {string} label
 * @param {Config} config
 * @returns {string|null}
 */
export function requiredLabelActor(label, config) {
  const name = normalizeLabel(label);
  const keys = Object.keys(config.labelActors);
  const exact = keys.find((key) => !key.endsWith('*') && normalizeLabel(key) === name);
  if (exact !== undefined) return resolveActor(config.labelActors[exact], config);
  const prefixKeys = keys
    .filter((key) => key.endsWith('*') && name.startsWith(normalizeLabel(key.slice(0, -1))))
    .sort((a, b) => b.length - a.length);
  if (prefixKeys.length === 0) return null;
  return resolveActor(config.labelActors[prefixKeys[0]], config);
}

/**
 * The timeline must be chronological (pages concatenated in order); the last match wins.
 * @param {TimelineEvent[]} timeline
 * @param {string} label
 * @returns {{ actor: string, createdAt: string }|null}
 */
export function latestLabeledEvent(timeline, label) {
  const name = normalizeLabel(label);
  const matches = timeline.filter(
    (item) => item.event === 'labeled' && normalizeLabel(item.label?.name) === name,
  );
  if (matches.length === 0) return null;
  const latest = matches[matches.length - 1];
  return { actor: normalizeLogin(latest.actor?.login), createdAt: latest.created_at };
}

/**
 * @param {{ labels: string[], timeline: TimelineEvent[] }} input
 * @param {Config} config
 * @returns {string[]}
 */
export function validLabels({ labels, timeline }, config) {
  return labels.filter((label) => {
    const required = requiredLabelActor(label, config);
    if (required === null) return true;
    const event = latestLabeledEvent(timeline, label);
    return event !== null && sameLogin(event.actor, required);
  });
}

/**
 * @param {string} text
 * @param {string} author
 * @returns {string}
 */
export function untrustedBlock(text, author) {
  const body = String(text ?? '');
  const longestRun = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(MIN_FENCE_LENGTH, longestRun + 1));
  const info = `untrusted ${String(author ?? '').replace(/[^A-Za-z0-9[\]_-]/g, '')}`;
  return `${fence}${info}\n${body}\n${fence}`;
}

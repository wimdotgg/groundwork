import { pathToFileURL } from 'node:url';
import { runValidator } from '../lib/ci.mjs';
import { apiPath } from '../lib/github.mjs';
import { validLabels } from '../lib/trust.mjs';

/** @typedef {import('../lib/ci.mjs').ValidatorContext} ValidatorContext */
/** @typedef {import('../lib/ci.mjs').ValidatorResult} ValidatorResult */
/** @typedef {{ filename: string, previousFilename: string|null, status: string, additions: number, deletions: number, patch: string|null }} PrFile   patch null when GitHub omits it */
/** @typedef {{ eventName: string, validLabels: string[], files: PrFile[] }} TestIntegrityFacts */

export const name = 'test-integrity';

const PULL_REQUEST_EVENT = 'pull_request';
const EXCEPTION_LABEL = 'integrity-exception';
const REPO_PATH = '/repos/{owner}/{repo}';
const NUMBER_PATTERN = /\d+(?:\.\d+)?/g;
const NUMBER_PLACEHOLDER = '#';
const REMOVED_STATUS = 'removed';
const RENAMED_STATUS = 'renamed';

function emptyFacts(eventName) {
  return { eventName, validLabels: [], files: [] };
}

function toPrFile(file) {
  return {
    filename: file.filename,
    previousFilename: file.previous_filename ?? null,
    status: file.status,
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    patch: typeof file.patch === 'string' ? file.patch : null,
  };
}

const labelName = (label) => (typeof label === 'string' ? label : label?.name);

/**
 * @param {ValidatorContext} ctx
 * @returns {Promise<TestIntegrityFacts>}
 */
export async function collect(ctx) {
  if (ctx.eventName !== PULL_REQUEST_EVENT) return emptyFacts(ctx.eventName);
  const params = { ...ctx.repo, number: ctx.payload.pull_request.number };
  const [issue, timeline, files] = await Promise.all([
    ctx.client.request('GET', apiPath(`${REPO_PATH}/issues/{number}`, params)),
    ctx.client.paginate(apiPath(`${REPO_PATH}/issues/{number}/timeline`, params)),
    ctx.client.paginate(apiPath(`${REPO_PATH}/pulls/{number}/files`, params)),
  ]);
  const labels = (issue.data?.labels ?? []).map(labelName).filter(Boolean);
  return {
    eventName: ctx.eventName,
    validLabels: validLabels({ labels, timeline }, ctx.config),
    files: files.map(toPrFile),
  };
}

function escapeRegExp(character) {
  return character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** `**` followed by `/` also matches zero directories, so `**` + `/x` matches a root-level `x`. */
function globToRegExp(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    if (glob.startsWith('**/', index)) {
      source += '(?:.*/)?';
      index += 2;
    } else if (glob.startsWith('**', index)) {
      source += '.*';
      index += 1;
    } else if (glob[index] === '*') source += '[^/]*';
    else if (glob[index] === '?') source += '[^/]';
    else source += escapeRegExp(glob[index]);
  }
  return new RegExp(`^${source}$`);
}

function matcherFor(globs) {
  const expressions = globs.map(globToRegExp);
  return (path) => expressions.some((expression) => expression.test(path));
}

const anyMatch = (patterns) => (line) => patterns.some((pattern) => pattern.test(line));

function patchLines(patch, marker) {
  const header = marker.repeat(3);
  return patch
    .split('\n')
    .filter((line) => line.startsWith(marker) && !line.startsWith(header))
    .map((line) => line.slice(1));
}

const normalizeNumbers = (line) => line.replace(NUMBER_PATTERN, NUMBER_PLACEHOLDER);

function hasNumberOnlyChange(removed, added) {
  const addedByShape = new Map();
  for (const line of added) {
    const shape = normalizeNumbers(line);
    addedByShape.set(shape, [...(addedByShape.get(shape) ?? []), line]);
  }
  return removed.some((line) => {
    const shape = normalizeNumbers(line);
    return shape !== line && (addedByShape.get(shape) ?? []).some((candidate) => candidate !== line);
  });
}

const hasNoChangedLines = (file) => file.additions + file.deletions === 0;

function renameProblem(file, rules) {
  const wasTest = file.status === RENAMED_STATUS && file.previousFilename && rules.isTestPath(file.previousFilename);
  if (!wasTest || rules.isTestPath(file.filename)) return null;
  return `${file.previousFilename}: test file renamed to non-test path ${file.filename}`;
}

function patchProblems(file, patch, rules) {
  const added = patchLines(patch, '+');
  const removed = patchLines(patch, '-');
  const problems = [];
  if (rules.isTestPath(file.filename)) {
    const lost = removed.filter(rules.isDeclaration).length;
    const gained = added.filter(rules.isDeclaration).length;
    if (lost > gained) problems.push(`${file.filename}: test declarations dropped (${lost} removed, ${gained} added)`);
  }
  for (const line of added.filter(rules.isSuppression)) problems.push(`${file.filename}: suppression added: ${line.trim()}`);
  if (rules.isThresholdPath(file.filename) && hasNumberOnlyChange(removed, added)) {
    problems.push(`${file.filename}: threshold value changed`);
  }
  return problems;
}

function fileProblems(file, rules) {
  const isGuarded = rules.isTestPath(file.filename) || rules.isThresholdPath(file.filename);
  if (rules.isTestPath(file.filename) && file.status === REMOVED_STATUS) return [`${file.filename}: test file deleted`];
  const problems = [renameProblem(file, rules)].filter(Boolean);
  if (file.patch !== null) return [...problems, ...patchProblems(file, file.patch, rules)];
  if (isGuarded && !hasNoChangedLines(file)) problems.push(`${file.filename}: patch omitted by GitHub, cannot verify`);
  return problems;
}

function compileRules(config) {
  const { testGlobs, thresholdGlobs, testDeclarationPatterns, suppressionPatterns } = config.testIntegrity;
  return {
    isTestPath: matcherFor(testGlobs),
    isThresholdPath: matcherFor(thresholdGlobs),
    isDeclaration: anyMatch(testDeclarationPatterns.map((pattern) => new RegExp(pattern))),
    isSuppression: anyMatch(suppressionPatterns.map((pattern) => new RegExp(pattern))),
  };
}

function result(conclusion, { errors = [], warnings = [], details = '' }) {
  return { conclusion, errors, warnings, details, actions: [] };
}

/**
 * @param {TestIntegrityFacts} facts
 * @param {import('../lib/config.mjs').Config} config
 * @returns {ValidatorResult}
 */
export function evaluate(facts, config) {
  if (facts.eventName !== PULL_REQUEST_EVENT) return result('skip', { details: `Not a pull request event (${facts.eventName}).` });
  const rules = compileRules(config);
  const problems = facts.files.flatMap((file) => fileProblems(file, rules));
  if (problems.length === 0) return result('pass', { details: `${facts.files.length} files checked.` });
  if (facts.validLabels.includes(EXCEPTION_LABEL)) {
    return result('pass', { warnings: problems, details: `${EXCEPTION_LABEL} label applied: failures reported as warnings.` });
  }
  return result('fail', { errors: problems });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runValidator({ name, collect, evaluate }, { argv: process.argv, env: process.env, scriptUrl: import.meta.url });
}

import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runValidator } from '../lib/ci.mjs';
import { apiPath } from '../lib/github.mjs';
import { normalizeLabel, validLabels } from '../lib/trust.mjs';

/** @typedef {import('../lib/ci.mjs').ValidatorContext} ValidatorContext */
/** @typedef {import('../lib/ci.mjs').ValidatorResult} ValidatorResult */
/** @typedef {{ filename: string, previousFilename: string|null, status: string, additions: number, deletions: number, patch: string|null }} PrFile   patch null when GitHub omits it */
/** @typedef {{ eventName: string, validLabels: string[], files: PrFile[] }} TestIntegrityFacts */

export const name = 'test-integrity';

const PULL_REQUEST_EVENT = 'pull_request';
const EXCEPTION_LABEL = 'integrity-exception';
const REPO_PATH = '/repos/{owner}/{repo}';
const COMMENT_LINE_PATTERN = /^\s*(?:\/\/|#|\*|\/\*)/;
const REMOVED_STATUS = 'removed';
const RENAMED_STATUS = 'renamed';
const GUARDED_KINDS = [{ label: 'test', matches: 'isTestPath' }, { label: 'threshold', matches: 'isThresholdPath' }];

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

function matcherFor(globs) {
  return (path) => globs.some((glob) => posix.matchesGlob(path, glob));
}

const anyMatch = (patterns) => (line) => patterns.some((pattern) => pattern.test(line));

/** GitHub patches carry no file headers, so the first character alone classifies a line. */
function patchLines(patch, marker) {
  return patch
    .split('\n')
    .filter((line) => line.startsWith(marker))
    .map((line) => line.slice(1));
}

const collapseWhitespace = (line) => line.replace(/\s+/g, ' ').trim();
const hasNumber = (line) => /\d*\.?\d+/.test(line);

function hasThresholdChange(removed, added) {
  const keptLines = new Set(added.map(collapseWhitespace));
  return removed.some((line) => hasNumber(line) && !keptLines.has(collapseWhitespace(line)));
}

const isCommentLine = (line) => COMMENT_LINE_PATTERN.test(line);

function renameProblem(file, rules) {
  if (file.status !== RENAMED_STATUS || !file.previousFilename) return null;
  const left = GUARDED_KINDS.find(({ matches }) => rules[matches](file.previousFilename) && !rules[matches](file.filename));
  return left ? `${file.previousFilename}: ${left.label} file renamed to non-guarded path ${file.filename}` : null;
}

function deletionProblem(file, rules) {
  if (file.status !== REMOVED_STATUS) return null;
  const kind = GUARDED_KINDS.find(({ matches }) => rules[matches](file.filename));
  return kind ? `${file.filename}: ${kind.label} file deleted` : null;
}

function patchProblems(file, patch, rules) {
  const added = patchLines(patch, '+');
  const removed = patchLines(patch, '-');
  const problems = [];
  if (rules.isTestPath(file.filename)) {
    const lost = removed.filter(rules.isDeclaration).length;
    const gained = added.filter((line) => !isCommentLine(line) && rules.isDeclaration(line)).length;
    if (lost > gained) problems.push(`${file.filename}: test declarations dropped (${lost} removed, ${gained} added)`);
  }
  for (const line of added.filter(rules.isSuppression)) problems.push(`${file.filename}: suppression added: ${line.trim()}`);
  if (rules.isThresholdPath(file.filename) && hasThresholdChange(removed, added)) {
    problems.push(`${file.filename}: threshold value changed or removed`);
  }
  return problems;
}

function fileProblems(file, rules) {
  const deletion = deletionProblem(file, rules);
  if (deletion) return [deletion];
  const problems = [renameProblem(file, rules)].filter(Boolean);
  if (file.patch !== null) return [...problems, ...patchProblems(file, file.patch, rules)];
  if (file.additions > 0 && file.status !== REMOVED_STATUS) problems.push(`${file.filename}: patch omitted by GitHub, cannot verify`);
  return problems;
}

function compileRules(config) {
  const { testGlobs, thresholdGlobs, testDeclarationPatterns, suppressionPatterns } = config.testIntegrity;
  return {
    isTestPath: matcherFor(testGlobs),
    isThresholdPath: matcherFor(thresholdGlobs),
    isDeclaration: anyMatch(testDeclarationPatterns.map((pattern) => new RegExp(pattern))),
    isSuppression: anyMatch(suppressionPatterns.map((pattern) => new RegExp(pattern, 'i'))),
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
  if (facts.validLabels.some((label) => normalizeLabel(label) === EXCEPTION_LABEL)) {
    return result('pass', { warnings: problems, details: `${EXCEPTION_LABEL} label applied: failures reported as warnings.` });
  }
  return result('fail', { errors: problems });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runValidator({ name, collect, evaluate }, { argv: process.argv, env: process.env, scriptUrl: import.meta.url });
}

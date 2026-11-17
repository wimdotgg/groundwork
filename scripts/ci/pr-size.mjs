import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runValidator } from '../lib/ci.mjs';
import { apiPath } from '../lib/github.mjs';
import { normalizeLabel, resolveActor, sameLogin, validLabels } from '../lib/trust.mjs';

/** @typedef {import('../lib/ci.mjs').ValidatorContext} ValidatorContext */
/** @typedef {import('../lib/ci.mjs').ValidatorResult} ValidatorResult */
/** @typedef {{ filename: string, previousFilename: string|null, status: string, additions: number, deletions: number, patch: string|null }} PrFile */
/** @typedef {{ eventName: string, author: string|null, validLabels: string[], files: PrFile[] }} PrSizeFacts */

export const name = 'pr-size';

const MERGE_GROUP_EVENT = 'merge_group';
const SIZE_EXCEPTION_LABEL = 'size-exception';
const DEPENDENCIES_LABEL = 'dependencies';
const AUTOMATED_LABEL = 'automated';
const DEPENDABOT_ACTOR = 'dependabot[bot]';
const RELEASE_ACTOR = 'app:release';
const FILES_PATH = '/repos/{owner}/{repo}/pulls/{number}/files';
const TIMELINE_PATH = '/repos/{owner}/{repo}/issues/{number}/timeline';

/**
 * @param {ValidatorContext} ctx
 * @returns {Promise<PrSizeFacts>}
 */
export async function collect(ctx) {
  if (ctx.eventName === MERGE_GROUP_EVENT) return { eventName: ctx.eventName, author: null, validLabels: [], files: [] };
  const pullRequest = ctx.payload.pull_request;
  const params = { ...ctx.repo, number: pullRequest.number };
  const rawFiles = await ctx.client.paginate(apiPath(FILES_PATH, params));
  const timeline = await ctx.client.paginate(apiPath(TIMELINE_PATH, params));
  const labels = (pullRequest.labels ?? []).map((label) => label.name);
  return {
    eventName: ctx.eventName,
    author: pullRequest.user?.login ?? null,
    validLabels: validLabels({ labels, timeline }, ctx.config),
    files: rawFiles.map((file) => ({
      filename: file.filename,
      previousFilename: file.previous_filename ?? null,
      status: file.status,
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      patch: file.patch ?? null,
    })),
  };
}

function hasLabel(facts, label) {
  return facts.validLabels.some((candidate) => normalizeLabel(candidate) === label);
}

function isExempt(facts, config) {
  const dependabot = hasLabel(facts, DEPENDENCIES_LABEL) && sameLogin(facts.author, resolveActor(DEPENDABOT_ACTOR, config));
  const releaseBot = hasLabel(facts, AUTOMATED_LABEL) && sameLogin(facts.author, resolveActor(RELEASE_ACTOR, config));
  return dependabot || releaseBot;
}

function isExcluded(filename, config) {
  return [...config.sizeExcludeGlobs, ...config.generatedGlobs].some((glob) => path.posix.matchesGlob(filename, glob));
}

/**
 * @param {PrSizeFacts} facts
 * @param {import('../lib/config.mjs').Config} config
 * @returns {ValidatorResult}
 */
export function evaluate(facts, config) {
  if (facts.eventName === MERGE_GROUP_EVENT) return { conclusion: 'skip', errors: [], warnings: [], details: '', actions: [] };
  if (isExempt(facts, config)) {
    return { conclusion: 'pass', errors: [], warnings: [], details: 'Exempt: dependency or release automation PR.', actions: [] };
  }
  const counted = facts.files.filter((file) => !isExcluded(file.filename, config));
  const lines = counted.reduce((total, file) => total + file.additions + file.deletions, 0);
  const { prChangedLines, prFiles } = config.limits;
  const errors = [];
  if (lines > prChangedLines) errors.push(`${lines} changed lines exceed the limit of ${prChangedLines}`);
  if (counted.length > prFiles) errors.push(`${counted.length} files exceed the limit of ${prFiles}`);
  const details = `${lines} changed lines across ${counted.length} files (excluding lockfiles, snapshots and generated files).`;
  if (errors.length === 0) return { conclusion: 'pass', errors, warnings: [], details, actions: [] };
  if (hasLabel(facts, SIZE_EXCEPTION_LABEL)) {
    return { conclusion: 'pass', errors: [], warnings: [`size-exception applied: ${errors.join('; ')}`], details, actions: [] };
  }
  return { conclusion: 'fail', errors, warnings: [], details, actions: [] };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runValidator({ name, collect, evaluate }, { argv: process.argv, env: process.env, scriptUrl: import.meta.url });
}

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runValidator } from '../lib/ci.mjs';
import { CONFIG_DIR } from '../lib/config.mjs';
import { GitHubError, apiPath } from '../lib/github.mjs';
import {
  ISSUE_TYPES, TITLE_TYPES, isHotfixLane, loadIssueFacts, normalizeIssueBody, parseConventionalTitle, validateIssueBody,
} from '../lib/issue-model.mjs';
import {
  criterionIds, findClosingRefs, parseSections, parseTable,
} from '../lib/markdown.mjs';
import {
  isTrustedAuthor, latestLabeledEvent, normalizeLabel, resolveActor, sameLogin, validLabels,
} from '../lib/trust.mjs';

/** @typedef {import('../lib/ci.mjs').ValidatorContext} ValidatorContext */
/** @typedef {import('../lib/ci.mjs').ValidatorResult} ValidatorResult */
/** @typedef {import('../lib/issue-model.mjs').IssueFacts} IssueFacts */
/** @typedef {{ filename: string, previousFilename: string|null, status: string, additions: number, deletions: number, patch: string|null }} PrFile */
/** @typedef {{ number: number, title: string, body: string, draft: boolean, author: string, headRef: string,
 *   headRepo: string, headSha: string, labels: string[], validLabels: string[] }} PrFacts   headRepo is owner/name */
/** @typedef {{ eventName: string, repo: string, pr: PrFacts|null, closingRefs: Array<{ keyword: string, owner: string|null, repo: string|null, number: number }>,
 *   issue: IssueFacts|null, noIssueLabeledAt: string|null, headArrivedAt: string|null, files: PrFile[], stateTemplate: string|null,
 *   commitAuthors: string[], renamedBy: string[] }} PrMetadataFacts
 *   repo is owner/name. issue: the single same-repository closing reference's issue, else null; files: only for Spike issues, else [];
 *   headArrivedAt: the later of the earliest run created_at for the head SHA on the head branch and the newest head_ref_force_pushed event,
 *   read only when no-issue is present on the PR; commitAuthors: one login per PR commit, read only for Dependabot PRs;
 *   renamedBy: actor of every `renamed` timeline event */

export const name = 'pr-metadata';

const PULL_REQUEST_EVENT = 'pull_request';
const MERGE_GROUP_EVENT = 'merge_group';
const NO_ISSUE_LABEL = 'no-issue';
const DEPENDENCIES_LABEL = 'dependencies';
const AUTOMATED_LABEL = 'automated';
const NEEDS_FORMAT_LABEL = 'needs-format';
const ACCEPTED_LABEL = 'accepted';
const DEPENDABOT_ACTOR = 'dependabot[bot]';
const RELEASE_ACTOR = 'app:release';
const NOT_FOUND = 404;
const SPIKE_TYPE = 'Spike';
const CRITERION_PREFIX = 'AC';
const CRITERIA_TYPES = ['Feature', 'Bug', 'Chore'];
const CRITERIA_HEADING = 'Acceptance criteria';
const NO_RESPONSE = '_No response_';
const MAX_QUOTED_LENGTH = 200;
const TEMPLATE_PATH = ['templates', 'state-section.md'];
const DEPENDABOT_REQUIRED_ISSUE_TYPE = 'Chore';
const ISSUE_PATH = '/repos/{owner}/{repo}/issues/{number}';
const PULL_PATH = '/repos/{owner}/{repo}/pulls/{number}';
const TIMELINE_PATH = '/repos/{owner}/{repo}/issues/{number}/timeline';
const FILES_PATH = '/repos/{owner}/{repo}/pulls/{number}/files';
const COMMITS_PATH = '/repos/{owner}/{repo}/pulls/{number}/commits';
const RUNS_PATH = '/repos/{owner}/{repo}/actions/runs';
const FORCE_PUSH_EVENT = 'head_ref_force_pushed';
const RENAMED_EVENT = 'renamed';
const NOREPLY_EMAIL = /^(?:\d+\+)?(.+)@users\.noreply\.github\.com$/i;
const BRANCH_PATTERN = /^issue\/\d+$/;
const UPDATE_PAIR = /\bfrom\s+(\S+)\s+to\s+(\S+)/gi;
const LINK_SYNTAX = /\[([^\]]*)\]\([^)]*\)/g;
const HTML_TAG = /<\/?[A-Za-z][^<>]*>/g;
const VERSION = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][0-9A-Za-z.+-]*)?$/;
const STARTS_WITH_DIGIT = /^v?\d/;
const VERSION_DECORATION = /^[`'"*([]+|[`'"*,.;:)\]]+$/g;
const UPDATE_RANK = { patch: 0, minor: 1, major: 2 };
const EVIDENCE_HEADER = /^evidence/i;
const HTML_ENTITY = /&#?\w+;/g;
const HIDDEN_CHARACTERS = /[​-‍⁠﻿]/g;
const MEANINGFUL_CHARACTER = /[\p{L}\p{N}]/u;
// Cells that look filled but carry no evidence; compared case-insensitively after trimming punctuation.
const FILLER_EVIDENCE = ['tbd', 'todo', 'n/a', 'none', 'pending'];
const PLACEHOLDER_TOKEN = /<[^<>\n]+>/g;
const STATE_SECTION = 'State';
const STATE_FIELD_LINE = /^[\s>*_~`+-]*([A-Za-z][A-Za-z ]*?)[\s*_~`]*:[\s*_~`]*(.*)$/;

function emptyFacts(eventName) {
  return {
    eventName,
    repo: '',
    pr: null,
    closingRefs: [],
    issue: null,
    noIssueLabeledAt: null,
    headArrivedAt: null,
    files: [],
    stateTemplate: null,
    commitAuthors: [],
    renamedBy: [],
  };
}

function hasLabel(labels, label) {
  return labels.some((candidate) => normalizeLabel(candidate) === label);
}

function isDependabotAuthor(login, config) {
  return sameLogin(login, resolveActor(DEPENDABOT_ACTOR, config));
}

function isSameRepository(ref, repoName) {
  return ref.owner === null || sameLogin(`${ref.owner}/${ref.repo}`, repoName);
}

function requirePull(payload) {
  const pull = payload?.pull_request;
  if (!Number.isInteger(pull?.number)) throw new Error('pull_request.number is missing from the event payload');
  if (!pull.head?.sha || !pull.head?.ref) throw new Error('pull_request.head is missing from the event payload');
  return pull;
}

async function loadClosedIssue(ctx, closingRefs) {
  const repoName = `${ctx.repo.owner}/${ctx.repo.repo}`;
  if (closingRefs.length !== 1 || !isSameRepository(closingRefs[0], repoName)) return null;
  try {
    return await loadIssueFacts(ctx.client, { ...ctx.repo, number: closingRefs[0].number }, { config: ctx.config });
  } catch (error) {
    // A reference to a missing issue is a content problem for evaluate, not a crash.
    if (error instanceof GitHubError && error.status === NOT_FOUND) return null;
    throw error;
  }
}

function eventTimes(timeline, eventName) {
  return timeline.filter((item) => item.event === eventName).map((item) => new Date(item.created_at).getTime()).filter(Number.isFinite);
}

// Server-side arrival of the head: the earliest run for the head SHA on the PR's own branch (a run on another branch
// could predate the PR), pushed later by the newest force push. Fast-forward pushes are covered by protected-labels
// removing no-issue on every new commit.
async function loadHeadArrival(ctx, { headSha, headRef }, timeline) {
  const runs = await ctx.client.paginate(apiPath(RUNS_PATH, ctx.repo), { query: { head_sha: headSha }, itemsKey: 'workflow_runs' });
  const runTimes = runs.filter((run) => run.head_branch === headRef).map((run) => new Date(run.created_at).getTime()).filter(Number.isFinite);
  if (runTimes.length === 0) return null;
  return new Date(Math.max(Math.min(...runTimes), ...eventTimes(timeline, FORCE_PUSH_EVENT))).toISOString();
}

function commitAuthorLogin(commit) {
  if (commit.author?.login) return commit.author.login;
  return NOREPLY_EMAIL.exec(commit.commit?.author?.email ?? '')?.[1] ?? '';
}

async function loadCommitAuthors(ctx, params) {
  const commits = await ctx.client.paginate(apiPath(COMMITS_PATH, params));
  return commits.map(commitAuthorLogin);
}

async function loadFiles(ctx, params) {
  const rawFiles = await ctx.client.paginate(apiPath(FILES_PATH, params));
  return rawFiles.map((file) => ({
    filename: file.filename,
    previousFilename: file.previous_filename ?? null,
    status: file.status,
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    patch: file.patch ?? null,
  }));
}

async function readStateTemplate(root) {
  const file = path.join(root, CONFIG_DIR, ...TEMPLATE_PATH);
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read the State template ${file}: ${error.message}`);
  }
}

/**
 * @param {ValidatorContext} ctx
 * @returns {Promise<PrMetadataFacts>}
 */
export async function collect(ctx) {
  if (ctx.eventName === MERGE_GROUP_EVENT) return emptyFacts(ctx.eventName);
  if (ctx.eventName !== PULL_REQUEST_EVENT) throw new Error(`pr-metadata does not handle the ${ctx.eventName} event`);
  const pull = requirePull(ctx.payload);
  const params = { ...ctx.repo, number: pull.number };
  // Live reads: title, body, labels and the draft flag in the event payload are stale on a re-run after an edit.
  const livePull = (await ctx.client.request('GET', apiPath(PULL_PATH, params))).data;
  if (livePull.head?.sha !== pull.head.sha) {
    throw new Error(`stale run: the PR head is ${livePull.head?.sha} but this run is for ${pull.head.sha}; wait for the run of the new head`);
  }
  const live = (await ctx.client.request('GET', apiPath(ISSUE_PATH, params))).data;
  const timeline = await ctx.client.paginate(apiPath(TIMELINE_PATH, params));
  const labels = (live.labels ?? []).map((label) => label.name);
  const author = pull.user?.login ?? '';
  const pr = {
    number: pull.number,
    title: live.title ?? '',
    body: live.body ?? '',
    draft: livePull.draft === true,
    author,
    headRef: pull.head.ref,
    headRepo: pull.head.repo?.full_name ?? '',
    headSha: pull.head.sha,
    labels,
    validLabels: validLabels({ labels, timeline }, ctx.config),
  };
  const closingRefs = findClosingRefs(pr.body);
  const issue = await loadClosedIssue(ctx, closingRefs);
  const hasNoIssue = hasLabel(labels, NO_ISSUE_LABEL);
  return {
    eventName: ctx.eventName,
    repo: `${ctx.repo.owner}/${ctx.repo.repo}`,
    pr,
    closingRefs,
    issue,
    noIssueLabeledAt: hasNoIssue ? latestLabeledEvent(timeline, NO_ISSUE_LABEL)?.createdAt ?? null : null,
    headArrivedAt: hasNoIssue ? await loadHeadArrival(ctx, pr, timeline) : null,
    files: issue?.type === SPIKE_TYPE ? await loadFiles(ctx, params) : [],
    stateTemplate: await readStateTemplate(ctx.root),
    commitAuthors: isDependabotAuthor(author, ctx.config) ? await loadCommitAuthors(ctx, params) : [],
    renamedBy: timeline.filter((item) => item.event === RENAMED_EVENT).map((item) => item.actor?.login ?? ''),
  };
}

// Untrusted text reaches the job summary, so it goes in a code span: mentions, links and HTML stay inert.
function inlineCode(text) {
  const flat = String(text).replace(/\s+/g, ' ').replaceAll('`', "'");
  const capped = flat.length > MAX_QUOTED_LENGTH ? `${flat.slice(0, MAX_QUOTED_LENGTH)}...` : flat;
  return `\`${capped}\``;
}

const stripDecoration = (token) => token.replace(VERSION_DECORATION, '');

function parseVersion(token) {
  const match = VERSION.exec(stripDecoration(token));
  return match ? { major: Number(match[1]), minor: Number(match[2] ?? 0), patch: Number(match[3] ?? 0) } : null;
}

function jumpSize(from, to) {
  if (from.major !== to.major) return 'major';
  return from.minor === to.minor ? 'patch' : 'minor';
}

// A pair that is not a version pair is ignored, unless both sides start with a digit: then it is a version we cannot
// read, which counts as major so the exemption fails closed.
function pairJump([rawFrom, rawTo]) {
  const from = parseVersion(rawFrom);
  const to = parseVersion(rawTo);
  if (from && to) return jumpSize(from, to);
  return [rawFrom, rawTo].every((side) => STARTS_WITH_DIGIT.test(stripDecoration(side))) ? 'major' : null;
}

function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

// Grouped Dependabot bodies list updates in a `| Package | From | To |` table instead of `from <a> to <b>` prose.
function tablePairs(text) {
  const pairs = [];
  let columns = null;
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) {
      columns = null;
      continue;
    }
    const cells = tableCells(line);
    const lower = cells.map((cell) => cell.toLowerCase());
    if (lower.includes('from') && lower.includes('to')) columns = { from: lower.indexOf('from'), to: lower.indexOf('to') };
    else if (columns) pairs.push([cells[columns.from] ?? '', cells[columns.to] ?? '']);
  }
  return pairs;
}

/**
 * Largest semver jump over every `from <a> to <b>` pair in title and body, including From/To table rows. Link syntax
 * and HTML tags are stripped first. No readable pair at all is unknown and counts as major, so the exemption fails closed.
 * @param {string} title
 * @param {string} body
 * @returns {'major'|'minor'|'patch'}
 */
export function dependabotUpdateType(title, body) {
  const text = `${title}\n${body}`.replace(/\r\n?/g, '\n').replace(LINK_SYNTAX, '$1').replace(HTML_TAG, ' ');
  const prosePairs = [...text.matchAll(UPDATE_PAIR)].map((pair) => [pair[1], pair[2]]);
  const jumps = [...prosePairs, ...tablePairs(text)].map(pairJump).filter(Boolean);
  if (jumps.length === 0) return 'major';
  return jumps.reduce((largest, jump) => (UPDATE_RANK[jump] > UPDATE_RANK[largest] ? jump : largest));
}

function isLaterThan(later, earlier) {
  return new Date(later).getTime() > new Date(earlier).getTime();
}

function isFreshNoIssue(facts) {
  const { noIssueLabeledAt, headArrivedAt } = facts;
  return noIssueLabeledAt !== null && headArrivedAt !== null && isLaterThan(noIssueLabeledAt, headArrivedAt);
}

function isMinorDependabotUpdate(pr, config) {
  return isDependabotAuthor(pr.author, config) && hasLabel(pr.validLabels, DEPENDENCIES_LABEL) && dependabotUpdateType(pr.title, pr.body) !== 'major';
}

// Dependabot's own title and body are what dependabotUpdateType reads, so anyone else's commit or rename voids the
// exemption. Body edits are not tracked: the timeline records no edit actor, and a lowered update type needs write access.
function dependabotTamperErrors(facts, config) {
  if (!isMinorDependabotUpdate(facts.pr, config)) return [];
  const dependabot = resolveActor(DEPENDABOT_ACTOR, config);
  const foreignCommits = facts.commitAuthors.length === 0 || facts.commitAuthors.some((login) => !sameLogin(login, dependabot));
  if (foreignCommits) return ['Dependabot exemption refused: every commit on the PR must be authored by dependabot[bot]'];
  if (facts.renamedBy.some((login) => !sameLogin(login, dependabot))) return ['Dependabot exemption refused: the PR title was renamed by someone other than dependabot[bot]'];
  return [];
}

function exemptionReason(facts, config) {
  const { author, validLabels: valid } = facts.pr;
  if (isMinorDependabotUpdate(facts.pr, config) && dependabotTamperErrors(facts, config).length === 0) {
    return 'minor or patch dependency update by Dependabot';
  }
  if (hasLabel(valid, AUTOMATED_LABEL) && sameLogin(author, resolveActor(RELEASE_ACTOR, config))) {
    return 'release automation PR';
  }
  if (hasLabel(valid, NO_ISSUE_LABEL) && isFreshNoIssue(facts)) return 'no-issue applied after the head commit arrived';
  return null;
}

function staleNoIssueError(facts) {
  if (!hasLabel(facts.pr.validLabels, NO_ISSUE_LABEL) || isFreshNoIssue(facts)) return [];
  if (facts.headArrivedAt === null) return ['no-issue cannot be honored: no workflow run was found for the head commit'];
  return ['no-issue predates the head commit; the owner must re-apply it after the latest push'];
}

function closingRefErrors(facts) {
  const { closingRefs, repo } = facts;
  if (closingRefs.length === 0) return ['No closing reference: the body needs exactly one `Closes #N`'];
  if (closingRefs.length > 1) return [`${closingRefs.length} closing references found: exactly one is allowed`];
  const [ref] = closingRefs;
  if (!isSameRepository(ref, repo)) return [`Closing reference #${ref.number} points to ${inlineCode(`${ref.owner}/${ref.repo}`)}, not this repository`];
  if (facts.issue === null) return [`Issue #${ref.number} was not found in this repository`];
  return [];
}

function isAccepted(issue, config) {
  const acceptedEpic = issue.ancestors.some((ancestor) => ancestor.type === 'Epic' && hasLabel(ancestor.validLabels, ACCEPTED_LABEL));
  return acceptedEpic || isHotfixLane(issue, config);
}

// The needs-format label is set by a workflow that can lag or be removed, so the body is validated here too.
// Validation messages can quote issue text, hence the code spans. Unsupported types are reported by the caller.
function bodyErrors(issue) {
  if (!ISSUE_TYPES.includes(issue.type)) return [];
  const validation = validateIssueBody({ type: issue.type, body: issue.body });
  return validation.errors.map((error) => `Issue #${issue.number} body is invalid: ${inlineCode(error)}`);
}

function issueErrors(issue, config) {
  const ref = `Issue #${issue.number}`;
  const errors = [];
  if (issue.state !== 'open') errors.push(`${ref} is not open`);
  if (!issue.type) errors.push(`${ref} has no issue type`);
  if (issue.type && !ISSUE_TYPES.includes(issue.type)) errors.push(`${ref} has unsupported type ${inlineCode(issue.type)}`);
  if (hasLabel(issue.labels, NEEDS_FORMAT_LABEL)) errors.push(`${ref} is marked needs-format`);
  errors.push(...bodyErrors(issue));
  if (!isTrustedAuthor({ login: issue.author, kind: 'issue' }, config)) errors.push(`${ref} was authored by ${inlineCode(issue.author)}, not a trusted account`);
  if (!isAccepted(issue, config)) errors.push(`${ref} has no ancestor epic with a valid accepted label and is not a hotfix`);
  const openBlockers = issue.blockedBy.filter((blocker) => blocker.state === 'open');
  if (openBlockers.length > 0) errors.push(`${ref} is blocked by open ${openBlockers.map((blocker) => `#${blocker.number}`).join(', ')}`);
  return errors;
}

function dependabotIssueErrors(issue) {
  if (issue === null || issue.type === DEPENDABOT_REQUIRED_ISSUE_TYPE) return [];
  return [`A Dependabot PR must close a ${DEPENDABOT_REQUIRED_ISSUE_TYPE} issue; #${issue.number} is ${inlineCode(issue.type ?? 'untyped')}`];
}

function branchErrors(facts) {
  const { headRef } = facts.pr;
  const expected = facts.issue ? `issue/${facts.issue.number}` : null;
  if (expected !== null && headRef !== expected) return [`Branch ${inlineCode(headRef)} must be ${inlineCode(expected)}`];
  if (expected === null && !BRANCH_PATTERN.test(headRef)) return [`Branch ${inlineCode(headRef)} must be ${inlineCode('issue/N')}`];
  return [];
}

function headRepoErrors(facts) {
  const { headRepo } = facts.pr;
  return sameLogin(headRepo, facts.repo) ? [] : [`Head repository ${inlineCode(headRepo)} must be this repository: forks are not accepted`];
}

function titleMismatchErrors(title, parsed, issue) {
  const allowed = issue && Object.hasOwn(TITLE_TYPES, issue.type) ? TITLE_TYPES[issue.type] : null;
  if (allowed === null) return [];
  const typeMatches = allowed.types.includes(parsed.type);
  const scopeMatches = allowed.scope === null || parsed.scope === allowed.scope;
  if (typeMatches && scopeMatches) return [];
  const wanted = allowed.types.length === 0 ? 'none (a PR cannot close this type)' : allowed.types.map((type) => (allowed.scope ? `${type}(${allowed.scope})` : type)).join(', ');
  return [`Title ${inlineCode(title)} does not match issue type ${issue.type}: use ${wanted}`];
}

function titleErrors(title, issue) {
  const parsed = parseConventionalTitle(title);
  if (parsed === null) return [`Title ${inlineCode(title)} is not a Conventional Commit`];
  // The squash commit takes the title, so a closing keyword in it would close another issue on merge.
  const closing = findClosingRefs(title).length > 0 ? [`Title ${inlineCode(title)} contains a closing keyword: remove it`] : [];
  return [...closing, ...titleMismatchErrors(title, parsed, issue)];
}

function acceptanceCriteria(issue) {
  if (!issue || !CRITERIA_TYPES.includes(issue.type)) return [];
  const { byName } = parseSections(normalizeIssueBody(issue.type, issue.body));
  const content = byName[CRITERIA_HEADING] ?? '';
  return [...new Set(criterionIds(content === NO_RESPONSE ? '' : content, CRITERION_PREFIX))];
}

// Text that is left of a table cell once markup and invisible characters are gone.
function visibleText(cell) {
  return cell.replace(HTML_TAG, '').replace(HTML_ENTITY, '').replace(HIDDEN_CHARACTERS, '').trim();
}

function isSubstantiveEvidence(cell) {
  const text = visibleText(cell);
  if (!MEANINGFUL_CHARACTER.test(text)) return false;
  return !FILLER_EVIDENCE.includes(text.replace(/^[\s\W_]+|[\s\W_]+$/gu, '').toLowerCase());
}

// IDs with substantive evidence. The first column holds the ID; the evidence column is the one whose header starts with Evidence.
function evidenceTable(body) {
  const { byName } = parseSections(body);
  const rows = parseTable(byName.Evidence ?? '');
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  const evidenceColumn = headers.find((header) => EVIDENCE_HEADER.test(header)) ?? null;
  const documented = rows.filter((row) => evidenceColumn !== null && isSubstantiveEvidence(row[evidenceColumn])).map((row) => row[headers[0]]);
  return {
    exists: Object.hasOwn(byName, 'Evidence'),
    hasEvidenceColumn: rows.length === 0 || evidenceColumn !== null,
    documented: new Set(documented),
  };
}

function evidenceErrors(facts, evidence) {
  const required = acceptanceCriteria(facts.issue);
  if (required.length === 0) return [];
  if (!evidence.exists) return ['## Evidence section is missing'];
  if (!evidence.hasEvidenceColumn) return ['## Evidence table has no column whose header starts with `Evidence`'];
  const missing = required.filter((id) => !evidence.documented.has(id));
  return missing.length === 0 ? [] : [`## Evidence has no evidence for ${missing.join(', ')}`];
}

// `Key: value` lines of a State section, keyed by lower-cased name. List markers and emphasis around the key are
// ignored, and a line without a key continues the previous field. Repeated keys are joined so a second copy cannot hide the first.
function stateFields(sectionContent) {
  const fields = new Map();
  let current = null;
  for (const line of sectionContent.split('\n')) {
    const match = STATE_FIELD_LINE.exec(line);
    if (match) {
      current = match[1].trim().toLowerCase();
      fields.set(current, `${fields.get(current) ?? ''}\n${match[2]}`.trim());
      continue;
    }
    if (current !== null) fields.set(current, `${fields.get(current)}\n${line}`.trim());
  }
  return fields;
}

function stateSection(markdown) {
  return parseSections(markdown).sections.find((candidate) => candidate.name === STATE_SECTION);
}

function stateProblems(facts, evidence) {
  const section = stateSection(facts.pr.body);
  if (!section) return ['## State section is missing'];
  const problems = [];
  const placeholders = [...new Set(`${section.line}\n${section.content}`.match(PLACEHOLDER_TOKEN) ?? [])];
  if (placeholders.length > 0) problems.push(`## State still contains template placeholders: ${placeholders.map(inlineCode).join(', ')}`);
  const fields = stateFields(section.content);
  const templateSection = stateSection(facts.stateTemplate ?? '');
  const required = templateSection ? [...stateFields(templateSection.content).keys()] : [];
  const unfilled = required.filter((key) => !MEANINGFUL_CHARACTER.test(fields.get(key) ?? ''));
  if (unfilled.length > 0) problems.push(`## State has missing or empty fields: ${unfilled.map(inlineCode).join(', ')}`);
  const proven = fields.get('proven') ?? '';
  const unevidenced = [...new Set(proven.match(/\bAC\d+\b/g) ?? [])].filter((id) => !evidence.documented.has(id));
  if (unevidenced.length > 0) problems.push(`## State lists ${unevidenced.join(', ')} as proven without evidence in ## Evidence`);
  return problems;
}

function spikeErrors(facts) {
  if (facts.issue?.type !== SPIKE_TYPE) return [];
  const expected = new RegExp(`^docs/decisions/${facts.issue.number}-[a-z0-9]+(?:-[a-z0-9]+)*\\.md$`);
  const [file] = facts.files;
  if (facts.files.length === 1 && file.status === 'added' && expected.test(file.filename)) return [];
  return [`Spike PR must add exactly one file docs/decisions/${facts.issue.number}-<slug>.md and nothing else`];
}

function result(conclusion, { errors = [], warnings = [], details = '' } = {}) {
  return { conclusion, errors, warnings, details, actions: [] };
}

/**
 * @param {PrMetadataFacts} facts
 * @param {import('../lib/config.mjs').Config} config
 * @returns {ValidatorResult}
 */
export function evaluate(facts, config) {
  if (facts.eventName === MERGE_GROUP_EVENT) return result('skip');
  if (!facts.pr) return result('fail', { errors: ['The event carries no pull request'] });
  const exemption = exemptionReason(facts, config);
  if (exemption !== null) return result('pass', { details: `Exempt: ${exemption}.` });
  const isDependabot = isDependabotAuthor(facts.pr.author, config);
  const evidence = evidenceTable(facts.pr.body);
  const errors = [...staleNoIssueError(facts), ...dependabotTamperErrors(facts, config), ...closingRefErrors(facts)];
  if (facts.issue) errors.push(...issueErrors(facts.issue, config));
  if (isDependabot) errors.push(...dependabotIssueErrors(facts.issue));
  if (!isDependabot) errors.push(...branchErrors(facts));
  errors.push(...headRepoErrors(facts));
  errors.push(...titleErrors(facts.pr.title, facts.issue));
  if (!isDependabot) errors.push(...evidenceErrors(facts, evidence));
  errors.push(...spikeErrors(facts));
  const warnings = [];
  if (!isDependabot) (facts.pr.draft ? warnings : errors).push(...stateProblems(facts, evidence));
  const conclusion = errors.length === 0 ? 'pass' : 'fail';
  return result(conclusion, { errors, warnings, details: facts.issue ? `Closes issue #${facts.issue.number} (${facts.issue.type ?? 'no type'}).` : '' });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runValidator({ name, collect, evaluate }, { argv: process.argv, env: process.env, scriptUrl: import.meta.url });
}

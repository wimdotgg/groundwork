import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runValidator } from '../lib/ci.mjs';
import { CONFIG_DIR } from '../lib/config.mjs';
import { GitHubError, apiPath } from '../lib/github.mjs';
import {
  REQUIRED_HEADINGS, TITLE_TYPES, isHotfixLane, loadIssueFacts, parseConventionalTitle,
} from '../lib/issue-model.mjs';
import {
  criterionIds, findClosingRefs, parseSections, parseStateSection, parseTable, templatePlaceholders,
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
 *   issue: IssueFacts|null, noIssueLabeledAt: string|null, headArrivedAt: string|null, files: PrFile[], stateTemplate: string|null }} PrMetadataFacts
 *   repo is owner/name. issue: the single same-repository closing reference's issue, else null; files: only for Spike issues, else [];
 *   headArrivedAt: earliest run created_at for the head SHA, read only when no-issue is present on the PR */

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
const ISSUE_PATH = '/repos/{owner}/{repo}/issues/{number}';
const TIMELINE_PATH = '/repos/{owner}/{repo}/issues/{number}/timeline';
const FILES_PATH = '/repos/{owner}/{repo}/pulls/{number}/files';
const RUNS_PATH = '/repos/{owner}/{repo}/actions/runs';
const BRANCH_PATTERN = /^issue\/\d+$/;
const UPDATE_PAIR = /\bfrom\s+(\S+)\s+to\s+(\S+)/gi;
const VERSION = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][0-9A-Za-z.+-]*)?$/;
const VERSION_DECORATION = /^[`'"*([]+|[`'"*,.;:)\]]+$/g;
const UPDATE_RANK = { patch: 0, minor: 1, major: 2 };

function emptyFacts(eventName) {
  return {
    eventName, repo: '', pr: null, closingRefs: [], issue: null, noIssueLabeledAt: null, headArrivedAt: null, files: [], stateTemplate: null,
  };
}

function hasLabel(labels, label) {
  return labels.some((candidate) => normalizeLabel(candidate) === label);
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

async function loadHeadArrival(ctx, headSha) {
  const runs = await ctx.client.paginate(apiPath(RUNS_PATH, ctx.repo), { query: { head_sha: headSha }, itemsKey: 'workflow_runs' });
  const times = runs.map((run) => new Date(run.created_at).getTime()).filter(Number.isFinite);
  return times.length === 0 ? null : new Date(Math.min(...times)).toISOString();
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
  // Live read: title, body and labels in the event payload are stale on a re-run after an edit.
  const live = (await ctx.client.request('GET', apiPath(ISSUE_PATH, params))).data;
  const timeline = await ctx.client.paginate(apiPath(TIMELINE_PATH, params));
  const labels = (live.labels ?? []).map((label) => label.name);
  const pr = {
    number: pull.number,
    title: live.title ?? '',
    body: live.body ?? '',
    draft: pull.draft === true,
    author: pull.user?.login ?? '',
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
    headArrivedAt: hasNoIssue ? await loadHeadArrival(ctx, pr.headSha) : null,
    files: issue?.type === SPIKE_TYPE ? await loadFiles(ctx, params) : [],
    stateTemplate: await readStateTemplate(ctx.root),
  };
}

// Untrusted text reaches the job summary, so it goes in a code span: mentions, links and HTML stay inert.
function inlineCode(text) {
  const flat = String(text).replace(/\s+/g, ' ').replaceAll('`', "'");
  const capped = flat.length > MAX_QUOTED_LENGTH ? `${flat.slice(0, MAX_QUOTED_LENGTH)}...` : flat;
  return `\`${capped}\``;
}

function parseVersion(token) {
  const match = VERSION.exec(token.replace(VERSION_DECORATION, ''));
  return match ? { major: Number(match[1]), minor: Number(match[2] ?? 0), patch: Number(match[3] ?? 0) } : null;
}

function jumpSize(from, to) {
  if (from.major !== to.major) return 'major';
  return from.minor === to.minor ? 'patch' : 'minor';
}

/**
 * Largest semver jump over every `from <a> to <b>` pair in title and body. Pairs that are not versions are
 * ignored; no version pair at all is unknown and counts as major, so the exemption fails closed.
 * @param {string} title
 * @param {string} body
 * @returns {'major'|'minor'|'patch'}
 */
export function dependabotUpdateType(title, body) {
  const jumps = [...`${title}\n${body}`.matchAll(UPDATE_PAIR)].flatMap((pair) => {
    const from = parseVersion(pair[1]);
    const to = parseVersion(pair[2]);
    return from && to ? [jumpSize(from, to)] : [];
  });
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

function exemptionReason(facts, config) {
  const { author, validLabels: valid, title, body } = facts.pr;
  const isDependabot = sameLogin(author, resolveActor(DEPENDABOT_ACTOR, config));
  if (isDependabot && hasLabel(valid, DEPENDENCIES_LABEL) && dependabotUpdateType(title, body) !== 'major') {
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

function issueErrors(issue, config) {
  const ref = `Issue #${issue.number}`;
  const errors = [];
  if (issue.state !== 'open') errors.push(`${ref} is not open`);
  if (!issue.type) errors.push(`${ref} has no issue type`);
  if (hasLabel(issue.labels, NEEDS_FORMAT_LABEL)) errors.push(`${ref} is marked needs-format`);
  if (!isTrustedAuthor({ login: issue.author, kind: 'issue' }, config)) errors.push(`${ref} was authored by ${inlineCode(issue.author)}, not a trusted account`);
  if (!isAccepted(issue, config)) errors.push(`${ref} has no ancestor epic with a valid accepted label and is not a hotfix`);
  const openBlockers = issue.blockedBy.filter((blocker) => blocker.state === 'open');
  if (openBlockers.length > 0) errors.push(`${ref} is blocked by open ${openBlockers.map((blocker) => `#${blocker.number}`).join(', ')}`);
  return errors;
}

function branchErrors(facts) {
  const { headRef, headRepo } = facts.pr;
  const errors = [];
  const expected = facts.issue ? `issue/${facts.issue.number}` : null;
  if (expected !== null && headRef !== expected) errors.push(`Branch ${inlineCode(headRef)} must be ${inlineCode(expected)}`);
  if (expected === null && !BRANCH_PATTERN.test(headRef)) errors.push(`Branch ${inlineCode(headRef)} must be ${inlineCode('issue/N')}`);
  if (!sameLogin(headRepo, facts.repo)) errors.push(`Head repository ${inlineCode(headRepo)} must be this repository: forks are not accepted`);
  return errors;
}

function titleErrors(title, issue) {
  const parsed = parseConventionalTitle(title);
  if (parsed === null) return [`Title ${inlineCode(title)} is not a Conventional Commit`];
  const allowed = issue && Object.hasOwn(TITLE_TYPES, issue.type) ? TITLE_TYPES[issue.type] : null;
  if (allowed === null) return [];
  const typeMatches = allowed.types.includes(parsed.type);
  const scopeMatches = allowed.scope === null || parsed.scope === allowed.scope;
  if (typeMatches && scopeMatches) return [];
  const wanted = allowed.types.length === 0 ? 'none (a PR cannot close this type)' : allowed.types.map((type) => (allowed.scope ? `${type}(${allowed.scope})` : type)).join(', ');
  return [`Title ${inlineCode(title)} does not match issue type ${issue.type}: use ${wanted}`];
}

// Web forms render answers as `### <label>`; promote the required headings only when no `## <required heading>` exists,
// the same rule issue-model applies when validating the body.
function normalizedIssueBody(type, body) {
  const required = REQUIRED_HEADINGS[type];
  const hasLevelTwo = required.some((heading) => new RegExp(`^##[ \\t]+${heading}[ \\t]*$`, 'm').test(body));
  if (hasLevelTwo) return body;
  return body.replace(/^###([ \t]+)(.+?)[ \t]*$/gm, (line, space, heading) => (required.includes(heading) ? `##${space}${heading}` : line));
}

function acceptanceCriteria(issue) {
  if (!issue || !CRITERIA_TYPES.includes(issue.type)) return [];
  const { byName } = parseSections(normalizedIssueBody(issue.type, issue.body));
  const content = byName[CRITERIA_HEADING] ?? '';
  return [...new Set(criterionIds(content === NO_RESPONSE ? '' : content, CRITERION_PREFIX))];
}

// IDs with a non-empty evidence cell. The first column holds the ID, the second the evidence.
function evidenceTable(body) {
  const { byName } = parseSections(body);
  const rows = parseTable(byName.Evidence ?? '');
  const [idColumn, evidenceColumn] = rows.length > 0 ? Object.keys(rows[0]) : [];
  const documented = rows.filter((row) => (row[evidenceColumn] ?? '') !== '').map((row) => row[idColumn]);
  return { exists: Object.hasOwn(byName, 'Evidence'), documented: new Set(documented) };
}

function evidenceErrors(facts, evidence) {
  const required = acceptanceCriteria(facts.issue);
  if (required.length === 0) return [];
  if (!evidence.exists) return ['## Evidence section is missing'];
  const missing = required.filter((id) => !evidence.documented.has(id));
  return missing.length === 0 ? [] : [`## Evidence has no evidence for ${missing.join(', ')}`];
}

function stateProblems(facts, evidence) {
  const section = parseSections(facts.pr.body).sections.find((candidate) => candidate.name === 'State');
  if (!section) return ['## State section is missing'];
  const problems = [];
  const text = `${section.line}\n${section.content}`;
  const unfilled = templatePlaceholders(facts.stateTemplate ?? '').filter((placeholder) => text.includes(placeholder));
  if (unfilled.length > 0) problems.push(`## State still contains template placeholders: ${unfilled.map(inlineCode).join(', ')}`);
  const proven = parseStateSection(section).fields.Proven ?? '';
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
  const isDependabot = sameLogin(facts.pr.author, resolveActor(DEPENDABOT_ACTOR, config));
  const evidence = evidenceTable(facts.pr.body);
  const errors = [...staleNoIssueError(facts), ...closingRefErrors(facts)];
  if (facts.issue) errors.push(...issueErrors(facts.issue, config));
  if (!isDependabot) errors.push(...branchErrors(facts));
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

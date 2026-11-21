import { parseArgs } from 'node:util';
import { GitHubError, apiPath, createClient, repoFromEnv } from '../lib/github.mjs';

const RELEASES_PATH = '/repos/{owner}/{repo}/releases';
const RELEASE_BY_TAG_PATH = '/repos/{owner}/{repo}/releases/tags/{tag}';
const RELEASE_PATH = '/repos/{owner}/{repo}/releases/{id}';
const TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;
const RESULTS = ['deployed', 'rolled-back', 'failed'];
const NO_PREVIOUS = 'none';
const RECORD_MARKER = '<!-- groundwork:deploy -->';
const RECORD_HEADING = '### Deploy';
const RECORD_BLOCK_START = new RegExp(`^${RECORD_MARKER}\\n${RECORD_HEADING}$`, 'm');
const USAGE = 'usage: deploy-record.mjs previous-tag <tag> | record --tag <tag> --result <r> --previous <tag|none> --run-url <url>';

function parseTag(tag) {
  const match = TAG_PATTERN.exec(tag ?? '');
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const differing = left.findIndex((part, index) => part !== right[index]);
  return differing === -1 ? 0 : left[differing] - right[differing];
}

/**
 * The highest published release lower than `tag`.
 * @param {{ releases: object[], tag: string }} input `releases` is the `GET releases` array
 * @returns {string|null}
 */
export function previousTag({ releases, tag }) {
  const deployed = parseTag(tag);
  if (deployed === null) throw new GitHubError(`not a vX.Y.Z tag: ${tag}`);
  const candidates = releases
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) => ({ name: release.tag_name, version: parseTag(release.tag_name) }))
    .filter((candidate) => candidate.version !== null && compareVersions(candidate.version, deployed) < 0)
    .sort((left, right) => compareVersions(right.version, left.version));
  return candidates[0]?.name ?? null;
}

/**
 * @param {{ result: string, tag: string, previous: string, runUrl: string }} input
 * @returns {string} the record block, ending with a newline
 */
export function renderRecord({ result, tag, previous, runUrl }) {
  return [RECORD_MARKER, RECORD_HEADING, `Result: ${result}`, `Tag: ${tag}`, `Previous: ${previous}`, `Run: ${runUrl}`, ''].join('\n');
}

/**
 * Appends `record` after a blank line, or replaces the block from the marker to its end.
 * @param {{ notes: string, record: string }} input
 * @returns {string}
 */
export function upsertRecord({ notes, record }) {
  const text = notes.replaceAll('\r\n', '\n');
  // Whole-line match: commit subjects in the notes may quote the marker.
  const start = text.search(RECORD_BLOCK_START);
  if (start === -1) return `${text.trimEnd()}${text.trim() === '' ? '' : '\n\n'}${record}`;
  const blockEnd = text.slice(start).search(/\n\s*\n/);
  const after = blockEnd === -1 ? '' : text.slice(start + blockEnd).replace(/^\n+/, '\n');
  return `${text.slice(0, start)}${record}${after}`;
}

function requireValue(name, value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new GitHubError(`--${name} is missing or malformed`);
  return value;
}

export function validateRecordInput(values) {
  requireValue('tag', values.tag, TAG_PATTERN);
  requireValue('previous', values.previous, new RegExp(`^(${NO_PREVIOUS}|v\\d+\\.\\d+\\.\\d+)$`));
  requireValue('result', values.result, new RegExp(`^(${RESULTS.join('|')})$`));
  requireValue('run-url', values['run-url'], /^https:\/\/\S+$/);
  return { result: values.result, tag: values.tag, previous: values.previous, runUrl: values['run-url'] };
}

/**
 * @param {{ client: import('../lib/github.mjs').GitHubClient, repo: import('../lib/github.mjs').RepoRef,
 *   input: { result: string, tag: string, previous: string, runUrl: string } }} options
 */
export async function writeRecord({ client, repo, input }) {
  const { data: release } = await client.request('GET', apiPath(RELEASE_BY_TAG_PATH, { ...repo, tag: input.tag }));
  const notes = upsertRecord({ notes: release.body ?? '', record: renderRecord(input) });
  await client.request('PATCH', apiPath(RELEASE_PATH, { ...repo, id: release.id }), { body: { body: notes } });
}

async function runCli(argv, env) {
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: { tag: { type: 'string' }, result: { type: 'string' }, previous: { type: 'string' }, 'run-url': { type: 'string' } },
  });
  const client = createClient({ env });
  const repo = repoFromEnv(env);
  if (argv[0] === 'previous-tag') {
    const releases = await client.paginate(apiPath(RELEASES_PATH, repo));
    const found = previousTag({ releases, tag: positionals[0] });
    if (found !== null) process.stdout.write(`${found}\n`);
    return;
  }
  if (argv[0] !== 'record') throw new GitHubError(USAGE);
  const input = validateRecordInput(values);
  // Printed first so the job summary has the record even when the release PATCH fails.
  process.stdout.write(renderRecord(input));
  await writeRecord({ client, repo, input });
}

if (import.meta.main) {
  try {
    await runCli(process.argv.slice(2), process.env);
  } catch (error) {
    process.stderr.write(`deploy-record: ${String(error?.message ?? error).split('\n')[0]}\n`);
    process.exitCode = 1;
  }
}

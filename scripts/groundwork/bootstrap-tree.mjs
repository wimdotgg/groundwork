import { SettingsError } from '../lib/settings.mjs';

/** @typedef {{ path: string, mode: string, sha: string }} ReleaseEntry */
/** @typedef {{ path: string, mode: string, sha?: string, content?: string }} TreeEntry */

/** Exact paths or directory prefixes (ending "/") that stay in the control repo (spec 13.1). */
export const CONTROL_PATHS = [
  'admin-ops/',
  'scripts/groundwork/',
  'scripts/owner/',
  '.claude/skills/groundwork-setup/',
  '.github/workflows/reusable-verify.yml',
  '.github/workflows/reusable-security.yml',
  '.github/workflows/admin-run.yml',
];

export const KIT_VERSION_PATH = '.github/groundwork/kit-version.txt';

const STUBS_DIR = 'scripts/groundwork/stubs/';
const SETTINGS_DIR = '.github/groundwork/';
const FILE_MODE = '100644';
const FIRST_VERSION = '0.0.0';

// Paths whose project copy comes from a stub: [stub path, project path].
const FIXED_STUBS = [
  ['verify', 'scripts/verify'],
  ['verify.cmd', 'scripts/verify.cmd'],
  ['README.md', 'README.md'],
  // Inert until a project moves them to scripts/ (spec 8.5), so "deploy": "none" leaves no scripts/deploy.
  ...['deploy', 'smoke', 'rollback'].flatMap((name) => [name, `${name}.cmd`].map(
    (file) => [`deploy/${file}`, `scripts/stubs/deploy/${file}`],
  )),
];
const STUB_DOCS_DIR = `${STUBS_DIR}docs/`;
const PROJECT_DOCS_DIR = 'docs/';

export const CODEOWNERS_PATH = '.github/CODEOWNERS';
const CONFIG_PATH = `${SETTINGS_DIR}config.json`;
// A GitHub login: letters, digits, hyphens, and underscores for enterprise managed users (<handle>_<shortcode>).
// It must exclude whitespace, "#", "@" and "/", which could add a CODEOWNERS rule or a team.
const LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
// A rule line: path pattern, its owners, an optional trailing comment.
const CODEOWNERS_RULE = /^(\s*[^\s#]+\s+)([^#]*?)(\s*(?:#[^\n]*)?)$/;

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

const REUSABLE_REFERENCE = /\.\/\.github\/workflows\/(reusable-[\w-]+\.yml)([ \t]*# zizmor: ignore\[self-repository\][^\r\n]*)?/g;

const isUnder = (path, prefix) => path.startsWith(prefix);

function isControlPath(path) {
  return CONTROL_PATHS.some((entry) => (entry.endsWith('/') ? isUnder(path, entry) : path === entry));
}

/**
 * @param {ReleaseEntry[]} entries blobs of the release tree
 * @returns {string[]} blobs whose text the builder needs
 */
export function contentPaths(entries) {
  return entries
    .map((entry) => entry.path)
    .filter((path) => isUnder(path, '.github/') || isUnder(path, STUBS_DIR));
}

const replaceLiteral = (text, token, value) => text.split(token).join(value);

function fillPlaceholders(text, path, { org, repo, description }) {
  const withNames = replaceLiteral(replaceLiteral(text, '__ORG__', org), '__REPO__', repo);
  if (!withNames.includes('__DESCRIPTION__')) return withNames;
  if (!path.endsWith('.md')) {
    throw new SettingsError(`__DESCRIPTION__ is only allowed in .md files: ${path}`, path);
  }
  return replaceLiteral(withNames, '__DESCRIPTION__', description);
}

// zizmor's unpinned-uses fails a tag ref in a project's CI, so the ref is the tag's commit SHA and the tag stays a comment.
function rewriteReusableReferences(text, { org, controlRepo, tag, tagSha }) {
  return text.replace(
    REUSABLE_REFERENCE,
    (_match, name) => `${org}/${controlRepo}/.github/workflows/${name}@${tagSha} # ${tag}`,
  );
}

function requireContent(contents, path) {
  const text = Object.hasOwn(contents, path) ? contents[path] : undefined;
  if (typeof text !== 'string') throw new SettingsError(`missing release content: ${path}`, path);
  return text;
}

// The project's CODEOWNERS owner is the one its own config.json names, so `check` finds them equal.
function configuredOwner(contents) {
  let owner;
  try {
    owner = JSON.parse(requireContent(contents, CONFIG_PATH)).accounts?.owner;
  } catch (error) {
    if (error instanceof SettingsError) throw error;
    throw new SettingsError(`${CONFIG_PATH} is not valid JSON`, CONFIG_PATH);
  }
  if (typeof owner !== 'string' || !LOGIN_PATTERN.test(owner)) {
    throw new SettingsError(`${CONFIG_PATH} needs accounts.owner to be a GitHub login to fill ${CODEOWNERS_PATH}`, CONFIG_PATH);
  }
  return owner;
}

/** Every owner on every rule line becomes the one configured owner; comments, blank lines and unowned rules stay. */
function fillCodeowners(text, owner) {
  return text.split('\n').map((line) => {
    const rule = CODEOWNERS_RULE.exec(line);
    if (!rule || rule[2] === '') return line;
    // The pattern ends at the first space, so an escaped space would cut it and leave a rule with no owner.
    if (rule[1].trimEnd().endsWith('\\')) throw new SettingsError(`${CODEOWNERS_PATH} has a pattern with an escaped space: ${line.trim()}`, CODEOWNERS_PATH);
    return `${rule[1]}@${owner}${rule[3]}`;
  }).join('\n');
}

// A file whose text did not change keeps its blob sha; the caller then uploads nothing.
function textEntry(source, path, { text, original }) {
  if (text === original && source.sha) return { path, mode: source.mode, sha: source.sha };
  return { path, mode: source.mode, content: text };
}

function stubSources(entries) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const fixed = FIXED_STUBS.map(([stub, projectPath]) => {
    const source = byPath.get(STUBS_DIR + stub);
    if (!source) throw new SettingsError(`missing stub: ${STUBS_DIR}${stub}`, STUBS_DIR + stub);
    return { source, projectPath };
  });
  const docs = entries
    .filter((entry) => isUnder(entry.path, STUB_DOCS_DIR))
    .map((entry) => ({ source: entry, projectPath: PROJECT_DOCS_DIR + entry.path.slice(STUB_DOCS_DIR.length) }));
  if (docs.length === 0) throw new SettingsError(`missing stub: ${STUB_DOCS_DIR}`, STUB_DOCS_DIR);
  return [...fixed, ...docs];
}

function generatedFiles(tag) {
  const files = {
    [KIT_VERSION_PATH]: `${tag}\n`,
    '.release-please-manifest.json': '{}\n',
    'version.txt': `${FIRST_VERSION}\n`,
    'CHANGELOG.md': '',
  };
  return Object.entries(files).map(([path, content]) => ({ path, mode: FILE_MODE, content }));
}

function isReplacedByStub(path, stubs, generated) {
  if (isUnder(path, PROJECT_DOCS_DIR)) return true;
  return stubs.some((stub) => stub.projectPath === path) || generated.has(path);
}

function keptEntry(entry, contents, names) {
  if (isUnder(entry.path, SETTINGS_DIR) || !isUnder(entry.path, '.github/')) return entry;
  const original = requireContent(contents, entry.path);
  const filled = fillPlaceholders(rewriteReusableReferences(original, names), entry.path, names);
  const text = entry.path === CODEOWNERS_PATH ? fillCodeowners(filled, configuredOwner(contents)) : filled;
  return textEntry(entry, entry.path, { text, original });
}

/**
 * @param {{ entries: ReleaseEntry[], contents: Record<string, string>, org: string,
 *   controlRepo: string, repo: string, description: string, tag: string, tagSha: string }} options
 * @returns {TreeEntry[]} blob entries sorted by path, ready for POST git/trees without base_tree
 */
export function buildBootstrapTree({ entries, contents, org, controlRepo, repo, description, tag, tagSha }) {
  if (!COMMIT_SHA_PATTERN.test(String(tagSha))) throw new SettingsError(`tagSha for ${tag} is not a 40-character commit SHA`);
  const names = { org, controlRepo, repo, description, tag, tagSha };
  const stubs = stubSources(entries);
  const generated = generatedFiles(tag);
  const generatedPaths = new Set(generated.map((entry) => entry.path));

  const stubEntries = stubs.map(({ source, projectPath }) => {
    const original = requireContent(contents, source.path);
    const text = fillPlaceholders(original, projectPath, names);
    return textEntry(source, projectPath, { text, original });
  });
  const kept = entries
    .filter((entry) => !isControlPath(entry.path) && !isReplacedByStub(entry.path, stubs, generatedPaths))
    .map((entry) => keptEntry(entry, contents, names));

  return [...kept, ...stubEntries, ...generated].sort((a, b) => (a.path < b.path ? -1 : 1));
}

const README_PATH = 'README.md';
const LICENSE_PATH = 'LICENSE';
export const SYMLINK_MODE = '120000';
/** Spec 14.4: kit paths the merge never writes over a project entry (README.md only when the root holds a readme), so nothing there collides. */
export const ADOPT_UNWRITTEN_PATHS = new Set([README_PATH, LICENSE_PATH]);
/** Spec 14.4: kit paths an adopted repository keeps in its own form, so other content there is no collision. */
export const ADOPT_KEPT_PATHS = new Set([...ADOPT_UNWRITTEN_PATHS, CODEOWNERS_PATH]);
// A root readme in any case or extension: a second README.md beside Readme.md breaks case-insensitive checkouts.
const ROOT_README = /^readme(\.[^/]*)?$/i;

function appendedCodeowners(entry, contents, projectText) {
  if (typeof projectText !== 'string') throw new SettingsError(`the target's ${CODEOWNERS_PATH} text is needed to append the kit lines`, CODEOWNERS_PATH);
  const kitText = entry.content ?? requireContent(contents, entry.path);
  const separator = projectText === '' || projectText.endsWith('\n') ? '' : '\n';
  return { path: entry.path, mode: entry.mode, content: `${projectText}${separator}${kitText}` };
}

/**
 * The kit entries to write over an existing tree with `base_tree` (spec 14.4). Adopt never adds a LICENSE (owner
 * decision, #258) and adds README.md only when the root holds no readme; the target's CODEOWNERS keeps its own lines
 * and gets the kit lines appended, so the kit rules match last and win.
 * @param {{ treeEntries: TreeEntry[], contents: Record<string, string>,
 *   target: { tree: Array<{ path: string, type: string, mode?: string }>, codeowners?: string } }} options `target.codeowners` is the text of the
 *   target's CODEOWNERS, required when its tree holds one
 * @returns {TreeEntry[]} a subset of `treeEntries`, CODEOWNERS replaced by the appended text
 */
export function adoptTreeEntries({ treeEntries, contents, target }) {
  const targetCodeowners = target.tree.find((entry) => entry.path === CODEOWNERS_PATH);
  // Appending into a symlink or a directory would rewrite it into a regular file.
  if (targetCodeowners !== undefined && (targetCodeowners.type !== 'blob' || targetCodeowners.mode === SYMLINK_MODE)) {
    throw new SettingsError(`the target's ${CODEOWNERS_PATH} is a symlink or not a file, so the kit lines cannot be appended`, CODEOWNERS_PATH);
  }
  const targetPaths = new Set(target.tree.map((entry) => entry.path));
  const hasReadme = target.tree.some((entry) => ROOT_README.test(entry.path));
  return treeEntries
    .filter((entry) => entry.path !== LICENSE_PATH && !(entry.path === README_PATH && hasReadme))
    .map((entry) => (entry.path === CODEOWNERS_PATH && targetPaths.has(entry.path) ? appendedCodeowners(entry, contents, target.codeowners) : entry));
}

/**
 * @param {TreeEntry[]} treeEntries output of buildBootstrapTree
 * @param {Record<string, string>} contents the release contents the tree was built from
 * @returns {Record<string, string>} the .github/groundwork/ files of the built tree as text
 */
export function settingsFiles(treeEntries, contents) {
  const files = {};
  for (const entry of treeEntries.filter((candidate) => isUnder(candidate.path, SETTINGS_DIR))) {
    files[entry.path] = entry.content ?? requireContent(contents, entry.path);
  }
  return files;
}

// Pure Markdown helpers for issue and PR bodies (spec 13.1). No I/O, no internal imports.

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const SECTION_HEADING = /^##[ \t]+(\S.*?)[ \t]*$/;
const TRAILING_GROUP = /[ \t]*\([^()]*\)$/;
const SECTION_BREAK = '---';
const STATE_FIELD = /^([A-Za-z][A-Za-z ]*):[ \t]*(.*)$/;
const STATE_GROUP = /\(([^()]*)\)\s*$/;
const HEADER_SEPARATOR = '·';
const PLACEHOLDER = /<[^<>\s!/][^<>\n]*>/g;
const INLINE_CODE = /(`+)(?:[^`]|(?!\1)`+)*?\1(?!`)/g;
const CLOSING_REF = new RegExp(
  '(?<![\\w-])(close[sd]?|fix(?:es|ed)?|resolve[sd]?)\\b:?[ \\t]+(?:'
  + 'https?://github\\.com/([\\w.-]+)/([\\w.-]+)/(?:issues|pull)/(\\d+)'
  + '|(?:([\\w.-]+)/([\\w.-]+))?#(\\d+))\\b',
  'gi',
);

/**
 * Every export accepts CRLF or CR input; text is normalised to LF first, so
 * strings returned by the editing functions use LF.
 * @param {string} text
 * @returns {string}
 */
function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, '\n');
}

function lineEndAt(text, index) {
  const newline = text.indexOf('\n', index);
  return newline === -1 ? text.length : newline;
}

/**
 * Index just past the fence opened by the line at `start`, or the text length when unclosed.
 * @param {string} text
 * @param {number} start line start of the opening fence
 * @param {string} opener the run of fence characters
 * @returns {number}
 */
function fenceEnd(text, start, opener) {
  const closer = new RegExp(`^ {0,3}${opener[0]}{${opener.length},}[ \\t]*$`);
  let lineStart = lineEndAt(text, start) + 1;
  while (lineStart < text.length) {
    const lineEnd = lineEndAt(text, lineStart);
    if (closer.test(text.slice(lineStart, lineEnd))) return Math.min(lineEnd + 1, text.length);
    lineStart = lineEnd + 1;
  }
  return text.length;
}

/**
 * One in-order scan: whichever of a fence (at a line start) or a comment opens first wins,
 * and the other construct inside it is inert. An unclosed comment is live text; an unclosed
 * fence runs to the end. Input must already be LF.
 * @param {string} text
 * @returns {Uint8Array} 1 for characters inside a comment or fence
 */
function deadMask(text) {
  const dead = new Uint8Array(text.length);
  let index = 0;
  while (index < text.length) {
    const atLineStart = index === 0 || text[index - 1] === '\n';
    const fence = atLineStart ? FENCE_OPEN.exec(text.slice(index, lineEndAt(text, index))) : null;
    if (fence) {
      const end = fenceEnd(text, index, fence[1]);
      dead.fill(1, index, end);
      index = end;
      continue;
    }
    const commentEnd = text.startsWith('<!--', index) ? text.indexOf('-->', index + 4) : -1;
    if (commentEnd === -1) {
      index += 1;
      continue;
    }
    dead.fill(1, index, commentEnd + 3);
    index = commentEnd + 3;
  }
  return dead;
}

/**
 * Removes `<!-- ... -->` comments and fenced blocks (backtick and tilde) in one in-order scan.
 * @param {string} text
 * @returns {string}
 */
export function stripCommentsAndFences(text) {
  const normalized = normalizeNewlines(text);
  const dead = deadMask(normalized);
  let result = '';
  for (let index = 0; index < normalized.length; index += 1) {
    if (!dead[index]) result += normalized[index];
  }
  return result;
}

/**
 * Level-2 sections outside comments and fences. `content` is the text between
 * the heading and the next level-2 heading, trimmed. `byName` keeps the first
 * occurrence of a repeated name; `duplicates` lists each repeated name once.
 * @param {string} body
 * @returns {{ sections: Array<{ name: string, line: string, content: string }>, byName: Record<string, string>, duplicates: string[] }}
 */
export function parseSections(body) {
  const lines = stripCommentsAndFences(body).split('\n');
  const sections = [];
  for (const line of lines) {
    const heading = SECTION_HEADING.exec(line);
    if (heading) {
      sections.push({ name: heading[1].replace(TRAILING_GROUP, '').trim(), line: line.trimEnd(), content: [] });
      continue;
    }
    if (sections.length > 0) sections[sections.length - 1].content.push(line);
  }
  const result = sections.map((section) => ({ ...section, content: section.content.join('\n').trim() }));
  const firstByName = new Map();
  const duplicates = [];
  for (const section of result) {
    if (!firstByName.has(section.name)) {
      firstByName.set(section.name, section.content);
      continue;
    }
    if (!duplicates.includes(section.name)) duplicates.push(section.name);
  }
  return { sections: result, byName: Object.fromEntries(firstByName), duplicates };
}

/**
 * GitHub closing keywords outside comments, fences and inline code spans. `keyword` is
 * lower-case; `owner` and `repo` are null for same-repo refs. A colon after the keyword is
 * accepted. Both `#N`, `owner/repo#N` and `https://github.com/owner/repo/(issues|pull)/N` match.
 * @param {string} body
 * @returns {Array<{ keyword: string, owner: string|null, repo: string|null, number: number }>}
 */
export function findClosingRefs(body) {
  const text = stripCommentsAndFences(body).replace(INLINE_CODE, '');
  return [...text.matchAll(CLOSING_REF)].map((match) => ({
    keyword: match[1].toLowerCase(),
    owner: match[2] ?? match[5] ?? null,
    repo: match[3] ?? match[6] ?? null,
    number: Number(match[4] ?? match[7]),
  }));
}

/**
 * IDs such as `E1` or `AC3` from checklist lines `- [ ] <id> ...` / `- [x] <id> ...`.
 * `prefix` is literal; the id is the prefix plus digits. Order and duplicates kept.
 * @param {string} content
 * @param {string} prefix
 * @returns {string[]}
 */
export function criterionIds(content, prefix) {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = new RegExp(`^[ \\t]*[-*][ \\t]+\\[[ xX]\\][ \\t]+(${escaped}\\d+)(?![\\w])`);
  return normalizeNewlines(content).split('\n').flatMap((text) => {
    const match = line.exec(text);
    return match ? [match[1]] : [];
  });
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

const isTableRow = (line) => line.trim().startsWith('|');
const isSeparatorRow = (line) => isTableRow(line) && splitRow(line).every((cell) => /^:?-+:?$/.test(cell));

/**
 * First GFM table in the content, as one record per body row keyed by header cell.
 * Missing cells are empty strings. No table gives an empty array.
 * @param {string} content
 * @returns {Array<Record<string, string>>}
 */
export function parseTable(content) {
  const lines = normalizeNewlines(content).split('\n');
  const start = lines.findIndex((line, index) => isTableRow(line) && index + 1 < lines.length && isSeparatorRow(lines[index + 1]));
  if (start === -1) return [];
  const headers = splitRow(lines[start]);
  const rows = [];
  for (let index = start + 2; index < lines.length && isTableRow(lines[index]); index += 1) {
    const cells = splitRow(lines[index]);
    rows.push(Object.fromEntries(headers.map((header, column) => [header, cells[column] ?? ''])));
  }
  return rows;
}

function parseStateHeader(headingLine) {
  const header = { checkpoint: null, at: null, agent: null, session: null };
  const group = STATE_GROUP.exec(headingLine);
  if (!group) return header;
  const positional = [];
  for (const part of group[1].split(HEADER_SEPARATOR).map((value) => value.trim())) {
    if (/^checkpoint\s/i.test(part)) header.checkpoint = part.replace(/^checkpoint\s+/i, '');
    else if (/^session\s/i.test(part)) header.session = part.replace(/^session\s+/i, '');
    else if (part !== '') positional.push(part);
  }
  [header.at = null, header.agent = null] = positional;
  return header;
}

/**
 * Parses a 6.5 `## State` section. Pass a `parseSections` entry (`{ line, content }`) or a
 * string starting with the `## State (...)` heading. The header comes from the parenthesised
 * group on the heading line, split on `·`: `checkpoint` and `session` by prefix, the rest
 * positionally as `at` then `agent`; absent parts are null (`checkpoint` stays a string).
 * `fields` maps `Key:` lines to their trimmed values; a non-key line continues the previous
 * field, joined with a newline.
 * @param {string | { line: string, content: string }} section
 * @returns {{ header: { checkpoint: string|null, at: string|null, agent: string|null, session: string|null }, fields: Record<string, string> }}
 */
export function parseStateSection(section) {
  const text = typeof section === 'string' ? section : `${section.line}\n${section.content}`;
  const lines = normalizeNewlines(text).split('\n');
  const headingLine = lines.find((line) => /^##[ \t]+State\b/.test(line)) ?? '';
  const fields = new Map();
  let current = null;
  for (const line of lines) {
    if (line === headingLine || line.trim() === '') continue;
    const match = line.startsWith('#') ? null : STATE_FIELD.exec(line);
    if (match) {
      current = match[1].trim();
      fields.set(current, match[2].trim());
      continue;
    }
    if (current !== null) fields.set(current, `${fields.get(current)}\n${line.trim()}`.trim());
  }
  return { header: parseStateHeader(headingLine), fields: Object.fromEntries(fields) };
}

/**
 * Unique `<...>` tokens of a template, in order of first appearance, ignoring
 * comments and fences. A token starts with a non-space character other than `!` or `/`.
 * @param {string} templateText
 * @returns {string[]}
 */
export function templatePlaceholders(templateText) {
  const text = stripCommentsAndFences(templateText);
  return [...new Set(text.match(PLACEHOLDER) ?? [])];
}

/**
 * Replaces every `<name>` placeholder outside comments and fences with `values[name]`.
 * One pass: a value that itself looks like a placeholder is not filled again. A placeholder
 * with no value stays in the text and is listed in `unfilled` (with its angle brackets, once).
 * @param {string} template
 * @param {Record<string, string|number>} values keyed by the placeholder text without the brackets
 * @returns {{ text: string, unfilled: string[] }}
 */
export function fillTemplate(template, values) {
  const source = normalizeNewlines(template);
  const dead = deadMask(source);
  const unfilled = new Set();
  const text = source.replace(PLACEHOLDER, (token, offset) => {
    if (dead[offset]) return token;
    const name = token.slice(1, -1);
    if (Object.hasOwn(values, name)) return String(values[name]);
    unfilled.add(token);
    return token;
  });
  return { text, unfilled: [...unfilled] };
}

function liveLines(text) {
  const dead = deadMask(text);
  const lines = [];
  let start = 0;
  for (const value of text.split('\n')) {
    lines.push({ text: value, live: !dead[start] });
    start += value.length + 1;
  }
  return lines;
}

/**
 * Replaces the content of the first level-2 section `name`, keeping its heading line,
 * or appends `## name` plus the content when the section is absent. When `content`
 * itself starts with a `## ` heading, that heading replaces the old one (used to rewrite
 * the `## State  (checkpoint ...)` line). A section ends at the next level-2 heading or at
 * a line that is exactly `---` (a PR footer survives). Headings are found by the same
 * scan as `stripCommentsAndFences`. The result uses LF and ends with exactly one newline.
 * @param {string} body
 * @param {string} name
 * @param {string} content
 * @returns {string}
 */
export function replaceSection(body, name, content) {
  const lines = liveLines(normalizeNewlines(body));
  const newContent = normalizeNewlines(content).replace(/\s+$/, '');
  const replacesHeading = /^##[ \t]/.test(newContent);
  const start = lines.findIndex((line) => {
    const heading = line.live ? SECTION_HEADING.exec(line.text) : null;
    return heading !== null && heading[1].replace(TRAILING_GROUP, '').trim() === name;
  });
  const section = replacesHeading ? newContent : `## ${name}\n${newContent}`;
  if (start === -1) {
    const head = lines.map((line) => line.text).join('\n').trimEnd();
    return `${head === '' ? '' : `${head}\n\n`}${section}\n`;
  }
  const next = lines.findIndex((line, index) => index > start && line.live
    && (SECTION_HEADING.test(line.text) || line.text === SECTION_BREAK));
  const end = next === -1 ? lines.length : next;
  const before = lines.slice(0, start).map((line) => line.text);
  const after = lines.slice(end).map((line) => line.text);
  const kept = replacesHeading ? newContent : `${lines[start].text}\n${newContent}`;
  const result = [...before, kept, ...(after.length === 0 ? [] : ['', ...after])].join('\n');
  return `${result.replace(/\n+$/, '')}\n`;
}

/**
 * Raw text of the level-2 section `name` of a template file that holds several comments, one
 * per section; markers (HTML comments) are kept, unlike `parseSections`. `null` when absent.
 * @param {string} templateText
 * @param {string} name
 * @returns {string|null}
 */
export function templateSection(templateText, name) {
  const lines = liveLines(normalizeNewlines(templateText));
  const headingName = (line) => SECTION_HEADING.exec(line.text)?.[1].replace(TRAILING_GROUP, '').trim();
  const start = lines.findIndex((line) => line.live && headingName(line) === name);
  if (start === -1) return null;
  const next = lines.findIndex((line, index) => index > start && line.live && SECTION_HEADING.test(line.text));
  const end = next === -1 ? lines.length : next;
  return lines.slice(start + 1, end).map((line) => line.text).join('\n').trim();
}

const markerText =(name) => `<!-- groundwork:${name} -->`;

/**
 * @param {string} body
 * @param {string} name
 * @returns {boolean}
 */
export function hasMarker(body, name) {
  return normalizeNewlines(body).includes(markerText(name));
}

/**
 * Appends the marker on its own last line. Idempotent.
 * @param {string} body
 * @param {string} name
 * @returns {string}
 */
export function addMarker(body, name) {
  const text = normalizeNewlines(body);
  if (hasMarker(text, name)) return text;
  const head = text.trimEnd();
  return `${head === '' ? '' : `${head}\n\n`}${markerText(name)}\n`;
}

/**
 * Removes every occurrence of the marker. A line holding only the marker is dropped;
 * trailing blank lines left behind are trimmed to one newline when the body had one.
 * @param {string} body
 * @param {string} name
 * @returns {string}
 */
export function removeMarker(body, name) {
  const text = normalizeNewlines(body);
  if (!hasMarker(text, name)) return text;
  const marker = markerText(name);
  const kept = text.split('\n').flatMap((line) => {
    if (line.trim() === marker) return [];
    return [line.split(marker).join('')];
  });
  const result = kept.join('\n');
  if (!text.endsWith('\n')) return result.trimEnd();
  return `${result.trimEnd()}\n`;
}

/**
 * `label:` values of an issue-form YAML by regex (no YAML parser), in file order. Only
 * non-list-item lines match, so checkbox option labels (`- label: ...`) are skipped.
 * Surrounding single or double quotes are removed.
 * @param {string} yamlText
 * @returns {string[]}
 */
export function formFieldLabels(yamlText) {
  const labels = [];
  for (const line of normalizeNewlines(yamlText).split('\n')) {
    const match = /^\s*label:[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!match) continue;
    labels.push(match[1].replace(/^(["'])(.*)\1$/, '$2'));
  }
  return labels;
}

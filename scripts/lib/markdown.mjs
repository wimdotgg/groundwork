// Pure Markdown helpers for issue and PR bodies (spec 13.1). No I/O, no internal imports.

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const SECTION_HEADING = /^##[ \t]+(\S.*?)[ \t]*$/;
const TRAILING_GROUP = /[ \t]*\([^()]*\)$/;
const COMMENT = /<!--[\s\S]*?-->/g;
const CLOSING_REF = /(?<![\w-])(close[sd]?|fix(?:es|ed)?|resolve[sd]?)\b:?[ \t]+(?:([\w.-]+)\/([\w.-]+))?#(\d+)\b/gi;
const STATE_HEADER_GROUP = /\(\s*checkpoint\s+([^·)]*?)\s*(?:·\s*([^·)]*?)\s*)?(?:·\s*([^·)]*?)\s*)?(?:·\s*session\s+([^·)]*?)\s*)?\)/i;
const STATE_FIELD = /^([A-Za-z][A-Za-z ]*):[ \t]*(.*)$/;

/**
 * Line-wise fence scan. Returns, per line, whether it belongs to a fenced block
 * (fence delimiters included). An unclosed fence runs to the end of the text.
 * @param {string[]} lines
 * @returns {boolean[]}
 */
function fencedLines(lines) {
  const fenced = [];
  let open = null;
  for (const line of lines) {
    if (open === null) {
      const match = FENCE_OPEN.exec(line);
      fenced.push(match !== null);
      if (match) open = match[1];
      continue;
    }
    fenced.push(true);
    const closer = new RegExp(`^ {0,3}${open[0]}{${open.length},}[ \\t]*$`);
    if (closer.test(line)) open = null;
  }
  return fenced;
}

/**
 * Removes `<!-- ... -->` comments and fenced blocks (backtick and tilde).
 * Fences are removed first, then comments. An unclosed comment is left as is.
 * @param {string} text
 * @returns {string}
 */
export function stripCommentsAndFences(text) {
  const lines = text.split('\n');
  const fenced = fencedLines(lines);
  const kept = lines.filter((_, index) => !fenced[index]);
  return kept.join('\n').replace(COMMENT, '');
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
  const byName = {};
  const duplicates = [];
  const result = sections.map((section) => ({ ...section, content: section.content.join('\n').trim() }));
  for (const section of result) {
    if (!(section.name in byName)) {
      byName[section.name] = section.content;
      continue;
    }
    if (!duplicates.includes(section.name)) duplicates.push(section.name);
  }
  return { sections: result, byName, duplicates };
}

/**
 * GitHub closing keywords outside comments and fences. `keyword` is lower-case;
 * `owner` and `repo` are null for same-repo refs. A trailing colon after the keyword is accepted.
 * @param {string} body
 * @returns {Array<{ keyword: string, owner: string|null, repo: string|null, number: number }>}
 */
export function findClosingRefs(body) {
  const text = stripCommentsAndFences(body);
  return [...text.matchAll(CLOSING_REF)].map((match) => ({
    keyword: match[1].toLowerCase(),
    owner: match[2] ?? null,
    repo: match[3] ?? null,
    number: Number(match[4]),
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
  return content.split('\n').flatMap((text) => {
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
  const lines = content.split('\n');
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

/**
 * Parses a 6.5 `## State` section. Pass the section text including its heading line;
 * the header comes from the parenthesised group on the first `## State` line. Every
 * header part is a string or null (`checkpoint` stays a string; `agent` is `<model>/<harness>`).
 * `fields` maps `Key:` lines (Done, Next, ...) to their trimmed values.
 * @param {string} section
 * @returns {{ header: { checkpoint: string|null, at: string|null, agent: string|null, session: string|null }, fields: Record<string, string> }}
 */
export function parseStateSection(section) {
  const lines = section.split('\n');
  const headingLine = lines.find((line) => /^##[ \t]+State\b/.test(line)) ?? '';
  const group = STATE_HEADER_GROUP.exec(headingLine);
  const part = (index) => (group && group[index] ? group[index] : null);
  const fields = {};
  for (const line of lines) {
    const match = STATE_FIELD.exec(line);
    if (match && !line.startsWith('#')) fields[match[1].trim()] = match[2].trim();
  }
  return { header: { checkpoint: part(1), at: part(2), agent: part(3), session: part(4) }, fields };
}

/**
 * Unique `<...>` tokens of a template, in order of first appearance, ignoring
 * comments and fences. A token starts with a non-space character other than `!` or `/`.
 * @param {string} templateText
 * @returns {string[]}
 */
export function templatePlaceholders(templateText) {
  const text = stripCommentsAndFences(templateText);
  return [...new Set(text.match(/<[^<>\s!/][^<>\n]*>/g) ?? [])];
}

function trackComment(line, startedInside) {
  let inside = startedInside;
  for (const token of line.match(/<!--|-->/g) ?? []) inside = token === '<!--';
  return inside;
}

function findHeadings(lines) {
  const fenced = fencedLines(lines);
  const headings = [];
  let inComment = false;
  lines.forEach((line, index) => {
    const wasInComment = inComment;
    if (!fenced[index]) inComment = trackComment(line, inComment);
    if (fenced[index] || wasInComment) return;
    const match = SECTION_HEADING.exec(line);
    if (match) headings.push({ index, name: match[1].replace(TRAILING_GROUP, '').trim() });
  });
  return headings;
}

/**
 * Replaces the content of the first level-2 section `name`, keeping its heading line,
 * or appends `## name` plus the content when the section is absent. When `content`
 * itself starts with a `## ` heading, that heading replaces the old one (used to rewrite
 * the `## State  (checkpoint ...)` line). Result ends with a single newline.
 * @param {string} body
 * @param {string} name
 * @param {string} content
 * @returns {string}
 */
export function replaceSection(body, name, content) {
  const lines = body.split('\n');
  const headings = findHeadings(lines);
  const position = headings.findIndex((heading) => heading.name === name);
  const newContent = content.replace(/\s+$/, '');
  const replacesHeading = /^##[ \t]/.test(newContent);
  if (position === -1) {
    const head = body.trimEnd();
    const section = replacesHeading ? newContent : `## ${name}\n${newContent}`;
    return `${head === '' ? '' : `${head}\n\n`}${section}\n`;
  }
  const start = headings[position].index;
  const end = position + 1 < headings.length ? headings[position + 1].index : lines.length;
  const before = lines.slice(0, start);
  const after = lines.slice(end);
  const section = replacesHeading ? newContent : `${lines[start]}\n${newContent}`;
  const prefix = before.length === 0 ? '' : `${before.join('\n')}\n`;
  const suffix = after.length === 0 ? '\n' : `\n\n${after.join('\n')}`;
  return `${prefix}${section}${suffix}`;
}

const markerText = (name) => `<!-- groundwork:${name} -->`;

/**
 * @param {string} body
 * @param {string} name
 * @returns {boolean}
 */
export function hasMarker(body, name) {
  return body.includes(markerText(name));
}

/**
 * Appends the marker on its own last line. Idempotent.
 * @param {string} body
 * @param {string} name
 * @returns {string}
 */
export function addMarker(body, name) {
  if (hasMarker(body, name)) return body;
  const head = body.trimEnd();
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
  if (!hasMarker(body, name)) return body;
  const marker = markerText(name);
  const kept = body.split('\n').flatMap((line) => {
    if (line.trim() === marker) return [];
    return [line.split(marker).join('')];
  });
  const result = kept.join('\n');
  if (!body.endsWith('\n')) return result.trimEnd();
  return `${result.trimEnd()}\n`;
}

/**
 * `label:` values of an issue-form YAML by regex (no YAML parser), in file order.
 * Surrounding single or double quotes are removed.
 * @param {string} yamlText
 * @returns {string[]}
 */
export function formFieldLabels(yamlText) {
  const labels = [];
  for (const line of yamlText.split('\n')) {
    const match = /^\s*(?:-\s+)?label:[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!match) continue;
    labels.push(match[1].replace(/^(["'])(.*)\1$/, '$2'));
  }
  return labels;
}

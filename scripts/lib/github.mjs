import { spawn } from 'node:child_process';

/** @typedef {'GET'|'POST'|'PATCH'|'PUT'|'DELETE'} Method */
/** @typedef {{ owner: string, repo: string }} RepoRef */
/** @typedef {{ status: number, data: any, headers: Record<string, string> }} Response */
/** @typedef {{ body?: object, query?: Record<string, string|number|boolean>, accept?: string, okStatuses?: number[] }} RequestOptions */
/** @typedef {{ method: Method, path: string, status: number }} CallRecord */
/** @typedef {{
 *   transport: 'gh'|'fetch'|'fixture',
 *   request(method: Method, path: string, options?: RequestOptions): Promise<Response>,
 *   paginate(path: string, options?: { query?: object, itemsKey?: string }): Promise<any[]>,
 *   graphql(query: string, variables?: object): Promise<object>,
 * }} GitHubClient */

const DEFAULT_API_URL = 'https://api.github.com';
const DEFAULT_ACCEPT = 'application/vnd.github+json';
const API_VERSION = '2022-11-28';
const PAGE_SIZE = 100;
const REPOSITORY_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

export class GitHubError extends Error {
  /**
   * @param {string} message one line
   * @param {{ status?: number, method?: string, path?: string, apiMessage?: string }} [fields]
   */
  constructor(message, { status = 0, method, path, apiMessage } = {}) {
    super(String(message).replace(/\s*[\r\n]+\s*/g, ' ').trim());
    this.name = 'GitHubError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.apiMessage = apiMessage;
  }
}

/**
 * Fills `{name}` segments with encoded values.
 * @param {string} template
 * @param {Record<string, string|number>} params
 * @returns {string}
 */
export function apiPath(template, params) {
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    const value = params?.[name];
    if (value === undefined || value === null) {
      throw new GitHubError(`apiPath: missing param ${name} for ${template}`);
    }
    return encodeURIComponent(String(value));
  });
}

/**
 * @param {Record<string, string|undefined>} env
 * @returns {RepoRef}
 */
export function repoFromEnv(env) {
  const match = REPOSITORY_PATTERN.exec(env?.GITHUB_REPOSITORY ?? '');
  if (!match) throw new GitHubError('GITHUB_REPOSITORY is missing or not <owner>/<repo>');
  return { owner: match[1], repo: match[2] };
}

/**
 * Agent machine only.
 * @returns {Promise<RepoRef>}
 */
export async function currentRepo() {
  const { code, stdout, stderr } = await runGh(['repo', 'view', '--json', 'owner,name'], undefined, process.env);
  if (code !== 0) throw new GitHubError(`gh repo view failed: ${firstLine(stderr)}`);
  try {
    const parsed = JSON.parse(stdout);
    return { owner: parsed.owner.login, repo: parsed.name };
  } catch {
    throw new GitHubError('gh repo view returned unexpected output');
  }
}

function compareText(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Merges `query` into the path's own query and sorts all pairs by name, so
 * requests and fixture keys are stable.
 * @param {string} path
 * @param {Record<string, string|number|boolean>} [query]
 * @returns {string}
 */
function withSortedQuery(path, query = {}) {
  const [base, existing = ''] = path.split('?');
  const pairs = [...new URLSearchParams(existing).entries()];
  for (const [name, value] of Object.entries(query)) pairs.push([name, String(value)]);
  if (pairs.length === 0) return base;
  pairs.sort((a, b) => compareText(a[0], b[0]) || compareText(a[1], b[1]));
  return `${base}?${pairs.map(([n, v]) => `${encodeURIComponent(n)}=${encodeURIComponent(v)}`).join('&')}`;
}

function firstLine(text) {
  return String(text ?? '').trim().split(/\r?\n/)[0] || 'no output';
}

function lowerCaseHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]));
}

/**
 * @param {string|undefined} linkHeader
 * @returns {string|null} the rel="next" URL
 */
function nextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(/,\s*(?=<)/)) {
    const match = /^\s*<([^>]*)>(.*)$/.exec(part);
    if (match && /;\s*rel="?next"?/.test(match[2])) return match[1];
  }
  return null;
}

function parseBody(text) {
  if (!text || text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Test seam. Parses `gh api -i` output: status line, headers, blank line, body.
 * Header names are lower-cased; repeated headers are joined with ", ". A
 * leading informational block (for example 100 Continue) is skipped.
 * @param {string} output
 * @returns {Response}
 */
export function parseGhOutput(output) {
  let rest = String(output).replace(/\r\n/g, '\n');
  for (;;) {
    const separator = rest.indexOf('\n\n');
    const head = separator === -1 ? rest : rest.slice(0, separator);
    const body = separator === -1 ? '' : rest.slice(separator + 2);
    const [statusLine, ...headerLines] = head.split('\n');
    const status = /^HTTP\/\S+\s+(\d{3})/.exec(statusLine ?? '');
    if (!status) throw new GitHubError(`gh api output has no HTTP status line: ${firstLine(output)}`);
    const code = Number(status[1]);
    if (code < 200 && /^HTTP\//.test(body)) {
      rest = body;
      continue;
    }
    const headers = {};
    for (const line of headerLines) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
    }
    return { status: code, data: parseBody(body), headers };
  }
}

function runGh(args, stdin, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new GitHubError(`cannot run gh: ${firstLine(error.message)}`)));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

function ghTransport(env) {
  return async (method, path, { body, accept }) => {
    const args = ['api', '-i', '--method', method, path];
    if (accept) args.push('-H', `Accept: ${accept}`);
    if (body !== undefined) args.push('--input', '-');
    const { stdout, stderr } = await runGh(args, body === undefined ? undefined : JSON.stringify(body), env);
    try {
      return parseGhOutput(stdout);
    } catch {
      throw new GitHubError(`gh api failed: ${firstLine(stderr || stdout)}`, { method, path });
    }
  };
}

function fetchTransport({ token, baseUrl, fetchImpl }) {
  return async (method, path, { body, accept }) => {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: accept ?? DEFAULT_ACCEPT,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'groundwork',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return {
        status: response.status,
        data: parseBody(text),
        headers: lowerCaseHeaders(Object.fromEntries(response.headers.entries())),
      };
    } catch (error) {
      throw new GitHubError(`fetch failed: ${firstLine(error.message)}`, { method, path });
    }
  };
}

function reduceLink(url, apiBasePath) {
  if (!url) return null;
  const parsed = new URL(url, 'https://placeholder.invalid');
  const path = apiBasePath && parsed.pathname.startsWith(`${apiBasePath}/`)
    ? parsed.pathname.slice(apiBasePath.length)
    : parsed.pathname;
  return withSortedQuery(`${path}${parsed.search}`);
}

/**
 * Behaviour shared by all transports: query sorting, okStatuses, error
 * mapping, pagination, GraphQL, and onCall (which never sees a body).
 * @param {GitHubClient['transport']} transport
 * @param {(method: Method, path: string, options: RequestOptions) => Promise<Response>} send
 * @param {((record: CallRecord) => void) | undefined} onCall
 * @param {string} apiBasePath path prefix of the API URL, dropped from Link URLs
 * @returns {GitHubClient}
 */
function buildClient(transport, send, onCall, apiBasePath = '') {
  async function request(method, path, options = {}) {
    const fullPath = withSortedQuery(path, options.query);
    let response;
    try {
      response = await send(method, fullPath, options);
    } catch (error) {
      onCall?.({ method, path: fullPath, status: 0 });
      throw error instanceof GitHubError ? error : new GitHubError(firstLine(error?.message), { method, path: fullPath });
    }
    onCall?.({ method, path: fullPath, status: response.status });
    const ok = (response.status >= 200 && response.status < 300) || (options.okStatuses ?? []).includes(response.status);
    if (ok) return response;
    const apiMessage = typeof response.data?.message === 'string' ? response.data.message : '';
    throw new GitHubError(`${method} ${fullPath}: ${response.status}${apiMessage ? ` ${apiMessage}` : ''}`, {
      status: response.status,
      method,
      path: fullPath,
      apiMessage,
    });
  }

  async function paginate(path, { query = {}, itemsKey } = {}) {
    const items = [];
    let nextPath = withSortedQuery(path, { ...query, per_page: PAGE_SIZE });
    while (nextPath) {
      const response = await request('GET', nextPath);
      const page = itemsKey ? response.data?.[itemsKey] : response.data;
      if (!Array.isArray(page)) {
        throw new GitHubError(`GET ${nextPath}: expected an array${itemsKey ? ` at ${itemsKey}` : ''}`, {
          method: 'GET',
          path: nextPath,
        });
      }
      items.push(...page);
      nextPath = reduceLink(nextLink(response.headers?.link), apiBasePath);
    }
    return items;
  }

  async function graphql(query, variables = {}) {
    const response = await request('POST', '/graphql', { body: { query, variables } });
    if (response.data?.errors?.length) {
      const message = response.data.errors[0]?.message ?? 'unknown error';
      throw new GitHubError(`POST /graphql: ${message}`, {
        status: response.status,
        method: 'POST',
        path: '/graphql',
        apiMessage: message,
      });
    }
    return response.data?.data ?? {};
  }

  return { transport, request, paginate, graphql };
}

/**
 * @param {{ env: Record<string, string|undefined>, token?: string, onCall?: (record: CallRecord) => void,
 *   fetchImpl?: typeof fetch }} options `fetchImpl` is a test seam; it defaults to global `fetch`.
 * @returns {GitHubClient}
 */
export function createClient({ env, token, onCall, fetchImpl = globalThis.fetch }) {
  const tokenGiven = token !== undefined;
  if (!tokenGiven && env.GITHUB_ACTIONS !== 'true') {
    return buildClient('gh', ghTransport(env), onCall);
  }
  const resolvedToken = tokenGiven ? token : env.GITHUB_TOKEN;
  if (!resolvedToken) throw new GitHubError('GitHub token is empty');
  const baseUrl = (env.GITHUB_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
  const apiBasePath = new URL(baseUrl).pathname.replace(/\/+$/, '');
  return buildClient('fetch', fetchTransport({ token: resolvedToken, baseUrl, fetchImpl }), onCall, apiBasePath);
}

/**
 * @param {Record<string, Response | Response[]>} routes keyed "<METHOD> <path-with-sorted-query>"
 * @param {{ onCall?: (record: CallRecord) => void }} [options]
 * @returns {GitHubClient}
 */
export function createFixtureClient(routes, { onCall } = {}) {
  const served = new Map();
  const send = async (method, path) => {
    const key = `${method} ${path}`;
    const route = routes[key];
    if (route === undefined) throw new GitHubError(`no fixture for ${key}`, { method, path });
    let response = route;
    if (Array.isArray(route)) {
      const index = served.get(key) ?? 0;
      if (index >= route.length) throw new GitHubError(`no fixture for ${key} (responses exhausted)`, { method, path });
      served.set(key, index + 1);
      response = route[index];
    }
    return { ...response, headers: lowerCaseHeaders(response.headers) };
  };
  return buildClient('fixture', send, onCall);
}

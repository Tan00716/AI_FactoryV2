/**
 * .http file parser (round-4 task A6).
 *
 * Grammar (one request per `###`-separated block):
 *
 *   ### optional name
 *   METHOD URL                        # e.g. GET {{baseUrl}}/users/1
 *   Header-Name: value                # any number of headers
 *   Header-Two: value
 *                                       # blank line ends the headers
 *   request body lines...             # until `>`, `###`, or EOF
 *
 *   > status == 200                   # assertions (one per line)
 *   > status in 2xx
 *   > header content-type contains json
 *   > body contains some text
 *   > json-path $.a.b == 3
 *   > json-path $.a exists
 *   > max-time-ms 500
 *
 *   @timeout-ms 3000                  # directives (one per line, anywhere in the block)
 *
 * Comment lines (`# ...` or `// ...`) are skipped outside the body.
 * `{{var}}` placeholders are NOT substituted here — substitution happens
 * at send time with the selected environment + explicit variables.
 */
import {
  HttpClientError,
  HttpMethod,
  HttpRequestSpec,
  type AssertionSpec,
} from './types';

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const MAX_REQUESTS = 100;
const MAX_BODY_LINES = 5000;
const MAX_LINE_LENGTH = 200_000;

interface Block {
  name: string;
  lines: { text: string; lineNo: number }[];
}

function fail(lineNo: number, message: string): never {
  throw new HttpClientError(`line ${lineNo}: ${message}`, 'parse-error');
}

/** Split the file into `###`-separated blocks (comments stripped outside bodies). */
function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.length > MAX_LINE_LENGTH) fail(i + 1, 'line too long');
    const trimmed = raw.trim();
    if (trimmed.startsWith('###')) {
      current = { name: trimmed.slice(3).trim(), lines: [] };
      blocks.push(current);
      continue;
    }
    if (!current) {
      // Leading content before the first `###` is allowed too: treat the
      // whole file as an implicit single block.
      current = { name: '', lines: [] };
      blocks.push(current);
    }
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    current.lines.push({ text: raw, lineNo: i + 1 });
  }
  return blocks.filter((b) => b.lines.length > 0);
}

function parseAssertion(text: string, lineNo: number): AssertionSpec {
  const body = text.trim().replace(/^>\s*/, '');
  let m = body.match(/^status\s*==\s*(\d{3})$/i);
  if (m) return { type: 'status', op: 'eq', expected: parseInt(m[1], 10) };
  m = body.match(/^status\s+in\s+([2-5])xx$/i);
  if (m) return { type: 'status-class', expected: `${m[1]}xx` as '2xx' | '3xx' | '4xx' | '5xx' };
  m = body.match(/^header\s+([A-Za-z0-9\-_]+)\s+(==|contains)\s+(.+)$/i);
  if (m) return { type: 'header', name: m[1].toLowerCase(), op: m[2] as 'eq' | 'contains', expected: m[3].trim() };
  m = body.match(/^body\s+contains\s+(.+)$/i);
  if (m) {
    const raw = m[1].trim();
    const unquoted = raw.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    return { type: 'body-contains', text: unquoted };
  }
  m = body.match(/^json-path\s+(\S+)\s+exists$/i);
  if (m) return { type: 'json-path', path: m[1], op: 'exists' };
  m = body.match(/^json-path\s+(\S+)\s*==\s*(.+)$/i);
  if (m) {
    let expected: unknown = m[2].trim();
    try {
      expected = JSON.parse(m[2].trim());
    } catch {
      // leave as a raw string when it is not a JSON literal
    }
    return { type: 'json-path', path: m[1], op: 'eq', expected };
  }
  m = body.match(/^max-time-ms\s+(\d+)$/i);
  if (m) return { type: 'max-time-ms', ms: parseInt(m[1], 10) };
  return fail(lineNo, `unrecognized assertion: ${JSON.stringify(body)}`);
}

function parseBlock(block: Block, index: number): HttpRequestSpec {
  const lines = block.lines;
  const reqLine = lines[0];
  const m = reqLine.text.trim().match(/^([A-Za-z]+)\s+(\S.*)$/);
  if (!m) fail(reqLine.lineNo, 'expected a request line like `GET https://host/path`');
  const method = m[1].toUpperCase() as HttpMethod;
  if (!METHODS.includes(method)) fail(reqLine.lineNo, `unsupported method ${JSON.stringify(m[1])}`);
  const url = m[2].trim();
  if (!url) fail(reqLine.lineNo, 'missing URL');

  const headers: Record<string, string> = {};
  const assertions: AssertionSpec[] = [];
  const bodyLines: string[] = [];
  let timeoutMs: number | undefined;
  let i = 1;
  // Headers: `Name: value` lines until the first blank line. (splitBlocks
  // already dropped blank lines, so the header section ends at the first
  // line that is not `Name: value`, an assertion `>`, or a directive `@`.)
  for (; i < lines.length; i++) {
    const t = lines[i].text.trim();
    if (t.startsWith('>') || t.startsWith('@')) break;
    const hm = t.match(/^([A-Za-z0-9\-_]+)\s*:\s*(.*)$/);
    if (!hm) break;
    headers[hm[1].toLowerCase()] = hm[2].trim();
  }
  // Body + assertions/directives.
  for (; i < lines.length; i++) {
    const t = lines[i].text.trim();
    if (t.startsWith('>')) {
      assertions.push(parseAssertion(t, lines[i].lineNo));
      continue;
    }
    if (t.startsWith('@')) {
      const dm = t.match(/^@timeout-ms\s+(\d+)$/i);
      if (!dm) fail(lines[i].lineNo, `unrecognized directive: ${JSON.stringify(t)}`);
      timeoutMs = parseInt(dm[1], 10);
      continue;
    }
    if (bodyLines.length >= MAX_BODY_LINES) fail(lines[i].lineNo, 'request body too long');
    bodyLines.push(lines[i].text);
  }

  const body = bodyLines.length > 0 ? bodyLines.join('\n') : undefined;
  return {
    id: String(index + 1),
    name: block.name,
    method,
    url,
    headers,
    body,
    timeoutMs,
    assertions,
  };
}

/** Parse a .http file into request specs. Throws HttpClientError on bad syntax. */
export function parseHttpFile(text: string): HttpRequestSpec[] {
  if (typeof text !== 'string') throw new HttpClientError('http file text must be a string', 'bad-input');
  if (text.length > 5_000_000) throw new HttpClientError('http file too large (5MB cap)', 'too-large');
  const blocks = splitBlocks(text);
  if (blocks.length > MAX_REQUESTS) {
    throw new HttpClientError(`too many requests (${blocks.length}, cap ${MAX_REQUESTS})`, 'too-many-requests');
  }
  if (blocks.length === 0) throw new HttpClientError('no requests found', 'empty');
  return blocks.map((b, i) => parseBlock(b, i));
}

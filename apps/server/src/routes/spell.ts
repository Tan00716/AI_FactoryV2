/**
 * Spell check — server routes (round-5 task R5-A7).
 *
 *   POST /api/spell/scan         scan one file (by path, jailed) or inline text
 *   GET  /api/spell/dictionary   project dictionary words (.ai-factory/spell-dictionary.txt)
 *   POST /api/spell/dictionary   add one word to the project dictionary
 *   DELETE /api/spell/dictionary remove one word from the project dictionary
 *
 * The 'spell-check' inspection checker is exposed through
 * spellCheckerProvider() and wired into the inspection run in
 * apps/server/src/index.ts via setExtraCheckerProvider — the same
 * setter-injection pattern as round-4 A4 (routes/ssr.ts) and round-5 A5
 * (routes/trojanscan.ts). It has its own profile gate ('spell-check'),
 * independent from the legacy shared 'ssr-template' gate.
 *
 * This route only DETECTS. It never rewrites source: an unknown word is
 * often a domain term, and auto-"fixing" it can silently change program
 * semantics — remediation is always a human decision (add to the project
 * dictionary, or edit by hand).
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleSpellRoutes, setSpellInspectionRootResolver, spellCheckerProvider } from './routes/spell';
 *   if (await handleSpellRoutes(req, res, url, ctx)) return;
 *   setSpellInspectionRootResolver((root) => resolveInspectionRoot(root));
 *   setExtraCheckerProvider((root) => [...ssrCheckerProvider(root), ...trojanCheckerProvider(root), ...spellCheckerProvider(root)]);
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { RouteContext } from './context';
import type { Checker, Finding } from '../inspections';
import { WORDS, buildDictionary, scanText, type SpellHit } from '@ai-factory/spellcheck';

export const SPELL_CHECKER_NAME = 'spell-check';
export const SPELL_DICTIONARY_FILE = join('.ai-factory', 'spell-dictionary.txt');

const PREFIX = '/api/spell';
const MAX_SCAN_BYTES = 1 * 1024 * 1024;
const MAX_WORD_LEN = 64;
const WORD_RE = /^[A-Za-z][A-Za-z'-]{0,63}$/;

class SpellRouteError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'SpellRouteError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Inspection-root resolver (setter injection, A4/A5 pattern)
// ---------------------------------------------------------------------------

let inspectionRootResolver: ((root?: string) => string) | null = null;

export function setSpellInspectionRootResolver(fn: ((root?: string) => string) | null): void {
  inspectionRootResolver = fn;
}

function resolveRoot(rawRoot?: string): string {
  if (!inspectionRootResolver) {
    throw new SpellRouteError('inspection root resolver is not wired', 500);
  }
  try {
    return inspectionRootResolver(rawRoot);
  } catch (e) {
    throw new SpellRouteError((e as Error).message, 403);
  }
}

function jailFile(root: string, raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024) {
    throw new SpellRouteError('path is required');
  }
  const abs = resolve(root, raw);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new SpellRouteError(`path escapes the scan root: ${raw.slice(0, 80)}`, 403);
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch {
    throw new SpellRouteError(`path does not exist: ${raw.slice(0, 80)}`, 404);
  }
  if (!st.isFile()) throw new SpellRouteError(`path is not a file: ${raw.slice(0, 80)}`);
  if (st.size > MAX_SCAN_BYTES) {
    throw new SpellRouteError(`file exceeds ${MAX_SCAN_BYTES} bytes`, 413);
  }
  return abs;
}

// ---------------------------------------------------------------------------
// Project dictionary (.ai-factory/spell-dictionary.txt)
// ---------------------------------------------------------------------------

function dictionaryPath(root: string): string {
  return join(root, SPELL_DICTIONARY_FILE);
}

/** Read the project dictionary; missing file = empty list (not an error). */
export function readProjectDictionary(root: string): string[] {
  const p = dictionaryPath(root);
  if (!existsSync(p)) return [];
  const words: string[] = [];
  const seen = new Set<string>();
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const w = line.trim().toLowerCase();
    if (w && WORD_RE.test(w) && !seen.has(w)) {
      seen.add(w);
      words.push(w);
    }
  }
  return words.sort();
}

function validateWord(raw: unknown): string {
  if (typeof raw !== 'string') throw new SpellRouteError('word must be a string');
  const w = raw.trim().toLowerCase();
  if (!WORD_RE.test(w)) {
    throw new SpellRouteError('word must be 1-64 ASCII letters (apostrophe/hyphen allowed after the first letter)');
  }
  return w;
}

function writeProjectDictionary(root: string, words: string[]): void {
  const p = dictionaryPath(root);
  mkdirSync(join(root, '.ai-factory'), { recursive: true });
  writeFileSync(p, words.length ? words.join('\n') + '\n' : '', 'utf8');
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export interface SpellApiHit {
  line: number;
  column: number;
  length: number;
  word: string;
  suggestions: string[];
  message: string;
}

const BASE_DICTIONARY = buildDictionary(WORDS);

export function hitToMessage(h: SpellHit): string {
  const sug = h.suggestions.length ? ` (did you mean: ${h.suggestions.join(', ')}?)` : '';
  return `possible typo: '${h.word}'${sug}`;
}

export function hitToApi(h: SpellHit): SpellApiHit {
  return {
    line: h.line,
    column: h.column,
    length: h.length,
    word: h.word,
    suggestions: h.suggestions,
    message: hitToMessage(h),
  };
}

function findingIdFor(checker: string, file: string, h: SpellHit): string {
  const sig = [checker, file, h.line, h.column, h.word].join('');
  return createHash('sha1').update(sig, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Inspection checker provider (wired via setExtraCheckerProvider).
 * Reads the project dictionary once per provider call and closes over it.
 * Suggestions are disabled here: project-wide runs report the word only
 * (edit-distance suggestions cost too much at that scale and the message
 * would bloat every finding).
 */
export function spellCheckerProvider(root: string): Checker[] {
  let extra: string[] = [];
  try {
    extra = readProjectDictionary(root);
  } catch {
    extra = [];
  }
  const checker: Checker = {
    name: SPELL_CHECKER_NAME,
    description:
      'Typo inspection: camelCase/snake_case identifier splitting against a hand-maintained English word subset + project dictionary (round-5 A7).',
    run({ file, lines }: { file: string; lines: string[] }): Finding[] {
      const findings: Finding[] = [];
      for (const h of scanText(lines.join('\n'), { dictionary: BASE_DICTIONARY, extraWords: extra, suggest: false })) {
        const message = hitToMessage(h);
        findings.push({
          id: findingIdFor(SPELL_CHECKER_NAME, file, h),
          checker: SPELL_CHECKER_NAME,
          severity: 'warning',
          file,
          line: h.line,
          message,
          detail: JSON.stringify({ column: h.column, word: h.word, suggestions: h.suggestions }),
        });
      }
      return findings;
    },
  };
  return [checker];
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function handleSpellRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // POST /api/spell/scan — one file or inline text (viewer).
  if (method === 'POST' && path === `${PREFIX}/scan`) {
    const body = (await ctx.readBody(req).catch(() => ({}))) as Record<string, unknown>;
    let text: string;
    let label: string;
    const inline = body['text'];
    if (typeof inline === 'string') {
      if (inline.length > MAX_SCAN_BYTES) {
        ctx.json(res, 413, { error: `text exceeds ${MAX_SCAN_BYTES} bytes` });
        return true;
      }
      text = inline;
      label = typeof body['filename'] === 'string' && body['filename'] ? String(body['filename']).slice(0, 128) : 'untitled';
    } else {
      let root: string;
      try {
        root = resolveRoot(typeof body['root'] === 'string' ? body['root'] : undefined);
      } catch (e) {
        const err = e as SpellRouteError;
        ctx.json(res, err.status || 403, { error: err.message });
        return true;
      }
      let abs: string;
      try {
        abs = jailFile(root, body['path']);
      } catch (e) {
        const err = e as SpellRouteError;
        ctx.json(res, err.status || 400, { error: err.message });
        return true;
      }
      try {
        text = readFileSync(abs, 'utf8');
      } catch (e) {
        ctx.json(res, 500, { error: `cannot read file: ${(e as Error).message}` });
        return true;
      }
      label = abs;
    }
    const rootForDict = (() => {
      try {
        return resolveRoot(typeof body['root'] === 'string' ? body['root'] : undefined);
      } catch {
        return null;
      }
    })();
    const extra = rootForDict ? readProjectDictionary(rootForDict) : [];
    const findings = scanText(text, { dictionary: BASE_DICTIONARY, extraWords: extra }).map(hitToApi);
    ctx.audit.record('viewer', 'SPELL_SCAN', 'spell-check', label, {
      findings: findings.length,
      findingsCap: 10000,
    });
    ctx.json(res, 200, { findings: findings.slice(0, 10000), label });
    return true;
  }

  // GET /api/spell/dictionary — list project words.
  if (method === 'GET' && path === `${PREFIX}/dictionary`) {
    let root: string;
    try {
      root = resolveRoot(url.searchParams.get('root') ?? undefined);
    } catch (e) {
      const err = e as SpellRouteError;
      ctx.json(res, err.status || 403, { error: err.message });
      return true;
    }
    const words = readProjectDictionary(root);
    ctx.json(res, 200, { words, file: SPELL_DICTIONARY_FILE });
    return true;
  }

  // POST /api/spell/dictionary — add a word (the quick-fix target).
  if (method === 'POST' && path === `${PREFIX}/dictionary`) {
    const body = (await ctx.readBody(req).catch(() => ({}))) as Record<string, unknown>;
    let root: string;
    let word: string;
    try {
      root = resolveRoot(typeof body['root'] === 'string' ? body['root'] : undefined);
      word = validateWord(body['word']);
    } catch (e) {
      const err = e as SpellRouteError;
      ctx.json(res, err.status || 400, { error: err.message });
      return true;
    }
    const words = readProjectDictionary(root);
    const added = !words.includes(word);
    if (added) {
      writeProjectDictionary(root, [...words, word].sort());
      ctx.audit.record('user', 'SPELL_WORD_ADDED', 'spell-check', SPELL_DICTIONARY_FILE, { word });
    }
    ctx.json(res, 200, { word, added, total: readProjectDictionary(root).length });
    return true;
  }

  // DELETE /api/spell/dictionary — remove a word.
  if (method === 'DELETE' && path === `${PREFIX}/dictionary`) {
    const body = (await ctx.readBody(req).catch(() => ({}))) as Record<string, unknown>;
    let root: string;
    let word: string;
    try {
      root = resolveRoot(typeof body['root'] === 'string' ? body['root'] : undefined);
      word = validateWord(body['word']);
    } catch (e) {
      const err = e as SpellRouteError;
      ctx.json(res, err.status || 400, { error: err.message });
      return true;
    }
    const words = readProjectDictionary(root);
    const removed = words.includes(word);
    if (removed) {
      writeProjectDictionary(root, words.filter((w) => w !== word));
      ctx.audit.record('user', 'SPELL_WORD_REMOVED', 'spell-check', SPELL_DICTIONARY_FILE, { word });
    }
    ctx.json(res, 200, { word, removed, total: readProjectDictionary(root).length });
    return true;
  }

  return false;
}

/**
 * R5-A7 Spell check — route integration tests (dist).
 *
 * NOTE: the full-server boot variant is deferred to the wave closeout:
 * a sibling wave-2 task (R5-A8) is mid-flight and its in-progress wiring
 * in apps/server/src/index.ts currently breaks server boot (missing
 * import). These tests exercise handleSpellRoutes directly with a mock
 * RouteContext — same handler code the dispatcher calls.
 *
 *   POST /api/spell/scan {text}        → inline typo sample → warning hit + suggestions
 *   POST /api/spell/scan {path}        → jailed fixture file scan
 *   POST /api/spell/scan {path:'../x'} → 403 (jail) / 404 missing
 *   POST /api/spell/dictionary {word}  → add; GET lists; scan no longer flags; DELETE removes
 *   spellCheckerProvider unit: checker shape, project dictionary honored, severity warning
 *
 * Run: npm run build -w @ai-factory/server && node scripts/run-tests-tmp.mjs --test apps/server/tests/spell.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleSpellRoutes,
  setSpellInspectionRootResolver,
  spellCheckerProvider,
  SPELL_CHECKER_NAME,
} from '../dist/routes/spell.js';

const TYPO_JS = [
  'function recieveFile(fielName) {',
  '  // retreive the package and seperate the parts',
  '  return fielName;',
  '}',
  '',
].join('\n');

const CLEAN_JS = 'function receiveFile(fileName) {\n  return fileName;\n}\n';

function homeTmp(prefix: string): string {
  const base = path.join(os.homedir(), 'r5a7-shots', 'tmp');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

function makeRepo(): string {
  const dir = homeTmp('aif-spell-repo-');
  fs.writeFileSync(path.join(dir, 'typo.js'), TYPO_JS, 'utf8');
  fs.writeFileSync(path.join(dir, 'clean.js'), CLEAN_JS, 'utf8');
  return dir;
}

interface Captured {
  status: number;
  body: unknown;
}

function mockCtx(repoDir: string, body: unknown) {
  const auditCalls: Array<{ event: string }> = [];
  const ctx = {
    readBody: async () => body,
    json: (_res: ServerResponse, status: number, obj: unknown) => {
      captured.status = status;
      captured.body = obj;
    },
    audit: {
      record: (_actor: string, event: string, ..._rest: unknown[]) => {
        auditCalls.push({ event });
      },
    },
  };
  let captured: Captured = { status: 0, body: null };
  return { ctx, captured: () => captured, auditCalls };
}

function mockReq(method: string, urlPath: string): { req: IncomingMessage; url: URL } {
  return {
    req: { method, headers: {} } as IncomingMessage,
    url: new URL(`http://127.0.0.1${urlPath}`),
  };
}

async function callRoute(repoDir: string, method: string, urlPath: string, body: unknown): Promise<Captured & { handled: boolean; auditCalls: Array<{ event: string }> }> {
  // The production resolver validates against FACTORY_INSPECT_ROOTS; here
  // the fixture repo is the root and jail logic is what under test.
  setSpellInspectionRootResolver((root?: string) => {
    if (root && root !== repoDir) throw new Error('root not allowed');
    return repoDir;
  });
  const { ctx, captured, auditCalls } = mockCtx(repoDir, body);
  const { req, url } = mockReq(method, urlPath);
  const res = {} as ServerResponse;
  const handled = await handleSpellRoutes(req, res, url, ctx as never);
  return { ...captured(), handled, auditCalls };
}

test('spell routes: inline scan flags typos with suggestions; clean text is empty', async () => {
  const repo = makeRepo();
  try {
    const r = await callRoute(repo, 'POST', '/api/spell/scan', { text: TYPO_JS, filename: 'typo.js' });
    assert.equal(r.handled, true);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    const findings = (r.body as { findings: Array<Record<string, unknown>> }).findings;
    // Note: `word` is the full source token; the checker matched its split parts.
    const words = findings.map((f) => f['word']);
    assert.ok(words.includes('recieveFile'), words.join(','));
    assert.ok(words.includes('fielName'), words.join(','));
    assert.ok(words.includes('retreive'), words.join(','));
    assert.ok(words.includes('seperate'), words.join(','));
    const recieve = findings.find((f) => f['word'] === 'recieveFile') as Record<string, unknown>;
    assert.ok((recieve['suggestions'] as string[]).includes('receive'));
    assert.ok(String(recieve['message']).includes('recieveFile'));
    assert.ok(r.auditCalls.some((a) => a.event === 'SPELL_SCAN'));
    const clean = await callRoute(repo, 'POST', '/api/spell/scan', { text: CLEAN_JS, filename: 'clean.js' });
    assert.equal(clean.status, 200);
    assert.deepEqual((clean.body as { findings: unknown[] }).findings, []);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('spell routes: path scan is jailed (403 escape, 404 missing)', async () => {
  const repo = makeRepo();
  try {
    const r = await callRoute(repo, 'POST', '/api/spell/scan', { path: 'typo.js' });
    assert.equal(r.status, 200);
    assert.ok(((r.body as { findings: unknown[] }).findings).length >= 3);
    const clean = await callRoute(repo, 'POST', '/api/spell/scan', { path: 'clean.js' });
    assert.equal(clean.status, 200);
    assert.equal(((clean.body as { findings: unknown[] }).findings).length, 0);
    const escape = await callRoute(repo, 'POST', '/api/spell/scan', { path: '../outside.js' });
    assert.equal(escape.status, 403);
    const missing = await callRoute(repo, 'POST', '/api/spell/scan', { path: 'nope.js' });
    assert.equal(missing.status, 404);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('spell routes: project dictionary add/list/suppress/remove', async () => {
  const repo = makeRepo();
  try {
    const add = await callRoute(repo, 'POST', '/api/spell/dictionary', { word: 'Tanboon' });
    assert.equal(add.status, 200, JSON.stringify(add.body));
    assert.equal((add.body as { added: boolean }).added, true);
    assert.equal((add.body as { word: string }).word, 'tanboon');
    assert.ok(add.auditCalls.some((a) => a.event === 'SPELL_WORD_ADDED'));
    const bad = await callRoute(repo, 'POST', '/api/spell/dictionary', { word: 'not a word!' });
    assert.equal(bad.status, 400);
    const list = await callRoute(repo, 'GET', '/api/spell/dictionary', undefined);
    assert.equal(list.status, 200);
    assert.ok(((list.body as { words: string[] }).words).includes('tanboon'));
    // The file really landed on disk under .ai-factory/.
    assert.ok(fs.existsSync(path.join(repo, '.ai-factory', 'spell-dictionary.txt')));
    // Inline scan consults the project dictionary when root is supplied.
    const scan = await callRoute(repo, 'POST', '/api/spell/scan', {
      text: 'const tanboon = 1;\n',
      filename: 'x.js',
      root: repo,
    });
    assert.equal(scan.status, 200);
    assert.deepEqual((scan.body as { findings: unknown[] }).findings, []);
    const del = await callRoute(repo, 'DELETE', '/api/spell/dictionary', { word: 'tanboon' });
    assert.equal(del.status, 200);
    assert.equal((del.body as { removed: boolean }).removed, true);
    const scan2 = await callRoute(repo, 'POST', '/api/spell/scan', {
      text: 'const tanboon = 1;\n',
      filename: 'x.js',
      root: repo,
    });
    assert.equal(((scan2.body as { findings: unknown[] }).findings).length, 1);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('spell routes: unknown paths are not handled', async () => {
  const repo = makeRepo();
  try {
    const r = await callRoute(repo, 'GET', '/api/spell/nope', undefined);
    assert.equal(r.handled, false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('spellCheckerProvider: inspection checker shape, severity, project dictionary', () => {
  const repo = homeTmp('aif-spell-checker-');
  try {
    const [checker] = spellCheckerProvider(repo);
    assert.equal(checker.name, SPELL_CHECKER_NAME);
    assert.ok(checker.description.length > 0);
    const findings = checker.run({ file: 'typo.js', lines: TYPO_JS.split('\n') });
    assert.ok(findings.length >= 3, `expected >=3, got ${findings.length}`);
    assert.ok(findings.every((f) => f.checker === SPELL_CHECKER_NAME));
    assert.ok(findings.every((f) => f.severity === 'warning'));
    assert.ok(findings.every((f) => f.file === 'typo.js'));
    assert.ok(findings.every((f) => typeof f.id === 'string' && f.id.length === 12));
    const clean = checker.run({ file: 'clean.js', lines: CLEAN_JS.split('\n') });
    assert.deepEqual(clean, []);
    // Project dictionary suppresses the hit (matched on split word parts).
    fs.mkdirSync(path.join(repo, '.ai-factory'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.ai-factory', 'spell-dictionary.txt'), 'fiel\nretreive\nseperate\nrecieve\n', 'utf8');
    const [checker2] = spellCheckerProvider(repo);
    const findings2 = checker2.run({ file: 'typo.js', lines: TYPO_JS.split('\n') });
    assert.deepEqual(findings2, []);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

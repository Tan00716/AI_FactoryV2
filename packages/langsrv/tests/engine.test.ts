import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SemanticEngine, identifierAtPosition, LangSrvError } from '../src/index.js';

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-langsrv-'));
  fs.writeFileSync(path.join(dir, 'a.ts'), [
    "export function greet(name: string): string {",
    "  return `hi ${name}`;",
    "}",
    "export const VERSION = '1.0.0';",
    "",
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'b.ts'), [
    "import { greet, VERSION } from './a';",
    "export function run(): string {",
    "  return greet(VERSION);",
    "}",
    "",
  ].join('\n'));
  return dir;
}

test('definition resolves a cross-file import to its declaration', async () => {
  const dir = fixture();
  const engine = new SemanticEngine(dir);
  // b.ts line 2 (0-based), `greet` call starts at character 9.
  const defs = await engine.definition('b.ts', 2, 10);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].file, 'a.ts');
  assert.equal(defs[0].line, 0);
});

test('references include the definition, the import, and the call site', async () => {
  const dir = fixture();
  const engine = new SemanticEngine(dir);
  const refs = await engine.references('a.ts', 0, 17);
  const files = refs.map((r) => `${r.file}:${r.line}`);
  assert.ok(files.includes('a.ts:0'), `definition missing: ${files}`);
  assert.ok(files.includes('b.ts:0'), `import missing: ${files}`);
  assert.ok(files.includes('b.ts:2'), `call site missing: ${files}`);
  assert.ok(refs.some((r) => r.isDefinition), 'one reference must be flagged as definition');
});

test('hover returns the signature for a call site', async () => {
  const dir = fixture();
  const engine = new SemanticEngine(dir);
  const hover = await engine.hover('b.ts', 2, 10);
  assert.ok(hover !== null);
  assert.match(hover.display, /greet/);
  assert.match(hover.display, /string/);
});

test('outline lists functions and top-level variables', async () => {
  const dir = fixture();
  const engine = new SemanticEngine(dir);
  const symbols = await engine.outline('a.ts');
  const byName = new Map(symbols.map((s) => [s.name, s.kind]));
  assert.equal(byName.get('greet'), 'function');
  assert.equal(byName.get('VERSION'), 'variable');
});

test('rename-preview computes edits without writing', async () => {
  const dir = fixture();
  const engine = new SemanticEngine(dir);
  const before = fs.readFileSync(path.join(dir, 'a.ts'), 'utf8');
  const res = await engine.renamePreview('a.ts', 0, 17, 'greet2');
  assert.equal(res.oldName, 'greet');
  assert.ok(res.edits.length >= 3, `expected >=3 edits, got ${res.edits.length}`);
  assert.ok(res.edits.every((e) => e.oldText === 'greet' && e.newText === 'greet2'));
  assert.equal(fs.readFileSync(path.join(dir, 'a.ts'), 'utf8'), before, 'rename-preview must not write');
});

test('rename-preview rejects invalid identifiers', async () => {
  const dir = fixture();
  const engine = new SemanticEngine(dir);
  await assert.rejects(
    engine.renamePreview('a.ts', 0, 17, 'not an identifier'),
    (err: unknown) => err instanceof LangSrvError && err.code === 'INVALID_IDENTIFIER',
  );
});

test('cache invalidates after a file edit', async () => {
  const dir = fixture();
  const engine = new SemanticEngine(dir);
  const before = await engine.outline('a.ts');
  assert.ok(!before.some((s) => s.name === 'farewell'));
  fs.appendFileSync(path.join(dir, 'a.ts'), "export function farewell(): string {\n  return 'bye';\n}\n");
  const after = await engine.outline('a.ts');
  assert.ok(after.some((s) => s.name === 'farewell' && s.kind === 'function'));
});

test('errors: unsupported extension, out-of-range position, outside root', async () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'c.py'), 'def hello():\n    pass\n');
  const engine = new SemanticEngine(dir);
  await assert.rejects(
    engine.definition('c.py', 0, 1),
    (err: unknown) => err instanceof LangSrvError && err.code === 'UNSUPPORTED_EXT',
  );
  await assert.rejects(
    engine.definition('a.ts', 99, 0),
    (err: unknown) => err instanceof LangSrvError && err.code === 'POSITION_OUT_OF_RANGE',
  );
  await assert.rejects(
    engine.definition('../escape.ts', 0, 0),
    (err: unknown) => err instanceof LangSrvError && err.code === 'FILE_OUTSIDE_ROOT',
  );
});

test('identifierAtPosition extracts the identifier under the cursor', () => {
  assert.equal(identifierAtPosition('  return greet(VERSION);', 0, 10), 'greet');
  assert.equal(identifierAtPosition('  return greet(VERSION);', 0, 1), null);
  assert.equal(identifierAtPosition('const x = 1;', 5, 0), null);
});

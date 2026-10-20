/**
 * Inspection engine unit tests — imports src straight under node's
 * type-stripping ESM loader (pure node builtins).
 *
 * Run: node --test apps/server/tests/inspections.test.ts
 * (test:server picks up the *.test.ts glob).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import {
  auditLicenses,
  builtinCheckers,
  consoleLogChecker,
  defaultInspectionProfile,
  findingSignature,
  loadBaseline,
  loadInspectionProfile,
  makeLongFileChecker,
  makeLongFunctionChecker,
  resolveInspectionRoot,
  runInspection,
  saveBaseline,
  saveInspectionProfile,
  todoFixmeChecker,
  validateInspectionProfile,
  InspectionConfigError,
  InspectionRootError,
  type Finding,
} from '../src/inspections.ts';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'aif-inspections-unit-'));
}

function write(root: string, rel: string, content: string): void {
  const fp = join(root, rel);
  mkdirSync(join(fp, '..'), { recursive: true });
  writeFileSync(fp, content, 'utf8');
}

function mkFinding(over: Partial<Finding> = {}): Finding {
  const base = { checker: 'todo-fixme', file: 'a.ts', line: 3, message: 'TODO: fix me' };
  return { id: 'x', severity: 'info', ...base, ...over } as Finding;
}

test('findingSignature is deterministic and whitespace-normalized', () => {
  const a = mkFinding({ message: 'TODO:   fix\nme' });
  const b = mkFinding({ message: 'TODO: fix me' });
  assert.equal(findingSignature(a), findingSignature(b));
  assert.notEqual(findingSignature(a), findingSignature(mkFinding({ line: 4 })));
});

test('todo-fixme finds markers with line numbers', () => {
  const out = todoFixmeChecker.run({ file: 'a.ts', lines: ['// TODO: rename this', 'const x = 1; // FIXME: hack'] });
  assert.equal(out.length, 2);
  assert.equal(out[0].line, 1);
  assert.equal(out[0].severity, 'info');
  assert.match(out[0].message, /TODO/);
});

test('long-file flags over-budget files only', () => {
  const c = makeLongFileChecker(3);
  const lines = ['a', 'b', 'c', 'd'];
  assert.equal(c.run({ file: 'f.ts', lines }).length, 1);
  assert.equal(c.run({ file: 'f.ts', lines: ['a', 'b', 'c'] }).length, 0);
});

test('long-function flags brace-balanced regions over budget', () => {
  const c = makeLongFunctionChecker(4);
  const lines = ['function big() {', '  a();', '  b();', '  c();', '  d();', '  e();', '}'];
  const out = c.run({ file: 'f.ts', lines });
  assert.equal(out.length, 1);
  assert.match(out[0].message, /big\(\)/);
  const small = ['function s() {', '  a();', '}'];
  assert.equal(c.run({ file: 'f.ts', lines: small }).length, 0);
});

test('console-log ignores test files', () => {
  const lines = ["console.log('debug');"];
  assert.equal(consoleLogChecker.run({ file: 'src/app.ts', lines }).length, 1);
  assert.equal(consoleLogChecker.run({ file: 'src/app.test.ts', lines }).length, 0);
  assert.equal(consoleLogChecker.run({ file: 'tests/x.ts', lines }).length, 0);
});

test('profile: missing file → default-missing; corrupt file → default-corrupt', () => {
  const root = tmpRoot();
  let r = loadInspectionProfile(root);
  assert.equal(r.source, 'default-missing');
  write(root, '.ai-factory/inspections.json', '{not json');
  r = loadInspectionProfile(root);
  assert.equal(r.source, 'default-corrupt');
  assert.match(r.note, /unreadable/);
  write(root, '.ai-factory/inspections.json', JSON.stringify({ maxFileLines: 'nope' }));
  r = loadInspectionProfile(root);
  assert.equal(r.source, 'default-corrupt');
  assert.match(r.note, /invalid/);
});

test('profile: unknown checker name is rejected', () => {
  const { errors } = validateInspectionProfile({ checkers: { nope: true } });
  assert.ok(errors.some((e) => e.includes('unknown checker')));
});

test('profile: save + load round trip', () => {
  const root = tmpRoot();
  const p = saveInspectionProfile(root, { name: 'team', maxFileLines: 2000, checkers: { 'console-log': false } });
  assert.equal(p.name, 'team');
  assert.equal(p.checkers['console-log'], false);
  const r = loadInspectionProfile(root);
  assert.equal(r.source, 'file');
  assert.equal(r.profile.maxFileLines, 2000);
});

test('profile: invalid input throws InspectionConfigError on save', () => {
  assert.throws(() => saveInspectionProfile(tmpRoot(), { maxFileLines: -5 }), InspectionConfigError);
});

test('root jail: /etc is refused, cwd default allowed', () => {
  assert.throws(() => resolveInspectionRoot('/etc'), InspectionRootError);
  process.env.FACTORY_INSPECT_ROOTS = tmpRoot();
  try {
    const root = resolveInspectionRoot();
    assert.ok(root);
    const sub = join(root, 'sub');
    mkdirSync(sub, { recursive: true });
    assert.equal(resolveInspectionRoot(sub), sub);
    assert.throws(() => resolveInspectionRoot('/etc'), InspectionRootError);
  } finally {
    delete process.env.FACTORY_INSPECT_ROOTS;
  }
});

test('runInspection: first run establishes baseline, second run reports only new findings', () => {
  const root = tmpRoot();
  process.env.FACTORY_INSPECT_ROOTS = root;
  try {
    write(root, 'src/a.ts', '// TODO: alpha\nconst x = 1;\n');
    const r1 = runInspection(root, 'proj-1');
    assert.equal(r1.baselineEstablished, true);
    assert.equal(r1.newFindings.length, 0);
    assert.equal(r1.totals.total, 1);
    const b = loadBaseline(root);
    assert.ok(b && b.signatures.length === 1);
    const r2 = runInspection(root, 'proj-1');
    assert.equal(r2.baselineEstablished, false);
    assert.equal(r2.newFindings.length, 0);
    write(root, 'src/b.ts', '// FIXME: beta\n');
    const r3 = runInspection(root, 'proj-1');
    assert.equal(r3.newFindings.length, 1);
    assert.match(r3.newFindings[0].message, /FIXME/);
  } finally {
    delete process.env.FACTORY_INSPECT_ROOTS;
  }
});

test('runInspection: profile disables a checker', () => {
  const root = tmpRoot();
  process.env.FACTORY_INSPECT_ROOTS = root;
  try {
    write(root, 'src/a.ts', '// TODO: alpha\nconsole.log(1);\n');
    write(root, '.ai-factory/inspections.json', JSON.stringify({ checkers: { 'console-log': false } }));
    const r = runInspection(root, 'proj-1');
    assert.equal(r.totals.byChecker['console-log'] ?? 0, 0);
    assert.equal(r.totals.byChecker['todo-fixme'], 1);
  } finally {
    delete process.env.FACTORY_INSPECT_ROOTS;
  }
});

test('builtinCheckers honors enabled flags', () => {
  const p = defaultInspectionProfile();
  // 6 built-ins: the 4 original style checkers + secret-scan + sast-patterns (wave2-④).
  assert.equal(builtinCheckers(p).length, 6);
  p.checkers['todo-fixme'] = false;
  assert.equal(builtinCheckers(p).length, 5);
});

test('license audit: no node_modules → present=false', () => {
  const r = auditLicenses(tmpRoot());
  assert.equal(r.nodeModulesPresent, false);
  assert.equal(r.total, 0);
});

test('license audit: classifies permissive / copyleft / unknown honestly', () => {
  const root = tmpRoot();
  const nm = join(root, 'node_modules');
  mkdirSync(join(nm, 'pkg-mit'), { recursive: true });
  mkdirSync(join(nm, 'pkg-gpl'), { recursive: true });
  mkdirSync(join(nm, 'pkg-none'), { recursive: true });
  mkdirSync(join(nm, '@scope', 'pkg-weird'), { recursive: true });
  writeFileSync(join(nm, 'pkg-mit', 'package.json'), JSON.stringify({ name: 'pkg-mit', version: '1.0.0', license: 'MIT' }));
  writeFileSync(join(nm, 'pkg-gpl', 'package.json'), JSON.stringify({ name: 'pkg-gpl', version: '2.0.0', license: 'GPL-3.0' }));
  writeFileSync(join(nm, 'pkg-none', 'package.json'), JSON.stringify({ name: 'pkg-none', version: '3.0.0' }));
  writeFileSync(join(nm, '@scope', 'pkg-weird', 'package.json'), JSON.stringify({ name: '@scope/pkg-weird', version: '4.0.0', license: { type: 'BSD-3-Clause' } }));
  const r = auditLicenses(root);
  assert.equal(r.nodeModulesPresent, true);
  assert.equal(r.total, 4);
  assert.equal(r.permissive, 2);
  assert.equal(r.copyleft.length, 1);
  assert.equal(r.copyleft[0].name, 'pkg-gpl');
  assert.equal(r.unknown.length, 1);
  assert.equal(r.unknown[0].name, 'pkg-none');
});

test('saveBaseline + loadBaseline round trip', () => {
  const root = tmpRoot();
  assert.equal(loadBaseline(root), null);
  const b = saveBaseline(root, ['b', 'a']);
  assert.deepEqual(b.signatures, ['a', 'b']);
  const loaded = loadBaseline(root);
  assert.deepEqual(loaded?.signatures, ['a', 'b']);
});

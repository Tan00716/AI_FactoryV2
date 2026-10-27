/**
 * @ai-factory/extensions tests: project-local store (install/list/enable/uninstall).
 * Run: node --test packages/extensions/dist/tests/*.test.js (after build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import {
  checkLine,
  enabledExtensions,
  installExtension,
  installExtensionFromDir,
  listExtensions,
  listExtensionsVerbose,
  readExtension,
  setExtensionEnabled,
  uninstallExtension,
} from '../src/index.js';

function root(): string {
  return mkdtempSync(join(tmpdir(), 'ext-store-'));
}

const MANIFEST = {
  name: 'demo-ext',
  version: '1.0.0',
  description: 'demo',
  permissions: ['commands.execute'],
  contributes: {
    commands: [{ id: 'demo.run', title: 'Run' }],
    panels: [],
    checkers: [{ id: 'mark', title: 'Mark', pattern: 'MARK', message: 'found MARK' }],
    providers: [],
  },
};
const MAIN = `api.registerCommand('demo.run', (args) => ({ ok: true }));`;

describe('store', () => {
  it('installs, lists, disables, re-enables, uninstalls', () => {
    const r = root();
    const info = installExtension(r, MANIFEST, MAIN);
    assert.equal(info.enabled, true);
    assert.equal(listExtensions(r).length, 1);
    assert.equal(listExtensions(r)[0].name, 'demo-ext');
    setExtensionEnabled(r, 'demo-ext', false);
    assert.equal(listExtensions(r)[0].enabled, false);
    assert.equal(enabledExtensions(r).length, 0);
    setExtensionEnabled(r, 'demo-ext', true);
    assert.equal(enabledExtensions(r).length, 1);
    uninstallExtension(r, 'demo-ext');
    assert.equal(listExtensions(r).length, 0);
    assert.equal(existsSync(join(r, '.ai-factory', 'extensions', 'demo-ext')), false);
  });
  it('refuses a second install of the same name', () => {
    const r = root();
    installExtension(r, MANIFEST, MAIN);
    assert.throws(() => installExtension(r, MANIFEST, MAIN), /already installed/);
  });
  it('refuses a broken bundle at install time (handler mismatch)', () => {
    const r = root();
    assert.throws(() => installExtension(r, MANIFEST, `// no handlers`), /no handler/);
    assert.equal(listExtensions(r).length, 0);
  });
  it('installs from a directory and reads it back', () => {
    const r = root();
    const src = join(r, 'src-ext');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'extension.json'), JSON.stringify(MANIFEST), 'utf8');
    writeFileSync(join(src, 'main.js'), MAIN, 'utf8');
    const info = installExtensionFromDir(r, src);
    assert.equal(info.name, 'demo-ext');
    const back = readExtension(r, 'demo-ext');
    assert.equal(back.manifest.version, '1.0.0');
    assert.equal(back.main, MAIN);
  });
  it('reports broken directories without hiding the rest', () => {
    const r = root();
    installExtension(r, MANIFEST, MAIN);
    const home = join(r, '.ai-factory', 'extensions', 'broken-ext');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'extension.json'), '{not json', 'utf8');
    const { installed, broken } = listExtensionsVerbose(r);
    assert.equal(installed.length, 1);
    assert.equal(broken.length, 1);
    assert.equal(broken[0].name, 'broken-ext');
    assert.equal(listExtensions(r).length, 1);
  });
  it('rejects a directory-name/manifest-name mismatch on read', () => {
    const r = root();
    installExtension(r, MANIFEST, MAIN);
    const dir = join(r, '.ai-factory', 'extensions', 'demo-ext');
    const m = JSON.parse(readFileSync(join(dir, 'extension.json'), 'utf8')) as Record<string, unknown>;
    m.name = 'other-name';
    writeFileSync(join(dir, 'extension.json'), JSON.stringify(m), 'utf8');
    assert.throws(() => readExtension(r, 'demo-ext'), /does not match/);
  });
});

describe('checkLine', () => {
  it('matches pattern and filePattern', () => {
    const c = { id: 'm', title: 't', pattern: 'MARK', message: 'm', filePattern: '*.ts' };
    assert.equal(checkLine(c, 'src/a.ts', 'xx MARK yy'), true);
    assert.equal(checkLine(c, 'src/a.js', 'xx MARK yy'), false);
    assert.equal(checkLine(c, 'src/a.ts', 'clean'), false);
  });
  it('honours the i flag', () => {
    const c = { id: 'm', title: 't', pattern: 'mark', flags: 'i', message: 'm' };
    assert.equal(checkLine(c, 'a.ts', 'MARK here'), true);
  });
});

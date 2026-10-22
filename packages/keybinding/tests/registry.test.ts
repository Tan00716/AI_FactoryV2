/**
 * Keybinding registry tests (round-5 R5-S1).
 * Run: npm run build -w @ai-factory/keybinding && node --test packages/keybinding/dist/tests/*.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KeybindingRegistry,
  parseKeybinding,
  validateUserKeybindings,
  formatSequence,
} from '../src/index.js';

function linuxRegistry() {
  const r = new KeybindingRegistry('linux');
  r.registerCommand({ id: 'palette.toggle', title: 'Toggle Command Palette', defaultKeys: ['mod+k'] });
  r.registerCommand({ id: 'go.tab.terminal', title: 'Go to Terminal' });
  return r;
}

test('duplicate command id is fail-closed', () => {
  const r = new KeybindingRegistry('linux');
  r.registerCommand({ id: 'a', title: 'A' });
  assert.throws(() => r.registerCommand({ id: 'a', title: 'A2' }), /duplicate/);
});

test('invalid default key is fail-closed at registration', () => {
  const r = new KeybindingRegistry('linux');
  assert.throws(
    () => r.registerCommand({ id: 'a', title: 'A', defaultKeys: ['hyper+k'] }),
    /default key invalid/,
  );
});

test('user layer overrides and unbinds', () => {
  const r = linuxRegistry();
  const issues = r.setUserKeybindings([
    { command: 'palette.toggle', key: 'ctrl+shift+p' },
    { command: 'go.tab.terminal', key: null },
  ]);
  assert.deepEqual(issues, []);
  const eff = r.effectiveBindings();
  const palette = eff.find((b) => b.command === 'palette.toggle')!;
  // User bindings are additive to defaults (VS Code semantics); key:null unbinds all.
  assert.deepEqual(palette.display, ['Ctrl+K', 'Ctrl+Shift+P']);
  assert.equal(palette.bindingSource, 'mixed');
  const term = eff.find((b) => b.command === 'go.tab.terminal')!;
  assert.equal(term.bindingSource, 'unbound');
  assert.deepEqual(term.sequences, []);
});

test('invalid user entries reject the whole payload (fail-closed)', () => {
  const r = linuxRegistry();
  const issues = r.setUserKeybindings([
    { command: 'palette.toggle', key: 'ctrl+shift+p' },
    { command: 'go.tab.terminal', key: 'hyper+zap' },
    { command: '', key: 'ctrl+x' },
  ]);
  assert.equal(issues.length, 2);
  assert.equal(issues[0].index, 1);
  assert.equal(issues[1].index, 2);
  // Fail-closed: nothing applied, defaults intact.
  const palette = r.effectiveBindings().find((b) => b.command === 'palette.toggle')!;
  assert.deepEqual(palette.display, ['Ctrl+K']);
  assert.equal(palette.bindingSource, 'default');
});

test('non-array payload is fail-closed', () => {
  assert.deepEqual(validateUserKeybindings({}), [{ index: -1, message: 'keybindings must be a JSON array' }]);
});

test('conflict detection names both commands', () => {
  const r = linuxRegistry();
  r.setUserKeybindings([{ command: 'go.tab.terminal', key: 'ctrl+k' }]);
  const conflicts = r.detectConflicts();
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].sequence, 'Ctrl+K');
  const ids = conflicts[0].commands.map((c) => c.id).sort();
  assert.deepEqual(ids, ['go.tab.terminal', 'palette.toggle']);
});

test('conflict policy: later binding wins, loser is named', () => {
  const r = linuxRegistry();
  r.setUserKeybindings([{ command: 'go.tab.terminal', key: 'ctrl+k' }]);
  const res = r.resolveSequence(parseKeybinding('ctrl+k', 'linux'))!;
  assert.equal(res.command, 'go.tab.terminal');
  assert.deepEqual(res.overridden, ['palette.toggle']);
});

test('resolveSequence returns null for unknown sequences', () => {
  const r = linuxRegistry();
  assert.equal(r.resolveSequence(parseKeybinding('ctrl+q', 'linux')), null);
});

test('prefixCandidates powers which-key', () => {
  const r = new KeybindingRegistry('linux');
  r.registerCommand({ id: 'a', title: 'A', defaultKeys: ['ctrl+k ctrl+c'] });
  r.registerCommand({ id: 'b', title: 'B', defaultKeys: ['ctrl+k ctrl+u'] });
  r.registerCommand({ id: 'c', title: 'C', defaultKeys: ['ctrl+x'] });
  const cands = r.prefixCandidates(parseKeybinding('ctrl+k', 'linux'));
  assert.equal(cands.length, 2);
  const displays = cands.map((c) => c.display).sort();
  assert.deepEqual(displays, ['Ctrl+C', 'Ctrl+U']);
  const forC = cands.find((c) => c.display === 'Ctrl+C')!;
  assert.deepEqual(forC.commands.map((c) => c.id), ['a']);
  // Non-prefix chord has no candidates.
  assert.deepEqual(r.prefixCandidates(parseKeybinding('ctrl+z', 'linux')), []);
});

test('platform display: mac glyphs vs windows text', () => {
  const mac = new KeybindingRegistry('mac');
  const win = new KeybindingRegistry('windows');
  const seqMac = parseKeybinding('mod+shift+p', 'mac');
  const seqWin = parseKeybinding('mod+shift+p', 'windows');
  assert.equal(formatSequence(seqMac, 'mac'), '⇧⌘P');
  assert.equal(formatSequence(seqWin, 'windows'), 'Ctrl+Shift+P');
});

test('unregisterCommand removes the command entirely', () => {
  const r = linuxRegistry();
  r.unregisterCommand('go.tab.terminal');
  assert.equal(r.hasCommand('go.tab.terminal'), false);
  assert.deepEqual(
    r.effectiveBindings().map((b) => b.command),
    ['palette.toggle'],
  );
});

/**
 * Desktop unit tests for keybinding/manager.ts (round-5 R5-S1).
 * node:test + node:assert/strict. React-free manager, no DOM needed:
 * exercises the chord state machine via processChord/simulateForTest.
 * Run: node --test apps/desktop/tests/unit/keybinding.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { KeybindingManager, resetKeybindingManagerForTests } = await import(
  '../../src/keybinding/manager.ts'
);
const { parseKeybinding } = await import('@ai-factory/keybinding');

function makeManager() {
  const m = new KeybindingManager('linux');
  m.registry.registerCommand({ id: 'palette.toggle', title: 'Palette', defaultKeys: ['mod+k'] });
  m.registry.registerCommand({ id: 'go.tab.terminal', title: 'Terminal' });
  return m;
}

function chord(m, s) {
  return parseKeybinding(s, 'linux')[0];
}

test('exact match fires immediately', () => {
  const m = makeManager();
  const action = m.processChord(chord(m, 'ctrl+k'));
  assert.equal(action.type, 'fire');
  assert.equal(action.command, 'palette.toggle');
  assert.deepEqual(action.overridden, []);
});

test('proper prefix opens which-key pending state', () => {
  const m = makeManager();
  m.registry.setUserKeybindings([{ command: 'go.tab.terminal', key: 'ctrl+k ctrl+t' }]);
  const action = m.processChord(chord(m, 'ctrl+k'));
  assert.equal(action.type, 'pending');
  assert.equal(action.state.candidates.length, 1);
  assert.equal(action.state.candidates[0].display, 'Ctrl+T');
  // Completing the sequence fires the longer binding.
  const second = m.processChord(chord(m, 'ctrl+t'));
  assert.equal(second.type, 'fire');
  assert.equal(second.command, 'go.tab.terminal');
});

test('chord that is both exact and prefix fires the short match on flush', () => {
  const m = makeManager();
  m.registry.setUserKeybindings([{ command: 'go.tab.terminal', key: 'ctrl+k ctrl+t' }]);
  const fired = m.simulateForTest(['ctrl+k']);
  assert.deepEqual(fired, ['palette.toggle']);
});

test('longer sequence wins over the prefix when completed', () => {
  const m = makeManager();
  m.registry.setUserKeybindings([{ command: 'go.tab.terminal', key: 'ctrl+k ctrl+t' }]);
  const fired = m.simulateForTest(['ctrl+k', 'ctrl+t']);
  assert.deepEqual(fired, ['go.tab.terminal']);
});

test('unknown chord is none; pending prefix cleared', () => {
  const m = makeManager();
  m.registry.setUserKeybindings([{ command: 'go.tab.terminal', key: 'ctrl+k ctrl+t' }]);
  let action = m.processChord(chord(m, 'ctrl+k'));
  assert.equal(action.type, 'pending');
  action = m.processChord(chord(m, 'ctrl+z'));
  assert.equal(action.type, 'none');
  assert.equal(action.hadPending, true);
  // After the dead end the registry still resolves fresh chords.
  action = m.processChord(chord(m, 'ctrl+k'));
  assert.equal(action.type, 'pending');
});

test('conflict: user binding wins and names the overridden command', () => {
  const m = makeManager();
  m.registry.setUserKeybindings([{ command: 'go.tab.terminal', key: 'ctrl+k' }]);
  const conflicts = m.registry.detectConflicts();
  assert.equal(conflicts.length, 1);
  const action = m.processChord(chord(m, 'ctrl+k'));
  assert.equal(action.type, 'fire');
  assert.equal(action.command, 'go.tab.terminal');
  assert.deepEqual(action.overridden, ['palette.toggle']);
});

test('unbound command never fires', () => {
  const m = makeManager();
  const fired = m.simulateForTest(['ctrl+shift+t']);
  assert.deepEqual(fired, []);
});

test('setSequenceTimeout clamps and persists', () => {
  const m = makeManager();
  assert.equal(m.setSequenceTimeout(50), 200);
  assert.equal(m.setSequenceTimeout(99999), 5000);
  assert.equal(m.setSequenceTimeout(1500), 1500);
});

test('singleton reset seam works', async () => {
  resetKeybindingManagerForTests();
  const { getKeybindingManager } = await import('../../src/keybinding/manager.ts');
  const a = getKeybindingManager();
  const b = getKeybindingManager();
  assert.equal(a, b);
  resetKeybindingManagerForTests();
});

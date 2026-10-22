/**
 * Keybinding parse tests (round-5 R5-S1).
 * Run: npm run build -w @ai-factory/keybinding && node --test packages/keybinding/dist/tests/*.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseKeybinding,
  canonicalSequence,
  chordFromEvent,
  KeybindingParseError,
} from '../src/index.js';

test('single chord with modifiers', () => {
  const seq = parseKeybinding('ctrl+shift+p', 'linux');
  assert.equal(seq.length, 1);
  assert.deepEqual(seq[0], { ctrl: true, meta: false, alt: false, shift: true, key: 'P' });
});

test('letters normalize to uppercase; mod resolves per platform', () => {
  assert.equal(parseKeybinding('ctrl+k', 'linux')[0].key, 'K');
  assert.equal(parseKeybinding('ctrl+k', 'linux')[0].ctrl, true);
  assert.equal(parseKeybinding('mod+k', 'mac')[0].meta, true);
  assert.equal(parseKeybinding('mod+k', 'mac')[0].ctrl, false);
  assert.equal(parseKeybinding('mod+k', 'windows')[0].ctrl, true);
  assert.equal(parseKeybinding('mod+k', 'windows')[0].meta, false);
});

test('modifier aliases', () => {
  assert.equal(parseKeybinding('cmd+k', 'linux')[0].meta, true);
  assert.equal(parseKeybinding('option+x', 'mac')[0].alt, true);
  assert.equal(parseKeybinding('control+y', 'linux')[0].ctrl, true);
});

test('named keys', () => {
  assert.equal(parseKeybinding('esc', 'linux')[0].key, 'Escape');
  assert.equal(parseKeybinding('ctrl+del', 'linux')[0].key, 'Delete');
  assert.equal(parseKeybinding('alt+f4', 'windows')[0].key, 'F4');
  assert.equal(parseKeybinding('shift+space', 'linux')[0].key, ' ');
});

test('multi-chord sequences', () => {
  const seq = parseKeybinding('ctrl+k ctrl+c', 'linux');
  assert.equal(seq.length, 2);
  assert.equal(canonicalSequence(seq), 'ctrl+K ctrl+C');
});

test('fail-closed: unknown modifier', () => {
  assert.throws(() => parseKeybinding('hyper+k', 'linux'), KeybindingParseError);
});

test('fail-closed: unknown key', () => {
  assert.throws(() => parseKeybinding('ctrl+frobnicator', 'linux'), KeybindingParseError);
});

test('fail-closed: empty and malformed', () => {
  assert.throws(() => parseKeybinding('', 'linux'), KeybindingParseError);
  assert.throws(() => parseKeybinding('   ', 'linux'), KeybindingParseError);
  assert.throws(() => parseKeybinding('ctrl++k', 'linux'), KeybindingParseError);
  assert.throws(() => parseKeybinding('ctrl+k ctrl+c ctrl+x ctrl+v ctrl+z', 'linux'), KeybindingParseError);
});

test('fail-closed: modifier in key position is still an error', () => {
  // 'ctrl' alone has no key part — the last segment is treated as the key
  // and 'ctrl' is not a key name, so this must fail rather than guess.
  assert.throws(() => parseKeybinding('ctrl', 'linux'), KeybindingParseError);
});

test('chordFromEvent normalizes DOM events', () => {
  const chord = chordFromEvent({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: 'k' });
  assert.deepEqual(chord, { ctrl: true, meta: false, alt: false, shift: false, key: 'K' });
  const esc = chordFromEvent({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: 'Escape' });
  assert.equal(esc.key, 'Escape');
});

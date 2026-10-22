/**
 * Platform handling for the keybinding system (round-5 R5-S1).
 *
 * The registry is constructed with an explicit platform so behavior is
 * deterministic and testable; the desktop passes the real platform, the
 * server never formats keys (it has no keyboard context).
 */
import type { KeybindingPlatform, KeyChord, KeySequence } from './types.js';

/** Map node process.platform to a keybinding platform. */
export function platformFromNode(platform?: string): KeybindingPlatform {
  const p = platform ?? (typeof process !== 'undefined' ? process.platform : '');
  if (p === 'darwin') return 'mac';
  if (p === 'win32') return 'windows';
  return 'linux';
}

const MAC_KEY_GLYPHS: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Escape: '⎋',
  Enter: '⏎',
  Backspace: '⌫',
  Delete: '⌦',
  Tab: '⇥',
};

function displayKey(key: string, platform: KeybindingPlatform): string {
  if (platform === 'mac') return MAC_KEY_GLYPHS[key] ?? key;
  return key === ' ' ? 'Space' : key;
}

/** Human-readable rendering of one chord, e.g. '⌘K' or 'Ctrl+Shift+P'. */
export function formatChord(chord: KeyChord, platform: KeybindingPlatform): string {
  const key = displayKey(chord.key, platform);
  if (platform === 'mac') {
    let out = '';
    if (chord.ctrl) out += '⌃';
    if (chord.alt) out += '⌥';
    if (chord.shift) out += '⇧';
    if (chord.meta) out += '⌘';
    return out + key;
  }
  const parts: string[] = [];
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  if (chord.meta) parts.push('Meta');
  parts.push(key);
  return parts.join('+');
}

/** Human-readable rendering of a sequence, e.g. '⌘K ⌘C' / 'Ctrl+K Ctrl+C'. */
export function formatSequence(seq: KeySequence, platform: KeybindingPlatform): string {
  return seq.map((c) => formatChord(c, platform)).join(' ');
}

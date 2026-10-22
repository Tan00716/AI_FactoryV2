/**
 * Keybinding string parsing (round-5 R5-S1). Pure, zero-dependency.
 *
 * Grammar: `<chord>( <chord>)*`, chord = `<part>(+<part>)*` where each part
 * is a modifier alias or a key name. Examples: 'ctrl+k', 'mod+shift+p',
 * 'ctrl+k ctrl+c'. The platform primary alias 'mod' resolves to Cmd on mac
 * and Ctrl elsewhere — the caller passes the platform so one config file
 * works cross-platform.
 *
 * Fail-closed: anything unparseable throws KeybindingParseError naming the
 * offending input; nothing is guessed.
 */
import type { KeyChord, KeySequence, KeybindingPlatform } from './types.js';

const MOD_ALIASES: Record<string, 'ctrl' | 'meta' | 'alt' | 'shift' | 'mod'> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  win: 'meta',
  windows: 'meta',
  super: 'meta',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  mod: 'mod',
};

/** Named keys: alias -> canonical name. */
const NAMED_KEYS: Record<string, string> = {
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: ' ',
  spacebar: ' ',
  enter: 'Enter',
  return: 'Enter',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  ins: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  plus: '+',
  minus: '-',
  comma: ',',
  period: '.',
  slash: '/',
  backslash: '\\',
  semicolon: ';',
  quote: "'",
  bracketleft: '[',
  bracketright: ']',
  backquote: '`',
};

for (let i = 1; i <= 24; i++) NAMED_KEYS[`f${i}`] = `F${i}`;

export class KeybindingParseError extends Error {
  readonly input: string;
  constructor(input: string, reason: string) {
    super(`invalid keybinding ${JSON.stringify(input)}: ${reason}`);
    this.name = 'KeybindingParseError';
    this.input = input;
  }
}

function normalizeKey(raw: string, input: string): string {
  const lower = raw.toLowerCase();
  const named = NAMED_KEYS[lower];
  if (named !== undefined) return named;
  if (raw.length === 1) {
    // Letters normalize to uppercase so 'ctrl+k' and 'ctrl+K' are one binding.
    return /^[a-zA-Z]$/.test(raw) ? raw.toUpperCase() : raw;
  }
  throw new KeybindingParseError(input, `unknown key ${JSON.stringify(raw)}`);
}

/**
 * Parse one keybinding string into a normalized chord sequence.
 * Throws KeybindingParseError on any malformed input (fail-closed).
 */
export function parseKeybinding(input: string, platform: KeybindingPlatform): KeySequence {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new KeybindingParseError(String(input), 'empty keybinding');
  }
  const chords: KeySequence = [];
  for (const chordText of input.trim().split(/\s+/)) {
    const parts = chordText.split('+');
    if (parts.some((p) => p === '')) {
      throw new KeybindingParseError(input, `empty part in chord ${JSON.stringify(chordText)}`);
    }
    let ctrl = false;
    let meta = false;
    let alt = false;
    let shift = false;
    // All but the last part must be modifiers; the last part is the key.
    for (let i = 0; i < parts.length - 1; i++) {
      const mod = MOD_ALIASES[parts[i].toLowerCase()];
      if (mod === undefined) {
        throw new KeybindingParseError(input, `unknown modifier ${JSON.stringify(parts[i])}`);
      }
      if (mod === 'ctrl') ctrl = true;
      else if (mod === 'meta') meta = true;
      else if (mod === 'alt') alt = true;
      else if (mod === 'shift') shift = true;
      else {
        // 'mod': platform primary.
        if (platform === 'mac') meta = true;
        else ctrl = true;
      }
    }
    const key = normalizeKey(parts[parts.length - 1], input);
    chords.push({ ctrl, meta, alt, shift, key });
  }
  if (chords.length > 4) {
    throw new KeybindingParseError(input, 'at most 4 chords per sequence are supported');
  }
  return chords;
}

/** Canonical string for one chord: fixed modifier order, then key. */
export function canonicalChord(chord: KeyChord): string {
  const mods: string[] = [];
  if (chord.ctrl) mods.push('ctrl');
  if (chord.meta) mods.push('meta');
  if (chord.alt) mods.push('alt');
  if (chord.shift) mods.push('shift');
  return [...mods, chord.key].join('+');
}

/** Canonical string for a sequence; the equality key for conflicts. */
export function canonicalSequence(seq: KeySequence): string {
  return seq.map(canonicalChord).join(' ');
}

/** Chord equality on normalized fields. */
export function chordEquals(a: KeyChord, b: KeyChord): boolean {
  return (
    a.ctrl === b.ctrl &&
    a.meta === b.meta &&
    a.alt === b.alt &&
    a.shift === b.shift &&
    a.key === b.key
  );
}

/** Build a chord from a DOM KeyboardEvent's modifier state + key. */
export function chordFromEvent(e: {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
}): KeyChord {
  let key = e.key;
  if (key.length === 1 && /^[a-zA-Z]$/.test(key)) key = key.toUpperCase();
  else {
    // Normalize the common DOM key names to our canonical set.
    const lower = key.toLowerCase();
    const named = NAMED_KEYS[lower];
    if (named !== undefined) key = named;
  }
  return { ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey, key };
}

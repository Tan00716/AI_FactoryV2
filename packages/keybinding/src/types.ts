/**
 * Keybinding system types (round-5 R5-S1). Pure types, no runtime.
 *
 * The package is UI-agnostic and model-free: it parses keybinding strings,
 * normalizes them per platform, merges default + user (keybindings.json)
 * layers, detects conflicts, and answers which-key prefix queries. The
 * desktop owns keyboard events; the server only stores/validates the user
 * layer (it has no keyboard context — see routes/keybinding.ts).
 */

/** Target platform for key normalization and display. */
export type KeybindingPlatform = 'mac' | 'windows' | 'linux';

/**
 * A single normalized chord: modifiers + one key. `mod` is the platform
 * primary modifier (Cmd on mac, Ctrl elsewhere) as written in config
 * strings; it is resolved to ctrl/meta at parse time for a given platform.
 */
export interface KeyChord {
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  /** Normalized key: single uppercase char, or a named key like 'Escape'. */
  key: string;
}

/** A keybinding sequence: one or more chords pressed in order. */
export type KeySequence = KeyChord[];

/** Where a command binding came from. */
export type CommandSource = 'builtin' | 'plugin' | 'user';

/** A command that can carry default keybindings. */
export interface CommandRegistration {
  id: string;
  /** English fallback title; the desktop renders keybinding.cmd.<id> when present. */
  title: string;
  /** Default keybinding strings, e.g. ['mod+k', 'ctrl+shift+p']. */
  defaultKeys?: string[];
  source?: CommandSource;
}

/**
 * One user-layer keybindings.json entry. `key: null` (or a command id
 * starting with '-') unbinds every binding of that command.
 */
export interface UserKeybinding {
  command: string;
  key: string | null;
  when?: string;
}

/** A command with its merged bindings, ready for display/dispatch. */
export interface EffectiveBinding {
  command: string;
  title: string;
  source: CommandSource;
  /** Normalized sequences from defaults and/or the user layer. */
  sequences: KeySequence[];
  /** Where the sequences came from. */
  bindingSource: 'default' | 'user' | 'mixed' | 'unbound';
  /** Human display strings for the registry's platform. */
  display: string[];
}

/** Two or more commands sharing one normalized sequence. */
export interface BindingConflict {
  /** Display of the colliding sequence for the registry's platform. */
  sequence: string;
  commands: Array<{ id: string; title: string; source: string }>;
}

/** One fail-closed validation problem in a keybindings.json entry. */
export interface ValidationIssue {
  index: number;
  message: string;
}

/** Result of dispatching a completed sequence. */
export interface SequenceResolution {
  command: string;
  title: string;
  /** Command ids shadowed by the winner (later binding wins, never silent). */
  overridden: string[];
}

/** A which-key candidate: one possible next chord after a prefix. */
export interface PrefixCandidate {
  next: KeyChord;
  /** Display of the single next chord for the registry's platform. */
  display: string;
  commands: Array<{ id: string; title: string }>;
}

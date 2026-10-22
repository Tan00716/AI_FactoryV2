/**
 * @ai-factory/keybinding — global keybinding system core (round-5 R5-S1).
 * Pure, zero-dependency: key parsing, platform normalization, command
 * registry with default+user layers, conflict detection, which-key prefix
 * queries. The desktop owns keyboard events; the server only stores and
 * validates the user layer (keybindings.json).
 */
export type {
  BindingConflict,
  CommandRegistration,
  CommandSource,
  EffectiveBinding,
  KeybindingPlatform,
  KeyChord,
  KeySequence,
  PrefixCandidate,
  SequenceResolution,
  UserKeybinding,
  ValidationIssue,
} from './types.js';
export {
  parseKeybinding,
  canonicalChord,
  canonicalSequence,
  chordEquals,
  chordFromEvent,
  KeybindingParseError,
} from './parse.js';
export { platformFromNode, formatChord, formatSequence } from './platform.js';
export { KeybindingRegistry, validateUserKeybindings } from './registry.js';

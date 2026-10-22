/**
 * Keybinding manager for the desktop (round-5 R5-S1). React-free so
 * node:test can import it directly (same reason as utils/cmdk.ts).
 *
 * Owns a KeybindingRegistry, listens to window keydown in the capture phase,
 * matches chord sequences with a configurable timeout, and dispatches
 * commands as 'ai-factory:command' CustomEvents (decoupled: panels listen
 * for the ids they own).
 *
 * Sequence semantics (VS Code-like, documented in the settings UI):
 * - An exact match with no longer continuation fires immediately.
 * - A chord that is a proper prefix of a longer binding opens the which-key
 *   popup and waits for the next chord.
 * - A chord that is BOTH an exact match and a prefix waits: if the next
 *   chord completes a longer sequence it wins, otherwise the shorter exact
 *   match fires when the timeout elapses.
 * - Typing in inputs/textareas/contentEditable is never stolen: unmodified
 *   chords there are ignored.
 */
import {
  KeybindingRegistry,
  chordFromEvent,
  chordEquals,
  canonicalSequence,
  formatSequence,
  parseKeybinding,
} from '@ai-factory/keybinding';
import type {
  KeybindingPlatform,
  KeyChord,
  KeySequence,
  PrefixCandidate,
} from '@ai-factory/keybinding';

export interface WhichKeyState {
  prefix: KeySequence;
  prefixDisplay: string;
  candidates: PrefixCandidate[];
  /** Exact-match command that fires if the timeout elapses (chord is both). */
  timeoutCommand: string | null;
}

export type WhichKeyListener = (state: WhichKeyState | null) => void;

export const SEQUENCE_TIMEOUT_KEY = 'keybinding.sequenceTimeoutMs';
export const DEFAULT_SEQUENCE_TIMEOUT_MS = 1000;
const MIN_TIMEOUT_MS = 200;
const MAX_TIMEOUT_MS = 5000;

export const COMMAND_EVENT = 'ai-factory:command';

export function detectDesktopPlatform(): KeybindingPlatform {
  if (typeof navigator === 'undefined') return 'linux';
  const ua = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const p = ua?.platform ?? navigator.platform ?? '';
  if (/mac/i.test(p)) return 'mac';
  if (/win/i.test(p)) return 'windows';
  return 'linux';
}

export type ChordAction =
  | { type: 'fire'; command: string; title: string; overridden: string[] }
  | { type: 'pending'; state: WhichKeyState }
  | { type: 'none'; hadPending: boolean };

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!(el as HTMLElement).isContentEditable;
}

export class KeybindingManager {
  readonly registry: KeybindingRegistry;
  readonly platform: KeybindingPlatform;
  sequenceTimeoutMs: number;
  /** Set once by the host so StrictMode-style double effects don't double-register. */
  builtinsRegistered = false;

  private pending: KeySequence = [];
  private pendingTimeoutCommand: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<WhichKeyListener>();
  private attached = false;
  private readonly onKey = (e: KeyboardEvent) => this.handleKey(e);

  constructor(platform?: KeybindingPlatform) {
    this.platform = platform ?? detectDesktopPlatform();
    this.registry = new KeybindingRegistry(this.platform);
    let saved = NaN;
    try {
      saved = Number(localStorage.getItem(SEQUENCE_TIMEOUT_KEY));
    } catch {
      /* storage unavailable: keep default */
    }
    this.sequenceTimeoutMs =
      Number.isFinite(saved) && saved >= MIN_TIMEOUT_MS && saved <= MAX_TIMEOUT_MS
        ? Math.round(saved)
        : DEFAULT_SEQUENCE_TIMEOUT_MS;
  }

  setSequenceTimeout(ms: number): number {
    const clamped = Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.round(ms) || DEFAULT_SEQUENCE_TIMEOUT_MS));
    this.sequenceTimeoutMs = clamped;
    try {
      localStorage.setItem(SEQUENCE_TIMEOUT_KEY, String(clamped));
    } catch {
      /* ignore */
    }
    return clamped;
  }

  subscribe(fn: WhichKeyListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(state: WhichKeyState | null): void {
    for (const fn of this.listeners) fn(state);
  }

  attach(): void {
    if (this.attached || typeof window === 'undefined') return;
    this.attached = true;
    window.addEventListener('keydown', this.onKey, true);
  }

  detach(): void {
    if (!this.attached || typeof window === 'undefined') return;
    this.attached = false;
    window.removeEventListener('keydown', this.onKey, true);
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private armTimer(): void {
    this.clearTimer();
    const fireOnTimeout = this.pendingTimeoutCommand;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pending = [];
      this.pendingTimeoutCommand = null;
      this.emit(null);
      if (fireOnTimeout) this.dispatch(fireOnTimeout);
    }, this.sequenceTimeoutMs);
  }

  /** Dispatch a command id to whoever listens (panels own their ids). */
  dispatch(commandId: string): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail: { commandId } }));
  }

  /**
   * Pure core of the state machine (no DOM): feed one chord, get the action.
   * The DOM handler wraps this with preventDefault/popup/timer side effects.
   */
  processChord(chord: KeyChord): ChordAction {
    const candidate: KeySequence = [...this.pending, chord];
    const resolution = this.registry.resolveSequence(candidate);
    const candidates = this.registry.prefixCandidates(candidate);
    if (candidates.length === 0) {
      if (resolution) {
        this.pending = [];
        this.pendingTimeoutCommand = null;
        return { type: 'fire', command: resolution.command, title: resolution.title, overridden: resolution.overridden };
      }
      const hadPending = this.pending.length > 0;
      this.pending = [];
      this.pendingTimeoutCommand = null;
      return { type: 'none', hadPending };
    }
    // Proper prefix (maybe also an exact match): wait for the next chord.
    this.pending = candidate;
    this.pendingTimeoutCommand = resolution ? resolution.command : null;
    const state: WhichKeyState = {
      prefix: candidate,
      prefixDisplay: formatSequence(candidate, this.platform),
      candidates,
      timeoutCommand: this.pendingTimeoutCommand,
    };
    return { type: 'pending', state };
  }

  private handleKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.isComposing) return;
    const chord = chordFromEvent(e);
    const unmodified = !chord.ctrl && !chord.meta && !chord.alt;
    if (unmodified && isEditableTarget(e.target)) return; // never steal typing
    const action = this.processChord(chord);
    if (action.type === 'fire') {
      e.preventDefault();
      e.stopPropagation();
      this.clearTimer();
      this.emit(null);
      this.dispatch(action.command);
    } else if (action.type === 'pending') {
      e.preventDefault();
      e.stopPropagation();
      this.emit(action.state);
      this.armTimer();
    } else if (action.hadPending) {
      // A chord that matches nothing while a prefix was pending: swallow it
      // so the half-typed sequence does not leak into the focused control.
      e.preventDefault();
      e.stopPropagation();
      this.clearTimer();
      this.emit(null);
    }
    // 'none' with no pending: let the key through untouched.
  }

  /** Test seam: feed keybinding strings as if typed, collect fired commands. */
  simulateForTest(keyStrings: string[]): string[] {
    const fired: string[] = [];
    const origDispatch = this.dispatch.bind(this);
    (this as { dispatch: (id: string) => void }).dispatch = (id: string) => {
      fired.push(id);
    };
    try {
      for (const k of keyStrings) {
        for (const chord of parseKeybinding(k, this.platform)) {
          const action = this.processChord(chord);
          if (action.type === 'fire') this.dispatch(action.command);
        }
      }
      // Flush: emulate the timeout elapsing.
      if (this.pendingTimeoutCommand) {
        const cmd = this.pendingTimeoutCommand;
        this.pending = [];
        this.pendingTimeoutCommand = null;
        this.emit(null);
        this.dispatch(cmd);
      } else if (this.pending.length > 0) {
        this.pending = [];
        this.emit(null);
      }
    } finally {
      (this as { dispatch: (id: string) => void }).dispatch = origDispatch;
    }
    void origDispatch;
    return fired;
  }

  /** Parse helper re-exported for the settings capture UI. */
  parseKeys(s: string): KeySequence {
    return parseKeybinding(s, this.platform);
  }

  chordDisplay(chord: KeyChord): string {
    return formatSequence([chord], this.platform);
  }

  sequenceDisplay(seq: KeySequence): string {
    return formatSequence(seq, this.platform);
  }
}

let instance: KeybindingManager | null = null;
/** Module singleton used by the host + settings panel. */
export function getKeybindingManager(): KeybindingManager {
  if (!instance) instance = new KeybindingManager();
  return instance;
}

/** Test seam: drop the singleton between tests. */
export function resetKeybindingManagerForTests(): void {
  if (instance) instance.detach();
  instance = null;
}

export { chordEquals, canonicalSequence };

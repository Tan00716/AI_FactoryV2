/**
 * CommandTracker (R4-A8) — turns the shell's OSC 133 marker stream into
 * per-command records {command, exitCode, at}.
 *
 * The shell (see markers.ts generateBashIntegrationRc) reports its own
 * command lines, so the tracker NEVER sniffs input bytes: no readline
 * editing emulation, no tab-completion guessing, no paste handling.
 * A command is recorded only when the tracker saw, in order:
 *   B (input started) → C (execution started) → D;<code> (exit) → H;<line>
 * H carries the exact typed line (`fc -ln -1`, base64). When H is empty
 * (the shell's history did not advance, e.g. HISTCONTROL=ignorespace),
 * the tracker falls back to joining the E payloads (BASH_COMMAND per
 * simple command) with newlines — an honest approximation.
 *
 * Aborted lines (Ctrl+C at the prompt, empty Enter) produce D without
 * a preceding C and are discarded, never recorded.
 */
import { findMarkers } from './markers.js';

export interface TrackedCommand {
  command: string;
  exitCode: number;
  at: number;
}

export type TrackerState = 'idle' | 'prompt' | 'input' | 'executing';

export interface CommandTrackerOptions {
  now?: () => number;
  /** In-memory per-session command cap. Default 500. */
  maxCommands?: number;
}

/** Fail-safe: drop the marker buffer past this size and reset. */
const OUT_BUF_CAP = 256 * 1024;

function b64ToText(b64: string): string | null {
  if (!b64) return null;
  try {
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export class CommandTracker {
  private state: TrackerState = 'idle';
  private outBuf = '';
  private sawExec = false;
  private eParts: string[] = [];
  private pendingExit: number | null = null;
  private commands: TrackedCommand[] = [];
  private listeners = new Set<(c: TrackedCommand) => void>();
  private readonly now: () => number;
  private readonly maxCommands: number;

  constructor(opts: CommandTrackerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxCommands = Math.max(1, Math.floor(opts.maxCommands ?? 500));
  }

  onCommand(cb: (c: TrackedCommand) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Current protocol state (for tests/debugging). */
  getState(): TrackerState {
    return this.state;
  }

  /** Commands recorded for this session, oldest first. */
  getCommands(): TrackedCommand[] {
    return [...this.commands];
  }

  /**
   * Feed raw pty output. Complete markers are handled in order; a
   * marker split across chunks is held until its terminator arrives
   * (the marker regex requires the ST/BEL terminator).
   */
  feedOutput(chunk: string): void {
    if (!chunk) return;
    this.outBuf += chunk;
    if (this.outBuf.length > OUT_BUF_CAP) {
      // Pathological: a single marker bigger than the cap, or a shell
      // that never emits markers. Drop and reset rather than grow.
      this.outBuf = '';
      this.resetCycle();
      this.state = 'idle';
      return;
    }
    let handledEnd = 0;
    for (const m of findMarkers(this.outBuf)) {
      this.handleMarker(m.kind, m.payload);
      handledEnd = m.index + m.length;
    }
    this.outBuf = this.outBuf.slice(handledEnd);
  }

  private resetCycle(): void {
    this.sawExec = false;
    this.eParts = [];
    this.pendingExit = null;
  }

  private handleMarker(kind: string, payload: string): void {
    switch (kind) {
      case 'A':
        this.resetCycle();
        this.state = 'prompt';
        break;
      case 'B':
        if (this.state === 'prompt') this.state = 'input';
        break;
      case 'C':
        // First C per cycle wins; the DEBUG trap fires per simple
        // command, so lists/loops emit several.
        if (this.state === 'input' && !this.sawExec) {
          this.sawExec = true;
          this.state = 'executing';
        }
        break;
      case 'D': {
        const code = /^\d+$/.test(payload) ? parseInt(payload, 10) : NaN;
        if (this.sawExec && Number.isFinite(code)) {
          this.pendingExit = code;
          // stay in 'executing' until H arrives
        } else {
          // D without a preceding C: startup, empty line, or an
          // aborted (Ctrl+C) line — nothing to record.
          this.resetCycle();
          this.state = 'prompt';
        }
        break;
      }
      case 'E': {
        if (this.sawExec) {
          const text = b64ToText(payload);
          if (text !== null) this.eParts.push(text);
        }
        break;
      }
      case 'H': {
        if (this.sawExec && this.pendingExit !== null) {
          let cmd = b64ToText(payload) ?? '';
          if (!cmd) cmd = this.eParts.join('\n'); // history stalled: fallback
          if (cmd) this.emit({ command: cmd, exitCode: this.pendingExit, at: this.now() });
        }
        this.resetCycle();
        this.state = 'prompt';
        break;
      }
      default:
        break;
    }
  }

  private emit(cmd: TrackedCommand): void {
    this.commands.push(cmd);
    if (this.commands.length > this.maxCommands) {
      this.commands.splice(0, this.commands.length - this.maxCommands);
    }
    for (const cb of this.listeners) {
      try {
        cb(cmd);
      } catch {
        /* listener errors must not break tracking */
      }
    }
  }
}

/**
 * Debounce + coalesce engine (R6-S3). Pure logic: no filesystem access,
 * no execution. The route feeds it file events (already glob-filtered by
 * the caller, or filtered here — the engine filters by rule globs itself
 * so a single event fan-outs to every matching rule) and the engine
 * fires one WatchFire per rule per debounce window.
 *
 * Guarantees:
 *  - One save = one fire: events inside the window reset the timer and
 *    merge into the pending set (deduplicated paths).
 *  - Burst: more than BURST_FILE_THRESHOLD distinct paths in one window
 *    (e.g. a git checkout) fires once with burst=true and the full list.
 *  - dispose() clears every pending timer — no zombie fires after stop.
 */
import { matchGlobs } from './glob';
import { BURST_FILE_THRESHOLD, type WatchChangeKind, type WatchFire, type WatchRule } from './types';

export interface TimerFns {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

export interface EngineOptions {
  timers?: TimerFns;
  /** Called once per fire. May be async; the engine does not await it. */
  onFire: (fire: WatchFire) => void;
}

interface Pending {
  files: Map<string, WatchChangeKind>;
  timer: unknown;
}

export class WatchEngine {
  private readonly timers: TimerFns;
  private readonly onFire: (fire: WatchFire) => void;
  private readonly rules = new Map<string, WatchRule>();
  private readonly pending = new Map<string, Pending>();
  private disposed = false;

  constructor(opts: EngineOptions) {
    this.timers =
      opts.timers ??
      {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        // Node's clearTimeout accepts Timeout|string|number; the engine
        // only ever stores ids it got from the paired setTimeout.
        clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      };
    this.onFire = opts.onFire;
  }

  addRule(rule: WatchRule): void {
    this.rules.set(rule.id, rule);
  }

  removeRule(ruleId: string): void {
    this.rules.delete(ruleId);
    this.clearPending(ruleId);
  }

  setRule(rule: WatchRule): void {
    this.rules.set(rule.id, rule);
  }

  /** Feed one filesystem event (project-root-relative posix path). */
  handleChange(relPath: string, kind: WatchChangeKind): void {
    if (this.disposed) return;
    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;
      if (!matchGlobs(rule.globs, relPath)) continue;
      let p = this.pending.get(rule.id);
      if (!p) {
        p = { files: new Map(), timer: null };
        this.pending.set(rule.id, p);
      }
      p.files.set(relPath, kind);
      if (p.timer !== null) this.timers.clearTimeout(p.timer);
      const captured = p;
      p.timer = this.timers.setTimeout(() => {
        this.pending.delete(rule.id);
        const files = [...captured.files.keys()].sort();
        this.onFire({
          rule,
          files,
          burst: files.length > BURST_FILE_THRESHOLD,
          firedAt: new Date().toISOString(),
        });
      }, rule.debounceMs);
    }
  }

  /** How many rules currently have a pending (debouncing) fire. */
  pendingCount(): number {
    return this.pending.size;
  }

  ruleCount(): number {
    return this.rules.size;
  }

  private clearPending(ruleId: string): void {
    const p = this.pending.get(ruleId);
    if (p && p.timer !== null) this.timers.clearTimeout(p.timer);
    this.pending.delete(ruleId);
  }

  dispose(): void {
    this.disposed = true;
    for (const ruleId of [...this.pending.keys()]) this.clearPending(ruleId);
    this.rules.clear();
  }
}

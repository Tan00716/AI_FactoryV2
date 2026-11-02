/**
 * File-backed run-history store: atomic tmp+rename writes, fail-closed
 * corrupt handling, retention pruning, and explicit clear.
 *
 * Mirrors the packages/dbbrowser QueryHistory discipline: missing file
 * means empty history; a corrupt file throws and is never overwritten;
 * clear() is the only path that removes a corrupt file, and it is an
 * explicit operator action (audited by the route, never here).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { redactText } from '@ai-factory/diagpack';
import {
  RUN_HISTORY_MAX_ENTRIES,
  RUN_HISTORY_RETENTION_MS,
  RunHistoryCorruptError,
  type RunHistoryMeta,
  type RunHistoryMetaInput,
  type RunStepCounts,
} from './types.ts';

function isCounts(v: unknown): v is RunStepCounts {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return ['ok', 'failed', 'denied', 'timeout', 'skipped', 'superseded'].every(
    (k) => typeof c[k] === 'number' && Number.isFinite(c[k]) && (c[k] as number) >= 0,
  );
}

function isMeta(v: unknown): v is RunHistoryMeta {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e['id'] === 'string' &&
    typeof e['label'] === 'string' &&
    typeof e['ok'] === 'boolean' &&
    typeof e['startedAt'] === 'string' &&
    typeof e['finishedAt'] === 'string' &&
    typeof e['durationMs'] === 'number' &&
    Number.isFinite(e['durationMs']) &&
    typeof e['taskCount'] === 'number' &&
    Number.isFinite(e['taskCount']) &&
    isCounts(e['counts']) &&
    (e['coverage'] === 'full' || e['coverage'] === 'partial') &&
    (e['rerunOf'] === undefined || typeof e['rerunOf'] === 'string') &&
    (e['rerunFrom'] === undefined || typeof e['rerunFrom'] === 'string')
  );
}

export class RunHistory {
  private entries: RunHistoryMeta[] = [];
  private loaded = false;
  /** Once set, no record/save may touch the file (fail-closed). */
  private broken = false;
  /** Stat of the file as last read/written; a change forces a re-read. */
  private lastStat: { mtimeMs: number; size: number } | null = null;
  private lastExists = false;
  private readonly filePath: string | null;
  private readonly maxEntries: number;
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(opts?: {
    filePath?: string | null;
    maxEntries?: number;
    retentionMs?: number;
    now?: () => number;
  }) {
    this.filePath = opts?.filePath ?? null;
    this.maxEntries = opts?.maxEntries ?? RUN_HISTORY_MAX_ENTRIES;
    this.retentionMs = opts?.retentionMs ?? RUN_HISTORY_RETENTION_MS;
    this.now = opts?.now ?? Date.now;
  }

  /** True when a previous load found the file corrupt. */
  get corrupt(): boolean {
    return this.broken;
  }

  /**
   * Load from disk; missing file = empty history, corrupt = throw.
   * Re-reads when the file changed under us (external edit or
   * corruption mid-process), so a stale cache can never mask a
   * corrupt file. Once broken, only clear() recovers (fail-closed).
   */
  load(): void {
    if (this.broken) {
      throw new RunHistoryCorruptError(`run history file is corrupt: ${this.filePath}`);
    }
    if (this.loaded) {
      if (!this.filePath) return;
      let st: { mtimeMs: number; size: number } | null = null;
      try {
        const s = statSync(this.filePath);
        st = { mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        st = null;
      }
      if (st === null && !this.lastExists) return;
      if (
        st !== null &&
        this.lastStat !== null &&
        st.mtimeMs === this.lastStat.mtimeMs &&
        st.size === this.lastStat.size
      ) {
        return;
      }
      // Changed or deleted: fall through and re-read below.
    }
    this.loaded = true;
    if (!this.filePath || !existsSync(this.filePath)) {
      this.entries = [];
      this.lastStat = null;
      this.lastExists = false;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch {
      this.broken = true;
      throw new RunHistoryCorruptError(`run history file is not valid JSON: ${this.filePath}`);
    }
    if (!Array.isArray(parsed) || !parsed.every(isMeta)) {
      this.broken = true;
      throw new RunHistoryCorruptError(`run history file has an unexpected shape: ${this.filePath}`);
    }
    this.entries = parsed.slice(-this.maxEntries);
    try {
      const s = statSync(this.filePath);
      this.lastStat = { mtimeMs: s.mtimeMs, size: s.size };
      this.lastExists = true;
    } catch {
      this.lastStat = null;
      this.lastExists = false;
    }
    this.prune();
  }

  /** Entries newest last; callers reverse for newest-first display. */
  list(): RunHistoryMeta[] {
    return [...this.entries];
  }

  /** Append one run's metadata (label/rerunFrom redacted first). */
  record(input: RunHistoryMetaInput): RunHistoryMeta {
    this.load();
    const meta: RunHistoryMeta = {
      ...input,
      label: redactText(input.label),
      ...(input.rerunFrom !== undefined ? { rerunFrom: redactText(input.rerunFrom) } : {}),
    };
    this.entries.push(meta);
    this.prune();
    while (this.entries.length > this.maxEntries) this.entries.shift();
    this.save();
    return meta;
  }

  /**
   * Remove all persisted history, including a corrupt file.
   * Returns the entry count removed, or null when the file was corrupt
   * and its count was unknowable.
   */
  clear(): number | null {
    const count = this.broken ? null : this.entries.length;
    this.entries = [];
    this.loaded = true;
    this.broken = false;
    this.lastStat = null;
    this.lastExists = false;
    if (this.filePath && existsSync(this.filePath)) unlinkSync(this.filePath);
    return count;
  }

  private prune(): void {
    const cutoff = this.now() - this.retentionMs;
    this.entries = this.entries.filter((e) => {
      const t = Date.parse(e.finishedAt);
      return Number.isFinite(t) && t >= cutoff;
    });
  }

  private save(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.entries), 'utf8');
    renameSync(tmp, this.filePath);
    try {
      const s = statSync(this.filePath);
      this.lastStat = { mtimeMs: s.mtimeMs, size: s.size };
      this.lastExists = true;
    } catch {
      this.lastStat = null;
      this.lastExists = false;
    }
  }
}

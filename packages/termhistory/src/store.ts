/**
 * HistoryStore (R4-A8) — persistent, cross-session command history.
 *
 * Storage: <dataDir>/terminal-history/history.jsonl (JSON lines, NOT
 * the repo — the server resolves the user data dir). Append-only with
 * periodic compaction; consecutive duplicates are skipped; corrupt
 * lines are ignored on load; oversized single entries are refused.
 *
 * Search is fuzzy (fuzzy.ts), most-recent-first on ties; an empty
 * query returns the most recent entries.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fuzzyScore } from './fuzzy.js';

export interface HistoryEntry {
  id: string;
  sessionId: string;
  principal: string;
  command: string;
  exitCode: number;
  at: number;
}

export interface NewHistoryEntry {
  sessionId: string;
  principal: string;
  command: string;
  exitCode: number;
  at?: number;
}

export interface HistoryStoreOptions {
  /** Max entries kept (compaction keeps the tail). Default 5000. */
  maxEntries?: number;
  now?: () => number;
}

/** Refuse single entries bigger than this (pathological pastes). */
const MAX_ENTRY_BYTES = 64 * 1024;
/** Refuse to load absurd files (fail-safe, start fresh). */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

export class HistoryStore {
  private readonly file: string;
  private entries: HistoryEntry[] = [];
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(dir: string, opts: HistoryStoreOptions = {}) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'history.jsonl');
    this.maxEntries = Math.max(1, Math.floor(opts.maxEntries ?? 5000));
    this.now = opts.now ?? Date.now;
    this.load();
  }

  /** Absolute path of the JSONL file (for smoke tests). */
  get path(): string {
    return this.file;
  }

  get count(): number {
    return this.entries.length;
  }

  private load(): void {
    this.entries = [];
    try {
      if (!existsSync(this.file)) return;
      if (statSync(this.file).size > MAX_FILE_BYTES) return;
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as Partial<HistoryEntry>;
          if (typeof e.id === 'string' && typeof e.command === 'string' && e.command !== '') {
            this.entries.push({
              id: e.id,
              sessionId: typeof e.sessionId === 'string' ? e.sessionId : '',
              principal: typeof e.principal === 'string' ? e.principal : 'human',
              command: e.command,
              exitCode: typeof e.exitCode === 'number' ? e.exitCode : 0,
              at: typeof e.at === 'number' ? e.at : 0,
            });
          }
        } catch {
          /* skip corrupt lines */
        }
      }
    } catch {
      /* unreadable file: start empty, best-effort */
      this.entries = [];
    }
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  /**
   * Append one entry. Returns the stored entry, or null when skipped
   * (empty command, consecutive duplicate, oversized).
   */
  append(n: NewHistoryEntry): HistoryEntry | null {
    if (!n.command) return null;
    const last = this.entries[this.entries.length - 1];
    if (last && last.command === n.command) return null;
    const entry: HistoryEntry = {
      id: randomUUID(),
      sessionId: n.sessionId,
      principal: n.principal,
      command: n.command,
      exitCode: n.exitCode,
      at: n.at ?? this.now(),
    };
    const line = JSON.stringify(entry);
    if (Buffer.byteLength(line, 'utf8') > MAX_ENTRY_BYTES) return null;
    this.entries.push(entry);
    try {
      appendFileSync(this.file, line + '\n');
    } catch {
      // Disk failure: keep the in-memory entry, report nothing —
      // history must never break the terminal. The entry is lost on
      // restart; the in-memory list stays consistent for this run.
    }
    if (this.entries.length > this.maxEntries * 1.2) this.compact();
    return entry;
  }

  /** Rewrite the file keeping only the newest maxEntries (atomic). */
  private compact(): void {
    this.entries = this.entries.slice(-this.maxEntries);
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
      renameSync(tmp, this.file);
    } catch {
      /* best-effort */
    }
  }

  /** Most recent entries first. */
  recent(limit = 50): HistoryEntry[] {
    const n = Math.max(1, Math.floor(limit));
    return this.entries.slice(-n).reverse();
  }

  /** Fuzzy search over command text; empty query = recent. */
  search(query: string, limit = 50): HistoryEntry[] {
    const q = query.trim();
    if (!q) return this.recent(limit);
    const scored: Array<{ e: HistoryEntry; s: number }> = [];
    for (const e of this.entries) {
      const s = fuzzyScore(q, e.command);
      if (s !== null) scored.push({ e, s });
    }
    scored.sort((a, b) => (b.s - a.s) || (b.e.at - a.e.at));
    return scored.slice(0, Math.max(1, Math.floor(limit))).map((x) => x.e);
  }
}

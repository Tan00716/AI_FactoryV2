/**
 * R7-#8 query history for the database browser.
 *
 * Every executed console query (plus write-gate refusals, which are
 * attempts worth seeing) is recorded as an entry: connection, sql,
 * verdict, outcome, timing. Entries can be listed (optionally filtered
 * by connection or favorites-only), re-run (which records a NEW entry,
 * never overwrites history), favorited, deleted, or cleared.
 *
 * Persistence: entries live in a JSON file under the server data dir
 * (default db-history.json), written atomically (tmp + rename) and
 * capped at 500 entries (oldest dropped). A corrupt file is fail-closed:
 * load() throws HISTORY_CORRUPT and the file is never overwritten, so
 * a bad write cannot silently eat history.
 *
 * Privacy note: history stores the SQL text itself — that is the point
 * (re-run needs it). It is stored in the server data dir only, never in
 * audit-chain details: audit events for history actions carry entry ids
 * and counts, never SQL.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export type HistoryVerdict = 'read' | 'write' | 'destructive' | 'blocked' | 'refused';

export interface HistoryEntry {
  id: string;
  connection: string;
  sql: string;
  verdict: HistoryVerdict;
  /** True when the statement actually executed. */
  ok: boolean;
  /** Machine-readable failure code for ok:false entries (e.g. WRITE_MODE_DISABLED). */
  errorCode: string | null;
  rowCount: number | null;
  durationMs: number | null;
  favorite: boolean;
  createdAt: number;
}

export interface HistoryRecordInput {
  connection: string;
  sql: string;
  verdict: HistoryVerdict;
  ok: boolean;
  errorCode?: string | null;
  rowCount?: number | null;
  durationMs?: number | null;
}

export const HISTORY_MAX_ENTRIES = 500;
export const HISTORY_MAX_SQL_CHARS = 4000;

export class HistoryCorruptError extends Error {
  readonly code = 'HISTORY_CORRUPT';
  constructor(message: string) {
    super(message);
    this.name = 'HistoryCorruptError';
  }
}

function isEntry(v: unknown): v is HistoryEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e['id'] === 'string' &&
    typeof e['connection'] === 'string' &&
    typeof e['sql'] === 'string' &&
    typeof e['verdict'] === 'string' &&
    typeof e['ok'] === 'boolean' &&
    typeof e['favorite'] === 'boolean' &&
    typeof e['createdAt'] === 'number'
  );
}

export class QueryHistory {
  private entries: HistoryEntry[] = [];
  private loaded = false;
  /** Once set, no record/save may touch the file (fail-closed). */
  private broken = false;
  private readonly filePath: string | null;
  private readonly maxEntries: number;
  private readonly maxSqlChars: number;
  private readonly now: () => number;

  constructor(opts?: { filePath?: string | null; maxEntries?: number; maxSqlChars?: number; now?: () => number }) {
    this.filePath = opts?.filePath ?? null;
    this.maxEntries = opts?.maxEntries ?? HISTORY_MAX_ENTRIES;
    this.maxSqlChars = opts?.maxSqlChars ?? HISTORY_MAX_SQL_CHARS;
    this.now = opts?.now ?? Date.now;
  }

  /** Load from disk once; missing file = empty history, corrupt = throw. */
  load(): void {
    if (this.broken) throw new HistoryCorruptError(`query history file is corrupt: ${this.filePath}`);
    if (this.loaded) return;
    this.loaded = true;
    if (!this.filePath || !existsSync(this.filePath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch {
      this.broken = true;
      throw new HistoryCorruptError(`query history file is not valid JSON: ${this.filePath}`);
    }
    if (!Array.isArray(parsed) || !parsed.every(isEntry)) {
      this.broken = true;
      throw new HistoryCorruptError(`query history file has an unexpected shape: ${this.filePath}`);
    }
    this.entries = parsed.slice(-this.maxEntries);
  }

  private save(): void {
    if (!this.filePath) return;
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.entries), 'utf8');
    renameSync(tmp, this.filePath);
  }

  record(input: HistoryRecordInput): HistoryEntry {
    this.load();
    const entry: HistoryEntry = {
      id: randomUUID(),
      connection: input.connection,
      sql: input.sql.slice(0, this.maxSqlChars),
      verdict: input.verdict,
      ok: input.ok,
      errorCode: input.errorCode ?? null,
      rowCount: input.rowCount ?? null,
      durationMs: input.durationMs ?? null,
      favorite: false,
      createdAt: this.now(),
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
    this.save();
    return entry;
  }

  list(opts?: { connection?: string; favoritesOnly?: boolean }): HistoryEntry[] {
    this.load();
    let out = [...this.entries].reverse(); // newest first
    if (opts?.connection) out = out.filter((e) => e.connection === opts.connection);
    if (opts?.favoritesOnly) out = out.filter((e) => e.favorite);
    return out;
  }

  get(id: string): HistoryEntry | null {
    this.load();
    return this.entries.find((e) => e.id === id) ?? null;
  }

  setFavorite(id: string, favorite: boolean): HistoryEntry | null {
    this.load();
    const e = this.entries.find((x) => x.id === id);
    if (!e) return null;
    e.favorite = favorite;
    this.save();
    return e;
  }

  remove(id: string): boolean {
    this.load();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length === before) return false;
    this.save();
    return true;
  }

  /** Clear all entries, or only one connection's. Returns removed count. */
  clear(connection?: string): number {
    this.load();
    const before = this.entries.length;
    this.entries = connection ? this.entries.filter((e) => e.connection !== connection) : [];
    const removed = before - this.entries.length;
    this.save();
    return removed;
  }
}

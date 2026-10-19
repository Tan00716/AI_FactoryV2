/**
 * Audit-chain tail anchoring — closes the W-C P2 gap.
 *
 * The §32 hash chain (packages/core audit.ts) verifies *forward*: every
 * chained record's prevHash must link to the previous record's summaryHash,
 * anchored at AUDIT_CHAIN_GENESIS. That detects tampering with any record's
 * content or order — including deletion of HEAD records (the first remaining
 * record's prevHash then points outside the window, so the break is
 * reported at index 0). But it is blind to one mutation: **deleting TAIL
 * records**. Remove the last N rows and the remaining chain still verifies
 * from genesis, with a smaller verifiedCount and no error.
 *
 * The tail anchor closes exactly that gap. After every successful verify
 * we persist a tiny watermark — the highest chained-record count ever
 * observed plus the head record's summaryHash. The next verify compares:
 *
 *   - observed chained count < watermark max  → TAIL_TRUNCATED
 *   - same count but different head hash       → TAIL_TRUNCATED (tail rewritten:
 *     delete + re-append; no legitimate API path does this)
 *   - otherwise                                → healthy; ratchet the watermark
 *     forward (monotonic — it never moves down)
 *
 * Only *chained* records are anchored (verifiedCount). Legacy records
 * (pre-chaining rows without hash fields) are unverified by design, so a
 * deleted trailing legacy record is intentionally not detected — the chain
 * makes no promise about it.
 *
 * Fail-closed semantics (each defined + tested):
 *   - anchor file missing      → bootstrap: initialize from the current
 *     chain and report ok (status 'initialized'). Existing databases predate
 *     this feature; failing verify forever on upgrade would be a false
 *     positive with no recovery path.
 *   - anchor file corrupt/unreadable → ok:false, code
 *     AUDIT_TAIL_ANCHOR_UNREADABLE (status 'unreadable'). A corrupt anchor
 *     is indistinguishable from anchor tampering, so we fail closed.
 *     Recovery: delete the anchor file; the next verify re-initializes.
 *     NOTE: restoring an older backup (POST /api/restore) legitimately
 *     shrinks the chain — the next verify will report TAIL_TRUNCATED.
 *     That is correct (a restore IS a tail truncation from the chain's
 *     perspective); delete the anchor file after a restore to re-baseline.
 *   - anchor write fails      → ok:false, code AUDIT_TAIL_ANCHOR_WRITE_FAILED
 *     (status 'write-failed'). A missed ratchet must not silently weaken
 *     future detection.
 *   - forward chain broken    → the existing brokenAt result, unchanged;
 *     the anchor is never updated from a broken chain (never bless it).
 *
 * Honest boundary (unchanged from W-C): this is detection, not prevention.
 * An attacker with raw DB access can also rewrite the anchor file — but
 * then they must consistently update TWO stores, and any mistake is
 * detected. The anchor raises the bar on the one mutation the hash chain
 * alone cannot see; it does not stop a DB superuser (nothing local can).
 * The hash algorithm itself is untouched (plain SHA-256 is deliberate —
 * HMAC was rejected in W-C and documented there).
 *
 * Persistence follows the plan-store/session-store convention: JSON file,
 * atomic write via temp + rename. The server colocates the anchor with the
 * database it anchors (same directory as DB_PATH) — an anchor is per-database
 * state; a CWD/data-dir default would let one database's watermark leak into
 * another (false TAIL_TRUNCATED on DB switches or temp test DBs).
 * AI_FACTORY_AUDIT_TAIL_ANCHOR_FILE overrides the path outright (used by
 * tests for hermetic anchors).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { verifyAuditChain } from '@ai-factory/core';
import type { AuditChainVerification, AuditLog, AuditRecord } from '@ai-factory/core';

/** Watermark persisted after each successful verify. */
export interface AuditTailAnchorState {
  /** Highest chained-record count (verifiedCount) ever observed. Monotonic. */
  maxChainedCount: number;
  /** summaryHash of the last chained record at the last verify ('': empty chain). */
  headHash: string;
  /** ISO timestamp of the last anchor update. */
  updatedAt: string;
}

export const AUDIT_TAIL_ANCHOR_FILENAME = 'audit-tail-anchor.json';

/** Machine-readable tail codes surfaced on the verify result. */
export type AuditTailCode =
  | 'AUDIT_TAIL_TRUNCATED'
  | 'AUDIT_TAIL_ANCHOR_UNREADABLE'
  | 'AUDIT_TAIL_ANCHOR_WRITE_FAILED';

export type AuditTailAnchorStatus = 'ok' | 'initialized' | 'unreadable' | 'write-failed';

export interface TailAnchoredVerification extends AuditChainVerification {
  /** True only when the tail was truncated or rewritten versus the anchor. */
  tailTruncated: boolean;
  /** How the anchor fared this verify: see the module doc for semantics. */
  tailAnchorStatus: AuditTailAnchorStatus;
  /** Present when tailTruncated or the anchor itself failed. */
  code?: AuditTailCode;
  /** Present when tailTruncated: the anchored max vs what verify observed. */
  expectedChainedCount?: number;
  /** Present when tailTruncated: the anchored max vs what verify observed. */
  observedChainedCount?: number;
}

export function auditTailAnchorPath(): string {
  const fromEnv = process.env.AI_FACTORY_AUDIT_TAIL_ANCHOR_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, AUDIT_TAIL_ANCHOR_FILENAME);
}

/**
 * Preferred anchor path for a server: colocated with the database file it
 * anchors. An anchor is per-database state — resolving it from CWD/data-dir
 * lets one file's watermark leak into a different database (false
 * TAIL_TRUNCATED when DBs are switched or tests use temp DBs). The explicit
 * AI_FACTORY_AUDIT_TAIL_ANCHOR_FILE override still wins.
 */
export function auditTailAnchorPathForDb(dbPath: string): string {
  const fromEnv = process.env.AI_FACTORY_AUDIT_TAIL_ANCHOR_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  return resolve(dirname(resolve(dbPath)), AUDIT_TAIL_ANCHOR_FILENAME);
}

/** The anchor file exists but cannot be parsed or fails shape validation. */
export class AuditTailAnchorCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditTailAnchorCorruptError';
  }
}

/** The anchor file could not be persisted (disk full, permissions, …). */
export class AuditTailAnchorWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditTailAnchorWriteError';
  }
}

/**
 * Pluggable anchor persistence. read() returns null when no anchor has
 * ever been written (bootstrap case) and throws AuditTailAnchorCorruptError
 * when the anchor exists but is unusable. write() throws
 * AuditTailAnchorWriteError on failure.
 */
export interface AuditTailAnchorStore {
  read(): AuditTailAnchorState | null;
  write(state: AuditTailAnchorState): void;
}

function isValidAnchorState(v: unknown): v is AuditTailAnchorState {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    Number.isInteger(r['maxChainedCount']) &&
    (r['maxChainedCount'] as number) >= 0 &&
    typeof r['headHash'] === 'string' &&
    typeof r['updatedAt'] === 'string'
  );
}

/** File-backed anchor store: atomic write (temp + rename), fail-closed reads. */
export class FileAuditTailAnchorStore implements AuditTailAnchorStore {
  private readonly filePath: string;
  constructor(filePath?: string) {
    // NOTE: no TS parameter properties here — node type-stripping
    // (strip-only mode) does not support them (dual-mode rule).
    this.filePath = filePath ?? auditTailAnchorPath();
  }

  read(): AuditTailAnchorState | null {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Exists but unreadable (permissions, I/O error): fail closed —
      // indistinguishable from anchor tampering.
      throw new AuditTailAnchorCorruptError(
        `audit tail anchor unreadable at ${this.filePath}: ${(e as Error).message}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new AuditTailAnchorCorruptError(
        `audit tail anchor at ${this.filePath} is not valid JSON: ${(e as Error).message}`,
      );
    }
    if (!isValidAnchorState(parsed)) {
      throw new AuditTailAnchorCorruptError(
        `audit tail anchor at ${this.filePath} failed shape validation`,
      );
    }
    return parsed;
  }

  write(state: AuditTailAnchorState): void {
    try {
      mkdirSync(resolve(this.filePath, '..'), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      renameSync(tmp, this.filePath);
    } catch (e) {
      throw new AuditTailAnchorWriteError(
        `audit tail anchor write failed at ${this.filePath}: ${(e as Error).message}`,
      );
    }
  }
}

/** Chained-record count + head hash of one append-order record list. */
function chainHead(records: readonly AuditRecord[]): { count: number; headHash: string } {
  let count = 0;
  let headHash = '';
  for (const r of records) {
    if (typeof r.summaryHash === 'string' && typeof r.prevHash === 'string') {
      count++;
      headHash = r.summaryHash;
    }
  }
  return { count, headHash };
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Verify the audit chain *and* its tail anchor. Semantics are defined in
 * the module doc — the short version:
 *   forward break            → existing brokenAt result, anchor untouched
 *   count < anchored max     → ok:false TAIL_TRUNCATED (never ratchet down)
 *   same count, head changed  → ok:false TAIL_TRUNCATED (tail rewritten)
 *   anchor missing           → bootstrap from current chain ('initialized')
 *   anchor corrupt/unreadable→ ok:false AUDIT_TAIL_ANCHOR_UNREADABLE
 *   anchor write fails        → ok:false AUDIT_TAIL_ANCHOR_WRITE_FAILED
 *   otherwise                → ok:true, anchor ratcheted forward if the
 *                              chain grew (write skipped when unchanged)
 */
export function verifyAuditChainWithTailAnchor(
  audit: Pick<AuditLog, 'list'>,
  anchor: AuditTailAnchorStore,
): TailAnchoredVerification {
  // One list() for both checks: the forward verify and the tail comparison
  // must see the same chain (no TOCTOU between two scans).
  const records = audit.list();
  const fwd = verifyAuditChain(records);
  if (!fwd.ok) {
    // A broken chain is never blessed: the anchor is left untouched.
    return { ...fwd, tailTruncated: false, tailAnchorStatus: 'ok' };
  }
  const { count, headHash } = chainHead(records);

  let state: AuditTailAnchorState | null;
  try {
    state = anchor.read();
  } catch {
    // Corrupt/unreadable anchor — fail closed: we cannot prove the tail
    // is intact, so the verify must not report ok.
    return {
      ...fwd,
      ok: false,
      tailTruncated: false,
      tailAnchorStatus: 'unreadable',
      code: 'AUDIT_TAIL_ANCHOR_UNREADABLE',
    };
  }

  if (state === null) {
    const fresh: AuditTailAnchorState = { maxChainedCount: count, headHash, updatedAt: nowIso() };
    try {
      anchor.write(fresh);
    } catch {
      return {
        ...fwd,
        ok: false,
        tailTruncated: false,
        tailAnchorStatus: 'write-failed',
        code: 'AUDIT_TAIL_ANCHOR_WRITE_FAILED',
      };
    }
    return { ...fwd, tailTruncated: false, tailAnchorStatus: 'initialized' };
  }

  if (count < state.maxChainedCount) {
    return {
      ...fwd,
      ok: false,
      tailTruncated: true,
      tailAnchorStatus: 'ok',
      code: 'AUDIT_TAIL_TRUNCATED',
      expectedChainedCount: state.maxChainedCount,
      observedChainedCount: count,
    };
  }
  if (state.maxChainedCount > 0 && count === state.maxChainedCount && headHash !== state.headHash) {
    // Same length, different head: the tail was deleted and re-appended.
    // No legitimate API path rewrites the tail, so this is tampering.
    return {
      ...fwd,
      ok: false,
      tailTruncated: true,
      tailAnchorStatus: 'ok',
      code: 'AUDIT_TAIL_TRUNCATED',
      expectedChainedCount: state.maxChainedCount,
      observedChainedCount: count,
    };
  }

  if (count !== state.maxChainedCount || headHash !== state.headHash) {
    const next: AuditTailAnchorState = {
      maxChainedCount: Math.max(state.maxChainedCount, count),
      headHash,
      updatedAt: nowIso(),
    };
    try {
      anchor.write(next);
    } catch {
      return {
        ...fwd,
        ok: false,
        tailTruncated: false,
        tailAnchorStatus: 'write-failed',
        code: 'AUDIT_TAIL_ANCHOR_WRITE_FAILED',
      };
    }
  }
  return { ...fwd, tailTruncated: false, tailAnchorStatus: 'ok' };
}

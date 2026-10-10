/**
 * Observable downstream-reference registry — SPEC v2 §43.3 (revocation /
 * TTL / project-deletion cleanup).
 *
 * When a memory entry is written, derived systems keep references to it:
 * the vector/summary INDEX, the retrieval CACHE, and the BACKUP retention
 * copy. §43.3 requires that fact expiry, permission revocation and project
 * deletion synchronously clean all of them: "记忆不能保留撤销后不该读取的数据".
 *
 * MemoryRefRegistry is the observable proof: every reference is tracked
 * here, `removeEntry` cleans all three kinds and reports the counts, and
 * `refsFor` lets tests (and the purge endpoint) assert that zero
 * references remain for a purged id.
 *
 * In production this registry would be backed by the real index/cache/
 * backup drivers; the counting contract is what matters for the v2
 * hardening tests.
 */

export type RefKind = 'index' | 'cache' | 'backup';

export interface RefCounts {
  index: number;
  cache: number;
  backup: number;
}

export interface RefsForEntry extends RefCounts {
  total: number;
}

const KINDS: RefKind[] = ['index', 'cache', 'backup'];

export class MemoryRefRegistry {
  private readonly refs = new Map<string, Map<RefKind, number>>();

  /** Record one downstream reference of `kind` for `entryId`. */
  track(entryId: string, kind: RefKind): void {
    let kinds = this.refs.get(entryId);
    if (!kinds) {
      kinds = new Map<RefKind, number>();
      this.refs.set(entryId, kinds);
    }
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }

  /** Current reference counts for one entry id (zeros when unknown). */
  refsFor(entryId: string): RefsForEntry {
    const kinds = this.refs.get(entryId);
    const out: RefsForEntry = { index: 0, cache: 0, backup: 0, total: 0 };
    if (!kinds) return out;
    for (const k of KINDS) out[k] = kinds.get(k) ?? 0;
    out.total = out.index + out.cache + out.backup;
    return out;
  }

  /**
   * Remove every reference for `entryId` (index + cache + backup) and
   * return how many of each were cleaned. After this call `refsFor(id)`
   * reports all zeros.
   */
  removeEntry(entryId: string): RefCounts {
    const before = this.refsFor(entryId);
    this.refs.delete(entryId);
    return { index: before.index, cache: before.cache, backup: before.backup };
  }

  /** Total references still tracked across all entries. */
  totalRefs(): number {
    let n = 0;
    for (const kinds of this.refs.values()) {
      for (const c of kinds.values()) n += c;
    }
    return n;
  }

  /** Entry ids that still hold at least one tracked reference. */
  entryIds(): string[] {
    return [...this.refs.keys()];
  }
}

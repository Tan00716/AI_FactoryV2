/**
 * Classic diff3 over (base, ours, theirs) built on the Myers line diff.
 *
 * Algorithm:
 *   1. opcodesO = diffLines(base, ours), opcodesT = diffLines(base, theirs)
 *   2. collect changed base-ranges per side (non-equal opcodes, adjacent
 *      ranges merged);
 *   3. union the two region sets (overlapping or touching regions merge);
 *   4. classify each region:
 *        neither side changed  -> stable
 *        only ours changed     -> ours-only   (auto-merges to ours)
 *        only theirs changed   -> theirs-only (auto-merges to theirs)
 *        both changed, identical result -> both-same (auto-merges)
 *        both changed differently       -> conflict (manual)
 *   5. stable gaps between regions become stable chunks.
 *
 * needsManual is set on conflict chunks that look structurally shaky:
 * large regions (>30 base lines) or delete-vs-change tangles. The UI
 * must render those as "needs manual review", never as authoritative.
 */
import { diffLines, type Opcode } from './myers.js';
import type { Diff3Chunk, Diff3ChunkKind } from './types.js';

interface BaseRange {
  bs: number;
  be: number;
}

const NEEDS_MANUAL_BASE_LINES = 30;

/** Changed base-ranges for one side, adjacent ranges merged. */
function changedRanges(opcodes: Opcode[]): BaseRange[] {
  const ranges: BaseRange[] = [];
  for (const oc of opcodes) {
    if (oc.tag === 'equal') continue;
    const last = ranges[ranges.length - 1];
    if (last && oc.aStart <= last.be) {
      last.be = Math.max(last.be, oc.aEnd);
    } else {
      ranges.push({ bs: oc.aStart, be: oc.aEnd });
    }
  }
  return ranges;
}

/**
 * Slice the side's lines that correspond to base range [rs, re).
 * An opcode touches the range when its a-range intersects it; empty
 * a-ranges (pure insertions) touch the point they sit at.
 */
function sliceSide(opcodes: Opcode[], sideLines: string[], rs: number, re: number): string[] {
  const out: string[] = [];
  for (const oc of opcodes) {
    const touches =
      oc.aStart < re && oc.aEnd > rs
        ? true
        : oc.aStart === oc.aEnd && oc.aStart >= rs && oc.aStart <= re;
    if (!touches) continue;
    if (oc.tag === 'equal') {
      const from = Math.max(rs, oc.aStart);
      const to = Math.min(re, oc.aEnd);
      for (let a = from; a < to; a += 1) out.push(sideLines[oc.bStart + (a - oc.aStart)]);
    } else {
      for (let b = oc.bStart; b < oc.bEnd; b += 1) out.push(sideLines[b]);
    }
  }
  return out;
}

function overlaps(ranges: BaseRange[], rs: number, re: number): boolean {
  return ranges.some((r) => {
    if (r.bs < re && r.be > rs) return true; // proper interval overlap
    // Pure insertion point p touches [rs, re): inside it, or exactly at a
    // zero-width query (avoids claiming the boundary point for both sides).
    if (r.bs === r.be) {
      const p = r.bs;
      return (rs <= p && p < re) || (rs === re && p === rs);
    }
    return false;
  });
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function diff3(base: string[], ours: string[], theirs: string[]): Diff3Chunk[] {
  const opO = diffLines(base, ours);
  const opT = diffLines(base, theirs);
  const regO = changedRanges(opO);
  const regT = changedRanges(opT);

  // Union of changed regions (touching regions merge).
  const all: BaseRange[] = [...regO, ...regT].sort((x, y) => x.bs - y.bs || x.be - y.be);
  const regions: BaseRange[] = [];
  for (const r of all) {
    const last = regions[regions.length - 1];
    if (last && r.bs <= last.be) {
      last.be = Math.max(last.be, r.be);
    } else {
      regions.push({ bs: r.bs, be: r.be });
    }
  }

  const chunks: Diff3Chunk[] = [];
  let cursor = 0;
  const pushStable = (from: number, to: number) => {
    if (to <= from) return;
    const lines = base.slice(from, to);
    chunks.push({
      kind: 'stable',
      baseStart: from + 1,
      baseLines: lines,
      oursLines: [...lines],
      theirsLines: [...lines],
      needsManual: false,
    });
  };

  for (const r of regions) {
    pushStable(cursor, r.bs);
    const baseLines = base.slice(r.bs, r.be);
    const oursLines = sliceSide(opO, ours, r.bs, r.be);
    const theirsLines = sliceSide(opT, theirs, r.bs, r.be);
    const oChanged = overlaps(regO, r.bs, r.be);
    const tChanged = overlaps(regT, r.bs, r.be);

    let kind: Diff3ChunkKind;
    if (oChanged && !tChanged) kind = 'ours-only';
    else if (tChanged && !oChanged) kind = 'theirs-only';
    else if (arraysEqual(oursLines, theirsLines)) kind = 'both-same';
    else kind = 'conflict';

    const oursEmpty = oursLines.length === 0 && baseLines.length > 0;
    const theirsEmpty = theirsLines.length === 0 && baseLines.length > 0;
    const needsManual =
      kind === 'conflict' &&
      (r.be - r.bs > NEEDS_MANUAL_BASE_LINES || (oursEmpty !== theirsEmpty));

    chunks.push({
      kind,
      baseStart: r.be > r.bs ? r.bs + 1 : -1,
      baseLines,
      oursLines,
      theirsLines,
      needsManual,
    });
    cursor = r.be;
  }
  pushStable(cursor, base.length);
  return chunks;
}

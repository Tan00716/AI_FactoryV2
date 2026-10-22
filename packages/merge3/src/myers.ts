/**
 * Myers O(ND) line diff (self-implemented, zero dependencies).
 *
 * diffLines(a, b) returns opcodes in difflib style, covering [0,a.length)
 * and [0,b.length) without gaps or overlaps. Used by diff3.ts to align
 * base→ours and base→theirs.
 *
 * Guard: inputs are capped (MAX_LINES) so pathological files fail fast
 * with a Merge3Error instead of burning CPU.
 */
import { Merge3Error } from './types.js';

export const MAX_DIFF_LINES = 20000;

export interface Opcode {
  tag: 'equal' | 'replace' | 'delete' | 'insert';
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

export function diffLines(a: string[], b: string[]): Opcode[] {
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    throw new Merge3Error(
      `diff input too large (${a.length} x ${b.length} lines, cap ${MAX_DIFF_LINES})`,
      'diff-too-large',
    );
  }
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ tag: 'insert', aStart: 0, aEnd: 0, bStart: 0, bEnd: m }];
  if (m === 0) return [{ tag: 'delete', aStart: 0, aEnd: n, bStart: 0, bEnd: 0 }];

  const max = n + m;
  const offset = max;
  const size = 2 * max + 1;
  let v = new Array<number>(size).fill(-1);
  v[offset + 1] = 0;
  const trace: Array<Map<number, number>> = [];

  let found = false;
  for (let d = 0; d <= max && !found; d += 1) {
    const vd = new Map<number, number>();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1]; // down (insertion)
      } else {
        x = v[offset + k - 1] + 1; // right (deletion)
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      vd.set(k, x);
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    trace.push(vd);
  }
  if (!found) {
    // Should be unreachable (d <= n+m always reaches the end), but
    // fail closed rather than returning a wrong diff.
    throw new Merge3Error('myers diff failed to converge', 'diff-failed');
  }

  // Backtrack to an edit script: list of {x, y, op} from start to end.
  type Step = { x: number; y: number; op: 'diag' | 'del' | 'ins' };
  const steps: Step[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const vPrev = trace[d - 1];
    const k = x - y;
    // The move that reached diagonal k at depth d came from k+1
    // (down = insertion) or from k-1 (right = deletion).
    let prevK: number;
    if (k === -d || (k !== d && (vPrev.get(k - 1) ?? -1) < (vPrev.get(k + 1) ?? -1))) {
      prevK = k + 1; // insertion: (xStart, yStart) -> (xStart, yStart+1)
    } else {
      prevK = k - 1; // deletion: (xStart, yStart) -> (xStart+1, yStart)
    }
    const xStart = vPrev.get(prevK) ?? 0;
    const yStart = xStart - prevK;
    // Walk back the snake (all diagonals) to just after the edit step.
    const sx = xStart + (prevK === k - 1 ? 1 : 0);
    const sy = yStart + (prevK === k + 1 ? 1 : 0);
    while (x > sx && y > sy) {
      steps.push({ x: x - 1, y: y - 1, op: 'diag' });
      x -= 1;
      y -= 1;
    }
    // Record the single edit step.
    if (prevK === k - 1) {
      steps.push({ x: x - 1, y, op: 'del' });
    } else {
      steps.push({ x, y: y - 1, op: 'ins' });
    }
    x = xStart;
    y = yStart;
  }
  // d = 0: the initial snake from (0,0).
  while (x > 0 && y > 0 && a[x - 1] === b[y - 1]) {
    steps.push({ x: x - 1, y: y - 1, op: 'diag' });
    x -= 1;
    y -= 1;
  }
  steps.reverse();

  // Fold the script into opcodes.
  const opcodes: Opcode[] = [];
  let ai = 0;
  let bi = 0;
  const push = (tag: Opcode['tag'], na: number, nb: number) => {
    const last = opcodes[opcodes.length - 1];
    if (last && last.tag === tag && last.aEnd === ai && last.bEnd === bi) {
      last.aEnd += na;
      last.bEnd += nb;
    } else {
      opcodes.push({ tag, aStart: ai, aEnd: ai + na, bStart: bi, bEnd: bi + nb });
    }
    ai += na;
    bi += nb;
  };
  for (const s of steps) {
    if (s.op === 'diag') push('equal', 1, 1);
    else if (s.op === 'del') push('delete', 1, 0);
    else push('insert', 0, 1);
  }
  // Merge adjacent delete+insert into replace for cleaner chunks.
  const merged: Opcode[] = [];
  for (const oc of opcodes) {
    const last = merged[merged.length - 1];
    if (
      last &&
      ((last.tag === 'delete' && oc.tag === 'insert') ||
        (last.tag === 'insert' && oc.tag === 'delete')) &&
      last.aEnd === oc.aStart &&
      last.bEnd === oc.bStart
    ) {
      last.tag = 'replace';
      last.aEnd = oc.aEnd;
      last.bEnd = oc.bEnd;
    } else {
      merged.push({ ...oc });
    }
  }
  return merged;
}

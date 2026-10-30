import {
  MAX_CELLS,
  MAX_CELL_SOURCE_BYTES,
  MAX_OUTPUT_CHARS,
  NotebookError,
  type Cell,
  type CellOutput,
  type CellRunResult,
  type Notebook,
} from './types.js';

/**
 * Pure cell operations (round-7 task R7-#2). No I/O: the store layer
 * owns persistence, the route layer owns execution. All functions
 * validate fail-closed and never mutate their input notebook.
 */

export function assertSourceSize(source: string): void {
  if (Buffer.byteLength(source, 'utf8') > MAX_CELL_SOURCE_BYTES) {
    throw new NotebookError('too-large', `cell source exceeds ${MAX_CELL_SOURCE_BYTES} bytes`);
  }
}

/** Next cell id for a notebook: cell-<n> over the max existing suffix. */
export function nextCellId(cells: readonly Cell[]): string {
  let max = 0;
  for (const c of cells) {
    const m = /^cell-(\d+)$/.exec(c.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `cell-${max + 1}`;
}

export function addCell(
  notebook: Notebook,
  input: { kind: 'code' | 'markdown'; language: string; source?: string; afterId?: string },
): { notebook: Notebook; cell: Cell } {
  if (notebook.cells.length >= MAX_CELLS) {
    throw new NotebookError('too-many-cells', `notebook cell limit reached (${MAX_CELLS})`);
  }
  const source = input.source ?? '';
  assertSourceSize(source);
  const cell: Cell = {
    id: nextCellId(notebook.cells),
    kind: input.kind,
    language: input.language,
    source,
    outputs: [],
    run: null,
  };
  const cells = [...notebook.cells];
  if (input.afterId !== undefined) {
    const idx = cells.findIndex((c) => c.id === input.afterId);
    if (idx < 0) throw new NotebookError('not-found', `cell not found: ${input.afterId}`);
    cells.splice(idx + 1, 0, cell);
  } else {
    cells.push(cell);
  }
  return { notebook: { ...notebook, cells, updatedAt: new Date().toISOString() }, cell };
}

export function updateCellSource(notebook: Notebook, cellId: string, source: string): Notebook {
  assertSourceSize(source);
  const idx = notebook.cells.findIndex((c) => c.id === cellId);
  if (idx < 0) throw new NotebookError('not-found', `cell not found: ${cellId}`);
  const cells = [...notebook.cells];
  cells[idx] = { ...cells[idx]!, source };
  return { ...notebook, cells, updatedAt: new Date().toISOString() };
}

export function deleteCell(notebook: Notebook, cellId: string): Notebook {
  if (!notebook.cells.some((c) => c.id === cellId)) {
    throw new NotebookError('not-found', `cell not found: ${cellId}`);
  }
  return {
    ...notebook,
    cells: notebook.cells.filter((c) => c.id !== cellId),
    updatedAt: new Date().toISOString(),
  };
}

export function moveCell(
  notebook: Notebook,
  cellId: string,
  target: { direction: 'up' | 'down' } | { toIndex: number },
): Notebook {
  const idx = notebook.cells.findIndex((c) => c.id === cellId);
  if (idx < 0) throw new NotebookError('not-found', `cell not found: ${cellId}`);
  const cells = [...notebook.cells];
  let to: number;
  if ('direction' in target) {
    to = target.direction === 'up' ? idx - 1 : idx + 1;
    if (to < 0 || to >= cells.length) {
      throw new NotebookError('bad-move', `cannot move cell ${target.direction} from position ${idx}`);
    }
  } else {
    to = target.toIndex;
    if (!Number.isInteger(to) || to < 0 || to >= cells.length) {
      throw new NotebookError('bad-move', `target index out of range: ${target.toIndex}`);
    }
  }
  const [cell] = cells.splice(idx, 1);
  cells.splice(to, 0, cell!);
  return { ...notebook, cells, updatedAt: new Date().toISOString() };
}

/** Cap one stream to MAX_OUTPUT_CHARS; returns the stored text + flag. */
export function capStream(text: string): { text: string; truncated: boolean } {
  if (text.length > MAX_OUTPUT_CHARS) {
    return { text: text.slice(0, MAX_OUTPUT_CHARS), truncated: true };
  }
  return { text, truncated: false };
}

/** Map a runner result onto stored cell outputs + run record. */
export function applyRunResult(
  notebook: Notebook,
  cellId: string,
  result: CellRunResult,
): Notebook {
  const idx = notebook.cells.findIndex((c) => c.id === cellId);
  if (idx < 0) throw new NotebookError('not-found', `cell not found: ${cellId}`);
  const outputs: CellOutput[] = [];
  const out = capStream(result.stdout);
  const err = capStream(result.stderr);
  if (out.text) outputs.push({ kind: 'stdout', text: out.text, truncated: out.truncated });
  if (err.text) outputs.push({ kind: 'stderr', text: err.text, truncated: err.truncated });
  const cells = [...notebook.cells];
  cells[idx] = {
    ...cells[idx]!,
    outputs,
    run: {
      ok: result.ok,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      ranAt: new Date().toISOString(),
    },
  };
  return { ...notebook, cells, updatedAt: new Date().toISOString() };
}

/** Clear every cell's outputs + run record (in-place clear, not export). */
export function clearOutputs(notebook: Notebook): Notebook {
  return {
    ...notebook,
    cells: notebook.cells.map((c) => ({ ...c, outputs: [], run: null })),
    updatedAt: new Date().toISOString(),
  };
}

/** Copy of the notebook with all outputs + run records removed (for export/commit). */
export function stripOutputs(notebook: Notebook): Notebook {
  return clearOutputs(notebook);
}

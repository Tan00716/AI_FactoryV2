/**
 * Notebook types (round-7 task R7-#2).
 *
 * A notebook is a versionable JSON document: an ordered list of cells.
 * Code cells run through the SHARED exec safety channel (route layer,
 * same checkCommandPolicy + isolated temp dir as scratch runs); markdown
 * cells never execute. Cell outputs are stored WITH the notebook by
 * default but can be stripped on export (stripOutputs) or cleared
 * in place (clearOutputs) so a notebook can be committed without
 * execution artefacts.
 *
 * Honest boundaries (also rendered in the UI):
 *  - No Jupyter kernel wire protocol: cells run as standalone `node`
 *    scripts, one process per code cell, in source order. There is no
 *    shared kernel state between cells — a variable defined in cell 1
 *    is NOT visible in cell 2. Sequential `run-all` is ordering, not
 *    a session.
 *  - Only node-runnable languages (TypeScript/JavaScript) can run; the
 *    shared exec policy whitelists 'node' only. Everything else is
 *    edit-only.
 *  - Notebook content is NOT audited and NOT covered by the pre-send
 *    prompt secret scan — do not paste secrets into a notebook.
 */
export class NotebookError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'NotebookError';
    this.code = code;
  }
}

export type CellKind = 'code' | 'markdown';

export interface CellOutput {
  /** 'stdout' | 'stderr' — one entry per stream, capped (see MAX_OUTPUT_CHARS). */
  kind: 'stdout' | 'stderr';
  text: string;
  truncated: boolean;
}

export interface CellRun {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  ranAt: string;
}

export interface Cell {
  id: string;
  kind: CellKind;
  /** Runnable language for code cells ('typescript' | 'javascript'); markdown cells carry 'markdown'. */
  language: string;
  source: string;
  outputs: CellOutput[];
  /** Last run record; null when never run or after outputs are cleared. */
  run: CellRun | null;
}

export interface NotebookMeta {
  id: string;
  name: string;
  /** Default language for newly added code cells. */
  language: string;
  cellCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Notebook extends NotebookMeta {
  version: 1;
  cells: Cell[];
}

/** Runner-facing result for one code cell (route maps it onto the cell). */
export interface CellRunResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  runner: string;
  language: string;
}

export interface LanguageDef {
  id: string;
  label: string;
  extension: string;
  monacoLanguage: string;
  runnable: boolean;
}

/** Store + cell limits (fail-closed, same order as scratch limits). */
export const MAX_NOTEBOOKS = 100;
export const MAX_CELLS = 200;
export const MAX_CELL_SOURCE_BYTES = 256_000;
/** Per-stream output cap per cell; exceeding it sets truncated: true. */
export const MAX_OUTPUT_CHARS = 64_000;
/** Cell run timeout, same as scratch runs. */
export const RUN_TIMEOUT_MS = 30_000;

export const LANGUAGES: readonly LanguageDef[] = [
  { id: 'typescript', label: 'TypeScript', extension: 'ts', monacoLanguage: 'typescript', runnable: true },
  { id: 'javascript', label: 'JavaScript', extension: 'js', monacoLanguage: 'javascript', runnable: true },
  { id: 'markdown', label: 'Markdown', extension: 'md', monacoLanguage: 'markdown', runnable: false },
] as const;

export function languageById(id: string): LanguageDef | null {
  return LANGUAGES.find((l) => l.id === id) ?? null;
}

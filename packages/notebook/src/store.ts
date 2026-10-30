import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { languageById } from './types.js';
import { MAX_NOTEBOOKS, NotebookError, type Notebook, type NotebookMeta } from './types.js';
import { addCell, deleteCell, moveCell, updateCellSource, clearOutputs } from './cells.js';

/**
 * File store for notebooks (round-7 task R7-#2).
 *
 * Layout under <root> (the caller passes <AI_FACTORY_DATA_DIR>/notebooks):
 *   index.json          — { [id]: NotebookMeta } (cellCount only, no sources)
 *   <id>.json           — the full notebook document (versioned JSON)
 *
 * All entry points are synchronous and fail-closed: an unknown id, an
 * unknown language, or a corrupt file throws NotebookError (the route
 * maps it to 4xx/5xx). Ids are caller-supplied (the route generates
 * crypto.randomUUID); they are validated against a strict charset so
 * they can never escape the store directory. Notebook bodies are never
 * written to the audit log and never pass through the pre-send secret
 * scan — the panel warns against pasting secrets.
 */
const INDEX_FILE = 'index.json';
const ID_RE = /^[a-f0-9-]{8,64}$/i;
const NAME_RE = /^[\p{L}\p{N} _\-+().]{1,80}$/u;

function assertId(id: string): void {
  if (!ID_RE.test(id)) throw new NotebookError('bad-id', `invalid notebook id: ${id}`);
}

function assertName(name: string): void {
  if (!NAME_RE.test(name)) throw new NotebookError('bad-name', `invalid notebook name: ${JSON.stringify(name)}`);
}

function storeDir(root: string): string {
  mkdirSync(root, { recursive: true });
  return root;
}

function readIndex(root: string): Record<string, NotebookMeta> {
  const dir = storeDir(root);
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, INDEX_FILE), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, NotebookMeta>;
    }
  } catch {
    // Missing or corrupt index: fall back to empty (fail-closed on
    // write paths anyway); files on disk are not trusted blindly.
  }
  return {};
}

function writeIndex(root: string, index: Record<string, NotebookMeta>): void {
  writeFileSync(join(storeDir(root), INDEX_FILE), JSON.stringify(index, null, 2), 'utf8');
}

function metaOf(nb: Notebook): NotebookMeta {
  return {
    id: nb.id,
    name: nb.name,
    language: nb.language,
    cellCount: nb.cells.length,
    createdAt: nb.createdAt,
    updatedAt: nb.updatedAt,
  };
}

function readNotebookFile(root: string, id: string): Notebook {
  const dir = storeDir(root);
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as { version?: unknown }).version === 1 &&
      Array.isArray((parsed as { cells?: unknown }).cells)
    ) {
      return parsed as Notebook;
    }
  } catch {
    // Fall through to not-found: a corrupt notebook file is never
    // surfaced as a partial document.
  }
  throw new NotebookError('not-found', `notebook not found: ${id}`);
}

function writeNotebookFile(root: string, nb: Notebook): void {
  const dir = storeDir(root);
  const index = readIndex(dir);
  writeFileSync(join(dir, `${nb.id}.json`), JSON.stringify(nb, null, 2), 'utf8');
  index[nb.id] = metaOf(nb);
  writeIndex(dir, index);
}

export function listNotebooks(root: string): NotebookMeta[] {
  const index = readIndex(root);
  return Object.values(index).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createNotebook(
  root: string,
  input: { id: string; name: string; language: string },
): NotebookMeta {
  assertId(input.id);
  assertName(input.name);
  if (!languageById(input.language) || input.language === 'markdown') {
    throw new NotebookError('bad-language', `unknown notebook language: ${input.language}`);
  }
  const dir = storeDir(root);
  const index = readIndex(dir);
  if (Object.keys(index).length >= MAX_NOTEBOOKS) {
    throw new NotebookError('too-many', `notebook limit reached (${MAX_NOTEBOOKS})`);
  }
  if (index[input.id]) throw new NotebookError('exists', `notebook already exists: ${input.id}`);
  const now = new Date().toISOString();
  const nb: Notebook = {
    version: 1,
    id: input.id,
    name: input.name,
    language: input.language,
    cellCount: 0,
    cells: [],
    createdAt: now,
    updatedAt: now,
  };
  writeNotebookFile(dir, nb);
  return metaOf(nb);
}

export function getNotebook(root: string, id: string): Notebook {
  assertId(id);
  return readNotebookFile(storeDir(root), id);
}

export function updateNotebook(
  root: string,
  id: string,
  patch: { name?: string; language?: string },
): NotebookMeta {
  assertId(id);
  const dir = storeDir(root);
  const nb = readNotebookFile(dir, id);
  if (patch.name !== undefined) {
    assertName(patch.name);
    nb.name = patch.name;
  }
  if (patch.language !== undefined) {
    if (!languageById(patch.language) || patch.language === 'markdown') {
      throw new NotebookError('bad-language', `unknown notebook language: ${patch.language}`);
    }
    nb.language = patch.language;
  }
  nb.updatedAt = new Date().toISOString();
  writeNotebookFile(dir, nb);
  return metaOf(nb);
}

export function deleteNotebook(root: string, id: string): void {
  assertId(id);
  const dir = storeDir(root);
  readNotebookFile(dir, id);
  try {
    unlinkSync(join(dir, `${id}.json`));
  } catch {
    throw new NotebookError('not-found', `notebook file missing: ${id}`);
  }
  const index = readIndex(dir);
  delete index[id];
  writeIndex(dir, index);
}

/** Apply a pure cell op and persist the result; returns the new notebook. */
function mutateCells(root: string, id: string, fn: (nb: Notebook) => Notebook): Notebook {
  const dir = storeDir(root);
  const nb = fn(readNotebookFile(dir, id));
  writeNotebookFile(dir, nb);
  return nb;
}

export function notebookAddCell(
  root: string,
  id: string,
  input: { kind: 'code' | 'markdown'; language: string; source?: string; afterId?: string },
): { notebook: Notebook; cellId: string } {
  assertId(id);
  if (input.kind === 'code') {
    const lang = languageById(input.language);
    if (!lang || !lang.runnable) {
      throw new NotebookError('bad-language', `code cells need a runnable language: ${input.language}`);
    }
  } else if (input.language !== 'markdown') {
    throw new NotebookError('bad-language', `markdown cells must use language "markdown"`);
  }
  let cellId = '';
  const nb = mutateCells(root, id, (cur) => {
    const r = addCell(cur, input);
    cellId = r.cell.id;
    return r.notebook;
  });
  return { notebook: nb, cellId };
}

export function notebookUpdateCell(root: string, id: string, cellId: string, source: string): Notebook {
  assertId(id);
  return mutateCells(root, id, (cur) => updateCellSource(cur, cellId, source));
}

export function notebookDeleteCell(root: string, id: string, cellId: string): Notebook {
  assertId(id);
  return mutateCells(root, id, (cur) => deleteCell(cur, cellId));
}

export function notebookMoveCell(
  root: string,
  id: string,
  cellId: string,
  target: { direction: 'up' | 'down' } | { toIndex: number },
): Notebook {
  assertId(id);
  return mutateCells(root, id, (cur) => moveCell(cur, cellId, target));
}

export function notebookClearOutputs(root: string, id: string): Notebook {
  assertId(id);
  return mutateCells(root, id, (cur) => clearOutputs(cur));
}

/** Persist a notebook produced by the route layer (e.g. after a cell run). */
export function saveNotebook(root: string, nb: Notebook): void {
  assertId(nb.id);
  writeNotebookFile(storeDir(root), nb);
}

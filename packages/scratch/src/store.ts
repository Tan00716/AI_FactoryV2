import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { languageById } from './languages.js';
import { ScratchError, type Scratch, type ScratchMeta } from './types.js';

/**
 * File store for scratch buffers (round-5 task R5-B10).
 *
 * Layout under <root> (the caller passes <AI_FACTORY_DATA_DIR>/scratches):
 *   index.json          — { [id]: ScratchMeta }
 *   <id>.<ext>          — the buffer content (extension follows language)
 *
 * All entry points are synchronous and fail-closed: an unknown id, an
 * unknown language, or a corrupt index throws ScratchError (the route
 * maps it to 4xx/5xx). Ids are caller-supplied (the route generates
 * crypto.randomUUID); they are validated against a strict charset so
 * they can never escape the store directory.
 */
const INDEX_FILE = 'index.json';
const ID_RE = /^[a-f0-9-]{8,64}$/i;
const NAME_RE = /^[\p{L}\p{N} _\-+().]{1,80}$/u;
export const MAX_CONTENT_BYTES = 512_000;
export const MAX_SCRATCHES = 200;

function assertId(id: string): void {
  if (!ID_RE.test(id)) throw new ScratchError('bad-id', `invalid scratch id: ${id}`);
}

function assertName(name: string): void {
  if (!NAME_RE.test(name)) throw new ScratchError('bad-name', `invalid scratch name: ${JSON.stringify(name)}`);
}

function storeDir(root: string): string {
  mkdirSync(root, { recursive: true });
  return root;
}

function readIndex(root: string): Record<string, ScratchMeta> {
  const dir = storeDir(root);
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, INDEX_FILE), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, ScratchMeta>;
    }
  } catch {
    // Missing or corrupt index: rebuild from disk below rather than
    // trusting garbage (fail-closed on write paths anyway).
  }
  return {};
}

function writeIndex(root: string, index: Record<string, ScratchMeta>): void {
  writeFileSync(join(storeDir(root), INDEX_FILE), JSON.stringify(index, null, 2), 'utf8');
}

function fileName(meta: ScratchMeta): string {
  const lang = languageById(meta.language);
  const ext = lang ? lang.extension : 'txt';
  return `${meta.id}.${ext}`;
}

/** Reconcile the index with the files actually on disk (defensive). */
export function listScratches(root: string): ScratchMeta[] {
  const index = readIndex(root);
  return Object.values(index).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createScratch(
  root: string,
  input: { id: string; name: string; language: string },
): ScratchMeta {
  assertId(input.id);
  assertName(input.name);
  const lang = languageById(input.language);
  if (!lang) throw new ScratchError('bad-language', `unknown language: ${input.language}`);
  const dir = storeDir(root);
  const index = readIndex(dir);
  if (Object.keys(index).length >= MAX_SCRATCHES) {
    throw new ScratchError('too-many', `scratch limit reached (${MAX_SCRATCHES})`);
  }
  if (index[input.id]) throw new ScratchError('exists', `scratch already exists: ${input.id}`);
  const now = new Date().toISOString();
  const meta: ScratchMeta = {
    id: input.id,
    name: input.name,
    language: input.language,
    createdAt: now,
    updatedAt: now,
    sizeBytes: 0,
  };
  writeFileSync(join(dir, fileName(meta)), '', 'utf8');
  index[input.id] = meta;
  writeIndex(dir, index);
  return meta;
}

export function getScratch(root: string, id: string): Scratch {
  assertId(id);
  const dir = storeDir(root);
  const meta = readIndex(dir)[id];
  if (!meta) throw new ScratchError('not-found', `scratch not found: ${id}`);
  let content = '';
  try {
    content = readFileSync(join(dir, fileName(meta)), 'utf8');
  } catch {
    throw new ScratchError('not-found', `scratch file missing: ${id}`);
  }
  return { ...meta, content };
}

export function updateScratch(
  root: string,
  id: string,
  patch: { name?: string; content?: string },
): ScratchMeta {
  assertId(id);
  if (patch.name !== undefined) assertName(patch.name);
  if (patch.content !== undefined && Buffer.byteLength(patch.content, 'utf8') > MAX_CONTENT_BYTES) {
    throw new ScratchError('too-large', `scratch content exceeds ${MAX_CONTENT_BYTES} bytes`);
  }
  const dir = storeDir(root);
  const index = readIndex(dir);
  const meta = index[id];
  if (!meta) throw new ScratchError('not-found', `scratch not found: ${id}`);
  if (patch.name !== undefined) meta.name = patch.name;
  if (patch.content !== undefined) {
    writeFileSync(join(dir, fileName(meta)), patch.content, 'utf8');
    meta.sizeBytes = Buffer.byteLength(patch.content, 'utf8');
  }
  meta.updatedAt = new Date().toISOString();
  index[id] = meta;
  writeIndex(dir, index);
  return meta;
}

export function deleteScratch(root: string, id: string): void {
  assertId(id);
  const dir = storeDir(root);
  const index = readIndex(dir);
  const meta = index[id];
  if (!meta) throw new ScratchError('not-found', `scratch not found: ${id}`);
  try {
    unlinkSync(join(dir, fileName(meta)));
  } catch {
    // File already gone: still drop the index entry (converge).
  }
  delete index[id];
  writeIndex(dir, index);
}

export function _fileNameForTest(meta: ScratchMeta): string {
  return fileName(meta);
}

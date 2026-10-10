/**
 * Import `.ai/` export files into a project directory (spec §4 module 33).
 *
 * Validation runs FIRST: if any issue is found the import is rejected and
 * NOTHING is written. On success every file is written under `targetDir`
 * (which should end in `.ai`) and the written paths are returned.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { validateImportFiles } from './validate';
import type { ExportFiles, ImportResult } from './types';

export interface ImportOptions {
  /** Directory receiving the files (normally `<projectDir>/.ai`). */
  targetDir: string;
}

function safeJoin(base: string, rel: string): string {
  const abs = resolve(join(base, rel));
  const normBase = resolve(base);
  if (abs !== normBase && !abs.startsWith(`${normBase}/`)) {
    throw new Error(`refusing to write outside target dir: ${rel}`);
  }
  return abs;
}

export function importProjectAi(files: ExportFiles, opts: ImportOptions): ImportResult {
  const issues = validateImportFiles(files);
  if (issues.length > 0) {
    return { ok: false, issues, written: [] };
  }
  const written: string[] = [];
  for (const [rel, text] of Object.entries(files)) {
    const abs = safeJoin(opts.targetDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, 'utf8');
    written.push(abs);
  }
  return { ok: true, issues: [], written };
}

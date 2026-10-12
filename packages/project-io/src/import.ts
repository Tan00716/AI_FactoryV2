/**
 * Import `.ai/` export files into a project directory (spec §4 module 33).
 *
 * Pipeline: v1→v2 migration (§52.4, see migrate-import.ts) → validation →
 * write. Migration runs FIRST so v1-shaped data is never validated or
 * stored under a v2 reading: detected v1 sections are rewritten to
 * their migrated form and the structured migration report is attached
 * to the result (and written as `.ai/migration-report.json`). Then
 * validation runs on the migrated map: if any issue is found the import
 * is rejected and NOTHING is written. On success every file is written
 * under `targetDir` (which should end in `.ai`).
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { validateImportFiles } from './validate';
import { migrateImportFiles } from './migrate-import';
import type { ExportFiles, ImportResult } from './types';

export interface ImportOptions {
  /** Directory receiving the files (normally `<projectDir>/.ai`). */
  targetDir: string;
  /**
   * Run the §52.4 v1→v2 migration before validation (default true).
   * Disabling it restores the legacy verbatim behavior — v1 data would
   * again be stored silently under a v2 reading; only for tests/tools
   * that explicitly handle v1 data themselves.
   */
  migrateV1?: boolean;
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
  let effective = files;
  let migration: ImportResult['migration'];
  if (opts.migrateV1 !== false) {
    const migrated = migrateImportFiles(files);
    effective = migrated.files;
    migration = migrated.report;
  }
  const issues = validateImportFiles(effective);
  if (issues.length > 0) {
    return { ok: false, issues, written: [], ...(migration ? { migration } : {}) };
  }
  const written: string[] = [];
  for (const [rel, text] of Object.entries(effective)) {
    const abs = safeJoin(opts.targetDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, 'utf8');
    written.push(abs);
  }
  return { ok: true, issues: [], written, ...(migration ? { migration } : {}) };
}

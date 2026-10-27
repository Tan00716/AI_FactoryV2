/**
 * Compat-file reading (round-6 R6-A6). Reads AGENTS.md / .cursorrules /
 * .clinerules at the project root, read-only. Content is returned verbatim
 * (no parsing, no semantic validation) and truncated at MAX_COMPAT_BYTES
 * with a flag, so a huge AGENTS.md cannot blow up the panel payload.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { COMPAT_FILES, MAX_COMPAT_BYTES, type CompatFile } from './types.js';

export function readCompatFiles(root: string): CompatFile[] {
  const out: CompatFile[] = [];
  for (const { source, file } of COMPAT_FILES) {
    const abs = join(root, file);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue; // Absent: not an error, just no compat file at this root.
    }
    if (!st.isFile()) continue;
    let raw: Buffer;
    try {
      raw = readFileSync(abs);
    } catch {
      continue; // Unreadable: skip rather than failing the whole view.
    }
    const truncated = raw.length > MAX_COMPAT_BYTES;
    out.push({
      source,
      file,
      content: raw.subarray(0, MAX_COMPAT_BYTES).toString('utf8'),
      sizeBytes: raw.length,
      truncated,
    });
  }
  return out;
}

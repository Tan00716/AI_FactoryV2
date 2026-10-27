/**
 * @ai-factory/datapreview — read-only table preview for data files
 * (round-6 task R6-B10).
 *
 * Formats: JSONL/NDJSON (one JSON object per line) and CSV (RFC 4180
 * shape). Malformed rows are skipped and counted, never guessed;
 * previews cap at 100,000 rows and 200 columns (fail-closed, with
 * `truncated` / `columnsTruncated` flags). The desktop panel renders
 * this package's output over HTTP; it never imports this package
 * directly, so the package ships CJS only (same as scratch/rebase/
 * watch — the dual-format exports rule applies to browser-consumed
 * packages only).
 */
export * from './types.js';
export { parseJsonl } from './jsonl.js';
export { parseCsv } from './csv.js';
export { viewDataFile } from './table.js';
import { parseCsv } from './csv.js';
import { parseJsonl } from './jsonl.js';
import { viewDataFile } from './table.js';
import {
  DataPreviewError,
  type DataPreviewFormat,
  type DataPreviewPage,
  type DataPreviewViewOptions,
  type ParsedDataFile,
} from './types.js';

/** Parse full file text into a parsed file (no view applied). */
export function parseDataFile(text: string, format: DataPreviewFormat): ParsedDataFile {
  if (format === 'jsonl') return parseJsonl(text);
  if (format === 'csv') return parseCsv(text);
  throw new DataPreviewError(`unsupported data preview format: ${format}`);
}

/** Parse full file text and apply sort/filter/paginate in one step. */
export function previewDataFile(
  text: string,
  format: DataPreviewFormat,
  opts: DataPreviewViewOptions = {},
): DataPreviewPage {
  return viewDataFile(parseDataFile(text, format), opts);
}

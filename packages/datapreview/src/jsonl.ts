/**
 * JSONL / NDJSON parsing for the data-file preview (R6-B10).
 *
 * One JSON object per line. Rules, all fail-closed (never guessed):
 *  - Blank lines are skipped silently (they carry no record).
 *  - A line that is not valid JSON, or that parses to a non-object
 *    (array, string, number, null), is skipped and counted in
 *    `malformedRows`.
 *  - Columns are the union of object keys in first-seen order, capped
 *    at DATA_PREVIEW_MAX_COLUMNS; further keys are dropped and
 *    `columnsTruncated` is set.
 *  - Rows past DATA_PREVIEW_MAX_ROWS stop the parse and set
 *    `truncated`.
 */
import {
  DATA_PREVIEW_MAX_COLUMNS,
  DATA_PREVIEW_MAX_ROWS,
  stringifyCell,
  truncateCell,
  type DataPreviewRow,
  type ParsedDataFile,
} from './types.js';

export function parseJsonl(text: string): ParsedDataFile {
  const columns: string[] = [];
  const seen = new Set<string>();
  let columnsTruncated = false;
  const rows: DataPreviewRow[] = [];
  let malformedRows = 0;
  let truncated = false;

  const lines = text.split(/\r\n|\n|\r/);
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (rows.length >= DATA_PREVIEW_MAX_ROWS) {
      truncated = true;
      break;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedRows += 1;
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      malformedRows += 1;
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (!seen.has(key)) {
        seen.add(key);
        if (columns.length < DATA_PREVIEW_MAX_COLUMNS) {
          columns.push(key);
        } else {
          columnsTruncated = true;
        }
      }
    }
    const row: DataPreviewRow = columns.map((col) => {
      const raw = Object.prototype.hasOwnProperty.call(obj, col)
        ? stringifyCell(obj[col])
        : null;
      return raw === null ? null : truncateCell(raw);
    });
    rows.push(row);
  }
  // Rows parsed before a late column appeared have fewer cells; pad them.
  for (const row of rows) {
    while (row.length < columns.length) row.push(null);
  }
  return { format: 'jsonl', columns, columnsTruncated, rows, malformedRows, truncated };
}

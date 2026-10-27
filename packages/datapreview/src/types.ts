/**
 * Shared types and limits for the data-file preview package (R6-B10).
 *
 * The preview is READ-ONLY: it never writes back to the file, and it
 * never guesses a format. A row that cannot be parsed is skipped and
 * counted in `malformedRows`, never silently repaired or coerced.
 */

/** Supported preview formats. */
export type DataPreviewFormat = 'jsonl' | 'csv';

/** File extensions mapped to a format (lowercased, with leading dot). */
export const DATA_PREVIEW_EXTENSIONS: Record<string, DataPreviewFormat> = {
  '.jsonl': 'jsonl',
  '.ndjson': 'jsonl',
  '.csv': 'csv',
};

/** Maximum data rows kept per preview (report: 10 万行分页). */
export const DATA_PREVIEW_MAX_ROWS = 100_000;

/** Maximum columns kept per preview; further keys are dropped. */
export const DATA_PREVIEW_MAX_COLUMNS = 200;

/** Maximum page size a caller may request. */
export const DATA_PREVIEW_MAX_PAGE_SIZE = 500;

/** Default page size when the caller does not specify one. */
export const DATA_PREVIEW_DEFAULT_PAGE_SIZE = 100;

/** Maximum characters kept per cell; longer cells are truncated. */
export const DATA_PREVIEW_MAX_CELL_CHARS = 4096;

/** Maximum file size the server route accepts (64 MiB). */
export const DATA_PREVIEW_MAX_FILE_BYTES = 64 * 1024 * 1024;

export class DataPreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataPreviewError';
  }
}

/** One parsed row: cell values aligned with `columns` (null = missing). */
export type DataPreviewRow = Array<string | null>;

/** Raw parse outcome, before sort/filter/paginate. */
export interface ParsedDataFile {
  format: DataPreviewFormat;
  columns: string[];
  /** True when more than MAX_COLUMNS distinct keys existed. */
  columnsTruncated: boolean;
  rows: DataPreviewRow[];
  /** Rows skipped because they could not be parsed (never guessed). */
  malformedRows: number;
  /** True when the file held more than MAX_ROWS data rows. */
  truncated: boolean;
}

/** Sort/filter/page request applied on top of a parsed file. */
export interface DataPreviewViewOptions {
  page?: number;
  pageSize?: number;
  sortColumn?: string;
  sortDir?: 'asc' | 'desc';
  filter?: string;
}

/** The paged view the desktop panel renders. */
export interface DataPreviewPage {
  format: DataPreviewFormat;
  columns: string[];
  columnsTruncated: boolean;
  /** Valid rows before filtering. */
  totalRows: number;
  /** Rows remaining after filtering. */
  filteredRows: number;
  malformedRows: number;
  truncated: boolean;
  page: number;
  pageSize: number;
  totalPages: number;
  rows: DataPreviewRow[];
}

/** Detect the format from a file name, or null when unknown. */
export function detectDataPreviewFormat(fileName: string): DataPreviewFormat | null {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return null;
  return DATA_PREVIEW_EXTENSIONS[fileName.slice(dot).toLowerCase()] ?? null;
}

/** Normalize a raw cell value for display. */
export function stringifyCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Objects/arrays render as compact JSON so the table stays one row per record.
  return JSON.stringify(value);
}

/** Truncate one cell to the cell cap (suffix marks the cut). */
export function truncateCell(cell: string | null): string | null {
  if (cell === null) return null;
  if (cell.length <= DATA_PREVIEW_MAX_CELL_CHARS) return cell;
  return cell.slice(0, DATA_PREVIEW_MAX_CELL_CHARS) + '…[truncated]';
}

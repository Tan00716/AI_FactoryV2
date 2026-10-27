/**
 * Sort / filter / paginate over a parsed data file (R6-B10).
 *
 * Sort is stable and nulls sort last in both directions. When both
 * compared cells parse as finite numbers they compare numerically,
 * otherwise by code-unit string order — no locale guessing.
 * Filter is a case-insensitive substring match across every cell.
 */
import {
  DATA_PREVIEW_DEFAULT_PAGE_SIZE,
  DATA_PREVIEW_MAX_PAGE_SIZE,
  type DataPreviewPage,
  type DataPreviewViewOptions,
  type ParsedDataFile,
} from './types.js';

function compareCells(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const na = Number(a);
  const nb = Number(b);
  if (a.trim() !== '' && b.trim() !== '' && Number.isFinite(na) && Number.isFinite(nb)) {
    return na - nb;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export function viewDataFile(parsed: ParsedDataFile, opts: DataPreviewViewOptions): DataPreviewPage {
  const pageSizeRaw = opts.pageSize ?? DATA_PREVIEW_DEFAULT_PAGE_SIZE;
  const pageSize = Math.max(1, Math.min(DATA_PREVIEW_MAX_PAGE_SIZE, Math.floor(pageSizeRaw) || DATA_PREVIEW_DEFAULT_PAGE_SIZE));
  const filter = (opts.filter ?? '').trim().toLowerCase();

  let rows = parsed.rows;
  if (filter !== '') {
    rows = rows.filter((row) =>
      row.some((cell) => cell !== null && cell.toLowerCase().includes(filter)),
    );
  }
  if (opts.sortColumn !== undefined) {
    const colIdx = parsed.columns.indexOf(opts.sortColumn);
    if (colIdx >= 0) {
      const dir = opts.sortDir === 'desc' ? -1 : 1;
      rows = rows
        .map((row, idx) => ({ row, idx }))
        .sort((x, y) => {
          const c = compareCells(x.row[colIdx] ?? null, y.row[colIdx] ?? null);
          return c !== 0 ? c * dir : x.idx - y.idx;
        })
        .map((entry) => entry.row);
    }
  }
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.max(1, Math.min(opts.page ?? 1, totalPages));
  const start = (page - 1) * pageSize;
  return {
    format: parsed.format,
    columns: parsed.columns,
    columnsTruncated: parsed.columnsTruncated,
    totalRows: parsed.rows.length,
    filteredRows: rows.length,
    malformedRows: parsed.malformedRows,
    truncated: parsed.truncated,
    page,
    pageSize,
    totalPages,
    rows: rows.slice(start, start + pageSize),
  };
}

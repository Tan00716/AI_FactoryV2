/**
 * CSV parsing for the data-file preview (R6-B10) — RFC 4180 shape:
 *  - Fields separated by commas; a field may be double-quoted.
 *  - Inside a quoted field, `""` is one literal quote; commas, CR, LF
 *    and CRLF inside quotes are data, not record separators.
 *  - The first record is the header. Empty header cells become
 *    `column_<n>` (1-based); duplicate header names gain a `_2`, `_3`
 *    suffix so every column is addressable.
 *  - Ragged rows are padded with null / extra fields dropped (real
 *    exports are ragged; padding is not a parse failure).
 *  - A record whose quoted field never terminates before EOF is
 *    malformed: it is skipped and counted, never guessed.
 *  - Rows past DATA_PREVIEW_MAX_ROWS stop the parse and set
 *    `truncated`. The header does not count as a data row.
 */
import {
  DATA_PREVIEW_MAX_COLUMNS,
  DATA_PREVIEW_MAX_ROWS,
  truncateCell,
  type DataPreviewRow,
  type ParsedDataFile,
} from './types.js';

interface CsvRecord {
  fields: string[];
  /** True when the record ended in an unterminated quoted field. */
  unterminated: boolean;
}

function parseCsvRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldQuoted = false;
  let recordHasContent = false;

  const endField = (): void => {
    fields.push(field);
    field = '';
    fieldQuoted = false;
  };
  const endRecord = (unterminated: boolean): void => {
    endField();
    records.push({ fields, unterminated });
    fields = [];
    recordHasContent = false;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    recordHasContent = true;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '' && !fieldQuoted) {
      inQuotes = true;
      fieldQuoted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      endRecord(false);
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endRecord(false);
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (inQuotes) {
    // Unterminated quoted field: the dangling record is malformed.
    records.push({ fields: [...fields, field], unterminated: true });
  } else if (recordHasContent || field !== '' || fields.length > 0) {
    endRecord(false);
  }
  return records;
}

function dedupeHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, idx) => {
    const base = h === '' ? `column_${idx + 1}` : h;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}

export function parseCsv(text: string): ParsedDataFile {
  const records = parseCsvRecords(text);
  let malformedRows = 0;
  let truncated = false;
  // The header is the first well-formed record; leading malformed
  // records are skipped and counted, never treated as a header.
  let headerIdx = -1;
  for (let k = 0; k < records.length; k += 1) {
    if ((records[k] as CsvRecord).unterminated) {
      malformedRows += 1;
      continue;
    }
    headerIdx = k;
    break;
  }
  if (headerIdx < 0) {
    return {
      format: 'csv',
      columns: [],
      columnsTruncated: false,
      rows: [],
      malformedRows,
      truncated: false,
    };
  }
  const rawHeader = (records[headerIdx] as CsvRecord).fields;
  const columnsTruncated = rawHeader.length > DATA_PREVIEW_MAX_COLUMNS;
  const columns = dedupeHeaders(rawHeader.slice(0, DATA_PREVIEW_MAX_COLUMNS));
  const rows: DataPreviewRow[] = [];
  for (let k = headerIdx + 1; k < records.length; k += 1) {
    const rec = records[k] as CsvRecord;
    if (rec.unterminated) {
      malformedRows += 1;
      continue;
    }
    // A record that is a single empty field is a blank line: skip silently.
    if (rec.fields.length === 1 && rec.fields[0] === '') continue;
    if (rows.length >= DATA_PREVIEW_MAX_ROWS) {
      truncated = true;
      break;
    }
    rows.push(
      columns.map((_, c) =>
        c < rec.fields.length ? truncateCell(rec.fields[c] as string) : null,
      ),
    );
  }
  return { format: 'csv', columns, columnsTruncated, rows, malformedRows, truncated };
}

import { useCallback, useState } from 'react';
import { api, type DataPreviewPage } from '../api';
import { useLang } from '../i18n';

/**
 * Data-file preview panel (round-6 task R6-B10) — one workspace file
 * rendered as a read-only table (JSONL/NDJSON/CSV).
 *
 * HONEST BOUNDARIES (rendered in the UI footer):
 *  - Read-only: there is no edit or write-back path in this panel.
 *  - This is a FILE preview, not the database browser (round-4 A5):
 *    it reads one workspace file, it never opens a database.
 *  - Previews cap at 100,000 rows and 200 columns; beyond that the
 *    table reports `truncated` / `columnsTruncated` instead of
 *    loading more.
 *  - Malformed rows are skipped and counted, never guessed or
 *    repaired; the count is shown next to the table.
 */
export function DataPreviewPanel({ projectRoot }: { projectRoot: string }) {
  const { t } = useLang();
  const [relPath, setRelPath] = useState('');
  const [page, setPage] = useState<DataPreviewPage | null>(null);
  const [pageNo, setPageNo] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [sortColumn, setSortColumn] = useState<string | undefined>(undefined);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [filter, setFilter] = useState('');
  const [filterInput, setFilterInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(
    async (overrides?: { page?: number; sortColumn?: string; sortDir?: 'asc' | 'desc'; filter?: string }) => {
      if (relPath.trim() === '') return;
      setLoading(true);
      setErr(null);
      try {
        const next = await api.datapreviewPreview({
          root: projectRoot || undefined,
          path: relPath.trim(),
          page: overrides?.page ?? pageNo,
          pageSize,
          sortColumn: overrides?.sortColumn ?? sortColumn,
          sortDir: overrides?.sortDir ?? sortDir,
          filter: overrides?.filter ?? filter,
        });
        setPage(next);
        setPageNo(next.page);
      } catch (e) {
        setErr((e as Error).message);
        setPage(null);
      } finally {
        setLoading(false);
      }
    },
    [relPath, projectRoot, pageNo, pageSize, sortColumn, sortDir, filter],
  );

  const onSort = (col: string) => {
    if (sortColumn === col) {
      const dir = sortDir === 'asc' ? 'desc' : 'asc';
      setSortDir(dir);
      void load({ page: 1, sortColumn: col, sortDir: dir });
    } else {
      setSortColumn(col);
      setSortDir('asc');
      void load({ page: 1, sortColumn: col, sortDir: 'asc' });
    }
    setPageNo(1);
  };

  return (
    <div className="panel">
      <h3>{t('datapreview.title')}</h3>
      <div className="row">
        <input
          value={relPath}
          onChange={(e) => setRelPath(e.target.value)}
          placeholder={t('datapreview.pathPlaceholder')}
          style={{ flex: 1 }}
        />
        <button
          disabled={loading || relPath.trim() === ''}
          onClick={() => {
            setPageNo(1);
            void load({ page: 1 });
          }}
        >
          {t('datapreview.load')}
        </button>
      </div>
      {page !== null && (
        <div className="row">
          <input
            value={filterInput}
            onChange={(e) => setFilterInput(e.target.value)}
            placeholder={t('datapreview.filterPlaceholder')}
            style={{ flex: 1 }}
          />
          <button
            onClick={() => {
              setFilter(filterInput);
              setPageNo(1);
              void load({ page: 1, filter: filterInput });
            }}
          >
            {t('datapreview.filter')}
          </button>
          <label>
            {t('datapreview.pageSize')}
            <select
              value={pageSize}
              onChange={(e) => {
                const next = Number(e.target.value);
                setPageSize(next);
                setPageNo(1);
              }}
            >
              {[25, 50, 100, 250, 500].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {loading && <div>{t('datapreview.loading')}</div>}
      {err !== null && <div className="banner err">{err}</div>}
      {page !== null && (
        <>
          <div className="row">
            <span>
              {t('datapreview.format')}: {page.format} · {t('datapreview.rows')}: {page.filteredRows} / {page.totalRows}
              {page.malformedRows > 0 && ` · ${t('datapreview.malformed')}: ${page.malformedRows}`}
              {page.truncated && ` · ${t('datapreview.truncated')}`}
              {page.columnsTruncated && ` · ${t('datapreview.columnsTruncated')}`}
            </span>
            <span style={{ marginLeft: 'auto' }}>
              <button disabled={page.page <= 1 || loading} onClick={() => void load({ page: page.page - 1 })}>
                {t('datapreview.prev')}
              </button>
              {' '}
              {page.page} / {page.totalPages}
              {' '}
              <button disabled={page.page >= page.totalPages || loading} onClick={() => void load({ page: page.page + 1 })}>
                {t('datapreview.next')}
              </button>
            </span>
          </div>
          <div style={{ overflow: 'auto', maxHeight: '60vh' }}>
            <table>
              <thead>
                <tr>
                  {page.columns.map((col) => (
                    <th key={col} onClick={() => onSort(col)} style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}>
                      {col}
                      {sortColumn === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.rows.map((row, r) => (
                  <tr key={r}>
                    {page.columns.map((col, c) => (
                      <td key={col} style={{ maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row[c] ?? ''}>
                        {row[c] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {page.rows.length === 0 && <div>{t('datapreview.empty')}</div>}
        </>
      )}
      <div className="footer">{t('datapreview.honest')}</div>
    </div>
  );
}

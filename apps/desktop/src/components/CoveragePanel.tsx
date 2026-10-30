import { useCallback, useEffect, useState } from 'react';
import { authHeaders } from '../api';
import { useLang } from '../i18n';
import { EmptyState } from './EmptyState';

/** Server response shapes (subset of apps/server/src/coverage.ts). */
export interface CoverageSummaryView {
  files: number;
  totalLines: number;
  coveredLines: number;
  coverage: number;
}

export interface CoverageHistoryView {
  at: string;
  format: string;
  trigger: string;
  summary: CoverageSummaryView;
}

export interface CoverageFileView {
  path: string;
  totalLines: number;
  coveredLines: number;
  coverage: number;
}

export interface CoverageFileDetailView extends CoverageFileView {
  lines: Record<string, number>;
}

export interface CoverageApi {
  summary(projectId: string): Promise<{
    projectId: string;
    latest: { format: string; reportPath: string; at: string; summary: CoverageSummaryView } | null;
    history: CoverageHistoryView[];
  }>;
  files(projectId: string): Promise<{ projectId: string; at: string | null; files: CoverageFileView[] }>;
  file(projectId: string, path: string): Promise<CoverageFileDetailView>;
  importReport(
    projectId: string,
    reportPath: string,
    format?: string,
  ): Promise<{ projectId: string; format: string; summary: CoverageSummaryView; at: string }>;
  readSource(path: string): Promise<string | null>;
}

export function createCoverageApi(base: string): CoverageApi {
  async function req<T>(p: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${base}${p}`, { headers: { ...authHeaders() }, ...init });
    const body = (await res.json()) as T;
    if (!res.ok) {
      const err = body as { error?: string };
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    return body;
  }
  return {
    summary: (projectId) => req(`/coverage/summary?projectId=${encodeURIComponent(projectId)}`),
    files: (projectId) => req(`/coverage/files?projectId=${encodeURIComponent(projectId)}`),
    file: (projectId, path) =>
      req(`/coverage/file?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`),
    importReport: (projectId, reportPath, format) =>
      req('/coverage/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, reportPath, ...(format ? { format } : {}) }),
      }),
    readSource: async (path) => {
      // Reuses the existing workspace file read (routes/files.ts). A
      // null result is handled honestly in the UI: the line hit map is
      // still shown, just without source text.
      try {
        const res = await fetch(`${base}/file?path=${encodeURIComponent(path)}`, {
          headers: { ...authHeaders() },
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { content?: string };
        return typeof body.content === 'string' ? body.content : null;
      } catch {
        return null;
      }
    },
  };
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

/** Per-file coverage badge: a tiny colored bar + % (also the "file tree"
 * surface for coverage — the file list is sorted worst-first). */
export function CoverageBadge({ coverage }: { coverage: number }) {
  const color = coverage >= 0.9 ? '#3fb950' : coverage >= 0.6 ? '#d29922' : '#f85149';
  return (
    <span
      className="coverage-badge"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        minWidth: 130,
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: 64,
          height: 6,
          borderRadius: 3,
          background: 'rgba(127,127,127,0.25)',
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            display: 'block',
            width: `${Math.round(coverage * 100)}%`,
            height: '100%',
            background: color,
          }}
        />
      </span>
      <span style={{ color }}>{pct(coverage)}</span>
    </span>
  );
}

const MAX_RENDER_LINES = 2000;

export function CoveragePanel({ api, projectId }: { api: CoverageApi; projectId: string }) {
  const { t } = useLang();
  const [latest, setLatest] = useState<{
    format: string;
    reportPath: string;
    at: string;
    summary: CoverageSummaryView;
  } | null>(null);
  const [history, setHistory] = useState<CoverageHistoryView[]>([]);
  const [files, setFiles] = useState<CoverageFileView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<CoverageFileDetailView | null>(null);
  const [source, setSource] = useState<string[] | null>(null);
  const [sourceMissing, setSourceMissing] = useState(false);
  const [reportPath, setReportPath] = useState('');
  const [format, setFormat] = useState<'auto' | 'lcov' | 'cobertura' | 'v8'>('auto');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [sum, fs] = await Promise.all([api.summary(projectId), api.files(projectId)]);
      setLatest(sum.latest);
      setHistory(sum.history);
      setFiles(fs.files);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, [api, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openFile = useCallback(
    async (path: string) => {
      setSelected(path);
      setDetail(null);
      setSource(null);
      setSourceMissing(false);
      try {
        const d = await api.file(projectId, path);
        setDetail(d);
        const text = await api.readSource(path);
        if (text === null) {
          setSourceMissing(true);
        } else {
          setSource(text.split('\n'));
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    },
    [api, projectId],
  );

  const doImport = useCallback(async () => {
    const p = reportPath.trim();
    if (!p) return;
    setBusy(true);
    setErr(null);
    try {
      await api.importReport(projectId, p, format === 'auto' ? undefined : format);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [api, projectId, reportPath, format, refresh]);

  const previous = history.length >= 2 ? history[history.length - 2] : null;
  const delta = latest && previous ? latest.summary.coverage - previous.summary.coverage : null;

  return (
    <div className="coverage-panel" style={{ padding: 16, overflowY: 'auto' }}>
      {files.length === 0 && <EmptyState panel="coverage" />}
      <h2 style={{ marginTop: 0 }}>{t('coverage.title')}</h2>
      <p style={{ opacity: 0.8 }}>{t('coverage.subtitle')}</p>
      <p style={{ opacity: 0.7, fontStyle: 'italic' }}>{t('coverage.honestNote')}</p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0' }}>
        <input
          value={reportPath}
          onChange={(e) => setReportPath(e.target.value)}
          placeholder={t('coverage.importPlaceholder')}
          style={{ flex: '1 1 320px', padding: '6px 8px' }}
          aria-label={t('coverage.importLabel')}
        />
        <select value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
          <option value="auto">{t('coverage.formatAuto')}</option>
          <option value="lcov">lcov</option>
          <option value="cobertura">cobertura</option>
          <option value="v8">v8 JSON</option>
        </select>
        <button onClick={() => void doImport()} disabled={busy || !reportPath.trim()}>
          {busy ? t('coverage.importing') : t('coverage.import')}
        </button>
      </div>
      <p style={{ opacity: 0.7 }}>{t('coverage.importHint')}</p>
      <p style={{ opacity: 0.7 }}>{t('coverage.gateHint')}</p>

      {err && <div className="banner err">{err}</div>}

      {!loaded ? (
        <p>{t('coverage.loading')}</p>
      ) : !latest ? (
        <p>{t('coverage.noData')}</p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', margin: '12px 0' }}>
            <div>
              <div style={{ opacity: 0.7 }}>{t('coverage.total')}</div>
              <div style={{ fontSize: 28 }}>
                {pct(latest.summary.coverage)}
                {delta !== null && (
                  <span style={{ fontSize: 14, marginLeft: 8, color: delta >= 0 ? '#3fb950' : '#f85149' }}>
                    {t('coverage.deltaVsPrev', { delta: `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}pt` })}
                  </span>
                )}
              </div>
            </div>
            <div>
              <div style={{ opacity: 0.7 }}>{t('coverage.lines')}</div>
              <div style={{ fontSize: 20 }}>
                {latest.summary.coveredLines}/{latest.summary.totalLines}
              </div>
            </div>
            <div>
              <div style={{ opacity: 0.7 }}>{t('coverage.files')}</div>
              <div style={{ fontSize: 20 }}>{latest.summary.files}</div>
            </div>
            <div>
              <div style={{ opacity: 0.7 }}>{t('coverage.updated')}</div>
              <div style={{ fontSize: 14 }}>
                {new Date(latest.at).toLocaleString()} · {latest.format}
              </div>
              <div style={{ fontSize: 12, opacity: 0.6 }}>{latest.reportPath}</div>
            </div>
          </div>

          {history.length >= 2 && (
            <div style={{ margin: '8px 0' }}>
              <div style={{ opacity: 0.7, marginBottom: 4 }}>{t('coverage.trend')}</div>
              <svg width={Math.min(600, history.length * 28)} height={48} role="img" aria-label="coverage trend">
                <polyline
                  fill="none"
                  stroke="#58a6ff"
                  strokeWidth={2}
                  points={history
                    .map((h, i) => `${8 + i * 28},${44 - h.summary.coverage * 40}`)
                    .join(' ')}
                />
                {history.map((h, i) => (
                  <circle key={i} cx={8 + i * 28} cy={44 - h.summary.coverage * 40} r={2.5} fill="#58a6ff" />
                ))}
              </svg>
              <div style={{ fontSize: 12, opacity: 0.7 }}>
                {history.map((h) => pct(h.summary.coverage)).join(' → ')}
              </div>
            </div>
          )}

          {!selected ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '4px 8px' }}>{t('coverage.fileCol')}</th>
                  <th style={{ textAlign: 'left', padding: '4px 8px' }}>{t('coverage.total')}</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px' }}>{t('coverage.lines')}</th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.path} style={{ borderTop: '1px solid rgba(127,127,127,0.2)' }}>
                    <td style={{ padding: '4px 8px' }}>
                      <button onClick={() => void openFile(f.path)} style={{ textAlign: 'left' }}>
                        {f.path}
                      </button>
                    </td>
                    <td style={{ padding: '4px 8px' }}>
                      <CoverageBadge coverage={f.coverage} />
                    </td>
                    <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                      {f.coveredLines}/{f.totalLines}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div>
              <button onClick={() => setSelected(null)}>{t('coverage.back')}</button>
              <h3 style={{ marginBottom: 4 }}>{selected}</h3>
              {detail && (
                <>
                  <CoverageBadge coverage={detail.coverage} />
                  <span style={{ marginLeft: 12 }}>
                    {detail.coveredLines}/{detail.totalLines}
                  </span>
                  <p style={{ opacity: 0.7 }}>{t('coverage.lineLegend')}</p>
                  {sourceMissing && <p style={{ opacity: 0.7 }}>{t('coverage.sourceMissing')}</p>}
                  <div
                    style={{
                      fontFamily: 'ui-monospace, monospace',
                      fontSize: 12,
                      overflowX: 'auto',
                      whiteSpace: 'pre',
                      border: '1px solid rgba(127,127,127,0.25)',
                      borderRadius: 4,
                    }}
                  >
                    {(() => {
                      if (source) {
                        const shown = source.slice(0, MAX_RENDER_LINES);
                        return (
                          <>
                            {shown.map((textLine, i) => {
                              const lineNo = i + 1;
                              const hits = detail.lines[String(lineNo)];
                              const bg =
                                hits === undefined
                                  ? 'transparent'
                                  : hits > 0
                                    ? 'rgba(63,185,80,0.18)'
                                    : 'rgba(248,81,73,0.18)';
                              return (
                                <div key={lineNo} style={{ background: bg, padding: '0 6px' }}>
                                  <span style={{ opacity: 0.5, marginRight: 10, userSelect: 'none' }}>
                                    {lineNo}
                                  </span>
                                  {hits !== undefined && (
                                    <span style={{ opacity: 0.6, marginRight: 10, userSelect: 'none' }}>
                                      ×{hits}
                                    </span>
                                  )}
                                  <span>{textLine || ' '}</span>
                                </div>
                              );
                            })}
                            {source.length > MAX_RENDER_LINES && <div>{t('coverage.truncatedNote')}</div>}
                          </>
                        );
                      }
                      // No source text: show the hit map itself (line numbers + counts).
                      return Object.entries(detail.lines)
                        .map(([ln, hits]) => ({ ln: Number(ln), hits }))
                        .sort((a, b) => a.ln - b.ln)
                        .slice(0, MAX_RENDER_LINES)
                        .map(({ ln, hits }) => (
                          <div
                            key={ln}
                            style={{ background: hits > 0 ? 'rgba(63,185,80,0.18)' : 'rgba(248,81,73,0.18)', padding: '0 6px' }}
                          >
                            <span style={{ opacity: 0.5, marginRight: 10 }}>{ln}</span>×{hits}
                          </div>
                        ));
                    })()}
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

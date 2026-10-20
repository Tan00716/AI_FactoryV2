import { useCallback, useEffect, useState } from 'react';
import { defaultApiBase, authHeaders } from '../api';
import { useLang } from '../i18n';

/**
 * Problems panel (task ③) — structured diagnostics parsed by the
 * server-side problem matchers from terminal / quality-gate /
 * scheduler command output. Rows are clickable: they jump to the
 * reported file:line and show the surrounding source lines.
 *
 * HONEST BOUNDARIES (rendered in the UI, not just here):
 *  - Regex matching is not an LSP: non-standard output can produce
 *    false positives/negatives; the parse rate is shown as-is.
 *  - The panel only shows diagnostics that were actually parsed from
 *    output that was actually produced. Nothing ran → nothing shown.
 */

export interface ProblemDiagnostic {
  source: 'terminal' | 'quality-gate' | 'scheduler' | 'manual';
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  matcher: string;
  at: string;
}

interface ParseStats {
  lines: number;
  matchedLines: number;
  skippedLines: number;
  diagnostics: number;
  matchers: string[];
  matchRate: number;
  truncated: boolean;
}

interface MatcherMeta {
  name: string;
  description: string;
  builtin: boolean;
  patterns: Array<{ regexp: string }>;
}

const SOURCES = ['all', 'terminal', 'quality-gate', 'scheduler', 'manual'] as const;

async function apiReq<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${defaultApiBase()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error((body.error as string) ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export function ProblemsPanel({ projectId }: { projectId: string }) {
  const { t } = useLang();
  const [diags, setDiags] = useState<ProblemDiagnostic[]>([]);
  const [stats, setStats] = useState<Partial<Record<string, ParseStats>>>({});
  const [evicted, setEvicted] = useState(false);
  const [filter, setFilter] = useState<(typeof SOURCES)[number]>('all');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ key: string; lines: Array<{ n: number; text: string }> | null; failed: boolean } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // matcher config + dry-run tester
  const [showMatchers, setShowMatchers] = useState(false);
  const [builtins, setBuiltins] = useState<MatcherMeta[]>([]);
  const [enabled, setEnabled] = useState<string[]>([]);
  const [testText, setTestText] = useState('');
  const [testMatcher, setTestMatcher] = useState<string>('');
  const [testResult, setTestResult] = useState<{ diagnostics: ProblemDiagnostic[]; stats: ParseStats } | null>(null);
  const [testErr, setTestErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiReq<{ diagnostics: ProblemDiagnostic[]; lastStats: Partial<Record<string, ParseStats>>; evicted: boolean }>(
        `/problem-matchers/diagnostics?projectId=${encodeURIComponent(projectId)}`,
      );
      setDiags(r.diagnostics);
      setStats(r.lastStats);
      setEvicted(r.evicted);
      setErr(null);
    } catch (e) {
      setErr(t('problems.err', { message: e instanceof Error ? e.message : String(e) }));
    }
  }, [projectId, t]);

  const loadConfig = useCallback(async () => {
    try {
      const r = await apiReq<{ builtins: MatcherMeta[]; enabled: string[] }>(
        `/problem-matchers?projectId=${encodeURIComponent(projectId)}`,
      );
      setBuiltins(r.builtins);
      setEnabled(r.enabled);
    } catch {
      /* config section is enhancement-only */
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    void loadConfig();
    const iv = setInterval(() => void load(), 8000);
    return () => clearInterval(iv);
  }, [load, loadConfig]);

  const collect = useCallback(
    async (source: 'terminal' | 'scheduler') => {
      setBusy(true);
      setErr(null);
      try {
        await apiReq('/problem-matchers/collect', {
          method: 'POST',
          body: JSON.stringify({ projectId, source }),
        });
        await load();
      } catch (e) {
        setErr(t('problems.err', { message: e instanceof Error ? e.message : String(e) }));
      } finally {
        setBusy(false);
      }
    },
    [projectId, load, t],
  );

  const clearAll = useCallback(async () => {
    setBusy(true);
    try {
      await apiReq('/problem-matchers/clear', {
        method: 'POST',
        body: JSON.stringify({ projectId }),
      });
      await load();
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  }, [projectId, load]);

  const toggleDiag = useCallback(
    async (d: ProblemDiagnostic, key: string) => {
      if (openKey === key) {
        setOpenKey(null);
        setPreview(null);
        return;
      }
      setOpenKey(key);
      setPreview({ key, lines: null, failed: false });
      try {
        const res = await fetch(`${defaultApiBase()}/file?path=${encodeURIComponent(d.file)}`, {
          headers: { ...authHeaders() },
        });
        if (!res.ok) throw new Error('unreadable');
        const body = (await res.json()) as { content?: string };
        const all = (body.content ?? '').split('\n');
        const from = Math.max(1, d.line - 3);
        const to = Math.min(all.length, Math.max(d.line, 1) + 3);
        const lines = [] as Array<{ n: number; text: string }>;
        for (let n = from; n <= to; n++) lines.push({ n, text: all[n - 1] ?? '' });
        setPreview({ key, lines, failed: false });
      } catch {
        setPreview({ key, lines: null, failed: true });
      }
    },
    [openKey],
  );

  const copyLoc = useCallback(
    async (d: ProblemDiagnostic, key: string) => {
      const loc = `${d.file}:${d.line}${d.column ? `:${d.column}` : ''}`;
      try {
        await navigator.clipboard.writeText(loc);
        setCopied(key);
        setTimeout(() => setCopied(null), 1500);
      } catch {
        /* clipboard unavailable in this context */
      }
    },
    [],
  );

  const toggleMatcher = useCallback(
    async (name: string, on: boolean) => {
      const next = on ? [...enabled, name] : enabled.filter((n) => n !== name);
      setEnabled(next);
      try {
        await apiReq('/problem-matchers', {
          method: 'PUT',
          body: JSON.stringify({ projectId, enabled: next }),
        });
      } catch {
        void loadConfig();
      }
    },
    [enabled, projectId, loadConfig],
  );

  const runTest = useCallback(async () => {
    setTestErr(null);
    try {
      const r = await apiReq<{ diagnostics: ProblemDiagnostic[]; stats: ParseStats }>('/problem-matchers/test', {
        method: 'POST',
        body: JSON.stringify({
          projectId,
          text: testText,
          ...(testMatcher ? { matcher: testMatcher } : {}),
        }),
      });
      setTestResult(r);
    } catch (e) {
      setTestErr(e instanceof Error ? e.message : String(e));
    }
  }, [projectId, testText, testMatcher]);

  const sevLabel = (s: ProblemDiagnostic['severity']) =>
    s === 'error' ? t('problems.sevError') : s === 'warning' ? t('problems.sevWarning') : t('problems.sevInfo');
  const srcLabel = (s: string) =>
    s === 'terminal'
      ? t('problems.sourceTerminal')
      : s === 'quality-gate'
        ? t('problems.sourceQuality')
        : s === 'scheduler'
          ? t('problems.sourceScheduler')
          : t('problems.sourceManual');

  const visible = filter === 'all' ? diags : diags.filter((d) => d.source === filter);

  return (
    <div className="problems-panel">
      <div className="act-toolbar">
        {SOURCES.map((s) => (
          <button key={s} className={filter === s ? 'pill active' : 'pill'} onClick={() => setFilter(s)}>
            {s === 'all' ? t('problems.filterAll') : srcLabel(s)}
          </button>
        ))}
        <button className="link" disabled={busy} onClick={() => void collect('terminal')}>
          {t('problems.collectTerminal')}
        </button>
        <button className="link" disabled={busy} onClick={() => void collect('scheduler')}>
          {t('problems.collectScheduler')}
        </button>
        <button className="link" onClick={() => void load()}>
          {t('problems.refresh')}
        </button>
        <button className="link" disabled={busy || diags.length === 0} onClick={() => void clearAll()}>
          {t('problems.clear')}
        </button>
        <span className="muted">{t('problems.collectQualityNote')}</span>
        <button className="link" onClick={() => setShowMatchers((v) => !v)}>
          {t('problems.matcherTitle')}
        </button>
      </div>
      <div className="muted" style={{ margin: '2px 0 6px' }}>
        {t('problems.honestNote')}
      </div>
      {Object.entries(stats).map(([src, st]) =>
        st ? (
          <div key={src} className="muted">
            {srcLabel(src)}:{' '}
            {t('problems.matchRate', {
              matched: String(st.matchedLines),
              lines: String(st.lines),
              rate: String(Math.round(st.matchRate * 100)),
            })}
            {st.truncated ? ' ⚠' : ''}
          </div>
        ) : null,
      )}
      {evicted && <div className="pill warn">{t('problems.evicted')}</div>}
      {err && <span className="pill warn">{err}</span>}
      {visible.length === 0 && !err && <div className="muted">{t('problems.empty')}</div>}
      <div className="problems-list">
        {visible.map((d, i) => {
          const key = `${d.source}|${d.file}|${d.line}|${d.column}|${d.message}|${i}`;
          const isOpen = openKey === key;
          return (
            <div key={key} className="problem-row">
              <button className="problem-head" onClick={() => void toggleDiag(d, key)}>
                <span className={`pill sev-${d.severity}`}>{sevLabel(d.severity)}</span>
                <span className="mono">
                  {d.file}:{d.line}
                  {d.column ? `:${d.column}` : ''}
                </span>
                <span className="problem-msg">{d.message}</span>
                <span className="pill">{srcLabel(d.source)}</span>
                <span className="muted">{d.matcher}</span>
              </button>
              {isOpen && (
                <div className="problem-detail">
                  {preview?.key === key && preview.failed && (
                    <div className="muted">{t('problems.filePreviewFail')}</div>
                  )}
                  {preview?.key === key && preview.lines && (
                    <pre className="problem-code">
                      {preview.lines
                        .map((l) => `${l.n === d.line ? '>' : ' '} ${String(l.n).padStart(4)} | ${l.text}`)
                        .join('\n')}
                    </pre>
                  )}
                  <button className="link" onClick={() => void copyLoc(d, key)}>
                    {copied === key ? t('problems.copied') : t('problems.copy')}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {showMatchers && (
        <div className="problem-matchers-box">
          <h4>{t('problems.matcherTitle')}</h4>
          {builtins.map((m) => (
            <div key={m.name} className="matcher-row">
              <label>
                <input
                  type="checkbox"
                  checked={enabled.includes(m.name)}
                  onChange={(e) => void toggleMatcher(m.name, e.target.checked)}
                />{' '}
                <b className="mono">{m.name}</b>
              </label>
              <span className="muted">{m.description}</span>
              <div className="mono muted">{m.patterns[0]?.regexp}</div>
            </div>
          ))}
          <h4>{t('problems.matcherTest')}</h4>
          <div className="muted">{t('problems.matcherTestHint')}</div>
          <textarea
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            rows={5}
            style={{ width: '100%' }}
            placeholder={'src/app.ts(12,7): error TS2322: Type \'string\' is not assignable to type \'number\'.'}
          />
          <div className="act-toolbar">
            <select value={testMatcher} onChange={(e) => setTestMatcher(e.target.value)}>
              <option value="">{t('problems.matcherAll')}</option>
              {builtins.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
            <button className="pill" onClick={() => void runTest()}>
              {t('problems.matcherRun')}
            </button>
            {testErr && <span className="pill warn">{testErr}</span>}
          </div>
          {testResult && (
            <div>
              <div className="muted">
                {t('problems.testStats', {
                  matched: String(testResult.stats.matchedLines),
                  lines: String(testResult.stats.lines),
                  skipped: String(testResult.stats.skippedLines),
                  count: String(testResult.diagnostics.length),
                })}
              </div>
              {testResult.diagnostics.length === 0 && <div className="muted">{t('problems.testEmpty')}</div>}
              {testResult.diagnostics.map((d, i) => (
                <div key={i} className="problem-head" style={{ cursor: 'default' }}>
                  <span className={`pill sev-${d.severity}`}>{sevLabel(d.severity)}</span>
                  <span className="mono">
                    {d.file}:{d.line}
                    {d.column ? `:${d.column}` : ''}
                  </span>
                  <span className="problem-msg">{d.message}</span>
                  <span className="muted">{d.matcher}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

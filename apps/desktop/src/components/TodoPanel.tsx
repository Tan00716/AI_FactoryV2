import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type TodoItem, type TodoPattern, type TodoScanResponse, type TodoSeverity } from '../api';
import { useLang } from '../i18n';

/**
 * TODO tracker panel (round-4 task B9) — JetBrains TODO tool-window style.
 * Lists task comments scanned from the project (regex-based, deterministic).
 * Rows are clickable: they jump to file:line in the editor.
 *
 * HONEST BOUNDARIES (rendered in the UI):
 *  - Regex scanning is not comment-aware: a TODO inside a string literal
 *    matches like one in a comment. Matching is case-sensitive.
 *  - Results are a snapshot of the scan moment; re-scan to refresh.
 *  - Custom patterns are session-scoped (server restart restores defaults).
 */

const SEV_ORDER: Record<TodoSeverity, number> = { error: 0, warning: 1, info: 2 };
type SevFilter = 'all' | TodoSeverity;

function sevLabel(t: (key: string) => string, s: TodoSeverity): string {
  return { error: t('todo.sevError'), warning: t('todo.sevWarning'), info: t('todo.sevInfo') }[s];
}

function openInEditor(path: string, line: number) {
  window.dispatchEvent(
    new CustomEvent('ai-factory:open-file', { detail: { path, line } }),
  );
}

function PatternConfig({ patterns, onChanged }: { patterns: TodoPattern[]; onChanged: () => void }) {
  const { t } = useLang();
  const [name, setName] = useState('');
  const [regexp, setRegexp] = useState('');
  const [severity, setSeverity] = useState<TodoSeverity>('info');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const toggle = useCallback(
    async (p: TodoPattern) => {
      setBusy(true);
      setMsg(null);
      try {
        await api.updateTodoConfig(
          patterns.map((x) => ({
            name: x.name,
            regexp: x.regexp,
            severity: x.severity,
            enabled: x.name === p.name ? !x.enabled : x.enabled,
          })),
        );
        onChanged();
      } catch (e) {
        setMsg(t('todo.saveFailed', { message: e instanceof Error ? e.message : String(e) }));
      } finally {
        setBusy(false);
      }
    },
    [patterns, onChanged, t],
  );

  const add = useCallback(async () => {
    if (!name.trim() || !regexp.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.updateTodoConfig([
        ...patterns.map((x) => ({ name: x.name, regexp: x.regexp, severity: x.severity, enabled: x.enabled })),
        { name: name.trim(), regexp, severity },
      ]);
      setName('');
      setRegexp('');
      onChanged();
    } catch (e) {
      setMsg(t('todo.saveFailed', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }, [name, regexp, severity, patterns, onChanged, t]);

  const reset = useCallback(async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.resetTodoConfig();
      onChanged();
    } catch (e) {
      setMsg(t('todo.saveFailed', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }, [onChanged, t]);

  return (
    <div className="todo-config">
      <div className="todo-config-title">{t('todo.config')}</div>
      {patterns.map((p) => (
        <label key={p.name} className="todo-pattern-row" title={p.regexp}>
          <input type="checkbox" checked={p.enabled} disabled={busy} onChange={() => void toggle(p)} />
          <span className={`pill sev-${p.severity}`}>{p.name}</span>
          <span className="muted">{sevLabel(t, p.severity)}</span>
          {p.builtin && <span className="muted">builtin</span>}
        </label>
      ))}
      <div className="todo-add">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('todo.patternName')} disabled={busy} />
        <input value={regexp} onChange={(e) => setRegexp(e.target.value)} placeholder={t('todo.patternRegexp')} disabled={busy} />
        <select value={severity} onChange={(e) => setSeverity(e.target.value as TodoSeverity)} disabled={busy}>
          <option value="error">{t('todo.sevError')}</option>
          <option value="warning">{t('todo.sevWarning')}</option>
          <option value="info">{t('todo.sevInfo')}</option>
        </select>
        <button className="pill" disabled={busy || !name.trim() || !regexp.trim()} onClick={() => void add()}>
          {t('todo.addPattern')}
        </button>
        <button className="link" disabled={busy} onClick={() => void reset()}>
          {t('todo.reset')}
        </button>
      </div>
      {msg && <span className="pill warn">{msg}</span>}
      <div className="muted">{t('todo.sessionNote')}</div>
    </div>
  );
}

export function TodoPanel() {
  const { t } = useLang();
  const [data, setData] = useState<TodoScanResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<SevFilter>('all');
  const [showConfig, setShowConfig] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setData(await api.todos());
    } catch (e) {
      setErr(t('todo.loadFailed', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(() => {
    const list = (data?.items ?? []).filter((i) => filter === 'all' || i.severity === filter);
    return [...list].sort(
      (a, b) =>
        SEV_ORDER[a.severity] - SEV_ORDER[b.severity] ||
        (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
        a.line - b.line,
    );
  }, [data, filter]);

  const counts = useMemo(() => {
    const c: Record<TodoSeverity, number> = { error: 0, warning: 0, info: 0 };
    for (const i of data?.items ?? []) c[i.severity]++;
    return c;
  }, [data]);

  const row = (i: TodoItem) => (
    <div
      key={`${i.file}:${i.line}:${i.tag}`}
      className="todo-row"
      role="button"
      tabIndex={0}
      onClick={() => openInEditor(i.file, i.line)}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter') openInEditor(i.file, i.line);
      }}
    >
      <span className={`pill sev-${i.severity}`}>{i.tag}</span>
      <span className="todo-file">{i.file}:{i.line}</span>
      <span className="todo-msg">{i.message || <span className="muted">—</span>}</span>
    </div>
  );

  return (
    <div className="todo-panel">
      <div className="todo-toolbar">
        <button className="pill" disabled={loading} onClick={() => void load()}>
          {t('todo.refresh')}
        </button>
        {(['all', 'error', 'warning', 'info'] as SevFilter[]).map((f) => (
          <button key={f} className={filter === f ? 'pill active' : 'pill'} onClick={() => setFilter(f)}>
            {f === 'all'
              ? t('todo.filterAll')
              : `${sevLabel(t, f as TodoSeverity)} ${counts[f as TodoSeverity]}`}
          </button>
        ))}
        <button className="link" onClick={() => setShowConfig((v) => !v)}>
          {t('todo.config')}
        </button>
        {data && (
          <span className="muted">
            {t('todo.stats', {
              items: String(data.stats.items),
              files: String(data.stats.filesScanned),
              ms: String(data.stats.durationMs),
            })}
            {data.stats.truncated && <span className="pill warn">{t('todo.truncated')}</span>}
          </span>
        )}
      </div>
      {showConfig && data && <PatternConfig patterns={data.patterns} onChanged={load} />}
      {err && <span className="pill warn">{err}</span>}
      {!err && loading && !data && <span className="muted">{t('todo.loading')}</span>}
      {!err && data && items.length === 0 && <span className="muted">{t('todo.empty')}</span>}
      <div className="todo-list">{items.map(row)}</div>
      <div className="muted todo-honest">{t('todo.honestNote')}</div>
    </div>
  );
}

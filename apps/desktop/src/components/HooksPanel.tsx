import { useCallback, useEffect, useState } from 'react';
import { defaultApiBase, authHeaders } from '../api';
import { useLang } from '../i18n';

export interface Hook {
  id: string;
  event: 'PreToolUse' | 'PostToolUse' | 'Stop';
  tool?: string;
  command: string;
  timeoutMs: number;
  enabled: boolean;
  description?: string;
  createdAt: string;
}

export interface HookRun {
  hookId: string;
  event: string;
  ok: boolean;
  timedOut: boolean;
  exitCode: number | null;
  verdict: 'allow' | 'deny' | null;
  reason: string | null;
  stdout: string;
  stderr: string;
}

export interface HooksApi {
  list(): Promise<{ hooks: Hook[]; events: string[] }>;
  create(input: {
    event: string;
    tool?: string;
    command: string;
    timeoutMs?: number;
    description?: string;
  }): Promise<{ hook: Hook }>;
  remove(id: string): Promise<{ ok: boolean }>;
  test(id: string): Promise<{ run: HookRun }>;
}

const DEFAULT_BASE = defaultApiBase();

async function req<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as T;
  if (!res.ok) {
    const err = body as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return body;
}

export function createHooksApi(base: string = DEFAULT_BASE): HooksApi {
  return {
    list: () => req(base, '/hooks'),
    create: (input) => req(base, '/hooks', { method: 'POST', body: JSON.stringify(input) }),
    remove: (id) => req(base, `/hooks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    test: (id) => req(base, `/hooks/${encodeURIComponent(id)}/test`, { method: 'POST', body: '{}' }),
  };
}

const EVENT_COLORS: Record<Hook['event'], string> = {
  PreToolUse: '#f85149',
  PostToolUse: '#58a6ff',
  Stop: '#d29922',
};

export function HooksPanel({ hooksApi }: { hooksApi: HooksApi }) {
  const { t } = useLang();
  const [hooks, setHooks] = useState<Hook[] | null>(null);
  const [events, setEvents] = useState<string[]>(['PreToolUse', 'PostToolUse', 'Stop']);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<Record<string, HookRun>>({});

  const [event, setEvent] = useState<Hook['event']>('PreToolUse');
  const [tool, setTool] = useState('');
  const [command, setCommand] = useState('');
  const [timeoutMs, setTimeoutMs] = useState('10000');
  const [description, setDescription] = useState('');

  const refresh = useCallback(async () => {
    try {
      setError('');
      const r = await hooksApi.list();
      setHooks(r.hooks);
      if (r.events.length) setEvents(r.events);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [hooksApi]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const doCreate = async () => {
    if (!command.trim()) {
      setError(t('hooks.commandRequired'));
      return;
    }
    setBusy(true);
    try {
      setError('');
      await hooksApi.create({
        event,
        tool: tool.trim() || undefined,
        command: command.trim(),
        timeoutMs: Number(timeoutMs) || undefined,
        description: description.trim() || undefined,
      });
      setCommand('');
      setDescription('');
      setTool('');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doTest = async (id: string) => {
    setBusy(true);
    try {
      setError('');
      const r = await hooksApi.test(id);
      setTestResult((m) => ({ ...m, [id]: r.run }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (id: string) => {
    if (!window.confirm(t('hooks.confirmDelete'))) return;
    setBusy(true);
    try {
      setError('');
      await hooksApi.remove(id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>{t('hooks.title')}</h2>
      <p className="muted">{t('hooks.desc')}</p>
      {error && <div className="error">{error}</div>}

      <h3>{t('hooks.add')}</h3>
      <div className="form-grid">
        <label>
          {t('hooks.event')}
          <select value={event} onChange={(e) => setEvent(e.target.value as Hook['event'])} disabled={busy}>
            {events.map((ev) => (
              <option key={ev} value={ev}>
                {ev}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('hooks.tool')}
          <input value={tool} onChange={(e) => setTool(e.target.value)} disabled={busy} placeholder="exec" />
        </label>
        <label>
          {t('hooks.command')}
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            disabled={busy}
            placeholder={`echo '{"decision":"deny","reason":"…"}'`}
          />
        </label>
        <label>
          {t('hooks.timeout')}
          <input value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} disabled={busy} />
        </label>
        <label>
          {t('hooks.description')}
          <input value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} />
        </label>
        <div>
          <button disabled={busy} onClick={doCreate}>
            {t('hooks.add')}
          </button>
        </div>
      </div>

      <h3>{t('hooks.title')} ({hooks?.length ?? 0})</h3>
      {hooks === null ? (
        <div className="muted">…</div>
      ) : hooks.length === 0 ? (
        <div className="muted">{t('hooks.empty')}</div>
      ) : (
        <div className="card-list">
          {hooks.map((h) => {
            const run = testResult[h.id];
            return (
              <div key={h.id} className="card">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span style={{ color: EVENT_COLORS[h.event], fontWeight: 600 }}>{h.event}</span>
                  <span className="muted" style={{ fontSize: 11 }}>
                    {h.tool ?? '*'} · {h.timeoutMs}ms · {h.enabled ? '✓' : '✗'}
                  </span>
                </div>
                {h.description && <div>{h.description}</div>}
                <code style={{ fontSize: 12, wordBreak: 'break-all' }}>{h.command}</code>
                {run && (
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    {t('hooks.testResult')}: {run.verdict ?? '—'}
                    {run.reason && ` (${run.reason})`}
                    {run.timedOut && ' ⏱'}
                    {run.stdout && <div><code>{run.stdout.slice(0, 200)}</code></div>}
                  </div>
                )}
                <div className="row" style={{ marginTop: 6 }}>
                  <button disabled={busy} onClick={() => doTest(h.id)}>
                    {t('hooks.test')}
                  </button>
                  <button disabled={busy} onClick={() => doDelete(h.id)}>
                    {t('hooks.delete')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

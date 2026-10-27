import { useEffect, useRef, useState } from 'react';
import { defaultApiBase, authHeaders } from '../api';
import { useLang } from '../i18n';
import { dispatchCommand } from '../keybinding/commands';

interface CommandInfo {
  name: string;
  description: string;
  usage?: string;
  template?: string;
}

interface ExecuteResult {
  type: string;
  name?: string;
  text?: string;
  message?: string;
  plan?: { id: string; title: string };
  builtins?: CommandInfo[];
  custom?: CommandInfo[];
  error?: string;
  commandId?: string;
  args?: string;
  label?: string;
  chain?: { ok: boolean; results: { label: string; status: string; output: string }[]; stoppedAt: string | null };
  warning?: string;
}

const DEFAULT_BASE = defaultApiBase();

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${DEFAULT_BASE}${path}`, {
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

/** Top-bar slash command input: `/help`, `/plan <taskId> <goal>`, `/review`, custom. */
export function SlashCommandBar({ onNavigateTab }: { onNavigateTab: (tab: string) => void }) {
  const { t } = useLang();
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [result, setResult] = useState<ExecuteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    req<{ builtins: CommandInfo[]; custom: CommandInfo[] }>('/commands')
      .then((r) => setCommands([...r.builtins, ...r.custom]))
      .catch(() => setCommands([]));
  }, [open ]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        setResult(null);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const filtered = value.startsWith('/')
    ? commands.filter((c) => c.name.startsWith(value.slice(1).toLowerCase()))
    : [];

  const execute = async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return;
    setBusy(true);
    try {
      const r = await req<ExecuteResult>('/commands/execute', {
        method: 'POST',
        body: JSON.stringify({ input: trimmed }),
      });
      setResult(r);
      setOpen(true);
      if (r.type === 'plan') setValue('');
      // R6-A7: a command binding is dispatched by the desktop (the
      // server only returns the descriptor — it runs no desktop command).
      if (r.type === 'command' && r.commandId) dispatchCommand(r.commandId);
    } catch (e) {
      setResult({ type: 'error', error: (e as Error).message });
      setOpen(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={boxRef} className="slash-bar" style={{ position: 'relative' }}>
      <input
        value={value}
        placeholder={t('cmd.placeholder')}
        aria-label="slash-command"
        disabled={busy}
        onChange={(e) => {
          setValue(e.target.value);
          setResult(null);
          if (e.target.value.startsWith('/')) setOpen(true);
        }}
        onFocus={() => {
          if (value.startsWith('/')) setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void execute(value);
          else if (e.key === 'Escape') {
            setOpen(false);
            setResult(null);
          }
        }}
        style={{ width: 220 }}
      />
      {open && !result && filtered.length > 0 && (
        <div className="slash-dropdown">
          {filtered.map((c) => (
            <button
              key={c.name}
              className="slash-item"
              onClick={() => {
                setValue(`/${c.name} `);
                setOpen(false);
              }}
            >
              <code>/{c.name}</code>
              <span className="muted">{c.description || c.usage}</span>
            </button>
          ))}
        </div>
      )}
      {open && result && (
        <div className="slash-dropdown slash-result">
          {result.type === 'error' && <div className="error">{result.error}</div>}
          {result.type === 'help' && (
            <div>
              {(result.builtins ?? []).map((c) => (
                <div key={c.name} className="slash-item-static">
                  <code>/{c.name}</code> <span className="muted">{c.usage}</span>
                  <div className="muted">{c.description}</div>
                </div>
              ))}
              {(result.custom ?? []).map((c) => (
                <div key={c.name} className="slash-item-static">
                  <code>/{c.name}</code> <span className="muted">{c.description}</span>
                </div>
              ))}
            </div>
          )}
          {result.type === 'plan' && result.plan && (
            <div>
              <div>✓ {t('cmd.planCreated')}: {result.plan.title}</div>
              <button className="link-btn" onClick={() => { setOpen(false); setResult(null); onNavigateTab('Plan'); }}>
                {t('cmd.viewPlan')}
              </button>
            </div>
          )}
          {result.type === 'review' && <div className="muted">{result.message}</div>}
          {result.type === 'template' && (
            <div>
              <code>/{result.name}</code>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{result.text}</pre>
            </div>
          )}
          {result.type === 'command' && (
            <div>
              <code>/{result.name}</code> <span className="muted">→ {result.commandId} {result.args}</span>
            </div>
          )}
          {result.type === 'task' && (
            <div>
              <code>/{result.name}</code>{' '}
              <span className="muted">
                {result.label}: {result.chain?.ok ? 'ok' : 'failed'}
              </span>
              {(result.chain?.results ?? []).map((r) => (
                <div key={r.label} className="muted">
                  {r.label} [{r.status}]: {(r.output || '').trim().slice(0, 200)}
                </div>
              ))}
            </div>
          )}
          {result.warning && <div className="muted">{result.warning}</div>}
          <button className="link-btn" onClick={() => { setOpen(false); setResult(null); }}>
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

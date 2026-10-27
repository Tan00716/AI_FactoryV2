import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type WatchRuleInput,
  type WatchRuleView,
  type WatchTriggerView,
} from '../api';
import { useLang } from '../i18n';

/**
 * Watch rules tool window (round-6 task R6-S3) — "file change → run a
 * tasks.json chain", the save-and-feedback loop.
 *
 * HONEST BOUNDARIES (rendered in the UI):
 *  - This is a trigger only, not incremental compilation: every fire runs
 *    the whole declared chain from scratch.
 *  - Watchers live in the server process: a server restart drops them,
 *    and enabled rules must be re-activated (the "Activate all" button).
 *  - Recipe apply is never auto-triggered (recipe runs are approval-gated
 *    by design): declare lint / test / build as tasks.json tasks and
 *    watch-trigger those instead.
 *  - One rule's chain runs serialize; a fire during a run queues once
 *    (further fires coalesce into it).
 */
export function WatchPanel() {
  const { t } = useLang();
  const [rules, setRules] = useState<WatchRuleView[]>([]);
  const [triggers, setTriggers] = useState<WatchTriggerView[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [globs, setGlobs] = useState('src/**/*.ts');
  const [label, setLabel] = useState('');
  const [debounceMs, setDebounceMs] = useState('500');

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [r, tr] = await Promise.all([api.watchRules(), api.watchTriggers()]);
      setRules(r.rules);
      setTriggers(tr.triggers);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = useCallback(
    async (fn: () => Promise<unknown>, okMsg: string) => {
      setErr(null);
      setMsg(null);
      try {
        await fn();
        setMsg(okMsg);
        await refresh();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  const create = useCallback(async () => {
    const input: WatchRuleInput = {
      name: name.trim(),
      globs: globs.split(',').map((g) => g.trim()).filter(Boolean),
      action: { type: 'task', label: label.trim() },
      debounceMs: Number(debounceMs) || 500,
      enabled: true,
    };
    await act(() => api.watchCreate(input), t('watch.created'));
    setShowAdd(false);
    setName('');
    setLabel('');
  }, [act, name, globs, label, debounceMs, t]);

  return (
    <div className="watch-panel">
      <div className="watch-toolbar">
        <button onClick={() => void refresh()} disabled={loading}>
          {t('watch.refresh')}
        </button>
        <button onClick={() => setShowAdd((v) => !v)}>{t('watch.newRule')}</button>
        <button onClick={() => void act(() => api.watchActivate(), t('watch.activated'))}>
          {t('watch.activateAll')}
        </button>
        <button onClick={() => void act(() => api.watchDeactivate(), t('watch.deactivated'))}>
          {t('watch.deactivateAll')}
        </button>
      </div>
      {err && <div className="watch-error">{err}</div>}
      {msg && <div className="watch-msg">{msg}</div>}
      {showAdd && (
        <div className="watch-form">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('watch.namePlaceholder')} />
          <input value={globs} onChange={(e) => setGlobs(e.target.value)} placeholder={t('watch.globsPlaceholder')} />
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('watch.labelPlaceholder')} />
          <input value={debounceMs} onChange={(e) => setDebounceMs(e.target.value)} placeholder={t('watch.debouncePlaceholder')} />
          <button onClick={() => void create()} disabled={!name.trim() || !label.trim()}>
            {t('watch.create')}
          </button>
        </div>
      )}
      <table className="watch-table">
        <thead>
          <tr>
            <th>{t('watch.colRule')}</th>
            <th>{t('watch.colGlobs')}</th>
            <th>{t('watch.colAction')}</th>
            <th>{t('watch.colDebounce')}</th>
            <th>{t('watch.colStatus')}</th>
            <th>{t('watch.colActions')}</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>{r.globs.join(', ')}</td>
              <td>task:{r.action.label}</td>
              <td>{r.debounceMs}ms</td>
              <td>{r.active ? t('watch.active', { dirs: String(r.watchedDirs) }) : r.enabled ? t('watch.enabledIdle') : t('watch.disabled')}</td>
              <td>
                <button onClick={() => void act(() => api.watchEnable(r.id), t('watch.started'))} disabled={r.active}>
                  {t('watch.enable')}
                </button>
                <button onClick={() => void act(() => api.watchDisable(r.id), t('watch.stopped'))} disabled={!r.active}>
                  {t('watch.disable')}
                </button>
                <button onClick={() => void act(() => api.watchDelete(r.id), t('watch.deleted'))}>
                  {t('watch.delete')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>{t('watch.triggersTitle')}</h4>
      <ul className="watch-triggers">
        {triggers.slice(0, 20).map((tr) => (
          <li key={tr.id}>
            {tr.startedAt} — {tr.ruleName} — {tr.status}
            {tr.burst ? ` (${t('watch.burst')})` : ''} — {tr.files.slice(0, 5).join(', ')}
            {tr.files.length > 5 ? ` +${tr.files.length - 5}` : ''}
            {tr.failedLabels.length > 0 ? ` — ${t('watch.failedLabels', { labels: tr.failedLabels.join(', ') })}` : ''}
          </li>
        ))}
      </ul>
      <p className="watch-footnote">{t('watch.honest')}</p>
    </div>
  );
}

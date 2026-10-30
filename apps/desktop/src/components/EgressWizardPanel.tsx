/**
 * Egress first-run wizard (V3-#5) — rendered inside the egress section of
 * the project panel. Three outcomes, all explicit and audited:
 *   enable + templates → firewall ON (deny) + selected template/custom
 *     rules merged in; existing rules are kept verbatim, never deleted.
 *   dev mode → firewall OFF by explicit operator choice (audited).
 *   dismiss → only a dismissal timestamp is recorded; egress.json is
 *     never touched.
 * Shown when the install is a factory default, when the stored config
 * is legacy (predates the wizard), or after the user re-opens it; once
 * the wizard completed it collapses to a mode indicator + reopen button.
 */
import { useEffect, useState } from 'react';
import { api, type EgressRule, type EgressWizardState } from '../api';
import { useLang } from '../i18n';

export default function EgressWizardPanel({ onDone }: { onDone: () => void }) {
  const { t, has } = useLang();
  const [state, setState] = useState<EgressWizardState | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [customDomain, setCustomDomain] = useState('');
  const [customRules, setCustomRules] = useState<EgressRule[]>([]);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [open, setOpen] = useState(false);

  const load = async () => {
    try {
      const res = await api.egressWizard();
      setState(res);
      // Auto-open only when the wizard has never completed and was not dismissed.
      if (!res.global.wizardCompletedAt && !res.wizard.dismissedAt) setOpen(true);
    } catch {
      /* wizard is best-effort display; the editors below still work */
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tplText = (id: string, field: 'title' | 'desc' | 'risk', fallback: string): string => {
    const key = `egress.wizard.tpl.${id}.${field}`;
    return has(key) ? t(key) : fallback;
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addCustom = () => {
    const domain = customDomain.trim().toLowerCase();
    if (!domain || domain.includes('*') || domain.includes(' ')) {
      setMsg({ kind: 'err', text: t('egress.wizard.badDomain') });
      return;
    }
    if (customRules.some((r) => r.domain === domain)) return;
    setCustomRules([...customRules, { domain, action: 'allow' }]);
    setCustomDomain('');
    setMsg(null);
  };

  const run = async (kind: 'complete' | 'dev' | 'dismiss') => {
    setBusy(kind);
    setMsg(null);
    try {
      if (kind === 'complete') {
        const res = await api.egressWizardComplete({ templateIds: [...selected], customRules });
        setMsg({ kind: 'ok', text: t('egress.wizard.done', { added: res.added.length, kept: res.preservedRuleCount }) });
      } else if (kind === 'dev') {
        await api.egressWizardDevMode();
        setMsg({ kind: 'ok', text: t('egress.wizard.devDone') });
      } else {
        await api.egressWizardDismiss();
        setMsg({ kind: 'ok', text: t('egress.wizard.dismissed') });
      }
      setOpen(false);
      await load();
      onDone();
    } catch (e) {
      setMsg({ kind: 'err', text: t('egress.wizard.failed', { message: (e as Error).message }) });
    } finally {
      setBusy('');
    }
  };

  if (!state) return null;
  const g = state.global;
  const modeLabel = !g.enabled
    ? t('egress.wizard.modeDev')
    : g.factoryDefault
      ? t('egress.wizard.modeFactory')
      : g.legacyConfig
        ? t('egress.wizard.modeLegacy')
        : t('egress.wizard.modeOn');

  return (
    <div className="sub-panel">
      <p>
        <strong>{t('egress.wizard.title')}</strong>
        <span className="muted"> · {modeLabel}</span>
        {!open && (
          <button style={{ marginLeft: 8 }} onClick={() => setOpen(true)}>
            {t('egress.wizard.reopen')}
          </button>
        )}
      </p>
      {g.legacyConfig && <p className="muted">{t('egress.wizard.legacyNote', { count: g.ruleCount })}</p>}
      {g.factoryDefault && <p className="muted">{t('egress.wizard.factoryNote')}</p>}
      <p className="muted">{t('egress.wizard.dnsNote')}</p>
      {open && (
        <>
          <p className="muted">{t('egress.wizard.pickHint')}</p>
          {state.templates.map((tpl) => (
            <label className="row" key={tpl.id}>
              <input type="checkbox" checked={selected.has(tpl.id)} onChange={() => toggle(tpl.id)} />
              <span>
                <strong>{tplText(tpl.id, 'title', tpl.label)}</strong>
                <span className="muted"> — {tpl.domains.join(', ')}</span>
                <br />
                <span className="muted">{tplText(tpl.id, 'desc', tpl.description)}</span>
                <br />
                <span className="muted">{tplText(tpl.id, 'risk', tpl.risk)}</span>
              </span>
            </label>
          ))}
          <div className="row">
            <input
              value={customDomain}
              onChange={(e) => setCustomDomain(e.target.value)}
              placeholder={t('egress.wizard.customPlaceholder')}
              style={{ fontFamily: 'monospace', minWidth: 240 }}
              spellCheck={false}
            />
            <button onClick={addCustom}>{t('egress.wizard.addCustom')}</button>
            {customRules.length > 0 && (
              <span className="muted">{customRules.map((r) => r.domain).join(', ')}</span>
            )}
          </div>
          <div className="row">
            <button disabled={busy !== ''} onClick={() => void run('complete')}>
              {busy === 'complete' ? t('egress.wizard.working') : t('egress.wizard.enableBtn')}
            </button>
            <button disabled={busy !== ''} onClick={() => void run('dev')}>
              {busy === 'dev' ? t('egress.wizard.working') : t('egress.wizard.devBtn')}
            </button>
            <button disabled={busy !== ''} onClick={() => void run('dismiss')}>
              {busy === 'dismiss' ? t('egress.wizard.working') : t('egress.wizard.dismissBtn')}
            </button>
          </div>
        </>
      )}
      {msg && <p className={msg.kind === 'ok' ? 'ok' : 'err'}>{msg.text}</p>}
    </div>
  );
}

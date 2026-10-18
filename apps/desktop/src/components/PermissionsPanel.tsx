import { useCallback, useEffect, useState } from 'react';
import { defaultApiBase, authHeaders, api, type AgentFull } from '../api';
import { useLang } from '../i18n';

/**
 * Permissions panel — W-C unified permission tiers.
 *
 * Three sections:
 *  1. Tier policies: the 4 tiers (read/write/exec/admin), each with
 *     editable auto/ask/deny pattern lists (comma-separated).
 *  2. Agent tiers: assign agents to tiers (unassigned → default).
 *  3. Evaluate: dry-run an action against a tier — shows the
 *     strictest-wins verdict (tier policy × approvals engine).
 *
 * Props-based: pass a custom PermissionsApi for tests; defaults to
 * the local server. The coordinator wires this into App.tsx.
 */

export type TierName = 'read' | 'write' | 'exec' | 'admin';
export const TIER_NAMES: TierName[] = ['read', 'write', 'exec', 'admin'];

export interface TierPolicyDto {
  tier: TierName;
  auto: string[];
  ask: string[];
  deny: string[];
}

export interface PermissionsApi {
  tiers(): Promise<{ tiers: TierPolicyDto[]; defaultAgentTier: TierName }>;
  saveTier(tier: TierName, policy: { auto: string[]; ask: string[]; deny: string[] }): Promise<TierPolicyDto>;
  agentTiers(): Promise<{ assignments: Array<{ agentId: string; tier: string }>; defaultTier: TierName }>;
  assignAgent(agentId: string, tier: TierName): Promise<{ agentId: string; tier: string }>;
  evaluate(input: { action: string; tier?: TierName; agentId?: string }): Promise<{
    tier: TierName;
    tierVerdict: 'auto' | 'ask' | 'deny';
    level: 'AUTO' | 'ASK' | 'DENY';
    requiresApproval: boolean;
    reasons: string[];
  }>;
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

export function createPermissionsApi(base: string = DEFAULT_BASE): PermissionsApi {
  return {
    tiers: () => req(base, '/permissions/tiers'),
    saveTier: (tier, policy) =>
      req(base, `/permissions/tiers/${tier}`, { method: 'PUT', body: JSON.stringify(policy) }),
    agentTiers: () => req(base, '/permissions/agents'),
    assignAgent: (agentId, tier) =>
      req(base, `/permissions/agents/${encodeURIComponent(agentId)}`, {
        method: 'PUT',
        body: JSON.stringify({ tier }),
      }),
    evaluate: (input) => req(base, '/permissions/evaluate', { method: 'POST', body: JSON.stringify(input) }),
  };
}

const join = (xs: string[]): string => xs.join(', ');
const split = (s: string): string[] =>
  s.split(',').map((x) => x.trim()).filter(Boolean);

function TierCard(props: {
  api: PermissionsApi;
  policy: TierPolicyDto;
  onSaved: () => void;
}): JSX.Element {
  const { t } = useLang();
  const { api: papi, policy } = props;
  const [auto, setAuto] = useState(join(policy.auto));
  const [ask, setAsk] = useState(join(policy.ask));
  const [deny, setDeny] = useState(join(policy.deny));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAuto(join(policy.auto));
    setAsk(join(policy.ask));
    setDeny(join(policy.deny));
    setSaved(false);
  }, [policy]);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await papi.saveTier(policy.tier, { auto: split(auto), ask: split(ask), deny: split(deny) });
      setSaved(true);
      props.onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [papi, policy.tier, auto, ask, deny, props]);

  const field = (
    label: string,
    value: string,
    set: (v: string) => void,
    rows = 2,
  ): JSX.Element => (
    <label style={{ display: 'block', margin: '6px 0' }}>
      <span className="muted">{label}</span>
      <textarea
        value={value}
        onChange={(e) => { set(e.target.value); setSaved(false); }}
        rows={rows}
        style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
        placeholder={t('permissions.patternHint')}
      />
    </label>
  );

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <h4 style={{ margin: '4px 0' }}>
        {t(`permissions.tier.${policy.tier}` as const)}{' '}
        <span className="muted">· {t(`permissions.tierDesc.${policy.tier}` as const)}</span>
      </h4>
      {field(t('permissions.auto'), auto, setAuto)}
      {field(t('permissions.ask'), ask, setAsk)}
      {field(t('permissions.deny'), deny, setDeny)}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button disabled={busy} onClick={save}>{t('permissions.save')}</button>
        {saved && <span className="muted">✓ {t('permissions.saved')}</span>}
        {error && <span className="banner err">{error}</span>}
      </div>
    </div>
  );
}

export function PermissionsPanel(props: { perms?: PermissionsApi }): JSX.Element {
  const { t } = useLang();
  const [papi] = useState<PermissionsApi>(() => props.perms ?? createPermissionsApi());
  const [tiers, setTiers] = useState<TierPolicyDto[]>([]);
  const [agents, setAgents] = useState<AgentFull[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [defaultTier, setDefaultTier] = useState<TierName>('write');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Evaluate tester state
  const [evAction, setEvAction] = useState('filesystem.write');
  const [evTier, setEvTier] = useState<TierName>('read');
  const [evResult, setEvResult] = useState<{
    level: string; tierVerdict: string; requiresApproval: boolean; reasons: string[];
  } | null>(null);
  const [evBusy, setEvBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [tr, at, ag] = await Promise.all([papi.tiers(), papi.agentTiers(), api.agents()]);
      setTiers(tr.tiers);
      setDefaultTier(tr.defaultAgentTier);
      const m: Record<string, string> = {};
      for (const a of at.assignments) m[a.agentId] = a.tier;
      setAssignments(m);
      setAgents(ag);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [papi]);

  useEffect(() => { refresh(); }, [refresh]);

  const assign = useCallback(async (agentId: string, tier: TierName) => {
    try {
      await papi.assignAgent(agentId, tier);
      setAssignments((m) => ({ ...m, [agentId]: tier }));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [papi]);

  const evaluate = useCallback(async () => {
    if (!evAction.trim()) return;
    setEvBusy(true);
    try {
      const r = await papi.evaluate({ action: evAction.trim(), tier: evTier });
      setEvResult(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setEvBusy(false);
    }
  }, [papi, evAction, evTier]);

  if (loading) return <div className="permissions-panel"><div className="muted">{t('permissions.loading')}</div></div>;

  return (
    <div className="permissions-panel">
      {error && <div className="banner err">{error}</div>}
      <h3 style={{ margin: '4px 0' }}>{t('permissions.title')}</h3>
      <p className="muted">{t('permissions.subtitle')}</p>

      <h4 style={{ margin: '12px 0 4px' }}>{t('permissions.tiers')}</h4>
      {tiers.map((p) => (
        <TierCard key={p.tier} api={papi} policy={p} onSaved={refresh} />
      ))}

      <h4 style={{ margin: '12px 0 4px' }}>
        {t('permissions.agents')} <span className="muted">({agents.length})</span>
      </h4>
      {agents.length === 0 && <div className="muted">—</div>}
      <ul className="ev-list">
        {agents.map((a) => {
          const cur = assignments[a.id] ?? defaultTier;
          return (
            <li key={a.id} style={{ marginBottom: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
              <b>{a.displayName || a.name}</b>
              <span className="muted">{a.id.slice(0, 8)}</span>
              <select value={cur} onChange={(e) => assign(a.id, e.target.value as TierName)}>
                {TIER_NAMES.map((tn) => (
                  <option key={tn} value={tn}>{t(`permissions.tier.${tn}` as const)}</option>
                ))}
              </select>
              {!assignments[a.id] && <span className="muted">· {t('permissions.unassigned')}</span>}
            </li>
          );
        })}
      </ul>

      <h4 style={{ margin: '12px 0 4px' }}>{t('permissions.evaluate')}</h4>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label>
          <span className="muted">{t('permissions.action')} </span>
          <input
            value={evAction}
            onChange={(e) => setEvAction(e.target.value)}
            placeholder={t('permissions.actionPh')}
            style={{ width: 220 }}
          />
        </label>
        <select value={evTier} onChange={(e) => setEvTier(e.target.value as TierName)}>
          {TIER_NAMES.map((tn) => (
            <option key={tn} value={tn}>{t(`permissions.tier.${tn}` as const)}</option>
          ))}
        </select>
        <button disabled={evBusy} onClick={evaluate}>{t('permissions.evaluate')}</button>
      </div>
      {evResult && (
        <div className="card" style={{ marginTop: 8 }}>
          <div>
            {t('permissions.verdict')}: <b>{t(`permissions.verdict.${evResult.level}` as const)}</b>{' '}
            <span className="muted">(tier: {evResult.tierVerdict})</span>
          </div>
          <div className="muted" style={{ marginTop: 4 }}>{t('permissions.reasons')}:</div>
          <ul>
            {evResult.reasons.map((r, i) => <li key={i} style={{ fontSize: 12 }}>{r}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

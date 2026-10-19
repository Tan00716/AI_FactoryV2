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

export interface PermissionRuleDto {
  tool: string;
  pattern: string;
  effect: 'allow' | 'ask' | 'deny';
}

export interface RuleLayerDto {
  name: string;
  path: string;
  rules: PermissionRuleDto[];
  corrupt: boolean;
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
  rules(): Promise<{ layers: RuleLayerDto[]; layerNames: string[] }>;
  saveRules(layer: string, rules: PermissionRuleDto[]): Promise<{ layer: string; saved: number; warnings: string[] }>;
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
    rules: () => req(base, '/permissions/rules'),
    saveRules: (layer, rules) =>
      req(base, '/permissions/rules', { method: 'PUT', body: JSON.stringify({ layer, rules }) }),
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

const RULE_EFFECTS: Array<'allow' | 'ask' | 'deny'> = ['allow', 'ask', 'deny'];

/**
 * Section 4 — declarative allow/ask/deny tool rules.
 *
 * Three layers (project / personal / global) merge with later layers
 * overriding identical (tool, pattern) pairs, but deny always wins.
 * Rules are enforced at the server tool-runner choke point, even when
 * approval is bypassed upstream.
 */
function RulesSection(props: { api: PermissionsApi }): JSX.Element {
  const { t } = useLang();
  const { api: papi } = props;
  const [layers, setLayers] = useState<RuleLayerDto[]>([]);
  const [search, setSearch] = useState('');
  const [newTool, setNewTool] = useState('Bash');
  const [newPattern, setNewPattern] = useState('');
  const [newEffect, setNewEffect] = useState<'allow' | 'ask' | 'deny'>('deny');
  const [newLayer, setNewLayer] = useState('project');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await papi.rules();
      setLayers(r.layers);
      if (r.layerNames.length > 0 && !r.layerNames.includes(newLayer)) {
        setNewLayer(r.layerNames[0] as string);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [papi, newLayer]);

  useEffect(() => { refresh(); }, [refresh]);

  const persist = useCallback(async (layerName: string, rules: PermissionRuleDto[]) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await papi.saveRules(layerName, rules);
      if (r.warnings.length > 0) {
        setNotice(r.warnings.join('\n'));
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [papi, refresh]);

  const addRule = useCallback(() => {
    if (!newTool.trim() || !newPattern.trim()) {
      setError(t('permissions.rules.required'));
      return;
    }
    const layer = layers.find((l) => l.name === newLayer);
    if (!layer) return;
    void persist(newLayer, [...layer.rules, {
      tool: newTool.trim(),
      pattern: newPattern.trim(),
      effect: newEffect,
    }]);
    setNewPattern('');
  }, [layers, newLayer, newTool, newPattern, newEffect, persist, t]);

  const removeRule = useCallback((layerName: string, idx: number) => {
    const layer = layers.find((l) => l.name === layerName);
    if (!layer) return;
    void persist(layerName, layer.rules.filter((_, i) => i !== idx));
  }, [layers, persist]);

  const q = search.trim().toLowerCase();
  const visible = (r: PermissionRuleDto): boolean =>
    q === '' || r.tool.toLowerCase().includes(q) || r.pattern.toLowerCase().includes(q);

  return (
    <div>
      <h4 style={{ margin: '12px 0 4px' }}>{t('permissions.rules.title')}</h4>
      <p className="muted">{t('permissions.rules.desc')}</p>
      <p className="muted" style={{ fontSize: 12 }}>{t('permissions.rules.globNote')}</p>
      <p className="muted" style={{ fontSize: 12 }}>{t('permissions.rules.scopeNote')}</p>
      {error && <div className="banner err">{error}</div>}
      {notice && <div className="banner warn" style={{ whiteSpace: 'pre-wrap' }}>{notice}</div>}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0', flexWrap: 'wrap' }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('permissions.rules.searchPh')}
          style={{ width: 240 }}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          {t('permissions.rules.denyWins')}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {RULE_EFFECTS.map((effect) => (
          <div key={effect} className="card" style={{ flex: '1 1 220px', minWidth: 220 }}>
            <h5 style={{ margin: '4px 0' }}>{t(`permissions.rules.${effect}` as const)}</h5>
            {layers.map((layer) =>
              layer.rules.map((r, i) =>
                r.effect === effect && visible(r) ? (
                  <div
                    key={`${layer.name}:${i}`}
                    style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '4px 0', fontSize: 12 }}
                  >
                    <code style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }} title={`${r.tool}(${r.pattern})`}>
                      {r.tool}({r.pattern})
                    </code>
                    <span className="muted" title={layer.path}>{layer.name}</span>
                    <button disabled={busy} onClick={() => removeRule(layer.name, i)} title={t('permissions.rules.delete')}>
                      ✕
                    </button>
                  </div>
                ) : null,
              ),
            )}
          </div>
        ))}
      </div>

      {layers.some((l) => l.corrupt) && (
        <div className="banner warn" style={{ marginTop: 8 }}>
          {t('permissions.rules.corrupt')}: {layers.filter((l) => l.corrupt).map((l) => l.name).join(', ')}
        </div>
      )}

      <div className="card" style={{ marginTop: 12 }}>
        <h5 style={{ margin: '4px 0' }}>{t('permissions.rules.add')}</h5>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label>
            <span className="muted">{t('permissions.rules.tool')} </span>
            <input value={newTool} onChange={(e) => setNewTool(e.target.value)} placeholder={t('permissions.rules.toolPh')} style={{ width: 130 }} />
          </label>
          <label>
            <span className="muted">{t('permissions.rules.pattern')} </span>
            <input value={newPattern} onChange={(e) => setNewPattern(e.target.value)} placeholder={t('permissions.rules.patternPh')} style={{ width: 180 }} />
          </label>
          <label>
            <span className="muted">{t('permissions.rules.effect')} </span>
            <select value={newEffect} onChange={(e) => setNewEffect(e.target.value as 'allow' | 'ask' | 'deny')}>
              {RULE_EFFECTS.map((e) => (
                <option key={e} value={e}>{t(`permissions.rules.${e}` as const)}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="muted">{t('permissions.rules.layer')} </span>
            <select value={newLayer} onChange={(e) => setNewLayer(e.target.value)}>
              {layers.map((l) => (
                <option key={l.name} value={l.name} title={l.path}>
                  {t(`permissions.rules.layer.${l.name}` as const)}
                </option>
              ))}
            </select>
          </label>
          <button disabled={busy} onClick={addRule}>{t('permissions.rules.add')}</button>
        </div>
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

      <RulesSection api={papi} />
    </div>
  );
}

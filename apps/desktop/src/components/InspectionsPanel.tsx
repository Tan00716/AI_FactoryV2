import { useCallback, useEffect, useMemo, useState } from 'react';
import { defaultApiBase, authHeaders } from '../api';
import { useLang } from '../i18n';

/** Server response shapes (subset of apps/server/src/inspections.ts). */
export interface InspectionFinding {
  id: string;
  checker: string;
  severity: 'info' | 'warning' | 'error';
  file: string;
  line: number | null;
  message: string;
  /** Opaque per-checker payload; ssr-template findings carry quick-fix data. */
  detail?: string;
}

export interface InspectionProfile {
  version: 1;
  name: string;
  maxFileLines: number;
  maxFunctionLines: number;
  checkers: Record<string, boolean>;
  licenseAudit: boolean;
  dependencyAudit: boolean;
}

export interface InspectionTotals {
  total: number;
  info: number;
  warning: number;
  error: number;
  byChecker: Record<string, number>;
}

export interface LicenseAuditView {
  scanned: boolean;
  nodeModulesPresent: boolean;
  total: number;
  permissive: number;
  other: number;
  copyleft: Array<{ name: string; version: string; license: string }>;
  unknown: Array<{ name: string; version: string; license: string; reason: string }>;
  note: string;
}

export interface InspectionRunView {
  runId: string;
  root: string;
  profileName: string;
  profileSource: string;
  profileNote: string;
  durationMs: number;
  filesScanned: number;
  totals: InspectionTotals;
  newCount: number;
  newFindings: InspectionFinding[];
  baselineEstablished: boolean;
  licenses: LicenseAuditView | null;
  securityFindings: InspectionFinding[];
  dependencies: DependencyAuditView | null;
}

export interface VulnerableDepView {
  name: string;
  version: string;
  source: string;
  ruleId: string;
  range: string;
  severity: 'info' | 'warning' | 'error';
  builtin: boolean;
  note?: string;
}

export interface DependencyAuditView {
  scanned: boolean;
  lockfiles: string[];
  skipped: string[];
  total: number;
  vulnerable: VulnerableDepView[];
  snapshot: string;
  snapshotNote: string;
  note: string;
}

export interface VulnerableRuleView {
  package: string;
  range: string;
  severity: 'info' | 'warning' | 'error';
  id: string;
  note?: string;
}

export interface SecuritySuppressionView {
  checker: string;
  file?: string;
  note?: string;
}

export interface SecurityRulesView {
  version: 1;
  additionalVulnerable: VulnerableRuleView[];
  suppress: SecuritySuppressionView[];
}

export interface InspectionHistoryEntry {
  runId: string;
  at: string;
  total: number;
  newCount: number;
  byChecker: Record<string, number>;
  profileName: string;
  baselineEstablished: boolean;
}

export interface SsrTemplateView {
  id: string;
  name: string;
  description?: string;
  version: 1;
  search: Record<string, unknown>;
  replace?: Record<string, unknown>;
  asInspection?: boolean;
  severity?: 'info' | 'warning' | 'error';
}

export interface InspectionsApi {
  overview(projectId: string, root?: string): Promise<{
    profile: InspectionProfile;
    profileSource: string;
    profileNote: string;
    baseline: { exists: boolean; establishedAt?: string; signatures?: number };
    lastRun: InspectionHistoryEntry | null;
  }>;
  saveProfile(projectId: string, root: string, profile: InspectionProfile): Promise<InspectionProfile>;
  run(projectId: string, root?: string): Promise<InspectionRunView>;
  history(projectId: string): Promise<InspectionHistoryEntry[]>;
  rebaseline(projectId: string, root?: string): Promise<{ baseline: { exists: boolean; establishedAt?: string; signatures?: number } }>;
  securityRules(projectId: string, root?: string): Promise<{
    root: string;
    rules: SecurityRulesView;
    rulesSource: string;
    rulesNote: string;
    builtIn: { snapshot: string; count: number };
  }>;
  saveSecurityRules(projectId: string, root: string, rules: SecurityRulesView): Promise<SecurityRulesView>;
  /** Structural search & replace (round-4 A4). */
  ssrTemplates(projectId: string, root?: string): Promise<{ builtins: SsrTemplateView[]; saved: SsrTemplateView[] }>;
  ssrSaveTemplate(projectId: string, root: string, template: Record<string, unknown>): Promise<{ template: SsrTemplateView }>;
  ssrDeleteTemplate(projectId: string, root: string, id: string): Promise<{ deleted: string }>;
  ssrQuickFix(
    projectId: string,
    root: string,
    quickfix: { templateId: string; file: string; startLine: number },
  ): Promise<{ applied: boolean; file: string; diff: string }>;
}

export function createInspectionsApi(base: string): InspectionsApi {
  const q = (projectId: string, root?: string) =>
    `?projectId=${encodeURIComponent(projectId)}${root ? `&root=${encodeURIComponent(root)}` : ''}`;
  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${base}${path}`, { headers: { ...authHeaders() }, ...init });
    const body = (await res.json()) as T;
    if (!res.ok) {
      const err = body as { error?: string };
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    return body;
  }
  return {
    overview: (projectId, root) => req(`/inspections${q(projectId, root)}`),
    saveProfile: (projectId, root, profile) =>
      req<{ projectId: string; root: string; profile: InspectionProfile }>('/inspections/profile', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, root, profile }),
      }).then((r) => r.profile),
    run: (projectId, root) =>
      req<InspectionRunView>('/inspections/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, ...(root ? { root } : {}) }),
      }),
    history: (projectId) =>
      req<{ projectId: string; runs: InspectionHistoryEntry[] }>(`/inspections/history?projectId=${encodeURIComponent(projectId)}`).then(
        (r) => r.runs,
      ),
    rebaseline: (projectId, root) =>
      req<{ projectId: string; root: string; baseline: { exists: boolean; establishedAt?: string; signatures?: number } }>(
        '/inspections/baseline',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId, ...(root ? { root } : {}) }),
        },
      ).then((r) => ({ baseline: r.baseline })),
    securityRules: (projectId, root) =>
      req<{ projectId: string; root: string; rules: SecurityRulesView; rulesSource: string; rulesNote: string; builtIn: { snapshot: string; count: number } }>(
        `/inspections/security-rules${q(projectId, root)}`,
      ),
    saveSecurityRules: (projectId, root, rules) =>
      req<{ projectId: string; root: string; rules: SecurityRulesView }>('/inspections/security-rules', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, root, rules }),
      }).then((r) => r.rules),
    ssrTemplates: (projectId, root) => req<{ builtins: SsrTemplateView[]; saved: SsrTemplateView[] }>(`/ssr/templates${q(projectId, root)}`),
    ssrSaveTemplate: (projectId, root, template) =>
      req<{ template: SsrTemplateView }>('/ssr/templates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, root, template }),
      }),
    ssrDeleteTemplate: (projectId, root, id) =>
      req<{ deleted: string }>(`/ssr/templates/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, root }),
      }),
    ssrQuickFix: (projectId, root, quickfix) =>
      req<{ applied: boolean; file: string; diff: string }>('/ssr/quickfix', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, root, ...quickfix }),
      }),
  };
}

export function defaultInspectionsApi(): InspectionsApi {
  return createInspectionsApi(defaultApiBase());
}

/** Minimal zero-dependency SVG line chart. */
function LineChart(props: { series: Array<{ label: string; color: string; points: number[] }>; height?: number }) {
  const { series, height = 150 } = props;
  const width = 560;
  const pad = { l: 44, r: 8, t: 8, b: 18 };
  const all = series.flatMap((s) => s.points);
  const max = Math.max(1, ...all);
  const min = 0;
  const x = (i: number, n: number) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (width - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - (v - min) / (max - min)) * (height - pad.t - pad.b);
  const ticks = [0, 0.5, 1].map((f) => min + f * (max - min));
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" style={{ display: 'block' }}>
      {ticks.map((tv, i) => (
        <g key={i}>
          <line x1={pad.l} x2={width - pad.r} y1={y(tv)} y2={y(tv)} stroke="#2a2f3a" strokeWidth={1} />
          <text x={pad.l - 6} y={y(tv) + 4} textAnchor="end" fontSize={10} fill="#8b93a3">
            {tv >= 100 ? Math.round(tv) : tv.toFixed(1)}
          </text>
        </g>
      ))}
      {series.map((s) =>
        s.points.length > 1 ? (
          <polyline
            key={s.label}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            points={s.points.map((p, i) => `${x(i, s.points.length)},${y(p)}`).join(' ')}
          />
        ) : null,
      )}
      {series.map((s, si) => (
        <g key={s.label}>
          <rect x={pad.l + si * 150} y={height - 14} width={10} height={10} fill={s.color} />
          <text x={pad.l + si * 150 + 14} y={height - 5} fontSize={11} fill="#c9d1d9">
            {s.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

const CHECKER_IDS = ['todo-fixme', 'long-file', 'long-function', 'console-log', 'secret-scan', 'sast-patterns', 'ssr-template'];

const SEV_COLOR: Record<'info' | 'warning' | 'error', string> = {
  error: '#f85149',
  warning: '#d29922',
  info: '#58a6ff',
};

/**
 * Structural search template manager (round-4 A4): list built-ins, save
 * them (or custom JSON templates) as inspections, toggle/delete saved.
 */
function SsrTemplatesManager({ api, projectId, root }: { api: InspectionsApi; projectId: string; root: string }) {
  const { t } = useLang();
  const [builtins, setBuiltins] = useState<SsrTemplateView[]>([]);
  const [saved, setSaved] = useState<SsrTemplateView[]>([]);
  const [json, setJson] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.ssrTemplates(projectId, root.trim() || undefined);
      setBuiltins(r.builtins);
      setSaved(r.saved);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }, [api, projectId, root]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const saveAsInspection = useCallback(
    async (tpl: SsrTemplateView, asInspection: boolean) => {
      try {
        await api.ssrSaveTemplate(projectId, root.trim() || '', { ...tpl, asInspection });
        setMsg(t('ssr.saved', { id: tpl.id }));
        await refresh();
      } catch (e) {
        setMsg(t('ssr.saveFailed', { message: e instanceof Error ? e.message : String(e) }));
      }
    },
    [api, projectId, root, refresh, t],
  );

  const deleteTemplate = useCallback(
    async (id: string) => {
      try {
        await api.ssrDeleteTemplate(projectId, root.trim() || '', id);
        setMsg(t('ssr.deleted', { id }));
        await refresh();
      } catch (e) {
        setMsg(t('ssr.saveFailed', { message: e instanceof Error ? e.message : String(e) }));
      }
    },
    [api, projectId, root, refresh, t],
  );

  const addCustom = useCallback(async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      setMsg(t('ssr.badJson'));
      return;
    }
    try {
      await api.ssrSaveTemplate(projectId, root.trim() || '', parsed as Record<string, unknown>);
      setJson('');
      setMsg(t('ssr.savedCustom'));
      await refresh();
    } catch (e) {
      setMsg(t('ssr.saveFailed', { message: e instanceof Error ? e.message : String(e) }));
    }
  }, [api, projectId, root, json, refresh, t]);

  return (
    <details className="card" style={{ padding: '8px 12px', marginBottom: 6 }}>
      <summary style={{ cursor: 'pointer', fontSize: 13 }}>
        {t('ssr.templatesTitle')} <span className="muted">({t('ssr.templatesHint')})</span>
      </summary>
      <div style={{ fontSize: 12, marginTop: 8 }}>
        <div className="muted" style={{ marginBottom: 4 }}>{t('ssr.builtins')}</div>
        <ul style={{ margin: '4px 0 8px', paddingLeft: 18 }}>
          {builtins.map((b) => {
            const isSaved = saved.some((s) => s.id === b.id);
            return (
              <li key={b.id} style={{ marginBottom: 4 }}>
                <strong>{b.id}</strong> — {b.name}{' '}
                <span className="muted">{b.description}</span>{' '}
                {!isSaved && (
                  <button style={{ fontSize: 11, marginLeft: 4 }} onClick={() => void saveAsInspection(b, true)}>
                    {t('ssr.saveAsInspection')}
                  </button>
                )}
                {isSaved && <span className="muted">({t('ssr.alreadySaved')})</span>}
              </li>
            );
          })}
        </ul>
        <div className="muted" style={{ marginBottom: 4 }}>{t('ssr.savedList')}</div>
        {saved.length === 0 ? (
          <div className="muted">{t('ssr.noSaved')}</div>
        ) : (
          <ul style={{ margin: '4px 0 8px', paddingLeft: 18 }}>
            {saved.map((s) => (
              <li key={s.id} style={{ marginBottom: 4 }}>
                <strong>{s.id}</strong> — {s.name}{' '}
                <label style={{ fontSize: 11 }}>
                  <input
                    type="checkbox"
                    checked={s.asInspection !== false}
                    onChange={(e) => void saveAsInspection(s, e.target.checked)}
                  />{' '}
                  {t('ssr.asInspection')}
                </label>{' '}
                <button style={{ fontSize: 11, marginLeft: 4 }} onClick={() => void deleteTemplate(s.id)}>
                  {t('ssr.delete')}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="muted" style={{ marginBottom: 4 }}>{t('ssr.customJson')}</div>
        <textarea
          value={json}
          onChange={(e) => setJson(e.target.value)}
          rows={4}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 11 }}
          placeholder='{"id":"my-tpl","name":"...","version":1,"search":{"kind":"method"},"replace":{"op":"rename","to":"x"}}'
        />
        <div style={{ marginTop: 4 }}>
          <button className="primary" onClick={() => void addCustom()}>{t('ssr.addCustom')}</button>
        </div>
        {msg && <div className="muted" style={{ marginTop: 6 }}>{msg}</div>}
      </div>
    </details>
  );
}

export function InspectionsPanel({ api, projectId }: { api: InspectionsApi; projectId: string }) {
  const { t } = useLang();
  const [root, setRoot] = useState('');
  const [profile, setProfile] = useState<InspectionProfile | null>(null);
  const [profileSource, setProfileSource] = useState('');
  const [profileNote, setProfileNote] = useState('');
  const [baseline, setBaseline] = useState<{ exists: boolean; establishedAt?: string; signatures?: number }>({ exists: false });
  const [run, setRun] = useState<InspectionRunView | null>(null);
  const [history, setHistory] = useState<InspectionHistoryEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [secRules, setSecRules] = useState<SecurityRulesView | null>(null);
  const [secRulesNote, setSecRulesNote] = useState('');
  const [secBuiltin, setSecBuiltin] = useState<{ snapshot: string; count: number }>({ snapshot: '', count: 0 });
  const [newRule, setNewRule] = useState({ package: '', range: '', id: '', severity: 'warning' as 'info' | 'warning' | 'error' });

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [ov, hist, sec] = await Promise.all([
        api.overview(projectId, root.trim() || undefined),
        api.history(projectId),
        api.securityRules(projectId, root.trim() || undefined),
      ]);
      setProfile(ov.profile);
      setProfileSource(ov.profileSource);
      setProfileNote(ov.profileNote);
      setBaseline(ov.baseline);
      setHistory(hist);
      setSecRules(sec.rules);
      setSecRulesNote(sec.rulesNote);
      setSecBuiltin(sec.builtIn);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('inspections.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [api, projectId, root, t]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const doRun = useCallback(async () => {
    setRunning(true);
    setMsg(null);
    try {
      const r = await api.run(projectId, root.trim() || undefined);
      setRun(r);
      setHistory(await api.history(projectId));
      setMsg(
        t('inspections.runDone', {
          total: r.totals.total,
          newCount: r.newCount,
          verdict: r.newCount > 0 ? t('inspections.hasNew') : t('inspections.clean'),
        }),
      );
    } catch (e) {
      setMsg(t('inspections.runFailed', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setRunning(false);
    }
  }, [api, projectId, root, t]);

  const doRebaseline = useCallback(async () => {
    if (!window.confirm(t('inspections.rebaselineConfirm'))) return;
    try {
      const r = await api.rebaseline(projectId, root.trim() || undefined);
      setBaseline(r.baseline);
      setMsg(t('inspections.rebased', { count: r.baseline.signatures ?? 0 }));
    } catch (e) {
      setMsg(t('inspections.runFailed', { message: e instanceof Error ? e.message : String(e) }));
    }
  }, [api, projectId, root, t]);

  const saveProfile = useCallback(async () => {
    if (!profile) return;
    try {
      const p = await api.saveProfile(projectId, root.trim() || '', profile);
      setProfile(p);
      setProfileSource('file');
      setProfileNote(t('inspections.profileSavedNote'));
      setMsg(t('inspections.saved'));
    } catch (e) {
      setMsg(t('inspections.saveFailed', { message: e instanceof Error ? e.message : String(e) }));
    }
  }, [api, profile, projectId, root, t]);

  const chartSeries = useMemo(() => {
    if (history.length === 0) return [];
    return [
      { label: t('inspections.trendTotal'), color: '#58a6ff', points: history.map((h) => h.total) },
      { label: t('inspections.trendNew'), color: '#f85149', points: history.map((h) => h.newCount) },
    ];
  }, [history, t]);

  const grouped = useMemo(() => {
    if (!run) return [];
    const map = new Map<string, InspectionFinding[]>();
    for (const f of run.newFindings) {
      const list = map.get(f.checker) ?? [];
      list.push(f);
      map.set(f.checker, list);
    }
    return [...map.entries()];
  }, [run]);

  /** Security findings grouped by severity (error first), stable for the Security section. */
  const secBySeverity = useMemo(() => {
    const findings = run?.securityFindings ?? [];
    const order: Array<'error' | 'warning' | 'info'> = ['error', 'warning', 'info'];
    return order
      .map((sev) => [sev, findings.filter((f) => f.severity === sev)] as const)
      .filter(([, list]) => list.length > 0);
  }, [run]);

  const secErrCount = useMemo(
    () => (run?.securityFindings ?? []).filter((f) => f.severity === 'error').length,
    [run],
  );
  const secWarnCount = useMemo(
    () => (run?.securityFindings ?? []).filter((f) => f.severity === 'warning').length,
    [run],
  );

  /** Add a project exemption for one finding, then re-run to refresh the list. */
  const suppressFinding = useCallback(
    async (f: InspectionFinding) => {
      if (!secRules) return;
      try {
        const rules: SecurityRulesView = {
          version: 1,
          additionalVulnerable: secRules.additionalVulnerable,
          suppress: [...secRules.suppress, { checker: f.checker, file: f.file }],
        };
        const saved = await api.saveSecurityRules(projectId, root.trim() || '', rules);
        setSecRules(saved);
        setMsg(t('inspections.secSuppressed'));
      } catch (e) {
        setMsg(t('inspections.saveFailed', { message: e instanceof Error ? e.message : String(e) }));
      }
    },
    [api, projectId, root, secRules, t],
  );

  const removeSuppression = useCallback(
    async (idx: number) => {
      if (!secRules) return;
      try {
        const rules: SecurityRulesView = {
          version: 1,
          additionalVulnerable: secRules.additionalVulnerable,
          suppress: secRules.suppress.filter((_, i) => i !== idx),
        };
        setSecRules(await api.saveSecurityRules(projectId, root.trim() || '', rules));
      } catch (e) {
        setMsg(t('inspections.saveFailed', { message: e instanceof Error ? e.message : String(e) }));
      }
    },
    [api, projectId, root, secRules, t],
  );

  /** One-click quick-fix for an ssr-template finding (round-4 A4). */
  const quickFixSsr = useCallback(
    async (f: InspectionFinding) => {
      if (!f.detail) return;
      let d: { templateId?: string; file?: string; startLine?: number };
      try {
        d = JSON.parse(f.detail);
      } catch {
        setMsg(t('ssr.badDetail'));
        return;
      }
      if (!d.templateId || !d.file || typeof d.startLine !== 'number') {
        setMsg(t('ssr.badDetail'));
        return;
      }
      try {
        const r = await api.ssrQuickFix(projectId, root.trim() || '', {
          templateId: d.templateId,
          file: d.file,
          startLine: d.startLine,
        });
        setMsg(t('ssr.fixed', { file: r.file }));
        await doRun();
      } catch (e) {
        setMsg(t('ssr.fixFailed', { message: e instanceof Error ? e.message : String(e) }));
      }
    },
    [api, projectId, root, t, doRun],
  );

  const addCustomRule = useCallback(async () => {
    if (!secRules || !newRule.package.trim() || !newRule.range.trim()) return;
    try {
      const rule: VulnerableRuleView = {
        package: newRule.package.trim(),
        range: newRule.range.trim(),
        id: newRule.id.trim() || 'CUSTOM',
        severity: newRule.severity,
      };
      const rules: SecurityRulesView = {
        version: 1,
        additionalVulnerable: [...secRules.additionalVulnerable, rule],
        suppress: secRules.suppress,
      };
      setSecRules(await api.saveSecurityRules(projectId, root.trim() || '', rules));
      setNewRule({ package: '', range: '', id: '', severity: 'warning' });
    } catch (e) {
      setMsg(t('inspections.saveFailed', { message: e instanceof Error ? e.message : String(e) }));
    }
  }, [api, projectId, root, secRules, newRule, t]);

  const removeCustomRule = useCallback(
    async (idx: number) => {
      if (!secRules) return;
      try {
        const rules: SecurityRulesView = {
          version: 1,
          additionalVulnerable: secRules.additionalVulnerable.filter((_, i) => i !== idx),
          suppress: secRules.suppress,
        };
        setSecRules(await api.saveSecurityRules(projectId, root.trim() || '', rules));
      } catch (e) {
        setMsg(t('inspections.saveFailed', { message: e instanceof Error ? e.message : String(e) }));
      }
    },
    [api, projectId, root, secRules, t],
  );

  const card = (label: string, value: string, sub?: string) => (
    <div className="card" style={{ padding: '10px 12px', minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 11 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, marginTop: 2 }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{sub}</div>}
    </div>
  );

  return (
    <div style={{ padding: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>{t('inspections.title')}</h3>
        <span className="muted" style={{ fontSize: 12 }}>{t('inspections.subtitle')}</span>
        <span style={{ flex: 1 }} />
        <button className="primary" onClick={doRun} disabled={running}>
          {running ? t('inspections.running') : t('inspections.run')}
        </button>
        <button onClick={doRebaseline} title={t('inspections.rebaselineHint')}>
          {t('inspections.rebaseline')}
        </button>
        <button onClick={refresh}>{t('inspections.refresh')}</button>
      </div>
      {msg && <div className="banner">{msg}</div>}
      {err && <div className="banner err">{err}</div>}
      {loading && <div className="muted">{t('inspections.loading')}</div>}

      <div className="card" style={{ padding: '10px 12px', marginBottom: 12 }}>
        <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>{t('inspections.rootLabel')}</div>
        <input
          value={root}
          onChange={(e) => setRoot(e.target.value)}
          placeholder={t('inspections.rootPlaceholder')}
          style={{ width: '100%', boxSizing: 'border-box' }}
          onBlur={refresh}
        />
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{t('inspections.rootHint')}</div>
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          {t('inspections.baselineStatus', { status: baseline.exists ? t('inspections.baselineYes') : t('inspections.baselineNo') })}
        </div>
      </div>

      {profile && (
        <div className="card" style={{ padding: '10px 12px', marginBottom: 12 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{t('inspections.profileTitle')}</div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <label>
              <span className="muted" style={{ fontSize: 11, marginRight: 6 }}>{t('inspections.profileName')}</span>
              <input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} style={{ width: 160 }} />
            </label>
            <label>
              <span className="muted" style={{ fontSize: 11, marginRight: 6 }}>{t('inspections.maxFileLines')}</span>
              <input
                type="number"
                value={profile.maxFileLines}
                onChange={(e) => setProfile({ ...profile, maxFileLines: Number(e.target.value) })}
                style={{ width: 90 }}
              />
            </label>
            <label>
              <span className="muted" style={{ fontSize: 11, marginRight: 6 }}>{t('inspections.maxFunctionLines')}</span>
              <input
                type="number"
                value={profile.maxFunctionLines}
                onChange={(e) => setProfile({ ...profile, maxFunctionLines: Number(e.target.value) })}
                style={{ width: 90 }}
              />
            </label>
            <label style={{ fontSize: 12 }}>
              <input
                type="checkbox"
                checked={profile.licenseAudit}
                onChange={(e) => setProfile({ ...profile, licenseAudit: e.target.checked })}
              />{' '}
              {t('inspections.licenseAudit')}
            </label>
            <label style={{ fontSize: 12 }}>
              <input
                type="checkbox"
                checked={profile.dependencyAudit !== false}
                onChange={(e) => setProfile({ ...profile, dependencyAudit: e.target.checked })}
              />{' '}
              {t('inspections.dependencyAudit')}
            </label>
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
            {CHECKER_IDS.map((id) => (
              <label key={id} style={{ fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={profile.checkers[id] !== false}
                  onChange={(e) => setProfile({ ...profile, checkers: { ...profile.checkers, [id]: e.target.checked } })}
                />{' '}
                {id}
              </label>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>{profileNote} ({profileSource})</div>
          <button className="primary" style={{ marginTop: 8 }} onClick={saveProfile}>
            {t('inspections.saveProfile')}
          </button>
        </div>
      )}

      <SsrTemplatesManager api={api} projectId={projectId} root={root} />

      {run && (
        <>
          <div className="muted" style={{ fontSize: 12, margin: '12px 0 6px' }}>
            {t('inspections.lastRun', { ms: run.durationMs, files: run.filesScanned })}
            {run.baselineEstablished && ` · ${t('inspections.baselineEstablished')}`}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
            {card(t('inspections.total'), String(run.totals.total))}
            {card(t('inspections.new'), String(run.newCount), run.newCount > 0 ? t('inspections.hasNew') : t('inspections.clean'))}
            {card(t('inspections.warnings'), String(run.totals.warning))}
            {card(t('inspections.infos'), String(run.totals.info))}
          </div>

          <div className="muted" style={{ fontSize: 12, margin: '12px 0 6px' }}>{t('inspections.newFindings')}</div>
          {grouped.length === 0 ? (
            <div className="muted">{t('inspections.noNew')}</div>
          ) : (
            grouped.map(([checker, findings]) => (
              <details key={checker} className="card" style={{ padding: '8px 12px', marginBottom: 6 }}>
                <summary style={{ cursor: 'pointer', fontSize: 13 }}>
                  {checker} <span className="muted">({findings.length})</span>
                </summary>
                <ul style={{ fontSize: 12, margin: '6px 0 0', paddingLeft: 18 }}>
                  {findings.slice(0, 50).map((f) => (
                    <li key={f.id}>
                      <span className="muted">{f.file}{f.line ? `:${f.line}` : ''}</span> — {f.message}{' '}
                      {f.checker === 'ssr-template' && f.detail && (
                        <button
                          onClick={() => void quickFixSsr(f)}
                          title={t('ssr.quickFixHint')}
                          style={{ fontSize: 11, marginLeft: 4 }}
                        >
                          {t('ssr.quickFix')}
                        </button>
                      )}
                    </li>
                  ))}
                  {findings.length > 50 && <li className="muted">…{t('inspections.more', { n: findings.length - 50 })}</li>}
                </ul>
              </details>
            ))
          )}

          {run.licenses && (
            <>
              <div className="muted" style={{ fontSize: 12, margin: '12px 0 6px' }}>{t('inspections.licenseTitle')}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
                {card(t('inspections.deps'), String(run.licenses.total), t('inspections.permissiveCount', { n: run.licenses.permissive }))}
                {card(t('inspections.copyleft'), String(run.licenses.copyleft.length))}
                {card(t('inspections.unknown'), String(run.licenses.unknown.length), t('inspections.unknownHint'))}
              </div>
              {(run.licenses.copyleft.length > 0 || run.licenses.unknown.length > 0) && (
                <div className="card" style={{ padding: '8px 12px', marginTop: 6, fontSize: 12 }}>
                  {run.licenses.copyleft.length > 0 && (
                    <div style={{ marginBottom: 6 }}>
                      <strong>{t('inspections.copyleft')}:</strong>
                      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                        {run.licenses.copyleft.map((c) => (
                          <li key={c.name}>{c.name} {c.version} — {c.license}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {run.licenses.unknown.length > 0 && (
                    <div>
                      <strong>{t('inspections.unknown')}:</strong>
                      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                        {run.licenses.unknown.slice(0, 30).map((u) => (
                          <li key={u.name}>{u.name} {u.version} — <span className="muted">{u.reason}</span></li>
                        ))}
                        {run.licenses.unknown.length > 30 && <li className="muted">…{t('inspections.more', { n: run.licenses.unknown.length - 30 })}</li>}
                      </ul>
                    </div>
                  )}
                </div>
              )}
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{run.licenses.note}</div>
            </>
          )}

          {/* Security section (wave2-④): severity-grouped findings + dependency audit. */}
          <div className="muted" style={{ fontSize: 12, margin: '12px 0 6px' }}>{t('inspections.securityTitle')}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
            {card(t('inspections.secErrors'), String(secErrCount))}
            {card(t('inspections.secWarnings'), String(secWarnCount))}
            {card(
              t('inspections.secVulnTitle'),
              run.dependencies ? String(run.dependencies.vulnerable.length) : '—',
              run.dependencies ? t('inspections.secDepsScanned', { n: run.dependencies.total }) : t('inspections.secAuditOff'),
            )}
          </div>
          {secBySeverity.length === 0 ? (
            <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>{t('inspections.secNoFindings')}</div>
          ) : (
            secBySeverity.map(([sev, findings]) => (
              <details key={sev} className="card" style={{ padding: '8px 12px', marginBottom: 6, marginTop: 6 }} open={sev === 'error'}>
                <summary style={{ cursor: 'pointer', fontSize: 13 }}>
                  <span style={{ color: SEV_COLOR[sev], fontWeight: 600 }}>{sev.toUpperCase()}</span>{' '}
                  <span className="muted">({findings.length})</span>
                </summary>
                <ul style={{ fontSize: 12, margin: '6px 0 0', paddingLeft: 18 }}>
                  {findings.slice(0, 60).map((f) => (
                    <li key={f.id} style={{ marginBottom: 4 }}>
                      <span className="muted">{f.file}{f.line ? `:${f.line}` : ''}</span> — {f.message}{' '}
                      <button
                        onClick={() => void suppressFinding(f)}
                        title={t('inspections.secSuppressHint')}
                        style={{ fontSize: 11, marginLeft: 4 }}
                      >
                        {t('inspections.secSuppress')}
                      </button>
                    </li>
                  ))}
                  {findings.length > 60 && <li className="muted">…{t('inspections.more', { n: findings.length - 60 })}</li>}
                </ul>
              </details>
            ))
          )}
          {run.dependencies && (
            <div className="card" style={{ padding: '8px 12px', marginTop: 6, fontSize: 12 }}>
              <div>
                <strong>{t('inspections.secVulnTitle')}:</strong>{' '}
                <span className="muted">{t('inspections.secSnapshot', { date: run.dependencies.snapshot, n: secBuiltin.count })}</span>
              </div>
              {run.dependencies.vulnerable.length === 0 ? (
                <div className="muted" style={{ marginTop: 4 }}>{t('inspections.secVulnNone')}</div>
              ) : (
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {run.dependencies.vulnerable.slice(0, 40).map((v) => (
                    <li key={`${v.name}@${v.version}`}>
                      <span style={{ color: SEV_COLOR[v.severity] }}>●</span>{' '}
                      {v.name}@{v.version} — {v.ruleId} ({v.range}){' '}
                      <span className="muted">
                        {v.builtin ? t('inspections.secBuiltin') : t('inspections.secCustom')}
                        {v.note ? ` — ${v.note}` : ''}
                      </span>
                    </li>
                  ))}
                  {run.dependencies.vulnerable.length > 40 && (
                    <li className="muted">…{t('inspections.more', { n: run.dependencies.vulnerable.length - 40 })}</li>
                  )}
                </ul>
              )}
              {run.dependencies.skipped.length > 0 && (
                <div className="muted" style={{ marginTop: 4 }}>
                  {t('inspections.secSkipped', { files: run.dependencies.skipped.join('; ') })}
                </div>
              )}
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{run.dependencies.note}</div>
            </div>
          )}
        </>
      )}

      {/* Rules & exemptions management (works without a run). */}
      <div className="muted" style={{ fontSize: 12, margin: '16px 0 6px' }}>{t('inspections.secRulesTitle')}</div>
      <div className="card" style={{ padding: '10px 12px', marginBottom: 12, fontSize: 12 }}>
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>{secRulesNote || t('inspections.secRulesNote')}</div>
        <div style={{ marginBottom: 8 }}>
          <strong>{t('inspections.secSuppressions')}</strong>
          {secRules && secRules.suppress.length === 0 ? (
            <span className="muted"> — {t('inspections.secNoSuppressions')}</span>
          ) : (
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {(secRules?.suppress ?? []).map((s, i) => (
                <li key={i}>
                  <span className="muted">{s.checker}</span>{s.file ? ` · ${s.file}` : ''}{s.note ? ` — ${s.note}` : ''}{' '}
                  <button onClick={() => void removeSuppression(i)} style={{ fontSize: 11 }}>
                    {t('inspections.secRemove')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <strong>{t('inspections.secCustomRules')}</strong>
          {secRules && secRules.additionalVulnerable.length === 0 ? (
            <span className="muted"> — {t('inspections.secNoCustomRules')}</span>
          ) : (
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {(secRules?.additionalVulnerable ?? []).map((r, i) => (
                <li key={i}>
                  {r.package} <span className="muted">{r.range}</span> — {r.id}{' '}
                  <button onClick={() => void removeCustomRule(i)} style={{ fontSize: 11 }}>
                    {t('inspections.secRemove')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
          <input
            placeholder={t('inspections.secPkg')}
            value={newRule.package}
            onChange={(e) => setNewRule({ ...newRule, package: e.target.value })}
            style={{ width: 140 }}
          />
          <input
            placeholder={t('inspections.secRange')}
            value={newRule.range}
            onChange={(e) => setNewRule({ ...newRule, range: e.target.value })}
            style={{ width: 130 }}
          />
          <input
            placeholder={t('inspections.secId')}
            value={newRule.id}
            onChange={(e) => setNewRule({ ...newRule, id: e.target.value })}
            style={{ width: 110 }}
          />
          <select
            value={newRule.severity}
            onChange={(e) => setNewRule({ ...newRule, severity: e.target.value as 'info' | 'warning' | 'error' })}
          >
            <option value="info">info</option>
            <option value="warning">warning</option>
            <option value="error">error</option>
          </select>
          <button onClick={() => void addCustomRule()}>{t('inspections.secAddRule')}</button>
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>
          {t('inspections.securityNote')}
        </div>
      </div>

      <div className="muted" style={{ fontSize: 12, margin: '16px 0 6px' }}>{t('inspections.trend')}</div>
      <div className="card" style={{ padding: 8 }}>
        {chartSeries.length > 0 && chartSeries[0].points.length > 0 ? (
          <LineChart series={chartSeries} />
        ) : (
          <div className="muted">{t('inspections.noHistory')}</div>
        )}
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 12, lineHeight: 1.6 }}>
        {t('inspections.honestyNote')}
      </div>
    </div>
  );
}

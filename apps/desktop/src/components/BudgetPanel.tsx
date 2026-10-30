import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type BudgetDefaultsView,
  type BudgetUsageView,
} from '../api';
import { useLang } from '../i18n';

/**
 * V3-#8 成本治理面板（Ops 页签内，复用 quota 显示位）：
 *  - 预算列表（当前窗口用量、状态）+ 新建 / 删除
 *  - 模拟用量记录（warn → trip → check 拦截 → 一键放行）
 *  - 项目默认预算幂等应用
 *  - 默认策略与换算表（全部占位系数，待实测水印）
 * 纯文字展示，样式跟随现有面板；费用/token 均为估算（除非用量源为
 * provider-reported），面板文案与服务端 basis 一致，不把估算当账单。
 */
export function BudgetPanel() {
  const { t } = useLang();
  const [budgets, setBudgets] = useState<BudgetUsageView[]>([]);
  const [defaults, setDefaults] = useState<BudgetDefaultsView | null>(null);
  const [overrides, setOverrides] = useState<{ budgetId: string; windowId: string; reason: string; releasedAt: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [scope, setScope] = useState('project');
  const [scopeKey, setScopeKey] = useState('');
  const [unit, setUnit] = useState('usd-estimate');
  const [limit, setLimit] = useState('10');
  const [period, setPeriod] = useState('monthly');

  const [usageId, setUsageId] = useState('');
  const [usageCost, setUsageCost] = useState('');
  const [usageCalls, setUsageCalls] = useState('');
  const [usageIn, setUsageIn] = useState('');
  const [usageOut, setUsageOut] = useState('');

  const [checkKey, setCheckKey] = useState('');
  const [checkScope, setCheckScope] = useState('project');
  const [checkResult, setCheckResult] = useState<{ allowed: boolean; blocking: BudgetUsageView[] } | null>(null);

  const [releaseId, setReleaseId] = useState('');
  const [releaseReason, setReleaseReason] = useState('');

  const [defaultsProject, setDefaultsProject] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [b, d, o] = await Promise.all([api.budgets(), api.budgetDefaults(), api.budgetOverrides()]);
      setBudgets(b.budgets ?? []);
      setDefaults(d);
      setOverrides(o.overrides ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const statusLabel = (s: string) =>
    s === 'warned' ? t('budget.statusWarned')
    : s === 'tripped' ? t('budget.statusTripped')
    : s === 'released' ? t('budget.statusReleased')
    : t('budget.statusOk');

  const unitLabel = (u: string) =>
    u === 'calls' ? t('budget.unitCalls')
    : u === 'tokens-estimate' ? t('budget.unitTokens')
    : t('budget.unitUsd');

  const scopeLabel = (s: string) =>
    s === 'task' ? t('budget.scopeTask')
    : s === 'person' ? t('budget.scopePerson')
    : t('budget.scopeProject');

  const periodLabel = (p: string) =>
    p === 'daily' ? t('budget.periodDaily')
    : p === 'weekly' ? t('budget.periodWeekly')
    : p === 'all-time' ? t('budget.periodAllTime')
    : t('budget.periodMonthly');

  async function onCreate() {
    setNotice(null);
    try {
      const n = Number(limit);
      if (!scopeKey.trim() || !Number.isFinite(n) || n <= 0) throw new Error('scopeKey + limit > 0 required');
      await api.createBudget({ scope, scopeKey: scopeKey.trim(), unit, limit: n, period });
      setScopeKey('');
      await refresh();
    } catch (e) {
      setNotice(t('budget.createFailed', { message: (e as Error).message }));
    }
  }

  async function onDelete(id: string) {
    try {
      await api.deleteBudget(id);
      await refresh();
    } catch (e) {
      setNotice(t('budget.deleteFailed', { message: (e as Error).message }));
    }
  }

  async function onRecord() {
    setNotice(null);
    try {
      if (!usageId.trim()) throw new Error('budget id required');
      const res = await api.recordBudgetUsage(usageId.trim(), {
        costUsd: usageCost.trim() ? Number(usageCost) : undefined,
        calls: usageCalls.trim() ? Number(usageCalls) : undefined,
        inputTokens: usageIn.trim() ? Number(usageIn) : undefined,
        outputTokens: usageOut.trim() ? Number(usageOut) : undefined,
        source: 'simulated',
      });
      const trips = res.tripped as { budgetId: string }[];
      for (const trip of trips) {
        const cp = res.checkpoints[trip.budgetId];
        setNotice(cp?.created
          ? t('budget.checkpointCreated', { id: cp.checkpointId ?? '' })
          : t('budget.checkpointSkipped', { reason: cp?.reason ?? '' }));
      }
      await refresh();
    } catch (e) {
      setNotice(t('budget.recordFailed', { message: (e as Error).message }));
    }
  }

  async function onCheck() {
    setNotice(null);
    try {
      if (!checkKey.trim()) throw new Error('scope id required');
      const refs = checkScope === 'task' ? { taskId: checkKey.trim() }
        : checkScope === 'person' ? { personId: checkKey.trim() }
        : { projectId: checkKey.trim() };
      setCheckResult(await api.checkBudget(refs));
    } catch (e) {
      setNotice(t('budget.checkFailed', { message: (e as Error).message }));
    }
  }

  async function onRelease() {
    setNotice(null);
    try {
      if (!releaseId.trim() || !releaseReason.trim()) throw new Error('budget id + reason required');
      await api.releaseBudget(releaseId.trim(), releaseReason.trim());
      setReleaseReason('');
      await refresh();
    } catch (e) {
      setNotice(t('budget.releaseFailed', { message: (e as Error).message }));
    }
  }

  async function onApplyDefaults() {
    setNotice(null);
    try {
      if (!defaultsProject.trim()) throw new Error('project id required');
      const res = await api.applyBudgetDefaults(defaultsProject.trim());
      setNotice(t('budget.applyDefaultsDone', { created: String(res.created.length), existing: String(res.existing.length) }));
      await refresh();
    } catch (e) {
      setNotice(t('budget.applyDefaultsFailed', { message: (e as Error).message }));
    }
  }

  if (error && budgets.length === 0 && !defaults) {
    return <div className="banner err">{t('budget.loadFailed', { message: error })}</div>;
  }

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-title">{t('budget.title')}</div>
      <p className="muted">{t('budget.desc')}</p>
      {error && <div className="banner err">{error}</div>}
      {notice && <div className="banner">{notice}</div>}

      {budgets.length === 0 ? (
        <p className="muted">{t('budget.empty')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('budget.scope')}</th>
              <th>{t('budget.unit')}</th>
              <th>{t('budget.limit')}</th>
              <th>{t('budget.used')}</th>
              <th>{t('budget.window')}</th>
              <th>{t('budget.status')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {budgets.map((u) => (
              <tr key={u.budget.id}>
                <td>{scopeLabel(u.budget.scope)}:{u.budget.scopeKey}</td>
                <td>{unitLabel(u.budget.unit)} / {periodLabel(u.budget.period)}</td>
                <td>{u.limit}</td>
                <td>{u.used} ({u.pct.toFixed(1)}%)</td>
                <td>{u.windowId}</td>
                <td>{statusLabel(u.status)}</td>
                <td><button onClick={() => onDelete(u.budget.id)}>{t('budget.delete')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ marginTop: 12 }}>
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="task">{t('budget.scopeTask')}</option>
          <option value="person">{t('budget.scopePerson')}</option>
          <option value="project">{t('budget.scopeProject')}</option>
        </select>{' '}
        <input placeholder={t('budget.scopeKey')} value={scopeKey} onChange={(e) => setScopeKey(e.target.value)} />{' '}
        <select value={unit} onChange={(e) => setUnit(e.target.value)}>
          <option value="usd-estimate">{t('budget.unitUsd')}</option>
          <option value="calls">{t('budget.unitCalls')}</option>
          <option value="tokens-estimate">{t('budget.unitTokens')}</option>
        </select>{' '}
        <input placeholder={t('budget.limit')} value={limit} onChange={(e) => setLimit(e.target.value)} />{' '}
        <select value={period} onChange={(e) => setPeriod(e.target.value)}>
          <option value="daily">{t('budget.periodDaily')}</option>
          <option value="weekly">{t('budget.periodWeekly')}</option>
          <option value="monthly">{t('budget.periodMonthly')}</option>
          <option value="all-time">{t('budget.periodAllTime')}</option>
        </select>{' '}
        <button onClick={onCreate}>{t('budget.create')}</button>
      </div>

      <div style={{ marginTop: 12 }}>
        <input placeholder="budget id" value={usageId} onChange={(e) => setUsageId(e.target.value)} />{' '}
        <input placeholder={t('budget.costUsd')} value={usageCost} onChange={(e) => setUsageCost(e.target.value)} />{' '}
        <input placeholder={t('budget.calls')} value={usageCalls} onChange={(e) => setUsageCalls(e.target.value)} />{' '}
        <input placeholder={t('budget.inputTokens')} value={usageIn} onChange={(e) => setUsageIn(e.target.value)} />{' '}
        <input placeholder={t('budget.outputTokens')} value={usageOut} onChange={(e) => setUsageOut(e.target.value)} />{' '}
        <button onClick={onRecord}>{t('budget.recordUsage')}</button>
      </div>

      <div style={{ marginTop: 12 }}>
        <select value={checkScope} onChange={(e) => setCheckScope(e.target.value)}>
          <option value="task">{t('budget.scopeTask')}</option>
          <option value="person">{t('budget.scopePerson')}</option>
          <option value="project">{t('budget.scopeProject')}</option>
        </select>{' '}
        <input placeholder={t('budget.scopeKey')} value={checkKey} onChange={(e) => setCheckKey(e.target.value)} />{' '}
        <button onClick={onCheck}>{t('budget.check')}</button>
        {checkResult && (
          <span className="muted"> {checkResult.allowed ? t('budget.checkAllowed') : t('budget.checkBlocked')}</span>
        )}
      </div>

      <div style={{ marginTop: 12 }}>
        <input placeholder="budget id" value={releaseId} onChange={(e) => setReleaseId(e.target.value)} />{' '}
        <input placeholder={t('budget.releaseReason')} value={releaseReason} onChange={(e) => setReleaseReason(e.target.value)} />{' '}
        <button onClick={onRelease}>{t('budget.release')}</button>
      </div>

      <div style={{ marginTop: 12 }}>
        <input placeholder={t('budget.applyDefaultsPlaceholder')} value={defaultsProject} onChange={(e) => setDefaultsProject(e.target.value)} />{' '}
        <button onClick={onApplyDefaults}>{t('budget.applyDefaults')}</button>
      </div>

      {defaults && (
        <div style={{ marginTop: 12 }}>
          <div className="card-title">{t('budget.defaultsTitle')}</div>
          <p className="muted">
            {t('budget.defaultsPolicy', {
              cap: defaults.policy.capEnabledByDefault ? t('budget.defaultsCapOn') : t('budget.defaultsCapOff'),
              renew: defaults.policy.autoRenewDefault ? t('budget.defaultsRenewOn') : t('budget.defaultsRenewOff'),
              pct: String(defaults.policy.warnAtPct),
              limit: String(defaults.policy.defaultProjectBudget.limit),
              taskLimit: String(defaults.policy.defaultTaskBudget.limit),
            })}
          </p>
          <p className="muted">{t('budget.conversionWatermark')}</p>
          <ul>
            {defaults.conversionTable.map((row) => (
              <li key={row.unit}>
                {row.unit}: {row.description} — {row.estimatedInputTokens} in / {row.estimatedOutputTokens} out / ${row.estimatedCostUsd}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <div className="card-title">{t('budget.overrides')}</div>
        {overrides.length === 0 ? (
          <p className="muted">{t('budget.overridesEmpty')}</p>
        ) : (
          <ul>
            {overrides.map((o, i) => (
              <li key={i}>{o.budgetId} ({o.windowId}): {o.reason} — {o.releasedAt}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

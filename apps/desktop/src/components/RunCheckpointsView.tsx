import { useCallback, useEffect, useState } from 'react';
import { api, type CheckpointV2 } from '../api';
import { useLang } from '../i18n';

/**
 * §28.3 checkpoint 查看区（Batch 14 在 OrchestratePanel 的 run 详情里
 * 首建，Batch 16 抽成共享组件，Observatory 的行内详情复用同一呈现）。
 *
 * 呈现口径与 Batch 14 一致、逐字保留：空列表是服务端诚实的「尚未
 * 捕获」而非错误；/latest 的 404（已知但未执行的 run）不算错误；
 * latest 一行给出恢复点（最高步位）的步位/捕获时间/版本/上下文哈希。
 * 数据加载不在本组件内：OrchestratePanel 用它自己的 client 加载，
 * Observatory 用下面的 useRunCheckpoints（走 api.ts）。
 */
export function RunCheckpointsSection({
  checkpoints,
  latest,
  error,
  onRefresh,
}: {
  /** null = 尚未加载完成（区别于已加载但为空）。 */
  checkpoints: CheckpointV2[] | null;
  latest: CheckpointV2 | null;
  error: string;
  onRefresh?: () => void;
}) {
  const { t } = useLang();
  return (
    <div>
      <h4>
        Checkpoints（§28.3）{' '}
        {onRefresh && <button onClick={onRefresh}>{t('runcheckpoints.refresh')}</button>}
      </h4>
      {error && <div className="banner err">{t('runcheckpoints.unavailable', { error })}</div>}
      {!error && checkpoints === null && <p className="muted">Loading checkpoints…</p>}
      {!error && checkpoints !== null && checkpoints.length === 0 && (
        <p className="muted">{t('runcheckpoints.empty')}</p>
      )}
      {latest && (
        <p className="muted" style={{ fontSize: 12 }}>
          {t('runcheckpoints.latest', {
            step: latest.stepPosition,
            time: new Date(latest.capturedAt).toLocaleString(),
            workflow: latest.workflowVersion,
            task: latest.taskVersion,
          })}{' '}
          <code>{latest.contextManifestHash.slice(0, 12)}…</code>
        </p>
      )}
      {checkpoints !== null && checkpoints.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('runcheckpoints.col.step')}</th><th>{t('runcheckpoints.col.capturedAt')}</th><th>{t('runcheckpoints.col.budget')}</th>
              <th>{t('runcheckpoints.col.activeTools')}</th><th>{t('runcheckpoints.col.pendingApprovals')}</th><th>{t('runcheckpoints.col.resumePreconditions')}</th>
            </tr>
          </thead>
          <tbody>
            {checkpoints.map((c) => (
              <tr key={c.stepPosition}>
                <td>{c.stepPosition}</td>
                <td>{new Date(c.capturedAt).toLocaleString()}</td>
                <td>
                  {Object.keys(c.budgetUsage).length === 0
                    ? '—'
                    : Object.entries(c.budgetUsage)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(', ')}
                </td>
                <td>{c.activeTools.length ? c.activeTools.join(', ') : '—'}</td>
                <td>{c.pendingApprovals.length ? c.pendingApprovals.join(', ') : '—'}</td>
                <td>{c.resumePreconditions.length ? c.resumePreconditions.join(t('runcheckpoints.sep')) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * 经 api.ts 加载某 run 的 checkpoints + latest（语义与 OrchestratePanel
 * 的 loadCheckpoints 相同：列表失败 → error 呈现；latest 404 → null
 * 不报红）。runId 变化时先清空，避免把上一个 run 的捕获显示到新 run 名下。
 */
export function useRunCheckpoints(runId: string | null) {
  const [checkpoints, setCheckpoints] = useState<CheckpointV2[] | null>(null);
  const [latest, setLatest] = useState<CheckpointV2 | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!runId) return;
    setError('');
    try {
      const res = await api.runCheckpoints(runId);
      setCheckpoints(res.checkpoints ?? []);
    } catch (e) {
      setCheckpoints(null);
      setError((e as Error).message);
    }
    try {
      setLatest(await api.runCheckpointLatest(runId));
    } catch {
      setLatest(null);
    }
  }, [runId]);

  useEffect(() => {
    setCheckpoints(null);
    setLatest(null);
    setError('');
    if (runId) void reload();
  }, [runId, reload]);

  return { checkpoints, latest, error, reload };
}

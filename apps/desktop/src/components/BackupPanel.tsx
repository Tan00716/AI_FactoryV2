import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type BackupSummary,
  type PendingRestore,
  type ProjectFilesRestoreResult,
  type RestoreStageResult,
} from '../api';
import { useLang } from '../i18n';

/**
 * 备份 / 恢复面板（运维区）：工厂数据库的备份与排队恢复，以及
 *  项目工作文件的备份与立即恢复（Batch 45 起）。
 *  - GET /api/backups：备份列表（manifest 摘要）+ 待生效恢复状态
 *  - POST /api/backup：创建备份（服务端 VACUUM INTO 一致性快照 +
 *    项目工作文件收录，Batch 45；scope 字段如实标注范围）
 *  - POST /api/restore：校验并排队恢复数据库 —— 破坏性相邻操作，
 *    UI 必须先展开确认区，讲清三件事后才允许提交：① 服务端会先自动
 *    备份当前数据库（pre-restore，可回滚）；② 恢复在下次服务端重启
 *    时才生效，运行中的服务继续使用现库；③ 只恢复数据库，项目工作
 *    文件不受影响（项目文件恢复走独立端点）。
 *  - POST /api/restore/project-files：校验并立即恢复备份中的项目
 *    工作文件到 live 项目目录 —— 同样是破坏性操作，确认区必须讲清：
 *    ① 立即生效，不排队重启（与数据库恢复不对称）；② 恢复前服务端
 *    已复制当前文件到 preRestoreDir（可再回滚）；③ 校验失败（422）
 *    则现树不动。对服务端返回与拒绝原因（校验 problems）如实呈现。
 */

function fmtTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function BackupPanel() {
  const { t, has } = useLang();
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [pending, setPending] = useState<PendingRestore | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  /** 项目文件恢复确认区中的 backupId（立即生效路径，独立于数据库恢复排队）。 */
  const [confirmFilesId, setConfirmFilesId] = useState<string | null>(null);
  const [stagedFiles, setStagedFiles] = useState<ProjectFilesRestoreResult | null>(null);
  /** backupId 正在确认区中等待操作者确认（null = 无确认进行中）。 */
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [staged, setStaged] = useState<RestoreStageResult | null>(null);

  /** 服务端 scope 码 → 展示文案（DashboardPanel statText 模式：有 key 用翻译、缺 key 回退服务端原文）。 */
  const scopeLabel = (scope: string): string => {
    const key = scope === 'factory-database+project-files' ? 'backup.scope.full' : 'backup.scope.dbOnly';
    return has(key) ? t(key) : scope;
  };

  const load = useCallback(async () => {
    try {
      const res = await api.backups();
      setBackups(res.backups ?? []);
      setPending(res.pendingRestore ?? null);
      setLoaded(true);
    } catch (e) {
      setErr(t('backup.loadFailed', { message: (e as Error).message }));
      setLoaded(true);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const onCreate = async () => {
    setBusy('create');
    setErr('');
    setProblems([]);
    try {
      await api.createBackup();
      await load();
    } catch (e) {
      setErr(t('backup.createFailed', { message: (e as Error).message }));
    } finally {
      setBusy('');
    }
  };

  const onConfirmRestore = async () => {
    if (!confirmId) return;
    setBusy('restore');
    setErr('');
    setProblems([]);
    try {
      const res = await api.stageRestore(confirmId);
      setStaged(res);
      setConfirmId(null);
      await load();
    } catch (e) {
      const ex = e as Error & { problems?: string[] };
      setErr(t('backup.stageRestoreFailed', { message: ex.message }));
      if (Array.isArray(ex.problems)) setProblems(ex.problems);
      // 409（已有排队）等状态变化后刷新列表，让 pending 状态如实呈现。
      await load();
    } finally {
      setBusy('');
    }
  };

  const onConfirmProjectFilesRestore = async () => {
    if (!confirmFilesId) return;
    setBusy('restore-files');
    setErr('');
    setProblems([]);
    try {
      const res = await api.restoreProjectFiles(confirmFilesId);
      setStagedFiles(res);
      setConfirmFilesId(null);
      await load();
    } catch (e) {
      const ex = e as Error & { problems?: string[] };
      setErr(t('backup.restoreFilesFailed', { message: ex.message }));
      if (Array.isArray(ex.problems)) setProblems(ex.problems);
      await load();
    } finally {
      setBusy('');
    }
  };

  const confirmTarget = confirmId
    ? backups.find((b) => b.backupId === confirmId)
    : undefined;
  const confirmFilesTarget = confirmFilesId
    ? backups.find((b) => b.backupId === confirmFilesId)
    : undefined;

  return (
    <div className="panel">
      <h2>{t('backup.title')} <span className="muted">{t('backup.subtitle')}</span></h2>
      <p className="muted">{t('backup.description')}</p>
      {err && <div className="banner err">{err}</div>}
      {problems.length > 0 && (
        <ul className="issue-list">
          {problems.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}

      {pending && (
        <div className="card" style={{ borderColor: 'var(--yellow)', cursor: 'default' }}>
          <div className="card-title">{t('backup.pendingTitle')}</div>
          <div style={{ fontSize: 13 }}>
            <div>
              {t('backup.pendingTarget')}<code>{pending.backupId}</code> · {t('backup.pendingTime')}{fmtTime(pending.stagedAt)}
            </div>
            <div>
              {t('backup.pendingPreRestore')}<code>{pending.preRestoreBackupId}</code>
            </div>
            <div className="muted">{t('backup.pendingNote')}</div>
          </div>
        </div>
      )}

      {staged && (
        <div className="card" style={{ cursor: 'default' }}>
          <div className="card-title">{t('backup.stagedTitle')}</div>
          <div style={{ fontSize: 13 }}>
            <p style={{ margin: '4px 0' }}>{staged.message}</p>
            <div className="muted">
              {t('backup.pendingTarget')}<code>{staged.backupId}</code> · {t('backup.preRestoreLabel')}
              <code>{staged.preRestoreBackupId}</code> · {t('backup.stagedRestartHint')}
            </div>
          </div>
        </div>
      )}

      <div className="row">
        <button onClick={() => void onCreate()} disabled={busy !== ''}>
          {busy === 'create' ? t('backup.creating') : t('backup.create')}
        </button>
        <button onClick={() => void load()} disabled={busy !== ''}>{t('backup.refresh')}</button>
        <span className="muted">{t('backup.count', { count: backups.length })}</span>
      </div>

      {!loaded ? (
        <p className="muted">{t('backup.loading')}</p>
      ) : backups.length === 0 ? (
        <p className="muted">{t('backup.empty', { create: t('backup.create') })}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('backup.col.backup')}</th><th>{t('backup.col.type')}</th><th>{t('backup.col.scope')}</th><th>{t('backup.col.created')}</th><th>{t('backup.col.appVersion')}</th>
              <th>{t('backup.col.rows')}</th><th>{t('backup.col.size')}</th><th>{t('backup.col.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {backups.map((b) => (
              <tr key={b.backupId}>
                <td><code>{b.backupId}</code></td>
                <td>
                  <span className={b.kind === 'pre-restore' ? 'pill warn' : 'pill'}>
                    {b.kind}
                  </span>
                </td>
                <td>
                  <span className="pill">{scopeLabel(b.scope)}</span>
                  {b.projectFiles && (
                    <div className="muted" style={{ fontSize: 11 }}>
                      {t('backup.fileCount', { count: b.projectFiles.projects.reduce((a, p) => a + p.fileCount, 0) })}
                    </div>
                  )}
                </td>
                <td>{fmtTime(b.createdAt)}</td>
                <td>{b.appVersion}</td>
                <td>{b.totalRows}</td>
                <td>{fmtBytes(b.bytes)}</td>
                <td>
                  <button
                    onClick={() => { setConfirmId(b.backupId); setStaged(null); }}
                    disabled={busy !== '' || pending !== null}
                    title={pending ? t('backup.restoreDbDisabledTitle') : undefined}
                  >
                    {t('backup.restoreDb')}
                  </button>
                  {b.scope === 'factory-database+project-files' && (
                    <button
                      onClick={() => { setConfirmFilesId(b.backupId); setStagedFiles(null); }}
                      disabled={busy !== ''}
                      title={t('backup.restoreFilesTitle')}
                    >
                      {t('backup.restoreFiles')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {pending && backups.length > 0 && (
        <p className="muted">{t('backup.pendingDisabledNote')}</p>
      )}

      {confirmId && (
        <div className="card" style={{ borderColor: 'var(--red)', cursor: 'default' }}>
          <div className="card-title">{t('backup.confirmRestoreTitle')}</div>
          <div style={{ fontSize: 13 }}>
            <p style={{ margin: '4px 0' }}>
              {t('backup.confirmRestoreLead')} <code>{confirmId}</code>{confirmTarget && <>{t('backup.confirmRestoreTarget', { time: fmtTime(confirmTarget.createdAt), rows: confirmTarget.totalRows })}</>}{t('backup.confirmRestoreBefore')}
            </p>
            <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
              <li>{t('backup.confirmRestoreItem1')}</li>
              <li>
                {t('backup.confirmRestoreItem2a')}<strong>{t('backup.confirmRestoreItem2b')}</strong>{t('backup.confirmRestoreItem2c')}
              </li>
              <li>{t('backup.confirmRestoreItem3', { btn: t('backup.restoreFiles') })}</li>
              <li>{t('backup.confirmRestoreItem4')}</li>
            </ul>
            <div className="row">
              <button
                onClick={() => void onConfirmRestore()}
                disabled={busy !== ''}
                style={{ borderColor: 'var(--red)' }}
              >
                {busy === 'restore' ? t('backup.staging') : t('backup.confirmRestore')}
              </button>
              <button onClick={() => setConfirmId(null)} disabled={busy !== ''}>{t('backup.cancel')}</button>
            </div>
          </div>
        </div>
      )}
      {confirmFilesId && (
        <div className="card" style={{ borderColor: 'var(--red)', cursor: 'default' }}>
          <div className="card-title">{t('backup.confirmFilesTitle')}</div>
          <div style={{ fontSize: 13 }}>
            <p style={{ margin: '4px 0' }}>
              {t('backup.confirmFilesLead')} <code>{confirmFilesId}</code>{confirmFilesTarget && <>{t('backup.confirmFilesTarget', { time: fmtTime(confirmFilesTarget.createdAt), scope: scopeLabel(confirmFilesTarget.scope) })}</>}{t('backup.confirmFilesTail')}
            </p>
            <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
              <li>
                {t('backup.confirmFilesItem1a')}<strong>{t('backup.confirmFilesItem1b')}</strong>{t('backup.confirmFilesItem1c')}
              </li>
              <li>{t('backup.confirmFilesItem2')}</li>
              <li>{t('backup.confirmFilesItem3')}</li>
            </ul>
            <div className="row">
              <button
                onClick={() => void onConfirmProjectFilesRestore()}
                disabled={busy !== ''}
                style={{ borderColor: 'var(--red)' }}
              >
                {busy === 'restore-files' ? t('backup.restoringFiles') : t('backup.confirmFilesNow')}
              </button>
              <button onClick={() => setConfirmFilesId(null)} disabled={busy !== ''}>{t('backup.cancel')}</button>
            </div>
          </div>
        </div>
      )}
      {stagedFiles && (
        <div className="card" style={{ cursor: 'default' }}>
          <div className="card-title">{t('backup.filesRestoredTitle')}</div>
          <div style={{ fontSize: 13 }}>
            <div>
              {t('backup.filesBackupLabel')}<code>{stagedFiles.backupId}</code> ·{' '}
              {t('backup.filesRestoredCount', { count: stagedFiles.projects.reduce((a, p) => a + p.restored, 0) })}
              {stagedFiles.skipped.length > 0 && (
                <> · {t('backup.filesSkipped', { count: stagedFiles.skipped.length, reasons: stagedFiles.skipped.map((s) => s.reason).join(t('backup.sep')) })}</>
              )}
            </div>
            <div className="muted">
              {t('backup.rollbackPoint')}<code>{stagedFiles.preRestoreDir}</code>{t('backup.rollbackHint')}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

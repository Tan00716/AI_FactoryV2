import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type BackupSummary,
  type PendingRestore,
  type RestoreStageResult,
} from '../api';

/**
 * 备份 / 恢复面板（运维区）：工厂数据库的备份与排队恢复。
 *  - GET /api/backups：备份列表（manifest 摘要）+ 待生效恢复状态
 *  - POST /api/backup：创建备份（服务端 VACUUM INTO 一致性快照）
 *  - POST /api/restore：校验并排队恢复 —— 破坏性相邻操作，UI 必须先
 *    展开确认区，讲清三件事后才允许提交：① 服务端会先自动备份当前
 *    数据库（pre-restore，可回滚）；② 恢复在下次服务端重启时才生效，
 *    运行中的服务继续使用现库；③ 备份范围仅为工厂数据库，项目工作
 *    文件不在内。对服务端返回（restartRequired、preRestoreBackupId、
 *    message）与拒绝原因（校验 problems、409 已有排队）如实呈现。
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
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [pending, setPending] = useState<PendingRestore | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  /** backupId 正在确认区中等待操作者确认（null = 无确认进行中）。 */
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [staged, setStaged] = useState<RestoreStageResult | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.backups();
      setBackups(res.backups ?? []);
      setPending(res.pendingRestore ?? null);
      setLoaded(true);
    } catch (e) {
      setErr(`备份列表不可用：${(e as Error).message}`);
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onCreate = async () => {
    setBusy('create');
    setErr('');
    setProblems([]);
    try {
      await api.createBackup();
      await load();
    } catch (e) {
      setErr(`创建备份失败：${(e as Error).message}`);
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
      setErr(`排队恢复失败：${ex.message}`);
      if (Array.isArray(ex.problems)) setProblems(ex.problems);
      // 409（已有排队）等状态变化后刷新列表，让 pending 状态如实呈现。
      await load();
    } finally {
      setBusy('');
    }
  };

  const confirmTarget = confirmId
    ? backups.find((b) => b.backupId === confirmId)
    : undefined;

  return (
    <div className="panel">
      <h2>备份 / 恢复 <span className="muted">工厂数据库 · VACUUM INTO 快照 + manifest 校验</span></h2>
      <p className="muted">
        备份范围仅为工厂数据库（项目、任务、证据、审批、审计链、需求、run 记录等）；
        项目工作文件（源码树、项目 .ai/ 配置）不在备份内。
      </p>
      {err && <div className="banner err">{err}</div>}
      {problems.length > 0 && (
        <ul className="issue-list">
          {problems.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}

      {pending && (
        <div className="card" style={{ borderColor: 'var(--yellow)', cursor: 'default' }}>
          <div className="card-title">⏳ 有恢复正在排队，等待服务端重启生效</div>
          <div style={{ fontSize: 13 }}>
            <div>
              目标备份：<code>{pending.backupId}</code> · 排队时间：{fmtTime(pending.stagedAt)}
            </div>
            <div>
              排队时自动创建的 pre-restore 备份：<code>{pending.preRestoreBackupId}</code>
            </div>
            <div className="muted">
              运行中的服务仍在使用当前数据库；重启服务端后该恢复才会应用，
              届时现库会被保留为同目录下的 .superseded 文件。在重启前不能再排队其他恢复（服务端返回 409）。
            </div>
          </div>
        </div>
      )}

      {staged && (
        <div className="card" style={{ cursor: 'default' }}>
          <div className="card-title">✅ 恢复已排队（restartRequired）</div>
          <div style={{ fontSize: 13 }}>
            <p style={{ margin: '4px 0' }}>{staged.message}</p>
            <div className="muted">
              目标备份：<code>{staged.backupId}</code> · pre-restore 备份：
              <code>{staged.preRestoreBackupId}</code> · 请重启服务端以应用恢复。
            </div>
          </div>
        </div>
      )}

      <div className="row">
        <button onClick={() => void onCreate()} disabled={busy !== ''}>
          {busy === 'create' ? '备份中…' : '创建备份'}
        </button>
        <button onClick={() => void load()} disabled={busy !== ''}>刷新列表</button>
        <span className="muted">{backups.length} 个备份</span>
      </div>

      {!loaded ? (
        <p className="muted">Loading backups…</p>
      ) : backups.length === 0 ? (
        <p className="muted">暂无备份。点击「创建备份」生成第一份数据库快照。</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>备份</th><th>类型</th><th>创建时间</th><th>应用版本</th>
              <th>总行数</th><th>大小</th><th>操作</th>
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
                <td>{fmtTime(b.createdAt)}</td>
                <td>{b.appVersion}</td>
                <td>{b.totalRows}</td>
                <td>{fmtBytes(b.bytes)}</td>
                <td>
                  <button
                    onClick={() => { setConfirmId(b.backupId); setStaged(null); }}
                    disabled={busy !== '' || pending !== null}
                    title={pending ? '已有恢复在排队，重启服务端应用后才能再排队' : undefined}
                  >
                    恢复…
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {pending && backups.length > 0 && (
        <p className="muted">已有恢复排队中，「恢复」按钮暂时禁用（服务端同样会以 409 拒绝新的排队）。</p>
      )}

      {confirmId && (
        <div className="card" style={{ borderColor: 'var(--red)', cursor: 'default' }}>
          <div className="card-title">⚠ 确认排队恢复</div>
          <div style={{ fontSize: 13 }}>
            <p style={{ margin: '4px 0' }}>
              将把数据库排队恢复到备份 <code>{confirmId}</code>
              {confirmTarget && (
                <>（创建于 {fmtTime(confirmTarget.createdAt)}，共 {confirmTarget.totalRows} 行）</>
              )}
              。提交前请确认以下事实：
            </p>
            <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
              <li>服务端会先自动备份当前数据库（pre-restore 备份），误操作可经该备份回滚。</li>
              <li>
                恢复<strong>不会立即生效</strong>：它被排队（restartRequired），
                在下一次服务端重启时才应用；重启前运行中的服务继续使用当前数据库。
              </li>
              <li>备份只含工厂数据库；项目工作文件不在恢复范围内，不会被触碰也不会被还原。</li>
              <li>恢复应用时，现库文件会被改名保留为 .superseded 文件，不直接删除。</li>
            </ul>
            <div className="row">
              <button
                onClick={() => void onConfirmRestore()}
                disabled={busy !== ''}
                style={{ borderColor: 'var(--red)' }}
              >
                {busy === 'restore' ? '排队中…' : '确认排队恢复'}
              </button>
              <button onClick={() => setConfirmId(null)} disabled={busy !== ''}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

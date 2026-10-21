import { useCallback, useEffect, useState } from 'react';
import {
  api, TaskDetail, TaskScopeReport, EvidenceItem, AgentFull, AuditRecord, MemoryEntry,
  FileEntry, DeploymentRecord,
} from '../api';
import { QaPanel, createQaApi, QaRun } from './QaPanel';
import { CicdPanel, createCicdApi } from './CicdPanel';
import { useLang } from '../i18n';

/**
 * Task Detail — spec §86，任务的 single source of truth.
 * 点击看板卡片打开的详情抽屉，14 个页签：
 * 概览 / 时间线 / AI团队 / 子任务 / 文件 / Diff / 测试 / QA /
 * 安全 / CI/CD / 部署 / 证据 / Memory / Trace。
 * 复用已有面板（QA 结果、CI/CD、证据链），缺数据的页签显示"暂无"。
 */

// TABS 持有 i18n key（与语言无关的稳定页签 id），渲染时 t() 翻译。
const TABS = [
  'taskdetail.tab.overview', 'taskdetail.tab.timeline', 'taskdetail.tab.team', 'taskdetail.tab.subtasks',
  'taskdetail.tab.files', 'taskdetail.tab.diff', 'taskdetail.tab.tests', 'taskdetail.tab.qa',
  'taskdetail.tab.security', 'taskdetail.tab.cicd', 'taskdetail.tab.deployments', 'taskdetail.tab.evidence',
  'taskdetail.tab.memory', 'taskdetail.tab.trace',
] as const;
type Tab = (typeof TABS)[number];

const EVIDENCE_TYPES = [
  'plan', 'code_change', 'code_review', 'ci_result', 'qa_result',
  'security_report', 'approval', 'merge', 'deployment', 'smoke_test', 'uat_result',
];

function Empty() {
  const { t } = useLang();
  return <p className="muted">{t('taskdetail.empty')}</p>;
}

function useTaskAudit(taskId: string): AuditRecord[] | null {
  const [records, setRecords] = useState<AuditRecord[] | null>(null);
  useEffect(() => {
    let dead = false;
    api.audit(300)
      .then((all) => {
        if (dead) return;
        setRecords(
          all.filter(
            (r) =>
              r.entityId === taskId ||
              (r.details as { taskId?: string } | undefined)?.taskId === taskId,
          ),
        );
      })
      .catch(() => { if (!dead) setRecords([]); });
    return () => { dead = true; };
  }, [taskId]);
  return records;
}

// -------------------------------------------------------- 范围锁定 ----

/** 第二轮加强 8 — 任务级编辑范围锁定卡片：徽标 + 规则 + 越界报告 + 编辑。 */
function ScopeSection({ task, onChanged }: { task: TaskDetail; onChanged: () => void }) {
  const { t } = useLang();
  const scope = task.scope;
  const locked = !!scope && (((scope.include?.length ?? 0) > 0) || ((scope.exclude?.length ?? 0) > 0));
  const [report, setReport] = useState<TaskScopeReport | null>(null);
  const [reportErr, setReportErr] = useState('');
  const [editing, setEditing] = useState(false);
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');

  useEffect(() => {
    let dead = false;
    setReport(null);
    setReportErr('');
    if (!locked) return;
    api.taskScopeReport(task.id)
      .then((r) => { if (!dead) setReport(r); })
      .catch((e) => { if (!dead) setReportErr((e as Error).message); });
    return () => { dead = true; };
  }, [task.id, locked]);

  const startEdit = () => {
    setInclude((scope?.include ?? []).join('\n'));
    setExclude((scope?.exclude ?? []).join('\n'));
    setSaveErr('');
    setEditing(true);
  };
  const save = async (clear: boolean) => {
    setSaving(true);
    setSaveErr('');
    try {
      const payload = clear
        ? null
        : (() => {
            const inc = include.split('\n').map((s) => s.trim()).filter(Boolean);
            const exc = exclude.split('\n').map((s) => s.trim()).filter(Boolean);
            return inc.length > 0 || exc.length > 0
              ? { ...(inc.length > 0 ? { include: inc } : {}), ...(exc.length > 0 ? { exclude: exc } : {}) }
              : null; // 全空 = 清除
          })();
      await api.updateTaskScope(task.id, payload);
      setEditing(false);
      onChanged();
    } catch (e) {
      setSaveErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="scope-section">
      <h4>{t('scope.title')}</h4>
      <p>
        <span className={`pill ${locked ? 'warn' : ''}`}>
          {locked ? t('scope.locked') : t('scope.unlimited')}
        </span>
        <button type="button" className="ghost" onClick={startEdit}>
          {locked ? t('scope.edit') : t('scope.add')}
        </button>
      </p>
      {locked && (
        <>
          {(scope?.include?.length ?? 0) > 0 && (
            <p><b>{t('scope.includeLabel')}</b> <code>{scope!.include!.join(', ')}</code></p>
          )}
          {(scope?.exclude?.length ?? 0) > 0 && (
            <p><b>{t('scope.excludeLabel')}</b> <code>{scope!.exclude!.join(', ')}</code></p>
          )}
          {reportErr && <p className="pill warn">{t('scope.reportFailed', { message: reportErr })}</p>}
          {report && report.outOfScope.length > 0 && (
            <div className="banner warn">
              <b>{t('scope.violationsTitle', { count: report.outOfScope.length })}</b>
              <ul>
                {report.outOfScope.map((v) => (
                  <li key={v.path}><code>{v.path}</code> <span className="muted">{t(`scope.reason.${v.reason}`)}</span></li>
                ))}
              </ul>
              <p className="muted">{t('scope.violationsHint')}</p>
            </div>
          )}
          {report && report.outOfScope.length === 0 && !reportErr && (
            <p className="muted">{t('scope.noViolations', { count: report.changedFiles.length })}</p>
          )}
          {report && !report.shadow && (
            <p className="muted">{t('scope.noShadowNote')}</p>
          )}
        </>
      )}
      <p className="hint">{t('scope.honestNote')}</p>
      {editing && (
        <div className="scope-block">
          <label>{t('scope.includeLabel')}
            <textarea value={include} onChange={(e) => setInclude(e.target.value)} rows={2} placeholder={t('scope.includePlaceholder')} />
          </label>
          <label>{t('scope.excludeLabel')}
            <textarea value={exclude} onChange={(e) => setExclude(e.target.value)} rows={2} placeholder={t('scope.excludePlaceholder')} />
          </label>
          {saveErr && <p className="err">{saveErr}</p>}
          <div className="btn-row">
            <button className="primary" onClick={() => void save(false)} disabled={saving}>{t('scope.save')}</button>
            {locked && <button onClick={() => void save(true)} disabled={saving}>{t('scope.clear')}</button>}
            <button onClick={() => setEditing(false)} disabled={saving}>{t('scope.cancel')}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 概览 --
function OverviewTab({ task, onMoved }: { task: TaskDetail; onMoved: () => void }) {
  const { t } = useLang();
  const [denied, setDenied] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [moving, setMoving] = useState<string | null>(null);

  const move = async (to: string) => {
    if (moving) return;
    setDenied([]);
    setError('');
    setMoving(to);
    try {
      await api.transition(task.id, to);
      onMoved();
    } catch (e) {
      const err = e as Error & { missing?: string[]; status: number };
      if (err.status === 422 && err.missing) {
        setDenied(err.missing);
      } else {
        setError(err.message);
      }
    } finally {
      setMoving(null);
    }
  };

  return (
    <div>
      <p className="muted">
        {t('taskdetail.metaLine', { id: task.id.slice(0, 8), status: task.status, priority: task.priority, risk: task.risk })}
      </p>
      {task.goal && <p><b>{t('taskdetail.goalLabel')}</b> {task.goal}</p>}
      {task.description && <p><b>{t('taskdetail.descLabel')}</b> {task.description}</p>}
      {task.acceptanceCriteria.length > 0 && (
        <p><b>{t('taskdetail.acceptLabel')}</b> {task.acceptanceCriteria.join('；')}</p>
      )}
      {task.constraints.length > 0 && (
        <p><b>{t('taskdetail.constraintsLabel')}</b> {task.constraints.join('；')}</p>
      )}
      <p className="muted">
        {t('taskdetail.createdLine', { created: new Date(task.createdAt).toLocaleString(), updated: new Date(task.updatedAt).toLocaleString() })}
        {task.completedAt && <>{t('taskdetail.completedSuffix', { at: new Date(task.completedAt).toLocaleString() })}</>}
      </p>

      <h4>{t('taskdetail.transitionTitle')}</h4>
      <ScopeSection task={task} onChanged={onMoved} />
      {task.nextStates.length === 0 && <p className="muted">{t('taskdetail.noTransitions')}</p>}
      <div className="btn-row">
        {task.nextStates.map((n) => (
          <button key={n.to} title={n.requires.join('\n') || n.note} onClick={() => move(n.to)} disabled={moving !== null}>
            → {moving === n.to ? t('taskdetail.moving') : n.to}
          </button>
        ))}
      </div>
      {error && <div className="banner err">{error}</div>}
      {denied.length > 0 && (
        <div className="denied">
          <b>{t('taskdetail.transitionDenied')}</b>
          <ul>{denied.map((m, i) => <li key={i}>{m}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 时间线 --
function TimelineTab({ taskId }: { taskId: string }) {
  const { t } = useLang();
  const records = useTaskAudit(taskId);
  if (records === null) return <p className="muted">{t('taskdetail.loading')}</p>;
  if (records.length === 0) return <Empty />;
  return (
    <ul className="timeline">
      {records.map((r) => (
        <li key={r.id}>
          <span className="muted">{new Date(r.ts).toLocaleString()}</span>
          {' '}<b>{r.action}</b>{' '}
          <span className="muted">by {r.actor} · {r.entityType}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- AI团队 --
function TeamTab({ task, onSelectAgent }: { task: TaskDetail; onSelectAgent?: (id: string) => void }) {
  const { t } = useLang();
  const [agents, setAgents] = useState<AgentFull[] | null>(null);
  const [agentsErr, setAgentsErr] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    api.agents()
      .then((a) => { if (!dead) { setAgents(a); setAgentsErr(null); } })
      .catch((e) => { if (!dead) { setAgents([]); setAgentsErr((e as Error).message); } });
    return () => { dead = true; };
  }, []);
  if (agents === null) return <p className="muted">{t('taskdetail.loading')}</p>;
  if (agentsErr) return <p className="pill warn">{t('taskdetail.agentsLoadFailed', { message: agentsErr })}</p>;
  const ids = [...new Set([task.currentAgentId, ...task.assignedAgentIds].filter(Boolean) as string[])];
  if (ids.length === 0) return <Empty />;
  return (
    <ul className="plain">
      {ids.map((id) => {
        const a = agents.find((x) => x.id === id);
        return (
          <li
            key={id}
            className={onSelectAgent ? 'clickable' : ''}
            onClick={() => onSelectAgent?.(id)}
            title={onSelectAgent ? t('taskdetail.viewAgent') : undefined}
          >
            {a ? (
              <><b>{a.displayName}</b> <span className="muted">{a.jobTitle} · {a.status}</span>
              {id === task.currentAgentId && <span className="pill">{t('taskdetail.current')}</span>}</>
            ) : (
              <span className="muted">{t('taskdetail.unknownAgent', { id: id.slice(0, 8) })}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- 子任务 --
function SubtasksTab({ task, onSelectTask }: { task: TaskDetail; onSelectTask: (id: string) => void }) {
  const { t } = useLang();
  const [subs, setSubs] = useState<TaskDetail[] | null>(null);
  const [subsErr, setSubsErr] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    if (task.subtaskIds.length === 0) { setSubs([]); return; }
    Promise.all(task.subtaskIds.map((id) => api.task(id).catch((e) => ({ __err: (e as Error).message } as const))))
      .then((list) => {
        if (dead) return;
        const failed = list.find((x) => x !== null && typeof x === 'object' && '__err' in x);
        if (failed) setSubsErr((failed as { __err: string }).__err);
        setSubs(list.filter((x) => x !== null && !(typeof x === 'object' && '__err' in x)) as TaskDetail[]);
      });
    return () => { dead = true; };
  }, [task]);
  if (subs === null) return <p className="muted">{t('taskdetail.loading')}</p>;
  if (subsErr) return <p className="pill warn">{t('taskdetail.subtasksLoadFailed', { message: subsErr })}</p>;
  if (subs.length === 0) return <Empty />;
  return (
    <ul className="plain">
      {subs.map((s) => (
        <li key={s.id} className="clickable" onClick={() => onSelectTask(s.id)}>
          <span className="pill">{s.status}</span> {s.title}
          <span className="muted"> · {s.priority} · #{s.id.slice(0, 8)}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- 文件 --
function FilesTab({ task }: { task: TaskDetail }) {
  const { t } = useLang();
  const [entries, setEntries] = useState<FileEntry[] | 'missing' | null>(null);
  useEffect(() => {
    let dead = false;
    if (!task.workspace) { setEntries('missing'); return; }
    api.files(task.workspace)
      .then((r) => { if (!dead) setEntries(r.entries); })
      .catch(() => { if (!dead) setEntries('missing'); });
    return () => { dead = true; };
  }, [task]);
  if (entries === null) return <p className="muted">{t('taskdetail.loading')}</p>;
  if (entries === 'missing') return <Empty />;
  if (entries.length === 0) return <Empty />;
  return (
    <ul className="plain">
      {entries.map((e) => (
        <li key={e.path}>
          {e.type === 'dir' ? '📁' : '📄'} {e.name}
          <span className="muted"> · {e.path}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- Diff --
function DiffTab({ task }: { task: TaskDetail }) {
  const items = task.evidence.filter((e) =>
    ['code_change', 'code_review', 'merge'].includes(e.type),
  );
  if (items.length === 0) return <Empty />;
  return (
    <ul className="ev-list">
      {items.map((e) => (
        <li key={e.id}>
          <span className={`seal ${e.status.toLowerCase()}`}>{e.status}</span>
          <b>{e.type}</b> — {e.title}
          <pre className="muted" style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>
            {JSON.stringify(e.payload, null, 1)?.slice(0, 800)}
          </pre>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- 测试 --
function TestsTab({ taskId }: { taskId: string }) {
  const { t } = useLang();
  const [runs, setRuns] = useState<QaRun[] | null>(null);
  const [runsErr, setRunsErr] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    createQaApi().runs()
      .then((r) => { if (!dead) { setRuns(r.runs.filter((x) => x.taskId === taskId)); setRunsErr(null); } })
      .catch((e) => { if (!dead) { setRuns([]); setRunsErr((e as Error).message); } });
    return () => { dead = true; };
  }, [taskId]);
  if (runs === null) return <p className="muted">{t('taskdetail.loading')}</p>;
  if (runsErr) return <p className="pill warn">{t('taskdetail.qaRunsLoadFailed', { message: runsErr })}</p>;
  if (runs.length === 0) return <Empty />;
  return (
    <div>
      {runs.map((r) => (
        <div key={r.id} className="qa-run">
          <b>{r.id.slice(0, 8)}</b> <span className="pill">{r.verdict ?? r.status}</span>
          <span className="muted"> · {new Date(r.createdAt).toLocaleString()}</span>
          {r.summary && (
            <div className="muted">
              {t('taskdetail.qaSummary', { passed: r.summary.passed, total: r.summary.total, failed: r.summary.failed })}
            </div>
          )}
          {r.summary?.categories.map((c) => (
            <div key={c.category} className="card-meta">
              <span>{c.category}</span>
              <span className={c.verdict === 'PASS' ? 'gate-ok' : c.verdict === 'FAIL' ? 'err' : 'muted'}>
                {c.verdict} {c.passed}/{c.total}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- 安全 --
function SecurityTab({ task, taskId }: { task: TaskDetail; taskId: string }) {
  const { t } = useLang();
  const reports = task.evidence.filter((e) => e.type === 'security_report');
  const [secCats, setSecCats] = useState<{ category: string; verdict: string }[] | null>(null);
  const [secErr, setSecErr] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    createQaApi().runs()
      .then((r) => {
        if (dead) return;
        const cats = r.runs
          .filter((x) => x.taskId === taskId)
          .flatMap((x) => x.summary?.categories ?? [])
          .filter((c) => c.category === 'security');
        setSecCats(cats);
        setSecErr(null);
      })
      .catch((e) => { if (!dead) { setSecCats([]); setSecErr((e as Error).message); } });
    return () => { dead = true; };
  }, [taskId]);
  if (reports.length === 0 && (secCats === null || secCats.length === 0)) {
    return secErr ? <p className="pill warn">{t('taskdetail.secCatsLoadFailed', { message: secErr })}</p>
      : secCats === null ? <p className="muted">{t('taskdetail.loading')}</p> : <Empty />;
  }
  return (
    <div>
      {reports.map((e) => (
        <div key={e.id} className="qa-run">
          <span className={`seal ${e.status.toLowerCase()}`}>{e.status}</span>
          <b>{e.title}</b>
          <pre className="muted" style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>
            {JSON.stringify(e.payload, null, 1)?.slice(0, 800)}
          </pre>
        </div>
      ))}
      {(secCats ?? []).map((c, i) => (
        <div key={i} className="card-meta">
          <span>{t('taskdetail.qaSecurityCat')}</span>
          <span className={c.verdict === 'PASS' ? 'gate-ok' : 'err'}>{c.verdict}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- 部署 --
function DeploymentsTab({ taskId }: { taskId: string }) {
  const { t } = useLang();
  const [deps, setDeps] = useState<DeploymentRecord[] | null>(null);
  const [depsErr, setDepsErr] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    api.deployments()
      .then((d) => { if (!dead) { setDeps(d.filter((x) => x.taskId === taskId)); setDepsErr(null); } })
      .catch((e) => { if (!dead) { setDeps([]); setDepsErr((e as Error).message); } });
    return () => { dead = true; };
  }, [taskId]);
  if (deps === null) return <p className="muted">{t('taskdetail.loading')}</p>;
  if (depsErr) return <p className="pill warn">{t('taskdetail.deploymentsLoadFailed', { message: depsErr })}</p>;
  if (deps.length === 0) return <Empty />;
  return (
    <ul className="plain">
      {deps.map((d) => (
        <li key={d.id}>
          <span className="pill">{String(d.status ?? 'unknown')}</span>
          {' '}{String(d.environment ?? '')}
          <span className="muted"> · #{d.id.slice(0, 8)}{d.createdAt ? ` · ${new Date(d.createdAt).toLocaleString()}` : ''}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- 证据 --
function EvidenceTab({ task, onAttached }: { task: TaskDetail; onAttached: () => void }) {
  const { t } = useLang();
  const [evType, setEvType] = useState('qa_result');
  const [evTitle, setEvTitle] = useState('');
  const [evPass, setEvPass] = useState(true);
  const [evError, setEvError] = useState('');
  const [evBusy, setEvBusy] = useState(false);

  const attach = async () => {
    if (!evTitle.trim() || evBusy) return;
    setEvBusy(true);
    setEvError('');
    try {
      await api.attachEvidence(task.id, {
        type: evType,
        title: evTitle.trim(),
        payload: { verdict: evPass ? 'PASS' : 'FAIL' },
      });
      setEvTitle('');
      onAttached();
    } catch (e) {
      setEvError((e as Error).message);
    } finally {
      setEvBusy(false);
    }
  };

  return (
    <div>
      {task.evidence.length === 0 && <p className="muted">{t('taskdetail.noEvidence')}</p>}
      <ul className="ev-list">
        {task.evidence.map((e: EvidenceItem) => (
          <li key={e.id}>
            <span className={`seal ${e.status.toLowerCase()}`}>{e.status}</span>
            <b>{e.type}</b> — {e.title}
            <span className="muted"> by {e.createdBy}</span>
          </li>
        ))}
      </ul>
      <h4>{t('taskdetail.attachTitle')}</h4>
      {evError && <p className="pill warn">{t('taskdetail.attachFailed', { message: evError })}</p>}
      <div className="ev-form">
        <select value={evType} onChange={(e) => setEvType(e.target.value)}>
          {EVIDENCE_TYPES.map((et) => <option key={et} value={et}>{et}</option>)}
        </select>
        <input placeholder={t('taskdetail.evidenceTitlePh')} value={evTitle} onChange={(e) => setEvTitle(e.target.value)} />
        <label><input type="checkbox" checked={evPass} onChange={(e) => setEvPass(e.target.checked)} /> PASS</label>
        <button onClick={attach} disabled={!evTitle.trim() || evBusy}>{evBusy ? t('taskdetail.attaching') : t('taskdetail.attach')}</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Memory --
function MemoryTab({ taskId }: { taskId: string }) {
  const { t } = useLang();
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [memErr, setMemErr] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    api.memoryEntries('task', taskId)
      .then((e) => { if (!dead) { setEntries(e); setMemErr(null); } })
      .catch((e) => { if (!dead) { setEntries([]); setMemErr((e as Error).message); } });
    return () => { dead = true; };
  }, [taskId]);
  if (entries === null) return <p className="muted">{t('taskdetail.loading')}</p>;
  if (memErr) return <p className="pill warn">{t('taskdetail.memoryLoadFailed', { message: memErr })}</p>;
  if (entries.length === 0) return <Empty />;
  return (
    <ul className="plain">
      {entries.map((e) => (
        <li key={e.id}>
          <b>{String(e.title ?? e.type ?? e.id.slice(0, 8))}</b>
          <span className="muted"> · {t('taskdetail.confidence', { value: e.confidence ?? '—' })}</span>
          {e.content && <div className="muted">{String(e.content).slice(0, 300)}</div>}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- Trace --
function TraceTab({ taskId }: { taskId: string }) {
  const { t } = useLang();
  const records = useTaskAudit(taskId);
  if (records === null) return <p className="muted">{t('taskdetail.loading')}</p>;
  if (records.length === 0) return <Empty />;
  return (
    <div>
      {records.map((r) => (
        <details key={r.id} className="trace-item">
          <summary>
            <span className="muted">{new Date(r.ts).toLocaleString()}</span> <b>{r.action}</b>
            <span className="muted"> · {r.actor}</span>
          </summary>
          <pre className="muted" style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>
            {JSON.stringify({ entityType: r.entityType, entityId: r.entityId, details: r.details }, null, 1)}
          </pre>
        </details>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- 抽屉 --
export function TaskDetailDrawer({ taskId, onClose, onChanged, onSelectTask, onSelectAgent }: {
  taskId: string;
  onClose: () => void;
  onChanged: () => void;
  onSelectTask: (id: string) => void;
  onSelectAgent?: (id: string) => void;
}) {
  const { t } = useLang();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>(TABS[0]);

  const load = useCallback(() => {
    setError('');
    api.task(taskId).then(setTask).catch((e: Error) => setError(e.message));
  }, [taskId]);

  useEffect(() => {
    setTask(null);
    setTab(TABS[0]);
    load();
  }, [taskId, load]);

  // QA-R1: Esc 关闭抽屉（与 CreateTaskModal 行为一致）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const moved = useCallback(() => {
    load();
    onChanged();
  }, [load, onChanged]);

  return (
    <div className="detail wide">
      <div className="detail-head">
        <h2>{task ? task.title : t('taskdetail.drawerTitle')}</h2>
        <button onClick={onClose}>✕</button>
      </div>
      {error && <div className="banner err">{error}</div>}
      {!task && !error && <p className="muted">{t('taskdetail.loading')}</p>}
      {task && (
        <>
          <div className="drawer-tabs">
            {TABS.map((k) => (
              <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
                {t(k)}
              </button>
            ))}
          </div>
          <div className="drawer-body">
            {tab === TABS[0] && <OverviewTab task={task} onMoved={moved} />}
            {tab === TABS[1] && <TimelineTab taskId={task.id} />}
            {tab === TABS[2] && <TeamTab task={task} onSelectAgent={onSelectAgent} />}
            {tab === TABS[3] && <SubtasksTab task={task} onSelectTask={onSelectTask} />}
            {tab === TABS[4] && <FilesTab task={task} />}
            {tab === TABS[5] && <DiffTab task={task} />}
            {tab === TABS[6] && <TestsTab taskId={task.id} />}
            {tab === TABS[7] && <QaPanel taskId={task.id} qa={createQaApi()} />}
            {tab === TABS[8] && <SecurityTab task={task} taskId={task.id} />}
            {tab === TABS[9] && <CicdPanel taskId={task.id} cicd={createCicdApi()} />}
            {tab === TABS[10] && <DeploymentsTab taskId={task.id} />}
            {tab === TABS[11] && <EvidenceTab task={task} onAttached={moved} />}
            {tab === TABS[12] && <MemoryTab taskId={task.id} />}
            {tab === TABS[13] && <TraceTab taskId={task.id} />}
          </div>
        </>
      )}
    </div>
  );
}

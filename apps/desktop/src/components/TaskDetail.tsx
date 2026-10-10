import { useCallback, useEffect, useState } from 'react';
import {
  api, TaskDetail, EvidenceItem, AgentFull, AuditRecord, MemoryEntry,
  FileEntry, DeploymentRecord,
} from '../api';
import { QaPanel, createQaApi, QaRun } from './QaPanel';
import { CicdPanel, createCicdApi } from './CicdPanel';

/**
 * Task Detail — spec §86，任务的 single source of truth.
 * 点击看板卡片打开的详情抽屉，14 个页签：
 * 概览 / 时间线 / AI团队 / 子任务 / 文件 / Diff / 测试 / QA /
 * 安全 / CI/CD / 部署 / 证据 / Memory / Trace。
 * 复用已有面板（QA 结果、CI/CD、证据链），缺数据的页签显示"暂无"。
 */

const TABS = [
  '概览', '时间线', 'AI团队', '子任务', '文件', 'Diff',
  '测试', 'QA', '安全', 'CI/CD', '部署', '证据', 'Memory', 'Trace',
] as const;
type Tab = (typeof TABS)[number];

const EVIDENCE_TYPES = [
  'plan', 'code_change', 'code_review', 'ci_result', 'qa_result',
  'security_report', 'approval', 'merge', 'deployment', 'smoke_test', 'uat_result',
];

function Empty() {
  return <p className="muted">暂无</p>;
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

// ---------------------------------------------------------------- 概览 --
function OverviewTab({ task, onMoved }: { task: TaskDetail; onMoved: () => void }) {
  const [denied, setDenied] = useState<string[]>([]);
  const [error, setError] = useState('');

  const move = async (to: string) => {
    setDenied([]);
    setError('');
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
    }
  };

  return (
    <div>
      <p className="muted">
        #{task.id.slice(0, 8)} · {task.status} · {task.priority} · 风险 {task.risk}
      </p>
      {task.goal && <p><b>目标:</b> {task.goal}</p>}
      {task.description && <p><b>描述:</b> {task.description}</p>}
      {task.acceptanceCriteria.length > 0 && (
        <p><b>验收标准:</b> {task.acceptanceCriteria.join('；')}</p>
      )}
      {task.constraints.length > 0 && (
        <p><b>约束:</b> {task.constraints.join('；')}</p>
      )}
      <p className="muted">
        创建 {new Date(task.createdAt).toLocaleString()} · 更新 {new Date(task.updatedAt).toLocaleString()}
        {task.completedAt && <> · 完成 {new Date(task.completedAt).toLocaleString()}</>}
      </p>

      <h4>请求流转 §13（引擎裁决）</h4>
      {task.nextStates.length === 0 && <p className="muted">暂无可用流转（终态）</p>}
      <div className="btn-row">
        {task.nextStates.map((n) => (
          <button key={n.to} title={n.requires.join('\n') || n.note} onClick={() => move(n.to)}>
            → {n.to}
          </button>
        ))}
      </div>
      {error && <div className="banner err">{error}</div>}
      {denied.length > 0 && (
        <div className="denied">
          <b>⛔ 流转被拒 — 缺少证据 (§12):</b>
          <ul>{denied.map((m, i) => <li key={i}>{m}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 时间线 --
function TimelineTab({ taskId }: { taskId: string }) {
  const records = useTaskAudit(taskId);
  if (records === null) return <p className="muted">加载中…</p>;
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
  const [agents, setAgents] = useState<AgentFull[] | null>(null);
  useEffect(() => {
    let dead = false;
    api.agents().then((a) => { if (!dead) setAgents(a); }).catch(() => { if (!dead) setAgents([]); });
    return () => { dead = true; };
  }, []);
  if (agents === null) return <p className="muted">加载中…</p>;
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
            title={onSelectAgent ? '查看员工档案 §87' : undefined}
          >
            {a ? (
              <><b>{a.displayName}</b> <span className="muted">{a.jobTitle} · {a.status}</span>
              {id === task.currentAgentId && <span className="pill">当前</span>}</>
            ) : (
              <span className="muted">{id.slice(0, 8)}（已离职或未知）</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- 子任务 --
function SubtasksTab({ task, onSelectTask }: { task: TaskDetail; onSelectTask: (id: string) => void }) {
  const [subs, setSubs] = useState<TaskDetail[] | null>(null);
  useEffect(() => {
    let dead = false;
    if (task.subtaskIds.length === 0) { setSubs([]); return; }
    Promise.all(task.subtaskIds.map((id) => api.task(id).catch(() => null)))
      .then((list) => { if (!dead) setSubs(list.filter(Boolean) as TaskDetail[]); });
    return () => { dead = true; };
  }, [task]);
  if (subs === null) return <p className="muted">加载中…</p>;
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
  const [entries, setEntries] = useState<FileEntry[] | 'missing' | null>(null);
  useEffect(() => {
    let dead = false;
    if (!task.workspace) { setEntries('missing'); return; }
    api.files(task.workspace)
      .then((r) => { if (!dead) setEntries(r.entries); })
      .catch(() => { if (!dead) setEntries('missing'); });
    return () => { dead = true; };
  }, [task]);
  if (entries === null) return <p className="muted">加载中…</p>;
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
  const [runs, setRuns] = useState<QaRun[] | null>(null);
  useEffect(() => {
    let dead = false;
    createQaApi().runs()
      .then((r) => { if (!dead) setRuns(r.runs.filter((x) => x.taskId === taskId)); })
      .catch(() => { if (!dead) setRuns([]); });
    return () => { dead = true; };
  }, [taskId]);
  if (runs === null) return <p className="muted">加载中…</p>;
  if (runs.length === 0) return <Empty />;
  return (
    <div>
      {runs.map((r) => (
        <div key={r.id} className="qa-run">
          <b>{r.id.slice(0, 8)}</b> <span className="pill">{r.verdict ?? r.status}</span>
          <span className="muted"> · {new Date(r.createdAt).toLocaleString()}</span>
          {r.summary && (
            <div className="muted">
              {r.summary.passed}/{r.summary.total} 通过 · {r.summary.failed} 失败
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
  const reports = task.evidence.filter((e) => e.type === 'security_report');
  const [secCats, setSecCats] = useState<{ category: string; verdict: string }[] | null>(null);
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
      })
      .catch(() => { if (!dead) setSecCats([]); });
    return () => { dead = true; };
  }, [taskId]);
  if (reports.length === 0 && (secCats === null || secCats.length === 0)) {
    return secCats === null ? <p className="muted">加载中…</p> : <Empty />;
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
          <span>QA security 分类</span>
          <span className={c.verdict === 'PASS' ? 'gate-ok' : 'err'}>{c.verdict}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- 部署 --
function DeploymentsTab({ taskId }: { taskId: string }) {
  const [deps, setDeps] = useState<DeploymentRecord[] | null>(null);
  useEffect(() => {
    let dead = false;
    api.deployments()
      .then((d) => { if (!dead) setDeps(d.filter((x) => x.taskId === taskId)); })
      .catch(() => { if (!dead) setDeps([]); });
    return () => { dead = true; };
  }, [taskId]);
  if (deps === null) return <p className="muted">加载中…</p>;
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
  const [evType, setEvType] = useState('qa_result');
  const [evTitle, setEvTitle] = useState('');
  const [evPass, setEvPass] = useState(true);

  const attach = async () => {
    if (!evTitle.trim()) return;
    await api.attachEvidence(task.id, {
      type: evType,
      title: evTitle.trim(),
      payload: { verdict: evPass ? 'PASS' : 'FAIL' },
    });
    setEvTitle('');
    onAttached();
  };

  return (
    <div>
      {task.evidence.length === 0 && <p className="muted">暂无证据</p>}
      <ul className="ev-list">
        {task.evidence.map((e: EvidenceItem) => (
          <li key={e.id}>
            <span className={`seal ${e.status.toLowerCase()}`}>{e.status}</span>
            <b>{e.type}</b> — {e.title}
            <span className="muted"> by {e.createdBy}</span>
          </li>
        ))}
      </ul>
      <h4>附加证据 §42</h4>
      <div className="ev-form">
        <select value={evType} onChange={(e) => setEvType(e.target.value)}>
          {EVIDENCE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input placeholder="证据标题" value={evTitle} onChange={(e) => setEvTitle(e.target.value)} />
        <label><input type="checkbox" checked={evPass} onChange={(e) => setEvPass(e.target.checked)} /> PASS</label>
        <button onClick={attach}>附加</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Memory --
function MemoryTab({ taskId }: { taskId: string }) {
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  useEffect(() => {
    let dead = false;
    api.memoryEntries('task', taskId)
      .then((e) => { if (!dead) setEntries(e); })
      .catch(() => { if (!dead) setEntries([]); });
    return () => { dead = true; };
  }, [taskId]);
  if (entries === null) return <p className="muted">加载中…</p>;
  if (entries.length === 0) return <Empty />;
  return (
    <ul className="plain">
      {entries.map((e) => (
        <li key={e.id}>
          <b>{String(e.title ?? e.type ?? e.id.slice(0, 8))}</b>
          <span className="muted"> · 置信度 {e.confidence ?? '—'}</span>
          {e.content && <div className="muted">{String(e.content).slice(0, 300)}</div>}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- Trace --
function TraceTab({ taskId }: { taskId: string }) {
  const records = useTaskAudit(taskId);
  if (records === null) return <p className="muted">加载中…</p>;
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
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('概览');

  const load = useCallback(() => {
    setError('');
    api.task(taskId).then(setTask).catch((e: Error) => setError(e.message));
  }, [taskId]);

  useEffect(() => {
    setTask(null);
    setTab('概览');
    load();
  }, [taskId, load]);

  const moved = useCallback(() => {
    load();
    onChanged();
  }, [load, onChanged]);

  return (
    <div className="detail wide">
      <div className="detail-head">
        <h2>{task ? task.title : '任务详情'}</h2>
        <button onClick={onClose}>✕</button>
      </div>
      {error && <div className="banner err">{error}</div>}
      {!task && !error && <p className="muted">加载中…</p>}
      {task && (
        <>
          <div className="drawer-tabs">
            {TABS.map((t) => (
              <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </div>
          <div className="drawer-body">
            {tab === '概览' && <OverviewTab task={task} onMoved={moved} />}
            {tab === '时间线' && <TimelineTab taskId={task.id} />}
            {tab === 'AI团队' && <TeamTab task={task} onSelectAgent={onSelectAgent} />}
            {tab === '子任务' && <SubtasksTab task={task} onSelectTask={onSelectTask} />}
            {tab === '文件' && <FilesTab task={task} />}
            {tab === 'Diff' && <DiffTab task={task} />}
            {tab === '测试' && <TestsTab taskId={task.id} />}
            {tab === 'QA' && <QaPanel taskId={task.id} qa={createQaApi()} />}
            {tab === '安全' && <SecurityTab task={task} taskId={task.id} />}
            {tab === 'CI/CD' && <CicdPanel taskId={task.id} cicd={createCicdApi()} />}
            {tab === '部署' && <DeploymentsTab taskId={task.id} />}
            {tab === '证据' && <EvidenceTab task={task} onAttached={moved} />}
            {tab === 'Memory' && <MemoryTab taskId={task.id} />}
            {tab === 'Trace' && <TraceTab taskId={task.id} />}
          </div>
        </>
      )}
    </div>
  );
}

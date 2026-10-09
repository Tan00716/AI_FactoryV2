import { useState } from 'react';
import { api, BoardCard, TaskDetail } from '../api';

/** §85 simplified columns: fold the 19 engine states into 6 board lanes. */
const LANES: { title: string; states: string[] }[] = [
  { title: 'TODO', states: ['TODO', 'PLANNING', 'BLOCKED'] },
  { title: 'IN PROGRESS', states: ['IN_PROGRESS', 'CODE_REVIEW'] },
  { title: 'QA', states: ['PENDING_QA', 'QA', 'QA_FAILED'] },
  { title: 'UAT', states: ['PENDING_UAT_MERGE', 'UAT', 'UAT_FAILED'] },
  { title: 'PROD', states: ['PENDING_PROD', 'PROD_DEPLOYING', 'PROD_VERIFICATION', 'PROD_FAILED', 'ROLLBACK'] },
  { title: 'DONE', states: ['DONE', 'CANCELLED', 'REJECTED', 'ESCALATED'] },
];

const EVIDENCE_TYPES = [
  'plan', 'code_change', 'code_review', 'ci_result', 'qa_result',
  'security_report', 'approval', 'merge', 'deployment', 'smoke_test', 'uat_result',
];

function TaskDetailView({ taskId, onClose, onChanged }: {
  taskId: string; onClose: () => void; onChanged: () => void;
}) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState('');
  const [denied, setDenied] = useState<string[]>([]);
  const [evType, setEvType] = useState('qa_result');
  const [evTitle, setEvTitle] = useState('');
  const [evPass, setEvPass] = useState(true);

  const load = () => {
    api.task(taskId).then(setTask).catch((e: Error) => setError(e.message));
  };
  if (!task && !error) load();

  const move = async (to: string) => {
    setDenied([]);
    setError('');
    try {
      await api.transition(taskId, to);
      load();
      onChanged();
    } catch (e) {
      const err = e as Error & { missing?: string[]; status: number };
      if (err.status === 422 && err.missing) {
        // Gate denial (§12): show exactly what evidence is missing.
        setDenied(err.missing);
      } else {
        setError(err.message);
      }
    }
  };

  const attach = async () => {
    if (!evTitle.trim()) return;
    await api.attachEvidence(taskId, {
      type: evType,
      title: evTitle.trim(),
      payload: { verdict: evPass ? 'PASS' : 'FAIL' },
    });
    setEvTitle('');
    load();
    onChanged();
  };

  if (error) return <div className="detail"><p className="err">{error}</p><button onClick={onClose}>Close</button></div>;
  if (!task) return <div className="detail"><p className="muted">Loading…</p></div>;

  return (
    <div className="detail">
      <div className="detail-head">
        <h2>{task.title}</h2>
        <button onClick={onClose}>✕</button>
      </div>
      <p className="muted">{task.id.slice(0, 8)} · {task.status} · {task.priority} · risk {task.risk}</p>
      {task.goal && <p><b>Goal:</b> {task.goal}</p>}
      {task.acceptanceCriteria.length > 0 && (
        <p><b>Acceptance:</b> {task.acceptanceCriteria.join('; ')}</p>
      )}

      <h4>Request transition (§13 — the engine decides)</h4>
      <div className="btn-row">
        {task.nextStates.map((n) => (
          <button key={n.to} title={n.requires.join('\n') || n.note} onClick={() => move(n.to)}>
            → {n.to}
          </button>
        ))}
      </div>
      {denied.length > 0 && (
        <div className="denied">
          <b>⛔ Transition denied — missing evidence (§12):</b>
          <ul>{denied.map((m, i) => <li key={i}>{m}</li>)}</ul>
        </div>
      )}

      <h4>Evidence (§42)</h4>
      {task.evidence.length === 0 && <p className="muted">No evidence attached yet.</p>}
      <ul className="ev-list">
        {task.evidence.map((e) => (
          <li key={e.id}>
            <span className={`seal ${e.status.toLowerCase()}`}>{e.status}</span>
            <b>{e.type}</b> — {e.title}
            <span className="muted"> by {e.createdBy}</span>
          </li>
        ))}
      </ul>
      <div className="ev-form">
        <select value={evType} onChange={(e) => setEvType(e.target.value)}>
          {EVIDENCE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input placeholder="Evidence title" value={evTitle} onChange={(e) => setEvTitle(e.target.value)} />
        <label><input type="checkbox" checked={evPass} onChange={(e) => setEvPass(e.target.checked)} /> PASS</label>
        <button onClick={attach}>Attach</button>
      </div>
    </div>
  );
}

export function Board({ columns, onChanged, onCreate }: {
  columns: Record<string, BoardCard[]>;
  onChanged: () => void;
  onCreate: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="board-wrap">
      <div className="board-head">
        <h2>Task Board</h2>
        <button className="primary" onClick={onCreate}>+ New Task</button>
      </div>
      <div className="board">
        {LANES.map((lane) => {
          const cards = lane.states.flatMap((s) => columns[s] ?? []);
          return (
            <div key={lane.title} className="lane">
              <div className="lane-title">{lane.title} <span className="count">{cards.length}</span></div>
              {cards.map((c) => (
                <div key={c.id} className="card" onClick={() => setSelected(c.id)}>
                  <div className="card-title">{c.title}</div>
                  <div className="card-meta">
                    <span className={`prio ${c.priority.toLowerCase()}`}>{c.priority}</span>
                    <span className="muted">{c.status}</span>
                  </div>
                  <div className="card-meta">
                    <span>{c.agent ?? 'unassigned'}</span>
                    <span className="muted">risk {c.risk}</span>
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {selected && (
        <TaskDetailView taskId={selected} onClose={() => setSelected(null)} onChanged={onChanged} />
      )}
    </div>
  );
}

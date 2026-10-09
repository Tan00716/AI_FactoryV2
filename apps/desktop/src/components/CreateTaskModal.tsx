import { useState } from 'react';
import { api } from '../api';

export function CreateTaskModal({ projectId, onClose, onCreated }: {
  projectId: string; onClose: () => void; onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [priority, setPriority] = useState('P2');
  const [error, setError] = useState('');

  const submit = async () => {
    if (!title.trim()) { setError('Title is required'); return; }
    try {
      await api.createTask({ projectId, title: title.trim(), goal: goal.trim(), priority });
      onCreated();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New Task</h2>
        <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Fix payment success but order stays Pending" /></label>
        <label>Goal<textarea value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What does 'done' mean?" /></label>
        <label>Priority
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            {['P0', 'P1', 'P2', 'P3', 'P4'].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        {error && <p className="err">{error}</p>}
        <div className="btn-row">
          <button className="primary" onClick={submit}>Create (§9 — AI PM takes it from here)</button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

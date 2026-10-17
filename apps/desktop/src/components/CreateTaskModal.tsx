import { useState } from 'react';
import { api } from '../api';
import { useLang } from '../i18n';

export function CreateTaskModal({ projectId, onClose, onCreated }: {
  projectId: string; onClose: () => void; onCreated: () => void;
}) {
  const { t } = useLang();
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [priority, setPriority] = useState('P2');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!title.trim()) { setError(t('createtask.titleRequired')); return; }
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.createTask({ projectId, title: title.trim(), goal: goal.trim(), priority });
      onCreated();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t('createtask.heading')}</h2>
        <label>{t('createtask.titleLabel')}<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('createtask.titlePlaceholder')} /></label>
        <label>{t('createtask.goalLabel')}<textarea value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={t('createtask.goalPlaceholder')} /></label>
        <label>{t('createtask.priorityLabel')}
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            {['P0', 'P1', 'P2', 'P3', 'P4'].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        {error && <p className="err">{error}</p>}
        <div className="btn-row">
          <button className="primary" onClick={submit} disabled={busy}>{busy ? t('createtask.creating') : t('createtask.create')}</button>
          <button onClick={onClose}>{t('createtask.cancel')}</button>
        </div>
      </div>
    </div>
  );
}

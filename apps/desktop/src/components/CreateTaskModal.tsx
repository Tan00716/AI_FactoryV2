import { useEffect, useRef, useState } from 'react';
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
  // QA-R1: 连击防护不能只靠 state——setBusy(true) 是异步的，同 tick 内的
  // 连续点击都会看到 busy=false。用 ref 做同步守卫。
  const busyRef = useRef(false);

  // QA-R1: Esc 关闭弹窗（之前只能点取消/背景关闭）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    if (!title.trim()) { setError(t('createtask.titleRequired')); return; }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await api.createTask({ projectId, title: title.trim(), goal: goal.trim(), priority });
      onCreated();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      busyRef.current = false;
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

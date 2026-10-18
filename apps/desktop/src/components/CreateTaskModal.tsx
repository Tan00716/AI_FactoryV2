import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useLang } from '../i18n';

/** W-E multimodal: images the user attached before task creation. */
interface PendingImage {
  file: File;
  previewUrl: string;
}

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : '');
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(file);
  });
}

export function CreateTaskModal({ projectId, onClose, onCreated }: {
  projectId: string; onClose: () => void; onCreated: () => void;
}) {
  const { t } = useLang();
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [priority, setPriority] = useState('P2');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // QA-R1: 连击防护不能只靠 state——setBusy(true) 是异步的，同 tick 内的
  // 连续点击都会看到 busy=false。用 ref 做同步守卫。
  const busyRef = useRef(false);

  // QA-R1: Esc 关闭弹窗（之前只能点取消/背景关闭）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Revoke object URLs on unmount.
  useEffect(() => () => { images.forEach((i) => URL.revokeObjectURL(i.previewUrl)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const addFiles = (files: FileList | File[]) => {
    const next: PendingImage[] = [];
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue;
      if (f.size > MAX_IMAGE_BYTES) {
        setError(t('createtask.imageTooLarge', { name: f.name }));
        continue;
      }
      next.push({ file: f, previewUrl: URL.createObjectURL(f) });
    }
    if (next.length > 0) setImages((prev) => [...prev, ...next].slice(0, 8));
  };

  const removeImage = (url: string) => {
    setImages((prev) => {
      const gone = prev.find((i) => i.previewUrl === url);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((i) => i.previewUrl !== url);
    });
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const submit = async () => {
    if (!title.trim()) { setError(t('createtask.titleRequired')); return; }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const task = await api.createTask({ projectId, title: title.trim(), goal: goal.trim(), priority });
      // Upload images after the task exists; a failed upload must not
      // silently vanish — report it and keep the modal open state honest.
      if (images.length > 0) {
        setUploading(true);
        const failures: string[] = [];
        for (const img of images) {
          try {
            const dataUrl = await fileToDataUrl(img.file);
            await api.uploadTaskAttachment(task.id, {
              filename: img.file.name,
              mimeType: img.file.type || 'image/png',
              dataBase64: dataUrl,
            });
          } catch (e) {
            failures.push(`${img.file.name}: ${(e as Error).message}`);
          }
        }
        setUploading(false);
        if (failures.length > 0) {
          setError(t('createtask.imageUploadFailed', { message: failures.join('; ') }));
          busyRef.current = false;
          setBusy(false);
          return;
        }
      }
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
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onPaste={onPaste}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files); }}
      >
        <h2>{t('createtask.heading')}</h2>
        <label>{t('createtask.titleLabel')}<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('createtask.titlePlaceholder')} /></label>
        <label>{t('createtask.goalLabel')}<textarea value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={t('createtask.goalPlaceholder')} /></label>
        <label>{t('createtask.priorityLabel')}
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            {['P0', 'P1', 'P2', 'P3', 'P4'].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <div className="attach-row">
          <button type="button" className="ghost" onClick={() => fileInputRef.current?.click()}>
            {t('createtask.attachImages')}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={IMAGE_ACCEPT}
            multiple
            hidden
            onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ''; }}
          />
          <span className="hint">{t('createtask.attachHint')}</span>
        </div>
        {images.length > 0 && (
          <div className="thumb-row">
            {images.map((img) => (
              <div key={img.previewUrl} className="thumb">
                <img src={img.previewUrl} alt={img.file.name} />
                <button type="button" className="thumb-x" onClick={() => removeImage(img.previewUrl)} title={t('createtask.removeImage')}>×</button>
              </div>
            ))}
          </div>
        )}
        {error && <p className="err">{error}</p>}
        <div className="btn-row">
          <button className="primary" onClick={submit} disabled={busy}>{busy ? (uploading ? t('createtask.uploadingImages') : t('createtask.creating')) : t('createtask.create')}</button>
          <button onClick={onClose}>{t('createtask.cancel')}</button>
        </div>
      </div>
    </div>
  );
}

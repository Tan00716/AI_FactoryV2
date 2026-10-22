/**
 * SnippetsPanel — snippet library manager (round-5 task R5-A6).
 *
 * Lists merged snippets (user + builtin + plugin providers), lets the user
 * add/edit/delete their own snippets stored at .ai-factory/snippets.json
 * (server fail-closed-validates). Provider snippets are read-only.
 * Preview shows the plain-text expansion; honest boundary text notes that
 * expansion is pure text substitution and nested placeholders are rejected.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useLang } from '../i18n';
import { previewSnippet } from '@ai-factory/snippets';
import type { SnippetDef } from '@ai-factory/snippets';
import {
  getMergedSnippets,
  getUserSnippetRoot,
  getUserSnippets,
  refreshSnippets,
  saveUserSnippets,
  validateUserSnippets,
} from '../snippets/manager';

const EMPTY_FORM = { id: '', trigger: '', description: '', scope: '*', body: '' };

export default function SnippetsPanel(props: { projectRoot: string }) {
  const { t } = useLang();
  const [tick, setTick] = useState(0);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [status, setStatus] = useState('');

  const reload = useCallback(async () => {
    await refreshSnippets(props.projectRoot);
    setTick((x) => x + 1);
  }, [props.projectRoot]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const merged = useMemo(() => getMergedSnippets(), [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const userIds = useMemo(() => new Set(getUserSnippets().map((s) => s.id)), [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const rootShown = getUserSnippetRoot() ?? props.projectRoot;

  const formIssues = useMemo(() => {
    if (!form.id && !form.trigger && !form.body) return [];
    const candidate: SnippetDef = {
      id: form.id.trim(),
      trigger: form.trigger.trim(),
      description: form.description.trim() || undefined,
      scope: form.scope.split(',').map((s) => s.trim()).filter(Boolean),
      body: form.body,
    };
    const others = getUserSnippets().filter((s) => s.id !== editingId);
    return validateUserSnippets([...others, candidate]);
  }, [form, editingId, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSave = async () => {
    setIssues([]);
    setStatus('');
    if (formIssues.length > 0) {
      setIssues(formIssues);
      return;
    }
    const next: SnippetDef = {
      id: form.id.trim(),
      trigger: form.trigger.trim(),
      description: form.description.trim() || undefined,
      scope: form.scope.split(',').map((s) => s.trim()).filter(Boolean),
      body: form.body,
    };
    const current = getUserSnippets();
    const updated = editingId ? current.map((s) => (s.id === editingId ? next : s)) : [...current, next];
    try {
      await saveUserSnippets(props.projectRoot, updated);
      setForm(EMPTY_FORM);
      setEditingId(null);
      setStatus(t('snippets.status.saved'));
      await reload();
    } catch (e) {
      setIssues([t('snippets.status.saveFailed', { error: e instanceof Error ? e.message : String(e) })]);
    }
  };

  const onEdit = (s: SnippetDef) => {
    setEditingId(s.id);
    setForm({
      id: s.id,
      trigger: s.trigger,
      description: s.description ?? '',
      scope: s.scope.join(', '),
      body: s.body,
    });
    setIssues([]);
  };

  const onDelete = async (id: string) => {
    const updated = getUserSnippets().filter((s) => s.id !== id);
    try {
      await saveUserSnippets(props.projectRoot, updated);
      if (editingId === id) {
        setEditingId(null);
        setForm(EMPTY_FORM);
      }
      setStatus(t('snippets.status.saved'));
      await reload();
    } catch (e) {
      setIssues([t('snippets.status.saveFailed', { error: e instanceof Error ? e.message : String(e) })]);
    }
  };

  const onCancel = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setIssues([]);
  };

  const preview = useMemo(() => {
    try {
      return previewSnippet({
        id: form.id || 'preview',
        trigger: form.trigger || 'x',
        scope: ['*'],
        body: form.body || '',
      });
    } catch {
      return '';
    }
  }, [form.body, form.id, form.trigger]);

  const set = (k: keyof typeof EMPTY_FORM) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="snippets-panel">
      <div className="snippets-head">
        <h2>{t('snippets.title')}</h2>
        <span className="snippets-root">{rootShown}/.ai-factory/snippets.json</span>
      </div>
      <p className="snippets-honest">{t('snippets.honest')}</p>

      <div className="snippets-list">
        <h3>{t('snippets.listTitle', { count: String(merged.length) })}</h3>
        <table className="snippets-table">
          <thead>
            <tr>
              <th>{t('snippets.colTrigger')}</th>
              <th>{t('snippets.colDescription')}</th>
              <th>{t('snippets.colScope')}</th>
              <th>{t('snippets.colSource')}</th>
              <th>{t('snippets.colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {merged.map((s) => (
              <tr key={s.id} title={previewSnippet({ ...s, description: undefined })}>
                <td><code>{s.trigger}</code></td>
                <td>{s.description ?? '—'}</td>
                <td><code>{s.scope.join(', ')}</code></td>
                <td>{userIds.has(s.id) ? t('snippets.sourceUser') : t('snippets.sourceProvider')}</td>
                <td>
                  {userIds.has(s.id) ? (
                    <>
                      <button type="button" onClick={() => onEdit(s)}>{t('snippets.edit')}</button>
                      {' '}
                      <button type="button" onClick={() => void onDelete(s.id)}>{t('snippets.delete')}</button>
                    </>
                  ) : (
                    <span className="snippets-readonly">{t('snippets.readonly')}</span>
                  )}
                </td>
              </tr>
            ))}
            {merged.length === 0 && (
              <tr><td colSpan={5}>{t('snippets.empty')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="snippets-form">
        <h3>{editingId ? t('snippets.editTitle') : t('snippets.addTitle')}</h3>
        <label>{t('snippets.fieldId')}
          <input value={form.id} onChange={set('id')} disabled={editingId !== null} placeholder="my-loop" />
        </label>
        <label>{t('snippets.fieldTrigger')}
          <input value={form.trigger} onChange={set('trigger')} placeholder="for" />
        </label>
        <label>{t('snippets.fieldDescription')}
          <input value={form.description} onChange={set('description')} placeholder={t('snippets.fieldDescriptionPh')} />
        </label>
        <label>{t('snippets.fieldScope')}
          <input value={form.scope} onChange={set('scope')} placeholder="typescript, javascript  (* = all)" />
        </label>
        <label>{t('snippets.fieldBody')}
          <textarea value={form.body} onChange={set('body')} rows={5}
            placeholder={'for (${1:item} of ${2:items}) {\n\t$0\n}'} />
        </label>
        <div className="snippets-preview">
          <span>{t('snippets.preview')}:</span>
          <pre>{preview}</pre>
        </div>
        {formIssues.length > 0 && (
          <ul className="snippets-issues">
            {formIssues.map((m, i) => <li key={i}>{m}</li>)}
          </ul>
        )}
        <div className="snippets-actions">
          <button type="button" className="primary" onClick={() => void onSave()}>{t('snippets.save')}</button>
          {editingId && <button type="button" onClick={onCancel}>{t('snippets.cancel')}</button>}
          {status && <span className="snippets-status">{status}</span>}
        </div>
        {issues.length > 0 && (
          <ul className="snippets-issues">
            {issues.map((m, i) => <li key={i}>{m}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}

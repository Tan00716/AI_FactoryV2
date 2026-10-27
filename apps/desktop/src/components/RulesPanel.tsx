/**
 * RulesPanel — tiered rule-file management (round-6 task R6-A6).
 *
 * Two managed levels (global ~/.ai-factory/rules + project
 * .ai-factory/rules.json) with add/edit/enable/disable/delete/reorder,
 * plus the effective view: project rules override same-named global rules
 * (labelled, never silent), and AGENTS.md / .cursorrules / .clinerules at
 * the project root are shown read-only — v1 never rewrites them, so their
 * free-form formatting cannot be damaged by a JSON round-trip. Rule
 * content is never semantically validated: it is the operator's prose.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useLang } from '../i18n';
import { api } from '../api';
import type { RuleDto, RuleEffectiveDto, RulesViewDto } from '../api';

export default function RulesPanel(props: { projectRoot: string }) {
  const { t } = useLang();
  const [view, setView] = useState<RulesViewDto | null>(null);
  const [scope, setScope] = useState<'global' | 'project'>('project');
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [editId, setEditId] = useState('');
  const [editContent, setEditContent] = useState('');
  const [status, setStatus] = useState('');

  const reload = useCallback(async () => {
    try {
      setView(await api.rulesView(props.projectRoot || undefined));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }, [props.projectRoot]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onAdd = async () => {
    setStatus('');
    try {
      await api.rulesAdd({ scope, name: name.trim(), content, root: props.projectRoot || undefined });
      setStatus(t('rules.status.saved'));
      setName('');
      setContent('');
      await reload();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const onToggle = async (rule: RuleDto) => {
    try {
      await api.rulesPatch(rule.id, rule.scope, { enabled: !rule.enabled }, props.projectRoot || undefined);
      await reload();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const onDelete = async (rule: RuleDto) => {
    try {
      await api.rulesDelete(rule.id, rule.scope, props.projectRoot || undefined);
      await reload();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const onSaveEdit = async (rule: RuleDto) => {
    try {
      await api.rulesPatch(rule.id, rule.scope, { content: editContent }, props.projectRoot || undefined);
      setEditId('');
      await reload();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const onMove = async (rules: RuleDto[], idx: number, dir: -1 | 1) => {
    const next = [...rules];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    try {
      await api.rulesOrder(rules[0].scope, next.map((r) => r.id), props.projectRoot || undefined);
      await reload();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const renderLevel = (title: string, rules: RuleDto[]) => (
    <section>
      <h3>{title} ({rules.length})</h3>
      {rules.length === 0 ? (
        <p>{t('rules.empty')}</p>
      ) : (
        <ul>
          {rules.map((rule, idx) => (
            <li key={rule.id} style={{ opacity: rule.enabled ? 1 : 0.55 }}>
              <strong>{rule.name}</strong>
              {rule.overriddenBy ? (
                <span> {t('rules.overriddenBy')}</span>
              ) : null}{' '}
              <button onClick={() => void onToggle(rule)}>
                {rule.enabled ? t('rules.disable') : t('rules.enable')}
              </button>{' '}
              <button onClick={() => { setEditId(rule.id); setEditContent(rule.content); }}>
                {t('rules.edit')}
              </button>{' '}
              <button onClick={() => void onDelete(rule)}>{t('rules.delete')}</button>{' '}
              <button onClick={() => void onMove(rules, idx, -1)} disabled={idx === 0}>
                {t('rules.moveUp')}
              </button>{' '}
              <button onClick={() => void onMove(rules, idx, 1)} disabled={idx === rules.length - 1}>
                {t('rules.moveDown')}
              </button>
              {editId === rule.id ? (
                <div>
                  <textarea value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={4} cols={72} />
                  <div>
                    <button onClick={() => void onSaveEdit(rule)}>{t('rules.save')}</button>{' '}
                    <button onClick={() => setEditId('')}>{t('rules.cancel')}</button>
                  </div>
                </div>
              ) : (
                <pre>{rule.content.slice(0, 500)}</pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  const renderEffective = (effective: RuleEffectiveDto[]) => (
    <section>
      <h3>{t('rules.effectiveTitle')} ({effective.length})</h3>
      <ul>
        {effective.map((e, i) => (
          <li key={`${e.source}-${e.name}-${i}`} style={{ opacity: e.enabled ? 1 : 0.55 }}>
            <strong>{e.name}</strong>
            <span> [{e.scope}/{e.source}{e.readOnly ? `/${t('rules.readOnly')}` : ''}]</span>
            {e.overrides.length > 0 ? <span> {t('rules.overrides')}</span> : null}
            {!e.enabled ? <span> {t('rules.disabledMark')}</span> : null}
            <pre>{e.content.slice(0, 500)}</pre>
          </li>
        ))}
      </ul>
    </section>
  );

  return (
    <div>
      <h2>{t('rules.title')}</h2>
      <p>{t('rules.honest')}</p>
      <section>
        <h3>{t('rules.addTitle')}</h3>
        <label>
          {t('rules.scopeLabel')}{' '}
          <select value={scope} onChange={(e) => setScope(e.target.value as 'global' | 'project')}>
            <option value="project">{t('rules.scopeProject')}</option>
            <option value="global">{t('rules.scopeGlobal')}</option>
          </select>
        </label>{' '}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('rules.namePlaceholder')}
        />
        <div>
          <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={4} cols={72} />
        </div>
        <button onClick={() => void onAdd()} disabled={!name.trim()}>{t('rules.add')}</button>
      </section>
      {view ? (
        <>
          {renderLevel(t('rules.globalTitle'), view.global)}
          {renderLevel(t('rules.projectTitle'), view.project)}
          {renderEffective(view.effective)}
        </>
      ) : (
        <p>{t('rules.loading')}</p>
      )}
      {status ? <p>{status}</p> : null}
    </div>
  );
}

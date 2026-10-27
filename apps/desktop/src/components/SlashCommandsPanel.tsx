import { useCallback, useEffect, useState } from 'react';
import { api, type SlashCommandInfo, type SlashExecuteResult } from '../api';
import { useLang } from '../i18n';

/**
 * Custom slash commands panel (round-6 task R6-A7) — user-defined
 * `/my-cmd` aliases on top of the W-B slash command system.
 *
 * A slash command is an alias + parameter template for something the IDE
 * already knows how to run — never a natural-language parser, never a
 * new execution channel:
 *  - template: deterministic text expansion ({args}, {args:N})
 *  - command: alias for a command-palette command id (the desktop
 *    dispatches it; the server only returns the descriptor)
 *  - task: alias for a tasks.json chain label, run through the same
 *    policy/audit/record path as a manual task run, with the expanded
 *    args appended to the REQUESTED task only.
 *
 * Scopes: user (AI_FACTORY_DATA_DIR/slash-commands.json) and project
 * (<root>/.ai-factory/slash-commands.json); project wins on name clash.
 * Shadowing a built-in needs explicit override and is always warned.
 * Disabled commands list but refuse execution.
 */
type SlashKind = 'template' | 'command' | 'task';

export function SlashCommandsPanel({ projectRoot }: { projectRoot: string }) {
  const { t } = useLang();
  const [builtins, setBuiltins] = useState<SlashCommandInfo[]>([]);
  const [custom, setCustom] = useState<SlashCommandInfo[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<SlashKind>('template');
  const [target, setTarget] = useState('');
  const [template, setTemplate] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<'user' | 'project'>('user');
  const [overrideBuiltin, setOverrideBuiltin] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [execInput, setExecInput] = useState('');
  const [execResult, setExecResult] = useState<SlashExecuteResult | null>(null);
  const [execErr, setExecErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const res = await api.slashList(projectRoot || undefined);
      setBuiltins(res.builtins);
      setCustom(res.custom);
      setWarnings(res.warnings);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [projectRoot]);

  useEffect(() => {
    void load();
  }, [load]);

  const resetForm = useCallback(() => {
    setName('');
    setKind('template');
    setTarget('');
    setTemplate('');
    setDescription('');
    setScope('user');
    setOverrideBuiltin(false);
    setEditing(null);
  }, []);

  const submit = useCallback(async () => {
    setErr(null);
    const clean = name.trim().toLowerCase();
    if (!clean) {
      setErr(t('slash.nameRequired'));
      return;
    }
    if (kind === 'template' && !template.trim()) {
      setErr(t('slash.templateRequired'));
      return;
    }
    if (kind !== 'template' && !target.trim()) {
      setErr(t('slash.targetRequired'));
      return;
    }
    try {
      await api.slashManage({
        op: editing ? 'update' : 'add',
        name: clean,
        scope,
        ...(scope === 'project' && projectRoot ? { root: projectRoot } : {}),
        kind,
        ...(kind !== 'template' ? { target: target.trim() } : {}),
        template: template.trim(),
        description: description.trim(),
        ...(editing ? {} : { override: overrideBuiltin }),
      });
      resetForm();
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [name, kind, target, template, description, scope, overrideBuiltin, editing, projectRoot, resetForm, load, t]);

  const act = useCallback(async (op: 'remove' | 'enable' | 'disable', c: SlashCommandInfo) => {
    setErr(null);
    try {
      await api.slashManage({
        op,
        name: c.name,
        scope: c.source === 'project' ? 'project' : 'user',
        ...(c.source === 'project' && projectRoot ? { root: projectRoot } : {}),
      });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [projectRoot, load]);

  const startEdit = useCallback((c: SlashCommandInfo) => {
    setEditing(c.name);
    setName(c.name);
    setKind(c.kind ?? 'template');
    setTarget(c.target ?? '');
    setTemplate(c.template ?? '');
    setDescription(c.description ?? '');
    setScope(c.source === 'project' ? 'project' : 'user');
    setOverrideBuiltin(false);
  }, []);

  const runExec = useCallback(async () => {
    setExecErr(null);
    setExecResult(null);
    try {
      const res = await api.slashExecute(execInput.trim(), {
        ...(projectRoot ? { root: projectRoot } : {}),
      });
      setExecResult(res);
    } catch (e) {
      setExecErr((e as Error).message);
    }
  }, [execInput, projectRoot]);

  return (
    <div className="panel">
      <h2>{t('slash.title')}</h2>
      <p>{t('slash.desc')}</p>
      {err && <p className="error">{err}</p>}
      {warnings.length > 0 && (
        <div className="notice">
          {warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      )}
      <h3>{t('slash.custom')}</h3>
      {custom.length === 0 ? (
        <p>{t('slash.noCustom')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('slash.name')}</th>
              <th>{t('slash.kind')}</th>
              <th>{t('slash.target')}</th>
              <th>{t('slash.scope')}</th>
              <th>{t('slash.enabled')}</th>
              <th>{t('slash.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {custom.map((c) => (
              <tr key={`${c.source}:${c.name}`}>
                <td>/{c.name}</td>
                <td>{c.kind}</td>
                <td>{c.kind === 'template' ? c.template : c.target}</td>
                <td>
                  {c.source === 'project' ? t('slash.sourceProject') : t('slash.sourceUser')}
                  {c.shadowsBuiltin ? ` (${t('slash.shadowsBuiltin')})` : ''}
                  {c.shadowsUser ? ` (${t('slash.shadowsUser')})` : ''}
                </td>
                <td>{c.enabled === false ? t('slash.disabled') : t('slash.enabled')}</td>
                <td>
                  <button onClick={() => startEdit(c)}>{t('slash.edit')}</button>{' '}
                  <button onClick={() => void act(c.enabled === false ? 'enable' : 'disable', c)}>
                    {c.enabled === false ? t('slash.enable') : t('slash.disable')}
                  </button>{' '}
                  <button onClick={() => void act('remove', c)}>{t('slash.remove')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>{editing ? t('slash.editing') : t('slash.add')}</h3>
      <div className="form-row">
        <label>
          {t('slash.name')}
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-cmd" disabled={!!editing} />
        </label>
        <label>
          {t('slash.kind')}
          <select value={kind} onChange={(e) => setKind(e.target.value as SlashKind)}>
            <option value="template">{t('slash.kindTemplate')}</option>
            <option value="command">{t('slash.kindCommand')}</option>
            <option value="task">{t('slash.kindTask')}</option>
          </select>
        </label>
        <label>
          {t('slash.scope')}
          <select value={scope} onChange={(e) => setScope(e.target.value as 'user' | 'project')}>
            <option value="user">{t('slash.scopeUser')}</option>
            <option value="project">{t('slash.scopeProject')}</option>
          </select>
        </label>
      </div>
      {kind !== 'template' && (
        <div className="form-row">
          <label>
            {t('slash.target')}
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={kind === 'command' ? 'go.tab.editor' : 'build'}
            />
          </label>
        </div>
      )}
      <div className="form-row">
        <label>
          {kind === 'template' ? t('slash.template') : t('slash.argsTemplate')}
          <input
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            placeholder={kind === 'template' ? 'Write a note about: {args}' : '{args}'}
          />
        </label>
        <label>
          {t('slash.description')}
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </div>
      {!editing && (
        <div className="form-row">
          <label>
            <input type="checkbox" checked={overrideBuiltin} onChange={(e) => setOverrideBuiltin(e.target.checked)} />
            {t('slash.override')} — {t('slash.overrideHint')}
          </label>
        </div>
      )}
      <div className="form-row">
        <button onClick={() => void submit()}>{editing ? t('slash.update') : t('slash.add')}</button>{' '}
        {editing && <button onClick={resetForm}>{t('slash.cancel')}</button>}
      </div>
      <h3>{t('slash.execute')}</h3>
      <div className="form-row">
        <input
          value={execInput}
          onChange={(e) => setExecInput(e.target.value)}
          placeholder={t('slash.executePlaceholder')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runExec();
          }}
        />
        <button onClick={() => void runExec()}>{t('slash.execute')}</button>
      </div>
      {execErr && <p className="error">{execErr}</p>}
      {execResult && (
        <div className="notice">
          {execResult.type === 'template' && <p>{execResult.text}</p>}
          {execResult.type === 'command' && (
            <p>
              {execResult.commandId} {execResult.args}
            </p>
          )}
          {execResult.type === 'task' && (
            <p>
              {execResult.label}: {execResult.chain?.ok ? 'ok' : 'failed'}
              {execResult.chain?.results.map((r) => (
                <span key={r.label}>
                  <br />
                  {r.label} [{r.status}]: {(r.output || '').trim().slice(0, 200)}
                </span>
              ))}
            </p>
          )}
          {execResult.warning && <p>{execResult.warning}</p>}
        </div>
      )}
      <h3>{t('slash.builtin')}</h3>
      <ul>
        {builtins.map((b) => (
          <li key={b.name}>
            /{b.name} — {b.description}
          </li>
        ))}
      </ul>
      <p className="hint">{t('slash.honest')}</p>
    </div>
  );
}

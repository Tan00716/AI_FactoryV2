import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type TaskChainResponse,
  type TaskDefView,
  type TaskRunResultView,
  type TasksListResponse,
} from '../api';
import { useLang } from '../i18n';
import { CascadeTimelinePanel } from './CascadeTimelinePanel';

/**
 * Declarative task runner panel (round-5 task R5-S2) — VS Code Tasks style.
 * Lists tasks from `.ai-factory/tasks.json`, runs a task (with its
 * dependsOn chain), and shows per-task output, exit codes and the
 * problem-matcher diagnostics each run produced.
 *
 * HONEST BOUNDARIES (rendered in the UI):
 *  - Only a documented subset of VS Code tasks.json is supported;
 *    background/watch tasks (isBackground) do not exist in v1.
 *  - `type: "shell"` never invokes a shell: the command string is
 *    tokenized quote-aware and run directly (no `;`, `|`, `$(...)`).
 *  - Task commands pass the same execution safety policy as /api/exec
 *    (binary whitelist + deny patterns + control-dir guard); denied
 *    commands never run.
 *  - A failing task stops the whole chain (fail-closed): dependents do
 *    not run.
 */

const SAMPLE_TASKS = `{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "hello",
      "type": "shell",
      "command": "echo hello from tasks",
      "group": "build",
      "problemMatcher": []
    },
    {
      "label": "node-version",
      "type": "process",
      "command": "node",
      "args": ["--version"],
      "dependsOn": ["hello"]
    }
  ]
}
`;

function StatusPill({ status }: { status: TaskRunResultView['status'] }) {
  const { t } = useLang();
  const cls =
    status === 'ok'
      ? 'pill'
      : status === 'skipped'
        ? 'pill muted'
        : 'pill warn';
  return <span className={cls}>{t(`tasks.status.${status}`)}</span>;
}

export function TasksPanel({ projectId }: { projectId: string }) {
  const { t } = useLang();
  const [data, setData] = useState<TasksListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<TaskChainResponse | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await api.tasksList();
      setData(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const runTask = useCallback(
    async (label: string) => {
      setRunning(label);
      setRunErr(null);
      setLastRun(null);
      try {
        const r = await api.tasksRun(label, projectId);
        setLastRun(r);
      } catch (e) {
        setRunErr(e instanceof Error ? e.message : String(e));
      } finally {
        setRunning(null);
      }
    },
    [projectId],
  );

  const openEditor = () => {
    setEditText(
      data && !data.missing
        ? JSON.stringify(
            { version: '2.0.0', tasks: data.tasks.map((x) => stripView(x)) },
            null,
            2,
          )
        : SAMPLE_TASKS,
    );
    setSaveMsg(null);
    setEditing(true);
  };

  const save = useCallback(async () => {
    setSaveMsg(null);
    try {
      const r = await api.tasksSave(editText);
      setSaveMsg(t('tasks.saved', { count: String(r.count) }));
      setEditing(false);
      load();
    } catch (e) {
      const err = e as Error & { status?: number; body?: { errors?: string[] } };
      const errs = (err as { errors?: string[] }).errors;
      setSaveMsg(
        t('tasks.saveFailed', {
          message: Array.isArray(errs) && errs.length > 0 ? errs.join('; ') : err.message ?? String(e),
        }),
      );
    }
  }, [editText, load, t]);

  if (loading) return <div className="muted">{t('tasks.loading')}</div>;
  if (err) {
    return (
      <div>
        <span className="pill warn">{t('tasks.loadFailed', { message: err })}</span>{' '}
        <button className="link" onClick={load}>{t('tasks.retry')}</button>
      </div>
    );
  }

  const tasks = data?.tasks ?? [];
  return (
    <div className="tasks-panel">
      <div className="tasks-toolbar">
        <button className="pill" onClick={openEditor}>
          {data?.missing ? t('tasks.createFile') : t('tasks.editFile')}
        </button>
        <button className="link" onClick={load}>{t('tasks.refresh')}</button>
        {data && data.warnings.length > 0 && (
          <span className="muted" title={data.warnings.join('\n')}>
            {t('tasks.warnings', { count: String(data.warnings.length) })}
          </span>
        )}
        {data && data.errors.length > 0 && (
          <span className="pill warn" title={data.errors.join('\n')}>
            {t('tasks.invalid', { count: String(data.errors.length) })}
          </span>
        )}
      </div>

      {editing && (
        <div className="tasks-editor">
          <textarea
            className="tasks-textarea"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            rows={14}
            spellCheck={false}
          />
          <div className="tasks-toolbar">
            <button className="pill" onClick={save}>{t('tasks.save')}</button>
            <button className="link" onClick={() => setEditing(false)}>{t('tasks.cancel')}</button>
            {saveMsg && <span className="muted">{saveMsg}</span>}
          </div>
          <div className="muted tasks-hint">{t('tasks.editHint')}</div>
        </div>
      )}

      {data?.missing && !editing && (
        <div className="muted">{t('tasks.noFile')}</div>
      )}

      {tasks.length > 0 && (
        <div className="tasks-list">
          {tasks.map((task) => (
            <div key={task.label} className="tasks-row">
              <div className="tasks-row-head">
                <b>{task.label}</b>
                <span className="muted">
                  {task.type === 'process' ? task.command : `${task.command} ${task.args.join(' ')}`.trim()}
                </span>
                {task.group !== 'none' && <span className="pill">{task.group}</span>}
                {task.dependsOn.length > 0 && (
                  <span className="muted" title={task.dependsOn.join(', ')}>
                    {t('tasks.dependsOn', { deps: task.dependsOn.join(', ') })}
                  </span>
                )}
                <button
                  className="pill"
                  disabled={running !== null}
                  onClick={() => runTask(task.label)}
                >
                  {running === task.label ? t('tasks.running') : t('tasks.run')}
                </button>
              </div>
              {task.detail && <div className="muted tasks-detail">{task.detail}</div>}
            </div>
          ))}
        </div>
      )}

      {runErr && <div className="pill warn">{t('tasks.runFailed', { message: runErr })}</div>}

      {lastRun && (
        <div className="tasks-results">
          <div className="tasks-results-head">
            <b>
              {t('tasks.chainResult', {
                ok: lastRun.ok ? t('tasks.chainOk') : t('tasks.chainFailed'),
              })}
            </b>
            {lastRun.stoppedAt && (
              <span className="muted">{t('tasks.stoppedAt', { label: lastRun.stoppedAt })}</span>
            )}
          </div>
          {lastRun.results.map((r) => (
            <div key={r.label} className="tasks-result">
              <div
                className="tasks-result-head"
                onClick={() => setExpanded((s) => ({ ...s, [r.label]: !s[r.label] }))}
                role="button"
                tabIndex={0}
              >
                <StatusPill status={r.status} />
                <b>{r.label}</b>
                <span className="muted">
                  {t('tasks.exitCode', { code: r.exitCode === null ? '—' : String(r.exitCode) })}
                  {' · '}
                  {t('tasks.duration', { ms: String(r.durationMs) })}
                  {r.diagnosticsAdded > 0 && (
                    <>
                      {' · '}
                      {t('tasks.diagnostics', { count: String(r.diagnosticsAdded) })}
                    </>
                  )}
                </span>
              </div>
              {r.error && <div className="pill warn">{r.error}</div>}
              {r.notes?.map((n) => (
                <div key={n} className="muted">{n}</div>
              ))}
              {expanded[r.label] && (
                <pre className="tasks-output">{r.output || t('tasks.noOutput')}</pre>
              )}
            </div>
          ))}
        </div>
      )}

      <CascadeTimelinePanel />

      <div className="muted tasks-hint">{t('tasks.honest')}</div>
    </div>
  );
}

/** Strip the parsed view back to a declarable shape for the editor. */
function stripView(v: TaskDefView): Record<string, unknown> {
  const o: Record<string, unknown> = { label: v.label, command: v.command };
  if (v.type !== 'shell') o['type'] = v.type;
  if (v.args.length > 0) o['args'] = v.args;
  if (v.group !== 'none') o['group'] = v.group;
  if (v.detail) o['detail'] = v.detail;
  if (v.dependsOn.length > 0) o['dependsOn'] = v.dependsOn;
  if (v.dependsOrder !== 'sequence') o['dependsOrder'] = v.dependsOrder;
  if (v.problemMatcher.length > 0) o['problemMatcher'] = v.problemMatcher;
  if (Object.keys(v.options).length > 0) o['options'] = v.options;
  return o;
}

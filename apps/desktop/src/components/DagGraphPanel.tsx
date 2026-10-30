import { useCallback, useEffect, useState } from 'react';
import { api, type TaskDagGraph, type TaskDefView } from '../api';
import { useLang } from '../i18n';

/**
 * R7-#4 task dependency DAG visualization, embedded in TasksPanel
 * (no new center tab, so the e2e tab count is untouched).
 *
 * Nodes are grouped into level columns (level = longest dependency
 * chain beneath the node); each node box is colored by its last-run
 * status (ok / failed / skipped / never run). Edges are listed as
 * "dependency -> dependent" lines under the columns. A cycle can never
 * reach this view: the server rejects cyclic files at save time and
 * plan time, and both failures surface here as the server's error.
 *
 * HONEST BOUNDARIES (rendered in the UI):
 *  - Statuses come from the server's process-local run ring: a server
 *    restart clears them and every node reports "never run" again.
 *  - The graph is the planned shape for one requested label, not a
 *    live execution trace — use the Cascade timeline for per-step
 *    outputs and the run history below.
 */
function statusClass(status: string | null): string {
  if (status === 'ok') return 'pill';
  if (status === 'skipped') return 'pill muted';
  if (status === 'failed' || status === 'denied' || status === 'timeout') return 'pill warn';
  return 'pill muted';
}

export function DagGraphPanel({
  projectId,
  tasks,
}: {
  projectId: string;
  tasks: TaskDefView[];
}) {
  const { t } = useLang();
  const withDeps = tasks.filter((x) => x.dependsOn.length > 0);
  const [label, setLabel] = useState<string>(withDeps[0]?.label ?? tasks[0]?.label ?? '');
  const [graph, setGraph] = useState<TaskDagGraph | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    if (!label) return;
    setLoading(true);
    setErr(null);
    try {
      setGraph(await api.tasksGraph(label));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setGraph(null);
    } finally {
      setLoading(false);
    }
  }, [label]);

  useEffect(() => {
    load();
  }, [load]);

  // Keep the selector on a real task when the file changes under us.
  useEffect(() => {
    if (tasks.length > 0 && !tasks.some((x) => x.label === label)) {
      setLabel(withDeps[0]?.label ?? tasks[0]?.label ?? '');
    }
  }, [tasks, label, withDeps]);

  const run = useCallback(async () => {
    if (!label) return;
    setRunning(true);
    setErr(null);
    try {
      await api.tasksRun(label, projectId);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [label, projectId, load]);

  if (tasks.length === 0) return null;

  const levels = new Map<number, TaskDagGraph['nodes']>();
  for (const n of graph?.nodes ?? []) {
    const col = levels.get(n.level) ?? [];
    col.push(n);
    levels.set(n.level, col);
  }

  return (
    <div className="dag-panel">
      <div className="tasks-toolbar">
        <b>{t('dag.title')}</b>
        <select value={label} onChange={(e) => setLabel(e.target.value)} aria-label={t('dag.selectLabel')}>
          {tasks.map((x) => (
            <option key={x.label} value={x.label}>
              {x.label}
              {x.dependsOn.length > 0 ? ` (${t('dag.deps', { count: String(x.dependsOn.length) })})` : ''}
            </option>
          ))}
        </select>
        <button className="pill" onClick={load} disabled={loading || !label}>
          {t('dag.refresh')}
        </button>
        <button className="pill" onClick={run} disabled={running || !label}>
          {running ? t('tasks.running') : t('tasks.run')}
        </button>
      </div>

      {loading && <div className="muted">{t('tasks.loading')}</div>}
      {err && <div className="pill warn">{t('dag.loadFailed', { message: err })}</div>}

      {graph && (
        <>
          <div className="dag-levels">
            {[...levels.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([level, nodes]) => (
                <div key={level} className="dag-level">
                  <div className="muted">{t('dag.level', { level: String(level) })}</div>
                  {nodes.map((n) => (
                    <div key={n.label} className="dag-node">
                      <span className={statusClass(n.status)}>{n.status ?? t('dag.neverRun')}</span>{' '}
                      <b>{n.label}</b>
                      <span className="muted"> {n.command}</span>
                      {n.parallel && <span className="pill"> {t('dag.parallel')}</span>}
                    </div>
                  ))}
                </div>
              ))}
          </div>
          <div className="dag-edges">
            {graph.edges.map((e) => (
              <div key={`${e.from}->${e.to}`} className="muted">
                {e.from} → {e.to}
              </div>
            ))}
            {graph.edges.length === 0 && <div className="muted">{t('dag.noEdges')}</div>}
          </div>
          <div className="muted">{t('dag.honest')}</div>
        </>
      )}
    </div>
  );
}

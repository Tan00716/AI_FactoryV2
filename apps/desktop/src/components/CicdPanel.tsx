import { useCallback, useEffect, useState } from 'react';
import { authHeaders } from '../api';

/** Typed client for the CI/CD endpoints (mirrors the req pattern in api.ts). */
export interface PipelineStage {
  name: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
  logs: string[];
  startedAt: string | null;
  endedAt: string | null;
}

export interface Pipeline {
  id: string;
  commitSha: string;
  environment: string;
  status: string;
  stages: PipelineStage[];
  taskId: string | null;
  deployments: Deployment[];
  failure?: { stage: string; message: string };
}

export interface Deployment {
  id: string;
  pipelineId: string;
  environment: string;
  status: string;
  snapshotId: string | null;
  approvalId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  error?: string;
}

export interface Environment {
  name: string;
  approvalPolicy: string;
  url: string;
}

export interface CicdApi {
  environments(): Promise<{ environments: Environment[] }>;
  pipelines(): Promise<Pipeline[]>;
  createPipeline(environment: string, taskId?: string): Promise<Pipeline>;
  runPipeline(id: string): Promise<Pipeline>;
  deploy(id: string, environment: string, taskId: string): Promise<{
    deployment: Deployment;
    pendingApproval: { deploymentId: string; environment: string; action: string; reason: string } | null;
    approval: { id: string } | null;
  }>;
  approve(id: string, approvalId: string): Promise<{ deployment: Deployment }>;
  rollback(id: string): Promise<{ deployment: Deployment; restored: unknown }>;
}

const DEFAULT_BASE = 'http://localhost:3100/api';

async function req<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as T;
  if (!res.ok) {
    const err = body as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return body;
}

export function createCicdApi(base: string = DEFAULT_BASE): CicdApi {
  return {
    environments: () => req(base, '/environments'),
    pipelines: () => req(base, '/pipelines'),
    createPipeline: (environment, taskId) =>
      req(base, '/pipelines', { method: 'POST', body: JSON.stringify({ environment, taskId }) }),
    runPipeline: (id) =>
      req(base, `/pipelines/${encodeURIComponent(id)}/run`, { method: 'POST', body: '{}' }),
    deploy: (id, environment, taskId) =>
      req(base, `/pipelines/${encodeURIComponent(id)}/deploy`, {
        method: 'POST',
        body: JSON.stringify({ environment, taskId }),
      }),
    approve: (id, approvalId) =>
      req(base, `/pipelines/${encodeURIComponent(id)}/approve`, {
        method: 'POST',
        body: JSON.stringify({ approvalId }),
      }),
    rollback: (id) =>
      req(base, `/pipelines/${encodeURIComponent(id)}/rollback`, { method: 'POST', body: '{}' }),
  };
}

function stageClass(s: string): string {
  if (s === 'SUCCEEDED') return 'st-working';
  if (s === 'FAILED') return 'st-failed';
  if (s === 'RUNNING') return 'st-active';
  if (s === 'SKIPPED') return 'st-idle';
  return 'st-idle';
}

/**
 * CI/CD panel (§39–§41, §77): environments, pipeline list with stage grid,
 * run / deploy / approve / rollback controls, deployment history.
 */
export function CicdPanel(props: { taskId?: string | null; cicd?: CicdApi }) {
  const [cicd] = useState<CicdApi>(() => props.cicd ?? createCicdApi());
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newEnv, setNewEnv] = useState('DEV');
  const [deployEnv, setDeployEnv] = useState<Record<string, string>>({});
  const [pendingApprovals, setPendingApprovals] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      const [e, p] = await Promise.all([cicd.environments(), cicd.pipelines()]);
      setEnvs(e.environments);
      setPipelines(p);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cicd]);

  useEffect(() => { refresh(); }, [refresh]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cicd-panel">
      <div className="row" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <span className="muted">Environments:</span>
        {envs.map((e) => (
          <span key={e.name} className="pill" title={`approval: ${e.approvalPolicy}`}>
            {e.name} · {e.approvalPolicy}
          </span>
        ))}
        <span style={{ flex: 1 }} />
        <select value={newEnv} onChange={(e) => setNewEnv(e.target.value)}>
          {envs.map((e) => (
            <option key={e.name} value={e.name}>{e.name}</option>
          ))}
        </select>
        <button disabled={busy} onClick={() => run(() => cicd.createPipeline(newEnv, props.taskId ?? undefined))}>
          New pipeline
        </button>
      </div>
      {error && <div className="banner err">{error}</div>}
      {pipelines.length === 0 && <p className="muted">No pipelines yet — create one above.</p>}
      {pipelines.map((p) => (
        <div key={p.id} className="card" style={{ marginBottom: 8 }}>
          <div className="row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <b>{p.id.slice(0, 8)}</b>
            <span className="pill">{p.environment}</span>
            <span className={`status-dot ${stageClass(p.status === 'SUCCEEDED' ? 'SUCCEEDED' : p.status === 'FAILED' ? 'FAILED' : 'PENDING')}`} />
            <span className="muted">{p.status}</span>
            {p.failure && <span className="banner err" style={{ margin: 0 }}>{p.failure.stage}: {p.failure.message}</span>}
            <span style={{ flex: 1 }} />
            <button disabled={busy} onClick={() => run(() => cicd.runPipeline(p.id))}>Run</button>
            <select
              value={deployEnv[p.id] ?? 'UAT'}
              onChange={(e) => setDeployEnv((prev) => ({ ...prev, [p.id]: e.target.value }))}
            >
              {envs.map((e) => (
                <option key={e.name} value={e.name}>{e.name}</option>
              ))}
            </select>
            <button
              disabled={busy || !props.taskId}
              title={props.taskId ? '' : 'Select a task on the Board tab first (deploys attach evidence to a task)'}
              onClick={() =>
                run(async () => {
                  const r = await cicd.deploy(p.id, deployEnv[p.id] ?? 'UAT', props.taskId!);
                  if (r.pendingApproval && r.approval) {
                    setPendingApprovals((prev) => ({ ...prev, [p.id]: r.approval!.id }));
                  }
                })
              }
            >
              Deploy
            </button>
            <button disabled={busy} onClick={() => run(() => cicd.rollback(p.id))}>Rollback</button>
          </div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
            {p.stages.map((s) => (
              <span key={s.name} className="pill" title={(s.logs ?? []).join('\n')}>
                <span className={`status-dot ${stageClass(s.status)}`} style={{ display: 'inline-block', marginRight: 4 }} />
                {s.name}
              </span>
            ))}
          </div>
          {pendingApprovals[p.id] && (
            <div className="banner" style={{ marginTop: 6 }}>
              Parked on HUMAN_APPROVAL (ticket <b>{pendingApprovals[p.id].slice(0, 8)}</b>).
              Approve it in the Approvals tab, then{' '}
              <button disabled={busy} onClick={() => run(() => cicd.approve(p.id, pendingApprovals[p.id]))}>
                Resume deploy
              </button>
            </div>
          )}
          {p.deployments.length > 0 && (
            <ul className="ev-list" style={{ marginTop: 6 }}>
              {p.deployments.map((d) => (
                <li key={d.id}>
                  <span className="pill">{d.environment}</span>{' '}
                  <span className="muted">{d.status}</span>
                  {d.error && <span className="banner err" style={{ margin: '0 0 0 6px' }}>{d.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

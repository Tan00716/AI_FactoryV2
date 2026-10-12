import { useCallback, useEffect, useState } from 'react';
import { authHeaders, type CheckpointV2 } from '../api';
import { RunCheckpointsSection } from './RunCheckpointsView';

/** Typed client for orchestrator + model-router + runtime endpoints. */
export interface OrchestrateApi {
  decompose(input: {
    title: string;
    goal: string;
    kind: 'bugfix' | 'feature' | 'refactor' | 'research';
  }): Promise<DecompositionPlan>;
  nextAction(input: { status: string; evidence?: string[]; failures?: number }): Promise<{ action: string }>;
  route(input: {
    taskType: string;
    complexity: number;
    privacy?: string;
    needsVision?: boolean;
    needsReasoning?: boolean;
    usedPct?: number;
  }): Promise<RouteDecision>;
  account(): Promise<unknown>;
  runAgent(input: { agentId: string; taskId: string }): Promise<{ id: string; status: string }>;
  runStatus(id: string): Promise<RuntimeRun>;
  /** §28.3 — the run's captured checkpoints, first-capture order. */
  runCheckpoints(id: string): Promise<{ runId: string; checkpoints: CheckpointV2[] }>;
  /** §28.3 — the run's resume point; the server 404s when none captured. */
  runCheckpointLatest(id: string): Promise<CheckpointV2>;
}

export interface DecompositionPlan {
  goal: string;
  acceptanceCriteria: string[];
  risks: string[];
  subtasks: Array<{ title: string; kind: string; estimate: string }>;
  requiredSpecialists: string[];
  testStrategy: string;
  deploymentStrategy: string;
}

export interface RouteDecision {
  primary: { provider: string; model: string };
  fallback: { provider: string; model: string };
  emergency: { provider: string; model: string };
  reason: string[];
}

export interface RuntimeRun {
  id: string;
  status: string;
  outcome: string | null;
  steps: number;
  error: string | null;
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

export function createOrchestrateApi(base: string = DEFAULT_BASE): OrchestrateApi {
  return {
    decompose: (input) =>
      req(base, '/orchestrator/decompose', { method: 'POST', body: JSON.stringify(input) }),
    nextAction: (input) =>
      req(base, '/orchestrator/next-action', { method: 'POST', body: JSON.stringify(input) }),
    route: (input) =>
      req(base, '/router/route', { method: 'POST', body: JSON.stringify(input) }),
    account: () => req(base, '/router/account'),
    runAgent: (input) =>
      req(base, '/runtime/runs', { method: 'POST', body: JSON.stringify(input) }),
    runStatus: (id) => req(base, `/runtime/runs/${encodeURIComponent(id)}`),
    runCheckpoints: (id) =>
      req(base, `/runtime/runs/${encodeURIComponent(id)}/checkpoints`),
    runCheckpointLatest: (id) =>
      req(base, `/runtime/runs/${encodeURIComponent(id)}/checkpoints/latest`),
  };
}

export function OrchestratePanel({
  api,
  agentId,
  taskId,
}: {
  api?: OrchestrateApi;
  agentId: string | null;
  taskId: string | null;
}) {
  const [client] = useState<OrchestrateApi>(() => api ?? createOrchestrateApi());
  const [plan, setPlan] = useState<DecompositionPlan | null>(null);
  const [decision, setDecision] = useState<RouteDecision | null>(null);
  const [run, setRun] = useState<RuntimeRun | null>(null);
  const [ckpts, setCkpts] = useState<CheckpointV2[] | null>(null);
  const [ckptLatest, setCkptLatest] = useState<CheckpointV2 | null>(null);
  const [ckptErr, setCkptErr] = useState('');
  const [account, setAccount] = useState<unknown>(null);
  const [err, setErr] = useState('');
  const [kind, setKind] = useState<'bugfix' | 'feature' | 'refactor' | 'research'>('bugfix');

  // §28.3 — whenever a run is on display, load its checkpoints. An empty
  // list is the server's honest "nothing captured (yet)" and renders as
  // such; the /latest 404 for a known-but-unstepped run is not an error.
  const loadCheckpoints = useCallback(async (runId: string) => {
    setCkptErr('');
    try {
      const res = await client.runCheckpoints(runId);
      setCkpts(res.checkpoints ?? []);
    } catch (e) {
      setCkpts(null);
      setCkptErr((e as Error).message);
    }
    try {
      setCkptLatest(await client.runCheckpointLatest(runId));
    } catch {
      setCkptLatest(null);
    }
  }, [client]);

  useEffect(() => {
    if (run?.id) void loadCheckpoints(run.id);
  }, [run?.id, run?.status, loadCheckpoints]);

  const loadAccount = useCallback(async () => {
    try {
      setAccount(await client.account());
    } catch {
      /* account is informational only */
    }
  }, [client]);

  useEffect(() => {
    void loadAccount();
  }, [loadAccount]);

  const doDecompose = async () => {
    setErr('');
    try {
      setPlan(
        await client.decompose({
          title: 'Fix payment success but order remains Pending',
          goal: 'Successful payment must always reach the correct final order state',
          kind,
        }),
      );
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const doRoute = async () => {
    setErr('');
    try {
      setDecision(
        await client.route({
          taskType: 'coding',
          complexity: 4,
          privacy: 'internal',
          needsReasoning: true,
          usedPct: 30,
        }),
      );
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const doRun = async () => {
    setErr('');
    if (!agentId || !taskId) {
      setErr('Need an agent and a task — create them first (Board / Workforce tabs).');
      return;
    }
    try {
      const started = await client.runAgent({ agentId, taskId });
      // Poll a few times for the (fast, scripted) run to finish.
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 600));
        const s = await client.runStatus(started.id);
        setRun(s);
        if (s.status !== 'RUNNING') break;
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="panel">
      <h2>Orchestrate <span className="muted">§92–95 · §30 router · §24–27 runtime</span></h2>
      {err && <div className="banner err">{err}</div>}

      <section>
        <h3>Auto-decomposition (§95)</h3>
        <div className="row">
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            {(['bugfix', 'feature', 'refactor', 'research'] as const).map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
          <button onClick={doDecompose}>Decompose sample task</button>
        </div>
        {plan && (
          <div>
            <p><strong>Goal:</strong> {plan.goal}</p>
            <ol>
              {plan.subtasks.map((s, i) => (
                <li key={i}>{s.title} <span className="muted">({s.kind}, {s.estimate})</span></li>
              ))}
            </ol>
            <p className="muted">Specialists: {plan.requiredSpecialists.join(', ') || '—'}</p>
            <p className="muted">Test: {plan.testStrategy}</p>
          </div>
        )}
      </section>

      <section>
        <h3>Model router (§30)</h3>
        <div className="row">
          <button onClick={doRoute}>Route a coding task</button>
          {account != null && <span className="muted">account: {JSON.stringify(account).slice(0, 120)}…</span>}
        </div>
        {decision && (
          <ul className="plain">
            <li><span className="pill">primary</span> {decision.primary.provider}/{decision.primary.model}</li>
            <li><span className="pill">fallback</span> {decision.fallback.provider}/{decision.fallback.model}</li>
            <li><span className="pill">emergency</span> {decision.emergency.provider}/{decision.emergency.model}</li>
            <li className="muted">{decision.reason.join(' · ')}</li>
          </ul>
        )}
      </section>

      <section>
        <h3>Agent run (§24–27, scripted)</h3>
        <div className="row">
          <button onClick={doRun} disabled={!agentId || !taskId}>Run agent loop</button>
          <span className="muted">
            agent: {agentId?.slice(0, 8) ?? '—'} · task: {taskId?.slice(0, 8) ?? '—'}
          </span>
        </div>
        {run && (
          <p>
            <span className="pill">{run.status}</span> outcome: {run.outcome ?? '—'} ·
            steps: {run.steps} {run.error && <span className="banner err">{run.error}</span>}
          </p>
        )}
        {run && (
          <RunCheckpointsSection
            checkpoints={ckpts}
            latest={ckptLatest}
            error={ckptErr}
            onRefresh={() => void loadCheckpoints(run.id)}
          />
        )}
      </section>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { defaultApiBase, authHeaders, type CheckpointV2 } from '../api';
import { RunCheckpointsSection } from './RunCheckpointsView';
import { useLang } from '../i18n';

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

const DEFAULT_BASE = defaultApiBase();

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
  const { t } = useLang();
  /**
   * 模型路由账号状态：服务端返回结构化对象（profile.kind / usage.authenticated），
   * 这里渲染成一行人类可读状态，不再 JSON.stringify 裸 dump。
   * 形状对不上时返回 null（不渲染），不猜测。
   */
  const accountLabel = (a: unknown): string | null => {
    if (typeof a !== 'object' || a === null) return null;
    const o = a as { profile?: { kind?: unknown }; usage?: { authenticated?: unknown; usedPct?: unknown } };
    const kind = typeof o.profile?.kind === 'string' && o.profile.kind ? o.profile.kind : null;
    if (!kind) return null;
    if (o.usage?.authenticated === true) {
      const pct = typeof o.usage.usedPct === 'number' ? o.usage.usedPct : null;
      return pct !== null
        ? t('orchestrate.accountLoggedInUsage', { kind, pct })
        : t('orchestrate.accountLoggedIn', { kind });
    }
    return t('orchestrate.accountNotLoggedIn', { kind });
  };
  const [client] = useState<OrchestrateApi>(() => api ?? createOrchestrateApi());
  const [plan, setPlan] = useState<DecompositionPlan | null>(null);
  const [decision, setDecision] = useState<RouteDecision | null>(null);
  const [run, setRun] = useState<RuntimeRun | null>(null);
  const [ckpts, setCkpts] = useState<CheckpointV2[] | null>(null);
  const [ckptLatest, setCkptLatest] = useState<CheckpointV2 | null>(null);
  const [ckptErr, setCkptErr] = useState('');
  const [account, setAccount] = useState<unknown>(null);
  const [err, setErr] = useState('');
  /** 正在进行的动作（decompose/route/run）—— 期间对应按钮禁用防重提交。 */
  const [busy, setBusy] = useState<'' | 'decompose' | 'route' | 'run'>('');
  // QA-R1: 连击防护——state 更新异步，同 tick 连击会绕过 if (busy)。
  const busyRef = useRef(false);
  const takeBusy = (slot: 'decompose' | 'route' | 'run') => {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(slot); return true;
  };
  const releaseBusy = () => { busyRef.current = false; setBusy(''); };
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
    if (!takeBusy('decompose')) return;
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
    } finally {
      releaseBusy();
    }
  };

  const doRoute = async () => {
    if (!takeBusy('route')) return;
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
    } finally {
      releaseBusy();
    }
  };

  const doRun = async () => {
    if (!takeBusy('run')) return;
    setErr('');
    if (!agentId || !taskId) {
      setErr(t('orchestrate.needAgentTask'));
      releaseBusy();
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
    } finally {
      releaseBusy();
    }
  };

  return (
    <div className="panel">
      <h2>{t('orchestrate.title')} <span className="muted">§92–95 · §30 router · §24–27 runtime</span></h2>
      {err && <div className="banner err">{err}</div>}

      <section>
        <h3>{t('orchestrate.autoDecomp')}</h3>
        <div className="row">
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            {(['bugfix', 'feature', 'refactor', 'research'] as const).map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
          <button onClick={doDecompose} disabled={busy !== ''}>{busy === 'decompose' ? t('orchestrate.decomposing') : t('orchestrate.decompose')}</button>
        </div>
        {plan && (
          <div>
            <p><strong>{t('orchestrate.goal')}</strong> {plan.goal}</p>
            <ol>
              {plan.subtasks.map((s, i) => (
                <li key={i}>{s.title} <span className="muted">({s.kind}, {s.estimate})</span></li>
              ))}
            </ol>
            <p className="muted">{t('orchestrate.specialists', { list: plan.requiredSpecialists.join(', ') || '—' })}</p>
            <p className="muted">{t('orchestrate.test', { strategy: plan.testStrategy })}</p>
          </div>
        )}
      </section>

      <section>
        <h3>{t('orchestrate.router')}</h3>
        <div className="row">
          <button onClick={doRoute} disabled={busy !== ''}>{busy === 'route' ? t('orchestrate.routing') : t('orchestrate.route')}</button>
          {accountLabel(account) != null && <span className="muted">{accountLabel(account)}</span>}
        </div>
        {decision && (
          <ul className="plain">
            <li><span className="pill">{t('orchestrate.primary')}</span> {decision.primary.provider}/{decision.primary.model}</li>
            <li><span className="pill">{t('orchestrate.fallback')}</span> {decision.fallback.provider}/{decision.fallback.model}</li>
            <li><span className="pill">{t('orchestrate.emergency')}</span> {decision.emergency.provider}/{decision.emergency.model}</li>
            <li className="muted">{decision.reason.join(' · ')}</li>
          </ul>
        )}
      </section>

      <section>
        <h3>{t('orchestrate.agentRun')}</h3>
        <div className="row">
          <button onClick={doRun} disabled={!agentId || !taskId || busy !== ''}>{busy === 'run' ? t('orchestrate.running') : t('orchestrate.runLoop')}</button>
          <span className="muted">
            {t('orchestrate.agentTask', { agent: agentId?.slice(0, 8) ?? '—', task: taskId?.slice(0, 8) ?? '—' })}
          </span>
        </div>
        {run && (
          <p>
            <span className="pill">{run.status}</span> {t('orchestrate.runStatus', { outcome: run.outcome ?? '—', steps: run.steps })} {run.error && <span className="banner err">{run.error}</span>}
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

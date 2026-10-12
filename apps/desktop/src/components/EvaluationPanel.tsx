import { useCallback, useEffect, useState } from 'react';
import { authHeaders } from '../api';

/** Typed client for the evaluation endpoints. */
export interface EvaluationApi {
  evaluate(input: Record<string, unknown>): Promise<{ evaluation: any }>;
  list(taskId?: string): Promise<{ evaluations: any[] }>;
  profiles(): Promise<{ profiles: any[] }>;
  profile(agentId: string): Promise<{ profile: any }>;
  propose(p: Record<string, unknown>): Promise<{ proposal: any }>;
  proposals(status?: string): Promise<{ proposals: any[] }>;
  approve(id: string, approver: string): Promise<{ proposal: any }>;
  reject(id: string, approver: string, reason?: string): Promise<{ proposal: any }>;
  apply(id: string): Promise<{ proposal: any }>;
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

export function createEvaluationApi(base: string = DEFAULT_BASE): EvaluationApi {
  return {
    evaluate: (input) => req(base, '/evaluations', { method: 'POST', body: JSON.stringify(input) }),
    list: (taskId) => req(base, taskId ? `/evaluations?taskId=${encodeURIComponent(taskId)}` : '/evaluations'),
    profiles: () => req(base, '/profiles'),
    profile: (agentId) => req(base, `/profiles/${encodeURIComponent(agentId)}`),
    propose: (p) => req(base, '/proposals', { method: 'POST', body: JSON.stringify(p) }),
    proposals: (status) => req(base, status ? `/proposals?status=${status}` : '/proposals'),
    approve: (id, approver) =>
      req(base, `/proposals/${encodeURIComponent(id)}/approve`, {
        method: 'POST',
        body: JSON.stringify({ approver }),
      }),
    reject: (id, approver, reason) =>
      req(base, `/proposals/${encodeURIComponent(id)}/reject`, {
        method: 'POST',
        body: JSON.stringify({ approver, reason }),
      }),
    apply: (id) => req(base, `/proposals/${encodeURIComponent(id)}/apply`, { method: 'POST' }),
  };
}

function verdictClass(v: string): string {
  if (v === 'EXCELLENT' || v === 'GOOD') return 'st-active';
  if (v === 'POOR') return 'st-failed';
  return 'st-working';
}

/**
 * Evaluation panel (§57–§58): run task evaluations, agent leaderboard,
 * and improvement proposals (APPLY requires approval — never silent).
 */
export function EvaluationPanel(props: { evaluation?: EvaluationApi; taskId?: string | null }) {
  const [api] = useState<EvaluationApi>(() => props.evaluation ?? createEvaluationApi());
  const [evaluations, setEvaluations] = useState<any[]>([]);
  const [profiles, setProfiles] = useState<any[]>([]);
  const [proposals, setProposals] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [eTaskId, setETaskId] = useState(props.taskId ?? 'task-demo-1');
  const [eAgentId, setEAgentId] = useState('agent-coder-01');
  const [pTitle, setPTitle] = useState('Raise retry budget for flaky e2e');

  const refresh = useCallback(async () => {
    try {
      const [ev, pf, pr] = await Promise.all([api.list(), api.profiles(), api.proposals()]);
      setEvaluations(ev.evaluations);
      setProfiles(pf.profiles);
      setProposals(pr.proposals);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);

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

  const doEvaluate = () =>
    run(() =>
      api.evaluate({
        taskId: eTaskId,
        agentId: eAgentId,
        summary: 'Demo task evaluation from the IDE panel',
        evidenceIds: [],
        success: true,
        tests: { passed: 42, total: 44 },
        regressions: 0,
        reviewRounds: 1,
        reviewRejections: 0,
        fixLoops: 1,
        durationMs: 60000,
        tokenUsage: 12000,
        toolCalls: 30,
        toolErrors: 1,
        falseCompletion: false,
        rollbacks: 0,
        humanEscalations: 0,
      }),
    );

  const doPropose = () =>
    run(() => api.propose({ kind: 'skill', title: pTitle, description: 'Demo improvement proposal', proposedBy: 'human' }));

  return (
    <div className="evaluation-panel">
      {error && <div className="banner err">{error}</div>}
      <h4 style={{ margin: '4px 0' }}>Evaluate a task <span className="muted">(§57)</span></h4>
      <div className="row" style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input value={eTaskId} onChange={(e) => setETaskId(e.target.value)} placeholder="taskId" />
        <input value={eAgentId} onChange={(e) => setEAgentId(e.target.value)} placeholder="agentId" />
        <button disabled={busy} onClick={doEvaluate}>Run evaluation</button>
      </div>
      <h4 style={{ margin: '4px 0' }}>Evaluations <span className="muted">({evaluations.length})</span></h4>
      <ul className="ev-list">
        {evaluations.slice(-8).reverse().map((e: any) => (
          <li key={e.evaluationId} style={{ marginBottom: 4 }}>
            <span className={`status-dot ${verdictClass(e.verdict)}`} style={{ display: 'inline-block', marginRight: 6 }} />
            <b>{e.taskId}</b> <span className="muted">{e.agentId}</span>{' '}
            <span className="pill">{e.verdict}</span>{' '}
            <span className="muted">score {e.score}</span>
          </li>
        ))}
      </ul>
      <h4 style={{ margin: '12px 0 4px' }}>Agent leaderboard</h4>
      <ul className="ev-list">
        {profiles.map((p: any) => (
          <li key={p.agentId} style={{ marginBottom: 4 }}>
            <b>{p.agentId}</b>{' '}
            <span className="muted">
              success {(p.successRate * 100).toFixed(0)}% · first-pass QA {(p.firstPassQaRate * 100).toFixed(0)}% ·
              avg fix loops {p.avgFixLoops?.toFixed(1)} · n={p.evaluationCount}
            </span>
          </li>
        ))}
      </ul>
      <h4 style={{ margin: '12px 0 4px' }}>Improvement proposals <span className="muted">(§58 — APPLY needs approval)</span></h4>
      <div className="row" style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input value={pTitle} onChange={(e) => setPTitle(e.target.value)} placeholder="proposal title" style={{ flex: 1 }} />
        <button disabled={busy} onClick={doPropose}>Propose</button>
      </div>
      <ul className="ev-list">
        {proposals.map((p: any) => (
          <li key={p.proposalId} style={{ marginBottom: 6 }}>
            <b>{p.title}</b> <span className="muted">{p.kind}</span>{' '}
            <span className="pill">{p.status}</span>
            <span style={{ marginLeft: 8 }}>
              <button disabled={busy} onClick={() => run(() => api.approve(p.proposalId, 'human'))}>Approve</button>{' '}
              <button disabled={busy} onClick={() => run(() => api.reject(p.proposalId, 'human'))}>Reject</button>{' '}
              <button disabled={busy} onClick={() => run(() => api.apply(p.proposalId))}>Apply</button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

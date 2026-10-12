import { useCallback, useEffect, useState } from 'react';
import { authHeaders } from '../api';

/**
 * Approvals panel — spec §45 (Tool Approval) + §69 (Approval System).
 * Props-based: pass a custom ApprovalsApi for tests; defaults to the local server.
 * The coordinator wires this into App.tsx (not touched here).
 */

export interface ApprovalItem {
  id: string;
  action: string;
  requestedBy: string;
  agentId: string;
  taskId: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  evidenceIds: string[];
  requiredApprover: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
  decision: '' | 'APPROVED' | 'REJECTED';
  decidedBy: string;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string | null;
}

export interface ActionEvaluation {
  level: 'AUTO' | 'AI_REVIEW_PLUS_POLICY' | 'HUMAN_APPROVAL' | 'BLOCKED';
  requiresApproval: boolean;
  reason: string;
}

export interface RequestApprovalInput {
  action: string;
  requestedBy?: string;
  agentId?: string;
  taskId?: string;
  riskLevel?: ApprovalItem['riskLevel'];
  evidenceIds?: string[];
  requiredApprover?: string;
  ttlMs?: number;
}

export interface ApprovalsApi {
  list(status?: ApprovalItem['status']): Promise<ApprovalItem[]>;
  get(id: string): Promise<ApprovalItem>;
  request(input: RequestApprovalInput): Promise<ApprovalItem>;
  decide(id: string, approved: boolean, decidedBy: string): Promise<{ approval: ApprovalItem }>;
  cancel(id: string, by?: string): Promise<{ approval: ApprovalItem }>;
  evaluate(action: string, riskLevel?: ApprovalItem['riskLevel']): Promise<ActionEvaluation>;
}

/** fetch client mirroring apps/desktop/src/api.ts `req`. */
export function createApprovalsApi(base = 'http://localhost:3100/api'): ApprovalsApi {
  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
    });
    const body = (await res.json()) as T;
    if (!res.ok) {
      const e = new Error(
        (body as { error?: string }).error ?? `HTTP ${res.status}`,
      ) as Error & { status: number };
      e.status = res.status;
      throw e;
    }
    return body;
  }
  const q = (status?: string) => (status ? `?status=${encodeURIComponent(status)}` : '');
  return {
    list: (status) => req<ApprovalItem[]>(`/approvals${q(status)}`),
    get: (id) => req<ApprovalItem>(`/approvals/${encodeURIComponent(id)}`),
    request: (input) => req<ApprovalItem>('/approvals', { method: 'POST', body: JSON.stringify(input) }),
    decide: (id, approved, decidedBy) =>
      req<{ approval: ApprovalItem }>(`/approvals/${encodeURIComponent(id)}/decision`, {
        method: 'POST',
        body: JSON.stringify({ approved, decidedBy }),
      }),
    cancel: (id, by) =>
      req<{ approval: ApprovalItem }>(`/approvals/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ by }),
      }),
    evaluate: (action, riskLevel) =>
      req<ActionEvaluation>('/approvals/evaluate', {
        method: 'POST',
        body: JSON.stringify({ action, riskLevel }),
      }),
  };
}

const RISK_CLASS: Record<ApprovalItem['riskLevel'], string> = {
  LOW: 'prio p3',
  MEDIUM: 'prio p2',
  HIGH: 'prio p1',
  CRITICAL: 'prio p0',
};

function fmtTs(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

export interface ApprovalsPanelProps {
  api?: ApprovalsApi;
  /** ms between refreshes; 0 disables polling. Default 5000. */
  pollMs?: number;
}

export function ApprovalsPanel({ api, pollMs = 5000 }: ApprovalsPanelProps) {
  const client = api ?? createApprovalsApi();
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [decidedBy, setDecidedBy] = useState('human');
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    client
      .list()
      .then(setItems)
      .catch((e: Error) => setError(e.message));
  }, [client]);

  useEffect(() => {
    refresh();
    if (!pollMs) return;
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  const act = (fn: () => Promise<unknown>) => {
    setError('');
    fn().then(refresh).catch((e: Error) => setError(e.message));
  };

  const pending = items.filter((a) => a.status === 'PENDING');
  const history = items.filter((a) => a.status !== 'PENDING');

  return (
    <div className="approvals">
      <div className="board-head">
        <h2>Approvals <span className="count">§45 · §69</span></h2>
        <label className="muted">
          Decided by{' '}
          <input
            value={decidedBy}
            onChange={(e) => setDecidedBy(e.target.value)}
            placeholder="human"
            style={{ width: 120 }}
          />
        </label>
      </div>
      {error && <div className="banner err">{error}</div>}

      <h4>Pending ({pending.length})</h4>
      {pending.length === 0 && <div className="muted">No pending approvals.</div>}
      {pending.map((a) => (
        <div key={a.id} className="card">
          <div className="card-title">
            <span className={RISK_CLASS[a.riskLevel]}>{a.riskLevel}</span>{' '}
            {a.action}
          </div>
          <div className="card-meta">
            <span>req: {a.requestedBy}{a.agentId ? ` · agent: ${a.agentId}` : ''}</span>
            <span>approver: {a.requiredApprover}</span>
          </div>
          {a.taskId && <div className="card-meta"><span>task: {a.taskId.slice(0, 8)}</span></div>}
          {a.evidenceIds.length > 0 && (
            <div className="card-meta">
              <span>evidence: {a.evidenceIds.map((e) => e.slice(0, 8)).join(', ')}</span>
            </div>
          )}
          <div className="card-meta"><span>expires: {fmtTs(a.expiresAt)}</span></div>
          <div className="btn-row" style={{ marginTop: 6 }}>
            <button onClick={() => act(() => client.decide(a.id, true, decidedBy || 'human'))}>
              Approve
            </button>
            <button onClick={() => act(() => client.decide(a.id, false, decidedBy || 'human'))}>
              Reject
            </button>
            <button onClick={() => act(() => client.cancel(a.id, decidedBy || 'human'))}>
              Cancel
            </button>
          </div>
        </div>
      ))}

      <h4>History ({history.length})</h4>
      {history.length === 0 && <div className="muted">No decided approvals yet.</div>}
      {history.map((a) => (
        <div key={a.id} className="act-row">
          <span className="pill">{a.status}</span>
          <b>{a.action}</b>
          <span className="muted">{a.riskLevel}</span>
          <span className="muted">
            {a.decision || '—'} by {a.decidedBy || '—'}
          </span>
          <span className="muted">{fmtTs(a.decidedAt ?? a.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}

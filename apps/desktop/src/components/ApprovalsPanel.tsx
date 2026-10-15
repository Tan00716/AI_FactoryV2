import { Component, useCallback, useEffect, useState } from 'react';
import { defaultApiBase, authHeaders } from '../api';

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
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED' | 'INVALIDATED';
  decision: '' | 'APPROVED' | 'REJECTED';
  decidedBy: string;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string | null;
}

/**
 * The server (`GET/POST /api/approvals*`) returns the manager's raw
 * `Approval` record (§23.3), which uses snake_case field names and has no
 * `agentId`/`evidenceIds` fields. Without a mapping the panel read
 * `a.evidenceIds.length` off `undefined` and crashed the whole React tree
 * (Batch 58-2 walkthrough: black screen on real data).
 */
interface RawApproval {
  approval_id: string;
  action: string;
  requester: string;
  task_id: string;
  risk_level: ApprovalItem['riskLevel'];
  required_approvers?: unknown;
  status: string;
  decision: '' | 'APPROVED' | 'REJECTED';
  decided_by: string;
  created_at: string;
  decided_at: string | null;
  deadline: string | null;
}

function toApprovalItem(raw: RawApproval): ApprovalItem {
  const approvers = Array.isArray(raw.required_approvers)
    ? raw.required_approvers.filter((e): e is string => typeof e === 'string')
    : [];
  return {
    id: raw.approval_id,
    action: raw.action,
    requestedBy: raw.requester,
    agentId: '',
    taskId: raw.task_id,
    riskLevel: raw.risk_level,
    // The server has no per-evidence id list (only evidence_manifest_hash);
    // default to [] so `evidenceIds.length` never throws.
    evidenceIds: [],
    requiredApprover: approvers.join(', '),
    status: (raw.status === 'INVALIDATED' ? 'INVALIDATED' : raw.status) as ApprovalItem['status'],
    decision: raw.decision,
    decidedBy: raw.decided_by,
    createdAt: raw.created_at,
    decidedAt: raw.decided_at,
    expiresAt: raw.deadline,
  };
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
export function createApprovalsApi(base = defaultApiBase()): ApprovalsApi {
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
    list: async (status) => (await req<RawApproval[]>(`/approvals${q(status)}`)).map(toApprovalItem),
    get: async (id) => toApprovalItem(await req<RawApproval>(`/approvals/${encodeURIComponent(id)}`)),
    request: async (input) => toApprovalItem(await req<RawApproval>('/approvals', { method: 'POST', body: JSON.stringify(input) })),
    decide: async (id, approved, decidedBy) => {
      const r = await req<{ approval: RawApproval }>(`/approvals/${encodeURIComponent(id)}/decision`, {
        method: 'POST',
        body: JSON.stringify({ approved, decidedBy }),
      });
      return { approval: toApprovalItem(r.approval) };
    },
    cancel: async (id, by) => {
      const r = await req<{ approval: RawApproval }>(`/approvals/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ by }),
      });
      return { approval: toApprovalItem(r.approval) };
    },
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

export function ApprovalsPanelInner({ api, pollMs = 5000 }: ApprovalsPanelProps) {
  const client = api ?? createApprovalsApi();
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [decidedBy, setDecidedBy] = useState('human');
  const [error, setError] = useState('');
  /** 正在提交的审批 id —— 提交期间整行按钮禁用，防止连击重复提交。 */
  const [acting, setActing] = useState<Record<string, boolean>>({});

  const refresh = useCallback(() => {
    client
      .list()
      .then((items) => {
        setItems(items);
        setError('');
      })
      .catch((e: Error) => setError(e.message));
  }, [client]);

  useEffect(() => {
    refresh();
    if (!pollMs) return;
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  const act = (id: string, fn: () => Promise<unknown>) => {
    if (acting[id]) return;
    setError('');
    setActing((p) => ({ ...p, [id]: true }));
    fn()
      .then(refresh)
      .catch((e: Error) => setError(e.message))
      .finally(() => setActing((p) => ({ ...p, [id]: false })));
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
          {(a.evidenceIds ?? []).length > 0 && (
            <div className="card-meta">
              <span>evidence: {(a.evidenceIds ?? []).map((e) => e.slice(0, 8)).join(', ')}</span>
            </div>
          )}
          <div className="card-meta"><span>expires: {fmtTs(a.expiresAt)}</span></div>
          <div className="btn-row" style={{ marginTop: 6 }}>
            <button disabled={!!acting[a.id]} onClick={() => act(a.id, () => client.decide(a.id, true, decidedBy || 'human'))}>
              {acting[a.id] ? '处理中…' : 'Approve'}
            </button>
            <button disabled={!!acting[a.id]} onClick={() => act(a.id, () => client.decide(a.id, false, decidedBy || 'human'))}>
              {acting[a.id] ? '处理中…' : 'Reject'}
            </button>
            <button disabled={!!acting[a.id]} onClick={() => act(a.id, () => client.cancel(a.id, decidedBy || 'human'))}>
              {acting[a.id] ? '处理中…' : 'Cancel'}
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

/**
 * Error boundary: a render failure inside the approvals panel must not
 * unmount the whole React tree (Batch 58-2: real server data once caused a
 * full black screen here). The panel degrades to a visible error card.
 */
class ApprovalsErrorBoundary extends Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error('[ApprovalsPanel] render failure contained', error);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="approvals">
          <div className="banner err">
            审批面板渲染失败（{this.state.error.message}），其余面板未受影响。
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function ApprovalsPanel(props: ApprovalsPanelProps) {
  return (
    <ApprovalsErrorBoundary>
      <ApprovalsPanelInner {...props} />
    </ApprovalsErrorBoundary>
  );
}

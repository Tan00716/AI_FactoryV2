import { useCallback, useEffect, useState } from 'react';
import { OrgNode as AgentOrgNode } from '../api';
import { OrgGraph } from './OrgGraph';

/** Typed client for the workforce endpoints (§14, §18–§20, §59). */
export interface WorkforceApi {
  createEmployee(input: {
    jobTitle: string;
    specialty?: string;
    parentId?: string;
    requestedBy?: string;
  }): Promise<unknown>;
  propose(input: {
    kind: 'create' | 'modify' | 'retire';
    target: string;
    rationale: string;
    requestedBy?: string;
  }): Promise<{ status: string; reason: string; [k: string]: unknown }>;
  squads(): Promise<{ active: unknown[]; archived: unknown[] }>;
  assembleSquad(taskId: string, candidateIds?: string[]): Promise<unknown>;
  archiveSquad(taskId: string): Promise<unknown>;
  org(): Promise<{ graph: { nodes: OrgNode[] }; validation: { ok: boolean; errors: string[] } }>;
  addOrgNode(input: { title: string; parentId?: string; agentId?: string }): Promise<unknown>;
}

export interface OrgNode {
  id: string;
  agentId: string | null;
  title: string;
  parentId: string | null;
  status: string;
}

const DEFAULT_BASE = 'http://localhost:3100/api';

async function req<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as T;
  if (!res.ok) {
    const err = body as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return body;
}

export function createWorkforceApi(base: string = DEFAULT_BASE): WorkforceApi {
  return {
    createEmployee: (input) =>
      req(base, '/workforce/employees', { method: 'POST', body: JSON.stringify(input) }),
    propose: (input) =>
      req(base, '/workforce/proposals', { method: 'POST', body: JSON.stringify(input) }),
    squads: () => req(base, '/workforce/squads'),
    assembleSquad: (taskId, candidateIds) =>
      req(base, '/workforce/squads', {
        method: 'POST',
        body: JSON.stringify({ taskId, candidateIds }),
      }),
    archiveSquad: (taskId) =>
      req(base, `/workforce/squads/${encodeURIComponent(taskId)}/archive`, { method: 'POST' }),
    org: () => req(base, '/workforce/org'),
    addOrgNode: (input) =>
      req(base, '/workforce/org/nodes', { method: 'POST', body: JSON.stringify(input) }),
  };
}

export function WorkforcePanel({ api, agentTree, onSelectAgent }: {
  api?: WorkforceApi;
  /** §84 agent 树（来自 /api/org），用于"图谱"模式。 */
  agentTree?: AgentOrgNode[];
  /** 点击 Agent → 打开 §87 员工详情。 */
  onSelectAgent?: (agentId: string) => void;
}) {
  const [client] = useState<WorkforceApi>(() => api ?? createWorkforceApi());
  const [view, setView] = useState<'list' | 'graph'>('list');
  const [nodes, setNodes] = useState<OrgNode[]>([]);
  const [validation, setValidation] = useState<{ ok: boolean; errors: string[] }>({ ok: true, errors: [] });
  const [squads, setSquads] = useState<{ active: unknown[]; archived: unknown[] }>({ active: [], archived: [] });
  const [jobTitle, setJobTitle] = useState('PostgreSQL Concurrency Specialist');
  const [specialty, setSpecialty] = useState('PostgreSQL');
  const [taskId, setTaskId] = useState('TASK-1042');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [o, s] = await Promise.all([client.org(), client.squads()]);
      setNodes(o.graph.nodes);
      setValidation(o.validation);
      setSquads(s);
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hire = async () => {
    setMsg('');
    setErr('');
    try {
      await client.createEmployee({ jobTitle, specialty, requestedBy: 'human' });
      setMsg(`Hired "${jobTitle}"`);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const assemble = async () => {
    setMsg('');
    setErr('');
    try {
      await client.assembleSquad(taskId);
      setMsg(`Squad assembled for ${taskId}`);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const archive = async (id: string) => {
    try {
      await client.archiveSquad(id);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head-row">
        <h2 style={{ margin: 0 }}>Workforce <span className="muted">§14 org · §18–19 factory · §20 squads · §59 proposals</span></h2>
        <span className="view-toggle">
          <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>列表</button>
          <button className={view === 'graph' ? 'active' : ''} onClick={() => setView('graph')}>图谱 §84</button>
        </span>
      </div>
      {err && <div className="banner err">{err}</div>}
      {msg && <div className="banner ok">{msg}</div>}

      {view === 'graph' ? (
        <OrgGraph org={agentTree ?? []} onSelectAgent={onSelectAgent} />
      ) : (
      <>
      <section>
        <h3>Organization graph {!validation.ok && <span className="pill warn">invalid</span>}</h3>
        {validation.errors.map((e) => (
          <div key={e} className="banner err">{e}</div>
        ))}
        <ul className="plain">
          {nodes.map((n) => (
            <li
              key={n.id}
              className={n.agentId && onSelectAgent ? 'clickable' : ''}
              onClick={() => { if (n.agentId && onSelectAgent) onSelectAgent(n.agentId); }}
              title={n.agentId ? '查看员工档案 §87' : undefined}
            >
              <span className="pill">{n.status}</span> {n.title}
              {n.parentId && <span className="muted"> ← {n.parentId.slice(0, 8)}</span>}
            </li>
          ))}
          {nodes.length === 0 && <li className="muted">No org nodes yet — add the root below.</li>}
        </ul>
        <AddNodeForm
          nodes={nodes}
          onAdd={async (title, parentId) => {
            await client.addOrgNode({ title, parentId });
            await refresh();
          }}
        />
      </section>

      <section>
        <h3>Hire AI employee (§18)</h3>
        <div className="row">
          <input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="Job title" />
          <input value={specialty} onChange={(e) => setSpecialty(e.target.value)} placeholder="Specialty" />
          <button onClick={hire}>Create</button>
        </div>
        <p className="muted">Governance (§19): max 6 children, depth 3, privileged roles denied.</p>
      </section>

      <section>
        <h3>Task squads (§20)</h3>
        <div className="row">
          <input value={taskId} onChange={(e) => setTaskId(e.target.value)} placeholder="Task ID" />
          <button onClick={assemble}>Assemble squad</button>
        </div>
        <ul className="plain">
          {(squads.active as Array<{ id: string; taskId: string; memberIds: string[] }>).map((s) => (
            <li key={s.id}>
              <span className="pill">active</span> {s.taskId} — {s.memberIds.length} members
              <button className="link" onClick={() => archive(s.taskId)}>archive</button>
            </li>
          ))}
        </ul>
      </section>
      </>
      )}
    </div>
  );
}

function AddNodeForm({
  nodes,
  onAdd,
}: {
  nodes: OrgNode[];
  onAdd: (title: string, parentId?: string) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [parentId, setParentId] = useState('');
  return (
    <div className="row">
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Node title (e.g. Tech Lead)" />
      <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
        <option value="">(root)</option>
        {nodes.map((n) => (
          <option key={n.id} value={n.id}>{n.title}</option>
        ))}
      </select>
      <button
        onClick={() => {
          if (title.trim()) void onAdd(title.trim(), parentId || undefined).then(() => setTitle(''));
        }}
      >
        Add node
      </button>
    </div>
  );
}

/** Typed client for the local @ai-factory/server API. */
const BASE = 'http://localhost:3100/api';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as T;
  if (!res.ok) {
    const err = body as { error?: string; missing?: string[] };
    const e = new Error(err.error ?? `HTTP ${res.status}`) as Error & {
      missing?: string[];
      status: number;
    };
    e.missing = err.missing;
    e.status = res.status;
    throw e;
  }
  return body;
}

export interface Project { id: string; name: string; description: string; path: string }
export interface BoardCard {
  id: string; title: string; priority: string; status: string; risk: string;
  agent: string | null; agentCount: number; updatedAt: string;
}
export interface EvidenceItem {
  id: string; type: string; title: string; payload: Record<string, unknown>;
  status: 'DRAFT' | 'SEALED'; createdBy: string; createdAt: string;
}
export interface NextState { to: string; note: string; requires: string[] }
export interface TaskDetail {
  id: string; title: string; goal: string; description: string; priority: string;
  status: string; risk: string; currentAgentId: string | null;
  assignedAgentIds: string[]; subtaskIds: string[]; dependencies: unknown[];
  acceptanceCriteria: string[]; createdAt: string; updatedAt: string;
  completedAt: string | null; evidence: EvidenceItem[]; nextStates: NextState[];
}
export interface OrgNode {
  agent: { id: string; displayName: string; jobTitle: string; status: string; autonomyLevel: number };
  children: OrgNode[];
}
export interface AuditRecord {
  id: string; ts: string; actor: string; action: string;
  entityType: string; entityId: string; details: Record<string, unknown>;
}

export const api = {
  health: () => req<{ ok: boolean }>('/health'),
  projects: () => req<Project[]>('/projects'),
  board: (projectId: string) =>
    req<{ projectId: string; columns: Record<string, BoardCard[]> }>(
      `/board?projectId=${encodeURIComponent(projectId)}`,
    ),
  createTask: (input: { projectId: string; title: string; goal?: string; priority?: string }) =>
    req<TaskDetail>('/tasks', { method: 'POST', body: JSON.stringify(input) }),
  task: (id: string) => req<TaskDetail>(`/tasks/${id}`),
  transition: (id: string, to: string, actor = 'human') =>
    req<{ ok: boolean; from: string; to: string; missing?: string[] }>(
      `/tasks/${id}/transition`, { method: 'POST', body: JSON.stringify({ to, actor }) },
    ),
  attachEvidence: (id: string, input: { type: string; title: string; payload?: object }) =>
    req<EvidenceItem>(`/tasks/${id}/evidence`, { method: 'POST', body: JSON.stringify(input) }),
  agents: () => req<unknown[]>('/agents'),
  org: () => req<OrgNode[]>('/org'),
  audit: (limit = 100) => req<AuditRecord[]>(`/audit?limit=${limit}`),
};

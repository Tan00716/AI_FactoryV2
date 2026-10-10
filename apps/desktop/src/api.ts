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
/** §85 full board: task rows come from GET /api/tasks (grouped client-side). */
export interface TaskSummary {
  id: string; projectId: string; parentTaskId: string | null; title: string;
  priority: string; status: string; risk: string;
  currentAgentId: string | null; assignedAgentIds: string[];
  createdAt: string; updatedAt: string;
}
/** §87 — full AI employee record from GET /api/agents. */
export interface AgentFull {
  id: string; name: string; displayName: string; jobTitle: string; department: string;
  parentAgentId: string | null; mission: string; instructions: string;
  skills: string[]; rules: string[]; model: string; reasoningLevel: string;
  tools: string[]; permissions: string[]; autonomyLevel: number;
  status: string; version: number; createdAt: string; updatedAt: string;
}
export interface DeploymentRecord {
  id: string; taskId?: string; environment?: string; status?: string;
  createdAt?: string; [k: string]: unknown;
}
export interface MemoryEntry {
  id: string; scope?: string; scopeId?: string; type?: string;
  title?: string; content?: string; confidence?: number; updatedAt?: string;
  [k: string]: unknown;
}
export interface FileEntry { name: string; path: string; type: 'dir' | 'file' }
export interface EvidenceItem {
  id: string; type: string; title: string; payload: Record<string, unknown>;
  status: 'DRAFT' | 'SEALED'; createdBy: string; createdAt: string;
}
export interface NextState { to: string; note: string; requires: string[] }
export interface TaskDetail {
  id: string; title: string; goal: string; description: string; priority: string;
  status: string; risk: string; currentAgentId: string | null;
  assignedAgentIds: string[]; subtaskIds: string[]; dependencies: unknown[];
  acceptanceCriteria: string[]; constraints: string[]; workspace?: string;
  createdAt: string; updatedAt: string;
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
export interface DashboardStat {
  key: string; label: string; value: number | string | null;
  unit?: string; source: string; note?: string;
}
export interface DashboardStats {
  generatedAt: string;
  status: Record<string, DashboardStat>;
  metrics: Record<string, DashboardStat>;
}
/** §24/§29.1 三轴 factory 状态（control/health/capacity + ACK 门控显示）。 */
export interface FactoryStatus {
  control: string;
  health: string;
  capacity: string;
  control_epoch: number;
  pending_acks: string[];
  display: string;
  updated_at: string;
}
/** §30 watchdog 自身健康。 */
export interface WatchdogSelf {
  selfHealth: 'ok' | 'degraded';
}
/** §27 quota bucket 用量视图（unknown 时字段缺失，不编造百分比）。 */
export interface QuotaBucketView {
  providerAccountId: string;
  workspaceId: string;
  limitBucket: string;
  used?: number;
  limit?: number;
  resetAt?: string;
  authState: string;
  freshness: string;
  collectedAt: string;
}
/** §33 incident 列表项。 */
export interface IncidentSummary {
  id: string;
  title: string;
  severity: string;
  status: string;
  detectedAt: string;
  updatedAt: string;
}

export const api = {
  health: () => req<{ ok: boolean }>('/health'),
  projects: () => req<Project[]>('/projects'),
  board: (projectId: string) =>
    req<{ projectId: string; columns: Record<string, BoardCard[]> }>(
      `/board?projectId=${encodeURIComponent(projectId)}`,
    ),
  /** §85 full-board source: all tasks of a project, grouped client-side. */
  tasks: (projectId?: string) =>
    req<TaskSummary[]>(`/tasks${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  createTask: (input: { projectId: string; title: string; goal?: string; priority?: string }) =>
    req<TaskDetail>('/tasks', { method: 'POST', body: JSON.stringify(input) }),
  task: (id: string) => req<TaskDetail>(`/tasks/${id}`),
  transition: (id: string, to: string, actor = 'human') =>
    req<{ ok: boolean; from: string; to: string; missing?: string[] }>(
      `/tasks/${id}/transition`, { method: 'POST', body: JSON.stringify({ to, actor }) },
    ),
  attachEvidence: (id: string, input: { type: string; title: string; payload?: object }) =>
    req<EvidenceItem>(`/tasks/${id}/evidence`, { method: 'POST', body: JSON.stringify(input) }),
  agents: () => req<AgentFull[]>('/agents'),
  org: () => req<OrgNode[]>('/org'),
  audit: (limit = 100) => req<AuditRecord[]>(`/audit?limit=${limit}`),
  deployments: () => req<DeploymentRecord[]>('/deployments'),
  memoryEntries: (scope: string, scopeId: string) =>
    req<MemoryEntry[]>(`/memory?scope=${encodeURIComponent(scope)}&scopeId=${encodeURIComponent(scopeId)}`),
  files: (root: string) =>
    req<{ root: string; entries: FileEntry[] }>(`/files?root=${encodeURIComponent(root)}`),
  policyEffective: () => req<unknown>('/policy/effective'),
  mcpServers: () => req<{ servers?: Array<{ name: string; status?: string; [k: string]: unknown }> } | Array<{ name: string }>>('/mcp'),
  evaluations: (taskId: string) =>
    req<{ evaluations: Array<{ evaluationId: string; verdict: string; score?: number; createdAt?: string; [k: string]: unknown }> }>(
      `/evaluations?taskId=${encodeURIComponent(taskId)}`,
    ),
  /** §87 评估页签：agent 能力画像（无记录时 404 → 暂无）。 */
  agentProfile: (agentId: string) =>
    req<{ profile: { agentId: string; [k: string]: unknown } }>(
      `/profiles/${encodeURIComponent(agentId)}`,
    ),
  exportProject: (id: string) =>
    req<{ projectId: string; exportedAt: string; format: string; files: Record<string, string> }>(
      `/projects/${encodeURIComponent(id)}/export`,
    ),
  importProject: (id: string, files: Record<string, string>) =>
    req<{ ok: boolean; targetDir?: string; written?: string[]; issues?: { file: string; message: string }[] }>(
      `/projects/${encodeURIComponent(id)}/import`,
      { method: 'POST', body: JSON.stringify({ files }) },
    ),
  stats: () => req<DashboardStats>('/stats'),
  /** §29.1 全局 Factory Strip：三轴状态（ACK 门控显示在 display）。 */
  factoryStatus: () => req<FactoryStatus>('/factory/status'),
  /** §30 watchdog 自身健康。 */
  watchdogSelf: () => req<WatchdogSelf>('/watchdog/self'),
  /** §27 quota buckets 用量（unknown 字段保持缺失）。 */
  quotaBuckets: () => req<{ buckets: QuotaBucketView[] }>('/quota/buckets'),
  /** §33 incidents 列表。 */
  incidents: () => req<{ incidents: IncidentSummary[] }>('/incidents'),
};

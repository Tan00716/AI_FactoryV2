/** Typed client for the local @ai-factory/server API. */
const BASE = 'http://localhost:3100/api';

/**
 * Operator API token for a server started with FACTORY_API_TOKEN
 * (checklist B). Stored by the operator in localStorage under
 * 'factory.apiToken'; when absent, no Authorization header is sent and the
 * default token-less local server works unchanged.
 */
function apiToken(): string | null {
  try {
    const t = localStorage.getItem('factory.apiToken');
    return t && t.trim() ? t.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Authorization header for the operator API token, or an empty object when
 * no token is stored. Shared by the panel-local `req` copies (GitPanel,
 * QaPanel, TerminalPanel, …) so every request to the local server carries
 * the token once FACTORY_API_TOKEN is enabled server-side. Spread it into a
 * headers literal — with no token it contributes nothing, so token-less
 * behavior is unchanged.
 */
export function authHeaders(): Record<string, string> {
  const token = apiToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json()) as T;
  if (!res.ok) {
    const err = body as { error?: string; missing?: string[]; problems?: string[] };
    const e = new Error(err.error ?? `HTTP ${res.status}`) as Error & {
      missing?: string[];
      problems?: string[];
      status: number;
    };
    e.missing = err.missing;
    e.problems = err.problems;
    e.status = res.status;
    throw e;
  }
  return body;
}

/** Raw-text sibling of `req` (same auth treatment) for non-JSON bodies
 *  such as the Final Report Markdown rendering. */
async function reqText(path: string, init?: RequestInit): Promise<string> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch { /* non-JSON error body — keep the status message */ }
    const e = new Error(message) as Error & { status: number };
    e.status = res.status;
    throw e;
  }
  return text;
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
/** §39 Final Report（服务端从 DB 真实记录汇编；无记录的段 available:false + note）。 */
export interface FinalReportTaskItem {
  id: string; title: string; status: string; priority: string; risk: string;
  createdAt: string; updatedAt: string; completedAt: string | null;
}
export interface FinalReportEvidenceItem {
  id: string; taskId: string; type: string; title: string; status: string;
  requirementVersion: string | null; createdAt: string; sealedAt: string | null;
}
export interface FinalReportApprovalItem {
  approvalId: string; taskId: string; action: string; status: string;
  decision: string; decidedBy: string; decisionReason: string;
  createdAt: string; decidedAt: string | null;
}
export interface FinalReportWaiverItem {
  grantId: string; taskId: string; action: string; grantedBy: string;
  failureReason: string; ts: string;
}
export interface FinalReport {
  artifactType: 'FINAL_REPORT';
  title: string;
  summary: string;
  outcomes: string[];
  metrics: Record<string, number | string | null>;
  followUps: string[];
  extensions: {
    note: string;
    project: {
      id: string; name: string; description: string; path: string;
      createdAt: string; updatedAt: string;
    };
    tasks: {
      available: boolean; note?: string; total: number;
      byStatus: Record<string, number>; terminal: number; open: number;
      items: FinalReportTaskItem[];
    };
    evidence: {
      available: boolean; note?: string; total: number;
      byType: Record<string, number>; byStatus: Record<string, number>;
      sealed: number; withRequirementPin: number; withoutRequirementPin: number;
      items: FinalReportEvidenceItem[];
    };
    approvals: {
      available: boolean; note?: string; total: number;
      decisions: { approved: number; rejected: number; pending: number };
      byStatus: Record<string, number>;
      items: FinalReportApprovalItem[];
      waived: { count: number; note?: string; items: FinalReportWaiverItem[] };
    };
    progress: {
      taskCompletionPercent: number | null;
      aocr: {
        ratePercent: number | null; authorizedTotal: number;
        authorizedCompleted: number; note?: string;
      };
      planBased: { available: false; note: string };
    };
    auditSummary: {
      available: boolean; note?: string; totalEvents: number;
      byAction: Record<string, number>;
      recent: Array<{
        ts: string; actor: string; action: string;
        entityType: string; entityId: string;
      }>;
    };
    openItems: {
      openTasks: FinalReportTaskItem[];
      pendingApprovals: FinalReportApprovalItem[];
      rejectedApprovals: FinalReportApprovalItem[];
      draftEvidence: FinalReportEvidenceItem[];
      total: number;
    };
    sectionStatus: Record<string, 'ok' | 'no-data'>;
  };
  meta: {
    generatedAt: string;
    dataThrough: string | null;
    contentHash: string;
    hashAlgorithm: 'sha256';
  };
}
/** 备份列表项（GET /api/backups 的 manifest 摘要）。 */
export interface BackupSummary {
  backupId: string;
  kind: 'manual' | 'pre-restore';
  createdAt: string;
  appVersion: string;
  tables: Record<string, number>;
  totalRows: number;
  bytes: number;
}
/** 已排队待重启生效的恢复（GET /api/backups 的 pendingRestore）。 */
export interface PendingRestore {
  backupId: string;
  stagedAt: string;
  preRestoreBackupId: string;
  restartRequired: true;
}
/** POST /api/restore 成功响应：仅排队，重启服务端才生效。 */
export interface RestoreStageResult {
  ok: boolean;
  restartRequired: boolean;
  backupId: string;
  preRestoreBackupId: string;
  message: string;
}
/** §28.3 checkpoint（runtime CheckpointV2 的线上形状；capturedAt 为 epoch ms）。 */
export interface CheckpointV2 {
  schemaVersion: '2.0';
  runId: string;
  stepPosition: number;
  workflowVersion: string;
  taskVersion: string;
  contextManifestHash: string;
  modelSessionRef?: string;
  workspaceSnapshotHash?: string;
  gitBase?: string;
  gitCandidate?: string;
  activeTools: string[];
  activeProcesses: number[];
  leaseGeneration: number;
  fencingToken: number;
  pendingApprovals: string[];
  budgetUsage: Record<string, number>;
  pendingSideEffects: string[];
  resumePreconditions: string[];
  capturedAt: number;
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
  /** §39 项目 Final Report（JSON 汇编结果）。 */
  finalReport: (id: string) =>
    req<{ report: FinalReport }>(`/projects/${encodeURIComponent(id)}/final-report`),
  /** §39 Final Report 的 Markdown 渲染（与 JSON 同一汇编对象、同一 contentHash）。 */
  finalReportMarkdown: (id: string) =>
    reqText(`/projects/${encodeURIComponent(id)}/final-report?format=md`),
  /** 备份列表 + 待生效恢复状态。 */
  backups: () =>
    req<{ backups: BackupSummary[]; pendingRestore: PendingRestore | null }>('/backups'),
  /** 创建一次数据库备份（VACUUM INTO 快照 + manifest）。 */
  createBackup: () =>
    req<{ backupId: string; kind: string; dir: string }>(
      '/backup', { method: 'POST', body: JSON.stringify({}) },
    ),
  /** 排队恢复：服务端校验备份后 staged，重启服务端才生效（restartRequired）。 */
  stageRestore: (backupId: string) =>
    req<RestoreStageResult>(
      '/restore', { method: 'POST', body: JSON.stringify({ backupId }) },
    ),
  /** §28.3 某 run 的全部 checkpoint（按首次捕获顺序）。 */
  runCheckpoints: (runId: string) =>
    req<{ runId: string; checkpoints: CheckpointV2[] }>(
      `/runtime/runs/${encodeURIComponent(runId)}/checkpoints`,
    ),
  /** §28.3 某 run 的恢复点（最高步位 checkpoint）；无捕获时服务端 404。 */
  runCheckpointLatest: (runId: string) =>
    req<CheckpointV2>(`/runtime/runs/${encodeURIComponent(runId)}/checkpoints/latest`),
};

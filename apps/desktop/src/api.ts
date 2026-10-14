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
/** §17.2 任务授权状态（Task.authorizationStatus 的取值）。旧任务在
 *  服务端读作 AUTHORIZED，但列表行可能不带该字段——调用方以 ?? 归一。 */
export type TaskAuthorizationStatus =
  | 'DRAFT' | 'WAITING_HUMAN_DISPATCH' | 'AUTHORIZED' | 'REVOKED' | 'EXPIRED';

/** §17.2 Dispatch 页签用的任务行：GET /api/tasks 返回全量任务对象，
 *  授权轴、创建者、项目与时间戳都在列表里，本面不逐行补拉详情。 */
export interface DispatchTask {
  id: string; projectId: string; title: string; priority: string;
  status: string; creator: string;
  authorizationStatus?: TaskAuthorizationStatus;
  currentAgentId: string | null; assignedAgentIds: string[];
  createdAt: string; updatedAt: string;
}

/** 派发流动作响应（五个 POST /api/tasks/:id/<action> 同一形状）：
 *  from/to 是本次授权状态迁移，task 是动作后的服务端任务对象。 */
export interface DispatchActionResult {
  from: TaskAuthorizationStatus;
  to: TaskAuthorizationStatus;
  task: DispatchTask;
}

/** Batch 18 预授权票（GET /api/authorization-tickets，服务端 Batch 18-1）。
 *  票面语义的宽松只读形状：本面只呈现服务端实际给出的字段，缺失即
 *  显示「—」；端点未就绪（404）由面板如实显示未就绪，不编造票面。 */
export interface DispatchTicket {
  id: string;
  policyRuleId?: string;
  scope?: unknown;
  status?: string;
  issuedBy?: string;
  issuedAt?: string;
  createdAt?: string;
  expiresAt?: string | null;
  consumedByTaskId?: string | null;
  consumedAt?: string | null;
  [k: string]: unknown;
}

/** §29.3 管理页签用：GET /api/approvals?status=PENDING 的行（服务端 §23.3
 *  Approval 的本面子集；缺失字段不编造）。 */
export interface QueueApproval {
  approval_id: string;
  action?: string;
  task_id?: string;
  status?: string;
  requester?: string;
  required_approvers?: string[];
  risk_level?: string;
  deadline?: string | null;
  [k: string]: unknown;
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
/** GET /api/audit/verify 的裸返回形状（服务端直接返回 audit.verify()，§32）。
 *  brokenAt 仅 ok=false 时出现，是追加序（ORDER BY ts, rowid）链的下标，
 *  不是 API 的 newest-first 序。 */
export interface AuditChainVerification {
  ok: boolean; verifiedCount: number; legacyCount: number; brokenAt?: number;
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
/** 备份列表项（GET /api/backups 的 manifest 摘要）。
 *  scope：'factory-database'（仅数据库）或 'factory-database+project-files'
 * （Batch 45 起：至少收录 1 个项目工作文件时为后者）；projectFiles 仅在
 *  scope 含项目文件时出现。 */
export interface BackupSummary {
  backupId: string;
  kind: 'manual' | 'pre-restore' | 'scheduled';
  createdAt: string;
  appVersion: string;
  scope: string;
  projectFiles?: {
    projects: Array<{
      projectId: string; name: string; fileCount: number; bytes: number; skipped: number;
    }>;
  };
  tables: Record<string, number>;
  totalRows: number;
  bytes: number;
}
/** POST /api/restore/project-files 的成功响应（Batch 45 起）。
 *  与 POST /api/restore 不同：项目文件恢复立即生效，不排队重启；
 *  恢复前服务端已复制当前项目文件到 preRestoreDir（回滚可再回滚）。
 *  校验失败 → 422 {error, problems}，现树不动。 */
export interface ProjectFilesRestoreResult {
  ok: boolean;
  backupId: string;
  projects: Array<{
    projectId: string; name: string; path: string; restored: number; bytes: number;
  }>;
  skipped: Array<{ projectId: string; name: string; reason: string }>;
  preRestoreDir: string;
}
/** §81 needs-human 升级记录（GET /api/needs-human[?status=] 的 items 行形状；
 *  镜像服务端 NeedsHumanDbRecord；detailJson 为 JSON 字符串，narrative
 *  在其中（Batch 44–45：诚实限定语活过持久化）。 */
export interface NeedsHumanRecord {
  id: string;
  /** §81 触发器之一（ai-disagreement / budget-exceeded / repeated-failure /
   *  high-risk-deployment / policy-violation / security-issue /
   *  requirement-ambiguity / irrecoverable-env-error）。 */
  reason: string;
  reasonZh: string;
  severity: 'medium' | 'high' | 'critical';
  /** 触发来源，如 'authority-conflict:ac-...'。 */
  source: string;
  /** 具名人工接收者；system-raised 的为 null（服务端 coarse-grained
   *  RBAC 无具名人工账号），requiredDeciderLevel 命名解决者需持有的级别。 */
  recipient: string | null;
  requiredDeciderLevel: string;
  /** JSON 字符串；`narrative` 键为给人看的诚实限定语。 */
  detailJson: string;
  /** JSON 字符串（Record<string,string> 可追溯上下文）。 */
  contextJson: string;
  /** epoch ms。 */
  raisedAt: number;
  status: 'open' | 'acknowledged' | 'resolved';
  resolvedAt: number | null;
  resolvedBy: string | null;
  resolution: string | null;
}
/** GET /api/needs-human[?status=] 的列表响应（viewer 角色）。 */
export interface NeedsHumanListResponse {
  items: NeedsHumanRecord[];
  total: number;
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

/** §24–27 run 记录（GET /api/runtime/runs/:id 的形状）。 */
export interface RuntimeRunRecord {
  id: string; agentId: string; taskId: string;
  status: 'RUNNING' | 'COMPLETED' | 'ESCALATED' | 'FAILED';
  outcome: string | null; steps: number;
  evidence: unknown[]; handoffs: string[]; trace: unknown[];
  createdAt: string; finishedAt: string | null; error: string | null;
}
/** Batch 15 Run Manifest 全量（GET /api/runtime/runs/:id/manifest）。
 *  完成块在 run 终结前为 null；stub 路径下 model 是适配器名并以
 *  modelSource 标注来源，不冒充真实模型名。 */
export interface RunManifest {
  runId: string; agentId: string; taskId: string; projectId: string;
  createdAt: string;
  driver: { kind: 'script' | 'default-script'; adapter: string; routeRequestProvided: boolean };
  grantedTools: string[];
  budgetLimits: {
    loop: { maxSteps: number; timeMs: number; maxRetries: number };
    extended: Record<string, number>;
  };
  contextManifestHash: string;
  status: string; outcome: string | null;
  finishedAt: string | null; error: string | null; steps: number | null;
  model: string | null; modelSource: 'model-router' | 'adapter' | null;
  budgetUsage: {
    modelCalls: number; toolCalls: number; repairLoops: number;
    noProgressSteps: number; elapsedMs: number;
  } | null;
  intents: {
    total: number; ids: string[];
    byStatus: { PENDING: number; EXECUTED: number; FAILED: number; DENIED: number };
  } | null;
  evidence: { count: number; byType: Record<string, number> } | null;
  checkpoints: { count: number; firstStep: number | null; lastStep: number | null } | null;
}
/** Batch 16 列表行里的 manifest 关键列（服务端 join；全量 manifest 不
 *  在列表里重复，经 runManifest 单独取）。无 manifest 的遗留 run 为 null。 */
export interface RunManifestSummary {
  status: string; outcome: string | null;
  finishedAt: string | null; error: string | null; steps: number | null;
  driverKind: string; adapter: string;
  model: string | null; modelSource: 'model-router' | 'adapter' | null;
  budgetUsage: RunManifest['budgetUsage'];
  intentsTotal: number | null;
  intentsByStatus: { PENDING: number; EXECUTED: number; FAILED: number; DENIED: number } | null;
  evidenceCount: number | null;
}
/** Batch 16 Observatory 列表行（GET /api/runtime/runs）：run 记录 +
 *  服务端 join 的 live（本进程是否正在执行）、checkpointCount（日志
 *  实时计数）、projectId/projectName（不可解析时 null）与 manifest 摘要。 */
export interface RuntimeRunListItem extends RuntimeRunRecord {
  live: boolean;
  checkpointCount: number;
  projectId: string | null;
  projectName: string | null;
  manifest: RunManifestSummary | null;
}
/** §28.4 resume 的逐项重校验结果（服务端原样：ok + detail 说明）。 */
export interface ResumeCheck {
  ok: boolean; detail: string; [k: string]: unknown;
}
/** POST /api/runtime/runs/:id/resume 的响应（成功 202 / 拒绝 404|409 皆
 *  同一形状族）：成功带新 run 的 id 与 resumedFrom；拒绝带 error/reason
 *  与逐项 checks。服务端从不复活原 run。 */
export interface ResumeRunResponse {
  id?: string;
  status?: string;
  resumedFrom?: { runId: string; stepPosition: number; capturedAt: number };
  resumeOf?: { runId: string; stepPosition: number };
  checks?: Record<string, ResumeCheck>;
  budgetBaseline?: Record<string, number>;
  note?: string;
  error?: string;
  reason?: string;
  runId?: string;
}

/** 与 req 同样处理 token、但不因 HTTP 状态抛错的版本：resume 的拒绝
 *  响应体（逐项 checks）是调用方必须原样呈现的内容，不是异常。 */
async function reqWithStatus<T>(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  return { status: res.status, body: (await res.json()) as T };
}

/** Batch 15 RBAC 身份（GET /api/auth/whoami）：调用方自己的角色与服务端
 *  认证模式，响应里永不含 token。mode 'open' = 本地单机模式（未配任何
 *  令牌，有效角色 admin）；拉取失败（旧服务端/未连通）由调用方如实显示
 *  「角色未知」，不猜测。 */
export interface ApiIdentity {
  role: 'viewer' | 'operator' | 'admin';
  mode: 'open' | 'single' | 'rbac';
  authRequired: boolean;
}

export function identityLabel(w: ApiIdentity): string {
  if (w.mode === 'open') return '本地模式（无令牌）';
  return `角色：${w.role}`;
}

export const api = {
  /** /api/health 的真实形状（服务端原样）：outbox.pending 是聚合
   *  阶段走查可直接用的计数；多余字段本面不读。 */
  health: () =>
    req<{ ok: boolean; outbox?: { store?: string; pending?: number }; [k: string]: unknown }>(
      '/health',
    ),
  /** 当前 API 身份（角色展示用）；失败时 req 抛错，调用方显示未知。 */
  whoami: () => req<ApiIdentity>('/auth/whoami'),
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
  /** §17.2 Dispatch 页签数据源：全部任务（不按项目过滤，授权队列是
   *  全局的），类型取 DispatchTask（列表即全量对象）。 */
  dispatchTasks: () => req<DispatchTask[]>('/tasks'),
  /** §17.2 提交派发：DRAFT → WAITING_HUMAN_DISPATCH。 */
  requestDispatch: (id: string) =>
    req<DispatchActionResult>(
      `/tasks/${encodeURIComponent(id)}/request-dispatch`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  /** §17.2 Human Dispatch：WAITING_HUMAN_DISPATCH → AUTHORIZED。
   *  via=POLICY 时服务端要求 policyRuleId（缺失 400），且审计 actor
   *  记 policy、不冒充人工点击——调用方须原样传字段。 */
  dispatchTask: (
    id: string,
    input: { assigneeAgentId?: string; via?: 'HUMAN' | 'POLICY'; policyRuleId?: string },
  ) =>
    req<DispatchActionResult>(
      `/tasks/${encodeURIComponent(id)}/dispatch`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  /** §17.2 驳回派发：WAITING_HUMAN_DISPATCH → DRAFT（回提交前状态）。 */
  rejectDispatch: (id: string, reason?: string) =>
    req<DispatchActionResult>(
      `/tasks/${encodeURIComponent(id)}/reject-dispatch`,
      { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) },
    ),
  /** §17.2 撤销授权：AUTHORIZED → REVOKED（规格无出边，不可恢复）。 */
  revokeAuthorization: (id: string, reason?: string) =>
    req<DispatchActionResult>(
      `/tasks/${encodeURIComponent(id)}/revoke-authorization`,
      { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) },
    ),
  /** §17.2 授权过期：AUTHORIZED|WAITING → EXPIRED（规格无出边）。 */
  expireAuthorization: (id: string, reason?: string) =>
    req<DispatchActionResult>(
      `/tasks/${encodeURIComponent(id)}/expire-authorization`,
      { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) },
    ),
  /** Batch 18 预授权票只读面（服务端 Batch 18-1）：用 reqWithStatus——
   *  端点未就绪（404）是面板要如实呈现的状态，不是异常。 */
  dispatchTickets: () =>
    reqWithStatus<{ tickets?: DispatchTicket[] } | DispatchTicket[]>('/authorization-tickets'),
  /** §29.3 管理页签用：待审批队列（GET /api/approvals?status=PENDING）。
   *  宽松只读形状：只呈现服务端实际给出的字段。 */
  approvalsQueue: () => reqWithStatus<QueueApproval[]>('/approvals?status=PENDING'),
  attachEvidence: (id: string, input: { type: string; title: string; payload?: object }) =>
    req<EvidenceItem>(`/tasks/${id}/evidence`, { method: 'POST', body: JSON.stringify(input) }),
  agents: () => req<AgentFull[]>('/agents'),
  org: () => req<OrgNode[]>('/org'),
  audit: (limit = 100) => req<AuditRecord[]>(`/audit?limit=${limit}`),
  /** §32 审计链完整性：GET /api/audit/verify 从 genesis 锚定验证整条链。
   *  不接受 limit/offset（F33：截断窗口会误报 brokenAt:0，所以端点 400
   *  拒绝分页）；角色门控 operator+（auth 模式下 viewer 403）。 */
  auditVerify: () => req<AuditChainVerification>('/audit/verify'),
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
  /** 排队恢复：服务端校验备份后 staged，重启服务端才生效（restartRequired）。
   *  注意：只恢复数据库快照，项目工作文件不在此路径。 */
  stageRestore: (backupId: string) =>
    req<RestoreStageResult>(
      '/restore', { method: 'POST', body: JSON.stringify({ backupId }) },
    ),
  /** Batch 45：恢复备份中的项目工作文件到 live 项目目录。立即生效，
   *  不排队重启；校验失败（422）则现树不动。preRestoreDir 为服务端
   *  恢复前复制的当前文件回滚点。 */
  restoreProjectFiles: (backupId: string) =>
    req<ProjectFilesRestoreResult>(
      '/restore/project-files', { method: 'POST', body: JSON.stringify({ backupId }) },
    ),
  /** Batch 50：§81 needs-human 升级记录（只读 viewer，NeedsHumanPanel 用）。
   *  默认列 OPEN；status 可为 open|acknowledged|resolved（非法值服务端 400）。
   *  只读 —— 解决动作走服务端 POST /api/needs-human/:id/resolve
   * （operator），桌面故意不接写路径，不引入未经验证的写操作。 */
  needsHuman: (status: 'open' | 'acknowledged' | 'resolved' = 'open') =>
    req<NeedsHumanListResponse>(`/needs-human?status=${status}`),
  /** §28.3 某 run 的全部 checkpoint（按首次捕获顺序）。 */
  runCheckpoints: (runId: string) =>
    req<{ runId: string; checkpoints: CheckpointV2[] }>(
      `/runtime/runs/${encodeURIComponent(runId)}/checkpoints`,
    ),
  /** §28.3 某 run 的恢复点（最高步位 checkpoint）；无捕获时服务端 404。 */
  runCheckpointLatest: (runId: string) =>
    req<CheckpointV2>(`/runtime/runs/${encodeURIComponent(runId)}/checkpoints/latest`),
  /** Batch 16 Observatory：全部 run 的列表行（服务端已 join manifest
   *  关键列 / checkpoint 实时计数 / live 标记 / 项目，不逐行再拉）。 */
  runs: () => req<{ runs: RuntimeRunListItem[] }>('/runtime/runs'),
  /** Batch 15 某 run 的全量 manifest；遗留 run 无 manifest → 服务端
   *  404 'run manifest not found'，经 req 以错误抛出、原文呈现。 */
  runManifest: (runId: string) =>
    req<RunManifest>(`/runtime/runs/${encodeURIComponent(runId)}/manifest`),
  /** §28.4 从检查点恢复：创建一个新的恢复 run（原 run 不复活）。
   *  拒绝不是异常——返回状态码 + 响应体，逐项 checks 由调用方原样呈现。 */
  resumeRun: (runId: string) =>
    reqWithStatus<ResumeRunResponse>(
      `/runtime/runs/${encodeURIComponent(runId)}/resume`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
};

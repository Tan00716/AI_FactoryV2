/** Typed client for the local @ai-factory/server API. */

import type { Lang } from './i18n';

/**
 * The renderer talks to the backend over plain HTTP. The default port is
 * 3100, but a packaged app may spawn its backend on a different PORT (see
 * electron/main.ts): the main process injects the real port as the `apiPort`
 * query parameter when it loads the renderer (`loadFile(..., { query })` /
 * `loadURL(...?apiPort=…)`). Prefer the injected value; fall back to 3100.
 * Resolved once and cached so every panel shares one base.
 */
let cachedBase: string | null = null;
export function defaultApiBase(): string {
  if (cachedBase) return cachedBase;
  try {
    const port =
      typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('apiPort')
        : null;
    cachedBase =
      port && /^\d+$/.test(port) ? `http://localhost:${port}/api` : 'http://localhost:3100/api';
  } catch {
    cachedBase = 'http://localhost:3100/api';
  }
  return cachedBase;
}

const BASE = defaultApiBase();

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
 * 第三波任务⑩：协同 WS 需要把 token 放进 query（浏览器 WebSocket 发不出
 * Authorization 头）。与 authHeaders() 同源（localStorage factory.apiToken）。
 */
export function getApiToken(): string | null {
  return apiToken();
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

export interface Project {
  id: string; name: string; description: string; path: string;
  /** 归一化后的项目生命周期状态（服务端原生 status）。 */
  status: 'active' | 'archived';
  /** ISO 时间戳（服务端原生 created_at / updated_at）。 */
  createdAt: string; updatedAt: string;
}
/**
 * GET /api/projects 的服务端原生形状（snake_case，见 packages/db/src/db.ts
 * 的 ProjectRow——§6.1 项目记录字段，snake_case 是服务端的原生契约，正确设计，
 * 不做服务端改名以免破坏 API 兼容性）。
 *
 * F48 闭环（Batch 62-2）：桌面不再对原生记录做"子集盲读"——toProject() 把它
 * 归一化为桌面的显式 camelCase 契约 Project，将来写 project.createdAt 不再
 * 静默 undefined（F41 同类问题——ApprovalsPanel 的教训）。
 */
interface RawProject {
  id: string; name: string; description: string; path: string;
  status: string; archived_at: string | null;
  created_at: string; updated_at: string;
  [k: string]: unknown;
}
/** snake_case → camelCase 归一化（58-5 ApprovalsPanel 的同模式）。 */
function toProject(raw: RawProject): Project {
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    description: String(raw.description ?? ''),
    path: String(raw.path ?? ''),
    status: raw.status === 'archived' ? 'archived' : 'active',
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : '',
    updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : '',
  };
}
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

/** R3-T5 sweep.yaml：外部事件输入（服务端做严格校验）。 */
export interface SweepEventInput {
  source: string;
  labels?: string[];
  title: string;
  body?: string;
  url?: string;
  external_id?: string;
}

/** R3-T5 sweep.yaml：GET /api/sweep/config 的规则摘要。 */
export interface SweepConfigSummary {
  path: string;
  exists: boolean;
  loadError?: string;
  ruleCount: number;
  rules: Array<{
    id: string;
    name?: string;
    enabled: boolean;
    priority: number;
    template: string;
  }>;
  invalidRules: Array<{ id: string; reason: string }>;
}

/** R3-T5 sweep.yaml：dry-run / ingest 的匹配结果。 */
export interface SweepMatchResult {
  ruleId: string;
  templateId: string;
  title: string;
  taskId: string;
}

export interface SweepDryRunResult {
  proposed: false;
  matches: SweepMatchResult[];
  skipped: Array<{ ruleId: string; reason: string }>;
  invalidRules: Array<{ id: string; reason: string }>;
}

export interface SweepIngestResult {
  proposed: boolean;
  task?: DispatchTask;
  ruleId?: string;
  templateId?: string;
  skipped: Array<{ ruleId: string; reason: string }>;
  invalidRules?: Array<{ id: string; reason: string }>;
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
/** 第二轮加强 8 — 任务级编辑范围锁定（Task.scope 的镜像形状）。 */
export interface TaskEditScope { include?: string[]; exclude?: string[] }
/** 第二轮加强 8 — GET /api/tasks/:id/scope 的范围报告。 */
export interface TaskScopeReport {
  taskId: string;
  scope: TaskEditScope | null;
  locked: boolean;
  checkedAt: string;
  shadow: { workspaceId: string; workspacePath: string; tip: string | null } | null;
  changedFiles: string[];
  outOfScope: { path: string; reason: 'not-included' | 'excluded' | 'escape' }[];
  notes: string[];
  newlyAudited: number;
}

export interface TaskDetail {
  id: string; title: string; goal: string; description: string; priority: string;
  status: string; risk: string; currentAgentId: string | null;
  assignedAgentIds: string[]; subtaskIds: string[]; dependencies: unknown[];
  acceptanceCriteria: string[]; constraints: string[]; workspace?: string;
  /** 第二轮加强 8 — 编辑范围锁定；缺失 = 未记录（不限制）。 */
  scope?: TaskEditScope;
  createdAt: string; updatedAt: string;
  completedAt: string | null; evidence: EvidenceItem[]; nextStates: NextState[];
}
/** W-E: one image attached to a task (mirrors the server attachment record). */
export interface TaskAttachment {
  id: string; taskId: string; filename: string; mimeType: string;
  size: number; createdAt: string; sha256: string;
}
/** 任务模板库：mirrors the server TaskTemplate record. */
export interface TaskTemplate {
  id: string; name: string; description: string; promptTemplate: string;
  variables: string[]; defaultAgentId?: string; defaultPriority?: string;
  toolAllowlist?: string[]; builtIn?: boolean; createdBy: string;
  createdAt: string; updatedAt: string;
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
    lang: 'zh' | 'en';
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
/** 自动备份策略（GET /api/auto-backup 的 policy 形状）。 */
export interface AutoBackupPolicy {
  enabled: boolean;
  kind: 'cron' | 'interval';
  cronExpr: string | null;
  intervalMs: number | null;
  retainCount: number;
  healthCheck: boolean;
  scheduleId: string | null;
  updatedAt: string;
}
/** 更新自动备份策略的请求体（PUT /api/auto-backup，字段均为可选）。 */
export interface AutoBackupPolicyInput {
  enabled?: boolean;
  kind?: 'cron' | 'interval';
  cronExpr?: string | null;
  intervalMs?: number | null;
  retainCount?: number;
  healthCheck?: boolean;
}
/** 两级忽略文件（GET/PUT /api/ignores）：Cursor 式 .ai-factory/ignore / .ai-factory/indexing-ignore，零模型。 */
export interface IgnoreFilesState {
  projectId: string;
  projectPath: string;
  hard: string;
  indexing: string;
  hardPatterns: number;
  indexingPatterns: number;
  errors: { layer: string; file: string; message: string }[];
  template: string;
}
export interface IgnorePreviewEntry {
  rel: string;
  pattern: string;
  line: number;
}
export interface IgnorePreview {
  projectId: string;
  projectPath: string;
  total: number;
  visited: number;
  truncated: boolean;
  hardIgnored: IgnorePreviewEntry[];
  indexingIgnored: IgnorePreviewEntry[];
  note: string;
}
/** 出站防火墙（三层 allowlist：global / project / task）。 */
export interface EgressRule {
  domain: string;
  pathPrefix?: string;
  action: 'allow' | 'deny';
  note?: string;
}
export interface EgressGlobalConfig {
  enabled: boolean;
  defaultPolicy: 'allow' | 'deny';
  rules: EgressRule[];
  updatedAt: string;
  updatedBy: string;
  loadError?: string;
}
export interface EgressConfigState {
  global: EgressGlobalConfig;
  project: { rules: EgressRule[]; taskIds: string[]; loadError?: string } | null;
  task: { rules: EgressRule[] } | null;
  projectPath: string | null;
  limits: { maxRulesPerLayer: number };
}
export interface EgressBlockEntry {
  at: string;
  url: string;
  hostname: string | null;
  source: string;
  reason: string;
  matchedLayer?: string;
  matchedRule?: string;
}
export interface EgressTestResult {
  url: string;
  allowed: boolean;
  reason: string;
  hostname: string | null;
  matchedLayer: string | null;
  matchedRule: string | null;
  enabled: boolean;
  defaultPolicy: 'allow' | 'deny';
  projectPath: string | null;
}
/** 质量闸门配置（GET/PUT /api/quality）：确定性 lint/test 门禁，零模型。 */
export interface QualityGateConfig {
  lintCmd: string;
  testCmd: string;
  timeoutMs: number;
  runOnEdit: boolean;
  blockOnFailure: boolean;
  /** 安全扫描阻断配置（wave2-④；缺失 = 未配置，兼容旧服务）。 */
  security?: { failOn: string[] };
  /** 变更影响阻断配置（第二轮⑥；缺失 = 未配置，兼容旧服务）。 */
  impact?: { failOnBreaking: boolean };
  /** 间歇失败重跑配置（第三轮③；缺失 = 未配置，兼容旧服务）。 */
  flaky?: { rerunFlakyOnce: boolean };
}
export interface QualityGateConfigInput {
  lintCmd?: string;
  testCmd?: string;
  timeoutMs?: number;
  runOnEdit?: boolean;
  blockOnFailure?: boolean;
  security?: { failOn: string[] };
  impact?: { failOnBreaking: boolean };
  flaky?: { rerunFlakyOnce: boolean };
}
export interface QualityGateLastRun {
  kind: 'lint' | 'test';
  ok: boolean;
  timedOut: boolean;
  exitCode: number | null;
  truncated: boolean;
  durationMs: number;
  at: string;
}
export interface QualityGateRunResult {
  kind: 'lint' | 'test';
  projectId: string;
  skipped: boolean;
  skipReason: string | null;
  ok: boolean;
  timedOut: boolean;
  exitCode: number | null;
  truncated: boolean;
  durationMs: number;
  startedAt: string;
  stdoutTail: string;
  stderrTail: string;
  blocked: boolean;
  /** 安全扫描联动结果（wave2-④；仅当 security.failOn 已配置时返回）。 */
  security?: {
    failOn: string[];
    secret: number;
    sast: number;
    sca: number;
    blocked: boolean;
    note?: string;
  } | null;
  /** 变更影响联动结果（第二轮⑥；仅当 impact.failOnBreaking 已配置时返回）。 */
  impact?: {
    failOnBreaking: boolean;
    root?: string;
    changedFiles?: number;
    affected?: number;
    breaking?: number;
    blocked: boolean;
    error?: string;
    note?: string;
  } | null;
  /** 间歇失败联动结果（第三轮③；仅当 flaky.rerunFlakyOnce 已配置且 test 步骤失败时返回）。 */
  flakyRerun?: {
    attempted: boolean;
    reason?: string;
    firstRun?: { failing: string[]; knownFlaky: string[]; otherFailing: string[] };
    rerun?: { ok: boolean; exitCode: number | null; timedOut: boolean; parsedOutcomes: number; failing: string[] };
    note?: string;
  } | null;
  /** 变异测试联动结果（第三轮 R3-T2；仅当 mutation.report 已配置时返回，仅标注）。 */
  mutationAnnotation?: {
    attempted: boolean;
    reason?: string;
    advisory?: boolean;
    blocks?: boolean;
    runId?: string;
    generatedAt?: string;
    score?: number | null;
    totals?: MutationTotals;
  } | null;
}
/** 变异测试（第三轮 R3-T2）——服务端 /api/mutation 的形状。 */
export type MutantVerdict = 'killed' | 'survived' | 'timeout' | 'invalid';
export interface MutationTotals {
  generated: number;
  sampled: number;
  killed: number;
  survived: number;
  timeout: number;
  invalid: number;
  score: number | null;
}
export interface MutationReportSummary {
  runId: string;
  seed: number;
  generatedAt: string;
  target: { dir: string; files: string[]; testFiles: string[] };
  sampling: { maxMutants: number; perFileCap: number };
  timeoutMs: number;
  truncated: boolean;
  truncateReason: string | null;
  totals: MutationTotals;
}
export interface MutationRunRequest {
  files: string[];
  testFiles: string[];
  targetDir?: string;
  seed?: number | string;
  maxMutants?: number;
  perFileCap?: number;
  timeoutMs?: number;
  maxTotalMs?: number;
}
export interface MutationRunAccepted {
  runId: string;
  status: 'running';
  generated: number;
  sampled: number;
}
export interface MutationRunStatus {
  runId: string;
  projectId: string;
  status: 'running' | 'done' | 'failed';
  progress: { done: number; total: number };
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  report: MutationReportSummary | null;
}
/** 依赖升级顾问（第四轮 R4-B10）——服务端 /api/depscan 的形状。 */
export type DepscanGrade = 'up-to-date' | 'patch' | 'minor' | 'major' | 'prerelease' | 'downgrade' | 'unknown';
export interface DepscanCveHit {
  id: string;
  severity: string;
  note?: string;
}
export interface DepscanAdvice {
  name: string;
  current: string;
  declaredRange: string;
  dev: boolean;
  wanted: string | null;
  latest: string | null;
  grade: DepscanGrade;
  changelogUrl?: string;
  cves: DepscanCveHit[];
  reviewFirst: boolean;
}
export interface DepscanPlan {
  generatedAt: string;
  registrySource: string;
  snapshotDate: string | null;
  advisories: DepscanAdvice[];
  commands: string[];
  summary: {
    total: number;
    upToDate: number;
    patch: number;
    minor: number;
    major: number;
    unknown: number;
    cveAffected: number;
  };
}
export interface DepscanSnapshot {
  source: string;
  snapshotDate: string | null;
  packageCount: number;
  honestBoundary: string;
}
/** 间歇失败检测（第三轮③）——服务端 /api/flaky 的形状。 */
export type FlakyStatus = 'flaky' | 'always-failing' | 'stable' | 'insufficient-data';
export interface FlakyTestEntry {
  key: string;
  file: string;
  name: string;
  firstSeen: string;
  lastSeen: string;
  recent: Array<'pass' | 'fail'>;
  passes: number;
  fails: number;
  runs: number;
  status: FlakyStatus;
}
export interface FlakyConfig {
  windowSize: number;
  minRuns: number;
}
export interface FlakyRunSummary {
  runId: string;
  at: string;
  label: string;
  file: string | null;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
}
export interface FlakyState {
  projectId: string;
  config: FlakyConfig;
  defaults: FlakyConfig;
  tests: FlakyTestEntry[];
  runs: FlakyRunSummary[];
  total: number;
  counts: { flaky: number; alwaysFailing: number; stable: number; insufficientData: number };
}
/** R4-B9 TODO 追踪：服务端 TodoItem / TodoPattern 的桌面侧形状。 */
export type TodoSeverity = 'error' | 'warning' | 'info';
/** R5-A5 Trojan Source 防护：服务端 TrojanApiHit 的桌面侧形状。 */
export type TrojanKind = 'bidi-control' | 'zero-width' | 'confusable';
export interface TrojanHit {
  line: number;
  column: number;
  length: number;
  kind: TrojanKind;
  severity: 'error' | 'warning';
  codePoint: string;
  name: string;
  script?: string;
  latin?: string;
  message: string;
}
/** R5-A7 拼写检查：服务端 SpellApiHit 的桌面侧形状。 */
export interface SpellHit {
  line: number;
  column: number;
  length: number;
  word: string;
  suggestions: string[];
  message: string;
}
/** R5-B10 草稿文件：服务端语言定义。 */
export interface ScratchLanguageDef {
  id: string;
  label: string;
  extension: string;
  monacoLanguage: string;
  runnable: boolean;
}
/** R5-B10 草稿文件：服务端 ScratchMeta 的桌面侧形状。 */
export interface ScratchMeta {
  id: string;
  name: string;
  language: string;
  createdAt: string;
  updatedAt: string;
  sizeBytes: number;
}
/** R5-B10 草稿文件：含内容的草稿。 */
export interface ScratchFile extends ScratchMeta {
  content: string;
}
/** R5-B10 草稿文件：运行结果。 */
export interface ScratchRunResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  runner: string;
  language: string;
}
/** R6-S5 任务计划：服务端 Schedule 的桌面侧形状。 */
export interface ScheduleItem {
  id: string;
  name: string;
  kind: 'cron' | 'interval' | 'once';
  cronExpr: string | null;
  intervalMs: number | null;
  runAt: string | null;
  job: Record<string, unknown>;
  status: 'active' | 'paused';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: 'ok' | 'failed' | null;
  lastError: string | null;
  lastOutput: string | null;
  runCount: number;
  recentRuns: ScheduleRunRecord[];
}
/** R6-S5：单条执行记录（ok/failed/skipped）。 */
export interface ScheduleRunRecord {
  firedAt: string;
  trigger: 'tick' | 'manual';
  ok: boolean;
  skipped: boolean;
  summary: string;
}
export interface TodoItem {
  file: string;
  line: number;
  column: number;
  severity: TodoSeverity;
  tag: string;
  message: string;
}
/** R5-B9 书签：服务端 Bookmark 的桌面侧形状。 */
export type BookmarkKindDto = 'line' | 'file' | 'dir';
export type BookmarkRelocationStatus = 'ok' | 'relocated' | 'drifted';
export interface BookmarkDtoItem {
  id: string;
  kind: BookmarkKindDto;
  path: string;
  line?: number;
  mnemonic?: string;
  label: string;
  tags: string[];
  createdAt: number;
}
/** R6-S1 扩展系统：服务端 ExtensionInfo 的桌面侧形状。 */
export interface ExtensionDto {
  name: string;
  version: string;
  description: string;
  author?: string;
  permissions: string[];
  enabled: boolean;
  commands: Array<{ id: string; title: string; description?: string }>;
  panels: Array<{ id: string; title: string; sections: Array<{ heading?: string; text: string }> }>;
  checkers: Array<{ id: string; title: string; pattern: string; message: string; severity?: string }>;
  providers: Array<{ id: string; prefix: string; description?: string }>;
}
export interface ExtensionPanelDto {
  extension: string;
  id: string;
  title: string;
  sections: Array<{ heading?: string; text: string }>;
}
export interface ExtensionProviderDto {
  extension: string;
  id: string;
  prefix: string;
  description?: string;
}
export type BookmarkDto = BookmarkDtoItem[];
export interface BookmarkInputDto {
  kind: BookmarkKindDto;
  path: string;
  line?: number;
  mnemonic?: string;
  label?: string;
  tags?: string[];
  root?: string;
}
export interface BookmarkPatchDto {
  label?: string;
  tags?: string[];
  mnemonic?: string | null;
}
export interface BookmarkResolveDto {
  bookmark: BookmarkDtoItem;
  status: BookmarkRelocationStatus;
  path: string;
  line?: number;
  drifted: boolean;
}
/** R6-S3 文件监听联动：规则与触发记录的桌面端视图。 */
export interface WatchRuleView {
  id: string;
  name: string;
  globs: string[];
  action: { type: 'task'; label: string };
  debounceMs: number;
  enabled: boolean;
  active: boolean;
  watchedDirs: number;
}
export interface WatchRuleInput {
  id?: string;
  name: string;
  globs: string[];
  action: { type: 'task'; label: string };
  debounceMs?: number;
  enabled?: boolean;
}
export interface WatchRulesResponse {
  rules: WatchRuleView[];
  missing: boolean;
}
export interface WatchTriggerView {
  id: string;
  ruleId: string;
  ruleName: string;
  root: string;
  files: string[];
  burst: boolean;
  startedAt: string;
  finishedAt: string;
  status: string;
  chainOk: boolean;
  stoppedAt: string | null;
  failedLabels: string[];
  error: string | null;
}
export interface WatchStatusView {
  root: string;
  rules: number;
  enabled: number;
  active: Array<{ id: string; name: string; watchedDirs: number }>;
  triggers: number;
}
export interface TodoPattern {
  name: string;
  regexp: string;
  severity: TodoSeverity;
  enabled: boolean;
  builtin: boolean;
}
export interface TodoPatternInput {
  name: string;
  regexp: string;
  severity: TodoSeverity;
  enabled?: boolean;
}
export interface TodoScanStats {
  filesScanned: number;
  linesScanned: number;
  items: number;
  truncated: boolean;
  skippedBinary: number;
  durationMs: number;
}
export interface TodoScanResponse {
  root: string;
  patterns: TodoPattern[];
  items: TodoItem[];
  stats: TodoScanStats;
}
/** R4-S3 确定性重构：桌面侧形状（服务端原样）。 */
export type RefactorOpName = 'extract-variable' | 'extract-method' | 'inline-variable' | 'rename-symbol';
export interface RefactorAnalyzeInput {
  projectId: string;
  targetDir?: string;
  file: string;
  op: RefactorOpName;
  selection?: { start: number; end: number };
  lines?: { startLine: number; endLine: number };
  offset?: number;
  name?: string;
  newName?: string;
  otherFiles?: string[];
}

/** R4-S2 DAP 调试器 API 类型。 */
export interface DebugLaunchConfig {
  name: string;
  request: 'launch' | 'attach';
  adapter: 'node';
  program?: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  stopOnEntry: boolean;
  port?: number;
  address: string;
}
export interface DebugBreakpointInput {
  file: string;
  line: number;
  column?: number;
  condition?: string;
  logMessage?: string;
}
export interface DebugStartSessionInput {
  projectId: string;
  targetDir?: string;
  configName?: string;
  config?: {
    name?: string;
    type?: string;
    request?: string;
    program?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    stopOnEntry?: boolean;
    port?: number;
    address?: string;
  };
  breakpoints?: DebugBreakpointInput[];
}
export interface DebugBreakpoint {
  id: number;
  verified: boolean;
  line?: number;
  file: string;
}
export interface DebugSessionStarted {
  sessionId: string;
  name: string;
  request: 'launch' | 'attach';
  state: string;
  createdAt: string;
  breakpoints: DebugBreakpoint[];
}
export interface DebugSessionSummary {
  sessionId: string;
  name: string;
  request: 'launch' | 'attach';
  state: 'starting' | 'running' | 'paused' | 'terminated';
  stopReason?: string;
  stopThreadId?: number;
  createdAt: string;
  exited: boolean;
}
export interface DebugOutputLine {
  seq: number;
  category: string;
  output: string;
}
export interface DebugStackFrame {
  id: number;
  name: string;
  source?: { name?: string; path?: string };
  line: number;
  column: number;
}
export interface DebugScope {
  name: string;
  variablesReference: number;
  expensive: boolean;
  presentationHint?: string;
}
export interface DebugVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}
export interface DebugEvalResult {
  result: string;
  type?: string;
  variablesReference: number;
}
/** R5-A4 Git blame 响应（逐行 blame，快照语义）。 */
export interface BlameLineDto {
  line: number;
  hash: string;
  shortHash: string;
  author: string;
  authorMail: string;
  authorTime: number;
  summary: string;
  uncommitted: boolean;
}
export interface BlameResponse {
  repoRoot: string;
  file: string;
  lines: BlameLineDto[];
  truncated: boolean;
  lineCap: number;
}
/** R5-S3 三路合并：冲突文件条目。 */
export interface MergeConflictFile {
  path: string;
  status: string;
}
/** R5-S3：冲突标记块（0-based 行号）。 */
export interface MergeHunkDto {
  index: number;
  startLine: number;
  midLine: number;
  endLine: number;
  oursLabel: string | null;
  theirsLabel: string | null;
  ours: string[];
  theirs: string[];
}
/** R5-S3：diff3 对齐块。 */
export interface MergeChunkDto {
  kind: 'stable' | 'ours-only' | 'theirs-only' | 'both-same' | 'conflict';
  baseStart: number;
  baseLines: string[];
  oursLines: string[];
  theirsLines: string[];
  needsManual: boolean;
}
/** R5-S3：analyze 响应（只读）。 */
export interface MergeAnalysisResponse {
  file: string;
  sha256: string;
  markerHunks: MergeHunkDto[];
  stages: { base: boolean; ours: boolean; theirs: boolean };
  chunks: MergeChunkDto[];
  summary: { markerHunks: number; cleanChunks: number; conflictChunks: number; needsManual: number };
}
/** R5-S3：逐块解决选项。 */
export type MergeResolutionChoice = 'ours' | 'theirs' | 'both' | 'custom';
export interface MergeHunkResolution {
  hunk: number;
  choice: MergeResolutionChoice;
  customText?: string;
}
/** R5-S3：resolve 响应。 */
export interface MergeResolveResponse {
  file: string;
  resolved: boolean;
  staged: boolean;
  stageError: string | null;
  checkpointId: string;
  sha256: string;
}
/** R6-S2：rebase todo 行（reword 的 message 仅单行）。 */
export type RebaseTodoAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop';
export interface RebaseTodoInput {
  action: RebaseTodoAction;
  hash: string;
  subject: string;
  message?: string;
}
export interface RebaseTodosResponse {
  repo: string;
  base: string;
  baseSha: string;
  head: string;
  commits: { hash: string; subject: string }[];
  todos: RebaseTodoInput[];
}
export interface RebaseResultResponse {
  status: 'completed' | 'conflict' | 'failed' | 'in-progress';
  headBefore: string;
  headAfter: string;
  conflictedFiles: string[];
  stderr: string;
  checkpointId?: string;
}
export interface RebaseStatusResponse {
  repo: string;
  inProgress: boolean;
  head: string;
  todoRaw: string | null;
  conflictedFiles: string[];
}
/** R6-S2：stash 条目。 */
export interface StashEntry {
  index: string;
  position: number;
  message: string;
}
export interface StashApplyResponse {
  index: string;
  outcome: 'applied' | 'conflict' | 'failed';
  conflictedFiles: string[];
  stderr: string;
}
/** R5-A4 Timeline 响应（git 提交 × local-history 快照融合）。 */
export type TimelineEntryDto =
  | { kind: 'git'; hash: string; shortHash: string; author: string; date: number; message: string }
  | { kind: 'snapshot'; id: string; dateMs: number; snapshotKind: string; size: number };
export interface TimelineResponse {
  repoRoot: string;
  file: string;
  noGit: boolean;
  entries: TimelineEntryDto[];
}
export interface TimelineDiffResponse {
  from: string;
  to: string;
  diff: string;
}
export interface RefactorWarning {
  code: string;
  message: string;
}
export interface RefactorProposalItem {
  id: string;
  file: string;
  diff: string;
  warnings: RefactorWarning[];
}
export interface RefactorProposalResponse {
  proposalId: string;
  projectId: string;
  op: RefactorOpName;
  createdAt?: string;
  warnings: RefactorWarning[];
  items: RefactorProposalItem[];
}
export interface RefactorApplyResponse {
  proposalId: string;
  applied: string[];
  skipped: string[];
}
/** R4-A7 性能剖析：V8 CPU profile（火焰图）/ 堆快照。 */
export interface ProfilerFlameNode {
  name: string;
  value: number;
  self: number;
  children: ProfilerFlameNode[];
}
export interface ProfilerHotspot {
  functionName: string;
  url: string;
  line: number;
  selfUs: number;
  totalUs: number;
  selfPct: number;
  totalPct: number;
}
export interface ProfilerCpuResult {
  script: string;
  args: string[];
  durationMs: number;
  sampleCount: number;
  totalUs: number;
  partial: boolean;
  hotspots: ProfilerHotspot[];
  flame: ProfilerFlameNode;
}
export interface ProfilerConstructorStat {
  constructor: string;
  count: number;
  selfBytes: number;
  selfPct: number;
}
export interface ProfilerHeapResult {
  script: string;
  durationMs: number;
  totalBytes: number;
  nodeCount: number;
  top: ProfilerConstructorStat[];
}
/** R4-A5 数据库浏览器。 */
export interface DbBrowserConnection {
  name: string;
  kind: 'sqlite' | 'postgres';
  env: 'dev' | 'staging' | 'prod';
}
export interface DbBrowserQueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  changes?: number;
}
export interface DbBrowserQueryResponse {
  verdict: 'read' | 'write' | 'destructive' | 'blocked';
  result: DbBrowserQueryResult;
}
export interface DbBrowserTablePage {
  table: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
}
export interface DbBrowserColumnDef {
  name: string;
  type: string;
  notNull: boolean;
  pk: number;
  defaultValue: string | null;
}
export interface DbBrowserTableDef {
  name: string;
  columns: DbBrowserColumnDef[];
  indexes: Array<{ name: string; unique: boolean; columns: string[] }>;
  foreignKeys: Array<{ column: string; refTable: string; refColumn: string }>;
}
export interface DbBrowserSchema {
  dialect: 'sqlite' | 'postgres';
  tables: DbBrowserTableDef[];
  views: Array<{ name: string; sql: string | null }>;
}
export interface DbBrowserSchemaDiff {
  addTables: DbBrowserTableDef[];
  addColumns: Array<{ table: string; column: DbBrowserColumnDef }>;
  droppedTables: string[];
  droppedColumns: Array<{ table: string; column: string }>;
  ddl: string[];
  notes: string[];
}
export interface DbBrowserErGraph {
  nodes: Array<{ id: string; label: string; columns: string[]; pk: string[] }>;
  edges: Array<{ from: string; to: string; label: string }>;
}
/** R4-A6 HTTP/REST 调试客户端。 */
export interface HttpRunInput {
  text: string;
  environment?: string;
  environments?: Record<string, { vars: Record<string, string> }>;
  variables?: Record<string, string>;
  timeoutMs?: number;
  projectId?: string;
}
export interface HttpAssertionView {
  passed: boolean;
  detail: string;
}
export interface HttpRunResultView {
  id: string;
  name: string;
  method: string;
  url: string;
  blocked?: boolean;
  blockedReason?: string;
  status?: number;
  statusText?: string;
  bodyText?: string;
  durationMs?: number;
  bytes?: number;
  assertions: HttpAssertionView[];
  ok: boolean;
  error?: string;
}
export interface HttpRunResponse {
  environment: string | null;
  results: HttpRunResultView[];
}
export interface HttpEnvironmentsResponse {
  root: string;
  environments: Record<string, { vars: Record<string, string> }>;
}
/** R5-S2 声明式任务运行器：任务定义视图。 */
export interface TaskDefView {
  label: string;
  type: 'shell' | 'process';
  command: string;
  args: string[];
  group: 'build' | 'test' | 'none';
  detail?: string;
  dependsOn: string[];
  dependsOrder: 'sequence' | 'parallel';
  problemMatcher: string[];
  options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number };
}
export interface TasksListResponse {
  tasks: TaskDefView[];
  errors: string[];
  warnings: string[];
  missing: boolean;
}
export interface TaskRunResultView {
  label: string;
  status: 'ok' | 'failed' | 'denied' | 'timeout' | 'skipped';
  exitCode: number | null;
  durationMs: number;
  output: string;
  truncated: boolean;
  diagnosticsAdded: number;
  matchRate: number;
  error?: string;
  notes?: string[];
}
export interface TaskChainResponse {
  requested: string[];
  results: TaskRunResultView[];
  stoppedAt: string | null;
  ok: boolean;
  startedAt: string;
  finishedAt: string;
}
export interface TaskRunsResponse {
  runs: Array<{
    id: string;
    label: string;
    ok: boolean;
    stoppedAt: string | null;
    taskCount: number;
    startedAt: string;
    finishedAt: string;
  }>;
}
/** R6-S4 后台任务队列：作业摘要（列表端点，不含日志字节）。 */
export interface QueueJobView {
  id: string;
  label: string;
  chain: string[];
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  currentTask: string | null;
  completedTaskCount: number;
  taskCount: number;
  diagnosticsAdded: number;
  logTruncated: boolean;
  error?: string;
}
export interface QueueJobTaskView {
  label: string;
  status: 'ok' | 'failed' | 'denied' | 'timeout' | 'cancelled' | 'skipped';
  exitCode: number | null;
  durationMs: number;
  diagnosticsAdded: number;
  error?: string;
}
export interface QueueJobDiagnosticView {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  matcher: string;
}
export interface QueueJobsResponse {
  jobs: QueueJobView[];
  config: { maxConcurrency: number };
  running: number;
  queued: number;
}
export interface QueueJobDetailResponse {
  job: QueueJobView;
  tasks: QueueJobTaskView[];
  diagnostics: QueueJobDiagnosticView[];
}
export interface FlakyRecordResponse {
  projectId: string;
  summary: FlakyRunSummary;
  stats: { lines: number; resultLines: number; recorded: number; yamlBlocks: number; truncated: boolean };
  newlyFlaky: string[];
  newlyStable: string[];
}
export interface FlakyRunsResponse {
  projectId: string;
  files: Array<{
    file: string;
    exitCode: number | null;
    timedOut: boolean;
    truncated: boolean;
    total: number;
    passed: number;
    failed: number;
    newlyFlaky: string[];
  }>;
  newlyFlaky: string[];
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

export const api = {
  /** /api/health 的真实形状（服务端原样）：outbox.pending 是聚合
   *  阶段走查可直接用的计数；多余字段本面不读。 */
  health: () =>
    req<{ ok: boolean; outbox?: { store?: string; pending?: number }; [k: string]: unknown }>(
      '/health',
    ),
  /** 当前 API 身份（角色展示用）；失败时 req 抛错，调用方显示未知。 */
  whoami: () => req<ApiIdentity>('/auth/whoami'),
  /** F48 闭环（Batch 62-2）：/api/projects 返回服务端原生 snake_case 行，
   *  toProject() 归一化为桌面的 camelCase 显式契约。 */
  projects: () => req<RawProject[]>('/projects').then((list) => list.map(toProject)),
  board: (projectId: string) =>
    req<{ projectId: string; columns: Record<string, BoardCard[]> }>(
      `/board?projectId=${encodeURIComponent(projectId)}`,
    ),
  /** §85 full-board source: all tasks of a project, grouped client-side. */
  tasks: (projectId?: string) =>
    req<TaskSummary[]>(`/tasks${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  createTask: (input: { projectId: string; title: string; goal?: string; priority?: string; scope?: TaskEditScope }) =>
    req<TaskDetail>('/tasks', { method: 'POST', body: JSON.stringify(input) }),
  /** 第二轮加强 8 — 更新/清除任务编辑范围（scope=null 清除）。 */
  updateTaskScope: (id: string, scope: TaskEditScope | null) =>
    req<TaskDetail>(`/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ scope }) }),
  /** 第二轮加强 8 — 事后越界报告（影子检查点 diff 对照 scope）。 */
  taskScopeReport: (id: string) =>
    req<TaskScopeReport>(`/tasks/${encodeURIComponent(id)}/scope`),
  /** 任务模板库：CRUD + 从模板发起（建任务并启动 run）。 */
  listTaskTemplates: () =>
    req<{ templates: TaskTemplate[] }>('/task-templates'),
  createTaskTemplate: (input: { name: string; description?: string; promptTemplate: string; defaultAgentId?: string; defaultPriority?: string; toolAllowlist?: string[] }) =>
    req<{ template: TaskTemplate }>('/task-templates', { method: 'POST', body: JSON.stringify(input) }),
  updateTaskTemplate: (id: string, patch: Partial<{ name: string; description: string; promptTemplate: string; defaultAgentId: string; defaultPriority: string; toolAllowlist: string[] }>) =>
    req<{ template: TaskTemplate }>(`/task-templates/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteTaskTemplate: (id: string) =>
    req<{ deleted: boolean }>(`/task-templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  launchTaskTemplate: (id: string, input: { projectId: string; params?: Record<string, string>; agentId?: string; title?: string }) =>
    req<TaskDetail & { runId: string }>(`/task-templates/${encodeURIComponent(id)}/launch`, { method: 'POST', body: JSON.stringify(input) }),
  /** W-E multimodal: upload one image to a task (base64 data URL or raw base64). */
  uploadTaskAttachment: (taskId: string, input: { filename: string; mimeType: string; dataBase64: string }) =>
    req<{ attachment: TaskAttachment }>(`/tasks/${encodeURIComponent(taskId)}/attachments`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  listTaskAttachments: (taskId: string) =>
    req<{ attachments: TaskAttachment[] }>(`/tasks/${encodeURIComponent(taskId)}/attachments`),
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
  /** R3-T5 sweep.yaml：外部事件 → 任务模板发起（只做约定+手动触发，
   *  无 webhook；ingest 永不自动执行，任务进 WAITING_HUMAN_DISPATCH）。 */
  sweepConfig: (projectId: string) =>
    req<SweepConfigSummary>(
      `/sweep/config?projectId=${encodeURIComponent(projectId)}`,
    ),
  sweepDryRun: (projectId: string, event: SweepEventInput) =>
    req<SweepDryRunResult>(
      '/sweep/dry-run',
      { method: 'POST', body: JSON.stringify({ projectId, event }) },
    ),
  sweepIngest: (projectId: string, event: SweepEventInput) =>
    req<SweepIngestResult>(
      '/sweep/ingest',
      { method: 'POST', body: JSON.stringify({ projectId, event }) },
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
  /** 审计合规导出：GET /api/audit/export（operator+）。返回 blob +
   *  服务端建议的文件名，调用方负责触发浏览器下载。服务端先验链，
   *  链断裂/尾被截时抛 409（err.status === 409）。 */
  auditExportBlob: async (
    format: 'csv' | 'json',
    from?: string,
    to?: string,
  ): Promise<{ blob: Blob; filename: string; recordCount: number | null }> => {
    const qs = new URLSearchParams({ format });
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const res = await fetch(`${BASE}/audit/export?${qs.toString()}`, {
      headers: { ...authHeaders() },
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string; code?: string };
        if (body.error) message = body.code ? `[${body.code}] ${body.error}` : body.error;
      } catch {
        /* keep the HTTP status message */
      }
      const e = new Error(message) as Error & { status: number };
      e.status = res.status;
      throw e;
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') ?? '';
    const m = /filename="?([^";]+)"?/.exec(cd);
    const rcRaw = res.headers.get('X-Audit-Export-Record-Count');
    const recordCount = rcRaw !== null && rcRaw !== '' && Number.isFinite(Number(rcRaw)) ? Number(rcRaw) : null;
    return { blob, filename: m?.[1] ?? `audit-export.${format}`, recordCount };
  },
  deployments: () => req<DeploymentRecord[]>('/deployments'),
  memoryEntries: (scope: string, scopeId: string) =>
    req<MemoryEntry[]>(`/memory?scope=${encodeURIComponent(scope)}&scopeId=${encodeURIComponent(scopeId)}`),
  files: (root: string) =>
    req<{ root: string; entries: FileEntry[] }>(`/files?root=${encodeURIComponent(root)}`),
  /** R5-A8: read a workspace text file (GET /api/file?path=). */
  fileRead: (path: string) =>
    req<{ path: string; size: number; content: string }>(`/file?path=${encodeURIComponent(path)}`),
  /** R5-A8: write a workspace text file (POST /api/file). */
  fileWrite: (path: string, content: string) =>
    req<{ ok: boolean; path: string }>('/file', {
      method: 'POST',
      body: JSON.stringify({ path, content }),
    }),
  /** R5-A8: project-wide text search (index-free grep, POST /api/codesearch/search). */
  codeSearch: (input: {
    root?: string;
    query: string;
    regex?: boolean;
    caseSensitive?: boolean;
    glob?: string;
    maxMatches?: number;
  }) =>
    req<{
      query: { query: string; regex: boolean; caseSensitive: boolean; globs: string[]; maxMatches: number };
      groups: Array<{
        file: string;
        matches: Array<{ line: number; column: number; text: string }>;
      }>;
      totalMatches: number;
      stats: {
        filesScanned: number;
        linesScanned: number;
        skippedBinary: number;
        skippedTooLarge: number;
        truncated: boolean;
        durationMs: number;
      };
    }>('/codesearch/search', { method: 'POST', body: JSON.stringify(input) }),
  policyEffective: () => req<unknown>('/policy/effective'),
  mcpServers: () => req<{ servers?: Array<{ name: string; status?: string; [k: string]: unknown }> } | Array<{ name: string }>>('/mcp'),
  /** Batch 89：侧栏 SKILLS 摘要走真实数据（GET /api/skills）；拉取失败由调用方回退到硬编码文本，不猜测。 */
  skills: () =>
    req<{ skills: Array<{ id: string; status: string; trustLevel: string }> }>('/skills'),
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
  /** §39 项目 Final Report（JSON 汇编结果）；lang 透传服务端叙述语言。 */
  finalReport: (id: string, lang: Lang) =>
    req<{ report: FinalReport }>(`/projects/${encodeURIComponent(id)}/final-report?lang=${lang}`),
  /** §39 Final Report 的 Markdown 渲染（与 JSON 同一汇编对象、同一 contentHash）。 */
  finalReportMarkdown: (id: string, lang: Lang) =>
    reqText(`/projects/${encodeURIComponent(id)}/final-report?format=md&lang=${lang}`),
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
  /** 自动备份策略（GET /api/auto-backup）：读 viewer。 */
  autoBackup: () =>
    req<{ policy: AutoBackupPolicy }>('/auto-backup'),
  /** 更新自动备份策略（PUT /api/auto-backup）：写 operator。 */
  updateAutoBackup: (p: AutoBackupPolicyInput) =>
    req<{ policy: AutoBackupPolicy; sync: string }>(
      '/auto-backup', { method: 'PUT', body: JSON.stringify(p) },
    ),
  /** 立即执行一次受卫备份（POST /api/auto-backup/run）：operator。 */
  runAutoBackupNow: () =>
    req<{ backupId: string; pruned: string[] }>(
      '/auto-backup/run', { method: 'POST', body: JSON.stringify({}) },
    ),
  /** 出站防火墙三层配置（GET /api/egress/config?projectId=&taskId=）：读 viewer。 */
  egressConfig: (projectId: string, taskId?: string) =>
    req<EgressConfigState>(
      `/egress/config?projectId=${encodeURIComponent(projectId)}${taskId ? `&taskId=${encodeURIComponent(taskId)}` : ''}`,
    ),
  /** 保存出站防火墙全局层（PUT /api/egress/config，scope=global）：写 operator。 */
  updateEgressGlobal: (p: { enabled: boolean; defaultPolicy: 'allow' | 'deny'; rules: EgressRule[] }) =>
    req<{ global: EgressGlobalConfig }>(
      '/egress/config', { method: 'PUT', body: JSON.stringify({ scope: 'global', ...p }) },
    ),
  /** 保存出站防火墙项目层（PUT /api/egress/config，scope=project）：写 operator。 */
  updateEgressProject: (projectId: string, rules: EgressRule[]) =>
    req<{ rules: EgressRule[]; taskIds: string[] }>(
      '/egress/config', { method: 'PUT', body: JSON.stringify({ scope: 'project', projectId, rules }) },
    ),
  /** 保存出站防火墙任务层（PUT /api/egress/config，scope=task）：写 operator。 */
  updateEgressTask: (projectId: string, taskId: string, taskRules: EgressRule[]) =>
    req<{ rules: EgressRule[]; taskIds: string[] }>(
      '/egress/config', { method: 'PUT', body: JSON.stringify({ scope: 'task', projectId, taskId, taskRules }) },
    ),
  /** 出站防火墙最近拦截记录（GET /api/egress/log）：读 viewer。 */
  egressLog: (limit = 50) =>
    req<{ entries: EgressBlockEntry[] }>(`/egress/log?limit=${limit}`),
  /** 出站防火墙干跑判定（POST /api/egress/test）：写 operator。 */
  egressTest: (p: { url: string; projectId?: string; taskId?: string }) =>
    req<EgressTestResult>('/egress/test', { method: 'POST', body: JSON.stringify(p) }),
  /** 质量闸门配置（GET /api/quality?projectId=）：读 viewer。 */
  qualityGate: (projectId: string) =>
    req<{ config: QualityGateConfig; lastRun: Record<'lint' | 'test', QualityGateLastRun | null> }>(
      `/quality?projectId=${encodeURIComponent(projectId)}`,
    ),
  /** 更新质量闸门配置（PUT /api/quality）：写 operator。 */
  updateQualityGate: (projectId: string, p: QualityGateConfigInput) =>
    req<{ config: QualityGateConfig }>(
      '/quality', { method: 'PUT', body: JSON.stringify({ projectId, ...p }) },
    ),
  /** 立即跑一次闸门（POST /api/quality/run）：operator。 */
  runQualityGate: (projectId: string, kind: 'lint' | 'test') =>
    req<QualityGateRunResult>(
      '/quality/run', { method: 'POST', body: JSON.stringify({ projectId, kind }) },
    ),
  /** 间歇失败检测状态（GET /api/flaky?projectId=）：读 viewer。 */
  flaky: (projectId: string) =>
    req<FlakyState>(`/flaky?projectId=${encodeURIComponent(projectId)}`),
  /** 间歇失败判定阈值（PUT /api/flaky）：写 operator。 */
  updateFlaky: (projectId: string, p: { windowSize?: number; minRuns?: number }) =>
    req<{ projectId: string; config: FlakyConfig }>(
      '/flaky', { method: 'PUT', body: JSON.stringify({ projectId, ...p }) },
    ),
  /** 解析 TAP 文本并记录一次运行（POST /api/flaky/record）：写 operator。 */
  recordFlakyTap: (projectId: string, p: { tap: string; file?: string; label?: string }) =>
    req<FlakyRecordResponse>(
      '/flaky/record', { method: 'POST', body: JSON.stringify({ projectId, ...p }) },
    ),
  /** 在服务端运行测试文件并记录（POST /api/flaky/runs）：写 operator。 */
  runFlakyFiles: (projectId: string, files: string[]) =>
    req<FlakyRunsResponse>(
      '/flaky/runs', { method: 'POST', body: JSON.stringify({ projectId, files }) },
    ),
  /** 清空项目历史（POST /api/flaky/clear）：写 operator。 */
  clearFlaky: (projectId: string) =>
    req<{ projectId: string; cleared: boolean }>(
      '/flaky/clear', { method: 'POST', body: JSON.stringify({ projectId }) },
    ),
  /** 变异测试最新报告摘要（GET /api/mutation/latest?projectId=）：读 viewer。 */
  mutationLatest: (projectId: string) =>
    req<{ projectId: string; report: MutationReportSummary | null }>(
      `/mutation/latest?projectId=${encodeURIComponent(projectId)}`,
    ),
  /** 发起一次抽样变异测试（POST /api/mutation/run）：写 operator，后台执行。 */
  runMutation: (projectId: string, p: MutationRunRequest) =>
    req<MutationRunAccepted>(
      '/mutation/run', { method: 'POST', body: JSON.stringify({ projectId, ...p }) },
    ),
  /** 查询变异测试运行状态（GET /api/mutation/runs/:runId）：读 viewer。 */
  mutationRunStatus: (runId: string) =>
    req<MutationRunStatus>(`/mutation/runs/${encodeURIComponent(runId)}`),
  /** 依赖升级快照元数据（GET /api/depscan/snapshot）：读 viewer。 */
  depscanSnapshot: () =>
    req<DepscanSnapshot>('/depscan/snapshot'),
  /** 生成依赖升级计划（POST /api/depscan/advise）：写 operator。 */
  depscanAdvise: (projectId: string, p: { dir?: string; source?: 'snapshot' | 'live' } = {}) =>
    req<{ projectId: string; plan: DepscanPlan }>(
      '/depscan/advise', { method: 'POST', body: JSON.stringify({ projectId, ...p }) },
    ),
  /** 两层忽略文件状态（GET /api/ignores?projectId=）：读 viewer。 */
  ignores: (projectId: string) =>
    req<IgnoreFilesState>(`/ignores?projectId=${encodeURIComponent(projectId)}`),
  /** 保存两层忽略文件（PUT /api/ignores）：写 operator。 */
  updateIgnores: (projectId: string, p: { hard?: string; indexing?: string }) =>
    req<IgnoreFilesState>(
      '/ignores', { method: 'PUT', body: JSON.stringify({ projectId, ...p }) },
    ),
  /** 忽略命中预览（GET /api/ignores/preview）：读 viewer。 */
  previewIgnores: (projectId: string, limit = 200) =>
    req<IgnorePreview>(
      `/ignores/preview?projectId=${encodeURIComponent(projectId)}&limit=${limit}`,
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
  /** R4-B9 TODO 追踪：全项目扫描（服务端快照）。 */
  todos: (root?: string) =>
    req<TodoScanResponse>(`/todos${root ? `?root=${encodeURIComponent(root)}` : ''}`),
  /** R4-B9：单个文件的 TODO 项（编辑器 gutter / overview ruler 用）。 */
  todoFileItems: (path: string, root?: string) =>
    req<{ root: string; items: TodoItem[] }>(
      `/todos/file?path=${encodeURIComponent(path)}${root ? `&root=${encodeURIComponent(root)}` : ''}`,
    ),
  /** R4-B9：更新自定义模式（operator；服务端会话级生效，重启回默认）。 */
  updateTodoConfig: (patterns: TodoPatternInput[], root?: string) =>
    req<TodoScanResponse>('/todos', {
      method: 'PUT',
      body: JSON.stringify({ ...(root ? { root } : {}), patterns }),
    }),
  /** R4-B9：恢复默认模式（operator）。 */
  resetTodoConfig: (root?: string) =>
    req<TodoScanResponse>('/todos/reset', {
      method: 'POST',
      body: JSON.stringify(root ? { root } : {}),
    }),
  /** R5-A5 Trojan Source 防护：扫描编辑器当前文本（inline，不读盘）。 */
  trojanScanText: (filename: string, text: string) =>
    req<{ findings: TrojanHit[] }>('/trojan/scan', {
      method: 'POST',
      body: JSON.stringify({ filename, text }),
    }),
  /** R5-A7 拼写检查：扫描编辑器当前文本（inline，不读盘；带建议）。 */
  spellScanText: (filename: string, text: string) =>
    req<{ findings: SpellHit[] }>('/spell/scan', {
      method: 'POST',
      body: JSON.stringify({ filename, text }),
    }),
  /** R5-A7 拼写检查：项目词典（.ai-factory/spell-dictionary.txt）。 */
  spellDictionaryGet: () =>
    req<{ words: string[]; file: string }>('/spell/dictionary', {}),
  spellDictionaryAdd: (word: string) =>
    req<{ word: string; added: boolean; total: number }>('/spell/dictionary', {
      method: 'POST',
      body: JSON.stringify({ word }),
    }),
  spellDictionaryRemove: (word: string) =>
    req<{ word: string; removed: boolean; total: number }>('/spell/dictionary', {
      method: 'DELETE',
      body: JSON.stringify({ word }),
    }),
  /** R4-S3 确定性重构：分析（preview，只读）→ proposal。 */
  refactorAnalyze: (input: RefactorAnalyzeInput) =>
    req<RefactorProposalResponse>('/api/refactor/analyze', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** R4-S3：应用 proposal 中被接受的条目（drift 则 409）。 */
  refactorApply: (proposalId: string, acceptedIds: string[]) =>
    reqWithStatus<RefactorApplyResponse>('/api/refactor/apply', {
      method: 'POST',
      body: JSON.stringify({ proposalId, acceptedIds }),
    }),
  /** R4-S3：读取 proposal（预览刷新）。 */
  refactorProposal: (proposalId: string) =>
    req<RefactorProposalResponse>(`/api/refactor/proposals/${encodeURIComponent(proposalId)}`),
  /** R4-A7 性能剖析：CPU profile（真实 V8 采样 + 火焰图数据）。 */
  profilerCpu: (input: { script: string; args?: string[]; timeoutMs?: number; sampleIntervalUs?: number }) =>
    req<ProfilerCpuResult>('/api/profiler/cpu', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** R4-A7 性能剖析：堆快照（真实 v8.writeHeapSnapshot 解析摘要）。 */
  profilerHeap: (input: { script: string; args?: string[]; timeoutMs?: number }) =>
    req<ProfilerHeapResult>('/api/profiler/heap', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** R4-A6 HTTP/REST 调试客户端：发送 .http 文件（走出站防火墙）。 */
  httpRun: (input: HttpRunInput) =>
    req<HttpRunResponse>('/api/http/run', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** R4-A6：读取环境文件。 */
  httpEnvironments: (root?: string) =>
    req<HttpEnvironmentsResponse>(`/api/http/environments${root ? `?root=${encodeURIComponent(root)}` : ''}`),
  /** R4-A6：保存环境文件。 */
  httpSaveEnvironments: (root: string | undefined, environments: Record<string, { vars: Record<string, string> }>) =>
    req<HttpEnvironmentsResponse>('/api/http/environments', {
      method: 'PUT',
      body: JSON.stringify({ root, environments }),
    }),
  /** R5-S1 快捷键：读取用户层 keybindings.json。 */
  keybindingsGet: () =>
    req<{ keybindings: Array<{ command: string; key: string | null; when?: string }> }>('/api/keybindings'),
  /** R5-S1 快捷键：整体替换用户层（服务端 fail-closed 校验）。 */
  keybindingsSave: (keybindings: Array<{ command: string; key: string | null; when?: string }>) =>
    req<{ ok: boolean; keybindings: unknown[] }>('/api/keybindings', {
      method: 'PUT',
      body: JSON.stringify({ keybindings }),
    }),
  /** R5-S1 快捷键：清空用户层，回到默认。 */
  keybindingsReset: () =>
    req<{ ok: boolean }>('/api/keybindings', { method: 'DELETE' }),
  /** R5-A6 片段库：读取项目 .ai-factory/snippets.json。 */
  snippetsGet: (root?: string) =>
    req<{ root: string; snippets: Array<{ id: string; trigger: string; description?: string; scope: string[]; body: string }> }>(
      `/api/snippets${root ? `?root=${encodeURIComponent(root)}` : ''}`,
    ),
  /** R5-A6 片段库：整体替换（服务端 fail-closed 校验）。 */
  snippetsSave: (
    root: string,
    snippets: Array<{ id: string; trigger: string; description?: string; scope: string[]; body: string }>,
  ) =>
    req<{ ok: boolean; root: string; snippets: unknown[] }>(
      `/api/snippets?root=${encodeURIComponent(root)}`,
      { method: 'PUT', body: JSON.stringify({ snippets }) },
    ),
  /** R6-S1 扩展系统：列表（含损坏目录）。 */
  extensionsList: (root?: string) =>
    req<{ root: string; installed: ExtensionDto[]; broken: Array<{ name: string; error: string }> }>(
      `/api/extensions${root ? `?root=${encodeURIComponent(root)}` : ''}`,
    ),
  /** R6-S1 扩展系统：内联安装（manifest + main.js）。 */
  extensionsInstall: (root: string, manifest: unknown, main: string) =>
    req<{ extension: ExtensionDto }>('/api/extensions/install', {
      method: 'POST',
      body: JSON.stringify({ root, manifest, main }),
    }),
  /** R6-S1 扩展系统：从项目内目录安装。 */
  extensionsInstallFromDir: (root: string, sourceDir: string) =>
    req<{ extension: ExtensionDto }>('/api/extensions/install-from-dir', {
      method: 'POST',
      body: JSON.stringify({ root, sourceDir }),
    }),
  /** R6-S1 扩展系统：启用/禁用。 */
  extensionsSetEnabled: (name: string, root: string, enabled: boolean) =>
    req<{ extension: ExtensionDto }>(`/api/extensions/${encodeURIComponent(name)}/${enabled ? 'enable' : 'disable'}`, {
      method: 'POST',
      body: JSON.stringify({ root }),
    }),
  /** R6-S1 扩展系统：卸载。 */
  extensionsUninstall: (name: string, root?: string) =>
    req<{ ok: boolean; removed: string }>(
      `/api/extensions/${encodeURIComponent(name)}${root ? `?root=${encodeURIComponent(root)}` : ''}`,
      { method: 'DELETE' },
    ),
  /** R6-S1 扩展系统：运行扩展命令（沙盒内执行）。 */
  extensionsRunCommand: (name: string, command: string, root: string, args: unknown) =>
    req<{ extension: string; command: string; result: unknown; logs: string[] }>(
      `/api/extensions/${encodeURIComponent(name)}/commands/${encodeURIComponent(command)}/run`,
      { method: 'POST', body: JSON.stringify({ root, args }) },
    ),
  /** R6-S1 扩展系统：已启用扩展贡献的面板。 */
  extensionsPanels: (root?: string) =>
    req<{ root: string; panels: ExtensionPanelDto[] }>(
      `/api/extensions/panels${root ? `?root=${encodeURIComponent(root)}` : ''}`,
    ),
  /** R6-S1 扩展系统：已启用扩展贡献的上下文提供器。 */
  extensionsProviders: (root?: string) =>
    req<{ root: string; providers: ExtensionProviderDto[] }>(
      `/api/extensions/providers${root ? `?root=${encodeURIComponent(root)}` : ''}`,
    ),
  /** R6-S1 扩展系统：运行扩展上下文提供器。 */
  extensionsResolveProvider: (name: string, provider: string, root: string, query: string) =>
    req<{ extension: string; provider: string; items: Array<{ label: string; text: string }>; logs: string[] }>(
      `/api/extensions/${encodeURIComponent(name)}/providers/${encodeURIComponent(provider)}/resolve`,
      { method: 'POST', body: JSON.stringify({ root, query }) },
    ),
  /** R5-B10 草稿文件：列表（含语言注册表）。 */
  scratchesList: () =>
    req<{ scratches: ScratchMeta[]; languages: ScratchLanguageDef[] }>('/api/scratches'),
  /** R5-B10 草稿文件：新建。 */
  scratchCreate: (input: { language: string; name?: string }) =>
    req<{ scratch: ScratchMeta }>('/api/scratches', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** R5-B10 草稿文件：读取（含内容）。 */
  scratchGet: (id: string) =>
    req<{ scratch: ScratchFile }>(`/api/scratches/${encodeURIComponent(id)}`),
  /** R5-B10 草稿文件：重命名/保存。 */
  scratchUpdate: (id: string, patch: { name?: string; content?: string }) =>
    req<{ scratch: ScratchMeta }>(`/api/scratches/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  /** R5-B10 草稿文件：删除。 */
  scratchDelete: (id: string) =>
    req<{ ok: boolean }>(`/api/scratches/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** R5-B10 草稿文件：运行（node 可运行语言；显式用户触发）。 */
  scratchRun: (id: string) =>
    req<{ run: ScratchRunResult }>(`/api/scratches/${encodeURIComponent(id)}/run`, {
      method: 'POST',
    }),
  /** R6-S5 任务计划：调度列表（附时区标注）。 */
  schedulesList: () =>
    req<{ schedules: ScheduleItem[]; cronTimezone: string; serverTimezone: string }>('/api/schedules'),
  /** R6-S5：新建调度。 */
  scheduleCreate: (input: { name: string; kind: 'cron' | 'interval' | 'once'; cronExpr?: string; intervalMs?: number; runAt?: string; job: Record<string, unknown> }) =>
    req<{ schedule: ScheduleItem }>('/api/schedules', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** R6-S5：改名 / 暂停 / 恢复。 */
  scheduleUpdate: (id: string, patch: { name?: string; status?: 'active' | 'paused' }) =>
    req<{ schedule: ScheduleItem }>(`/api/schedules/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  /** R6-S5：删除调度。 */
  scheduleDelete: (id: string) =>
    req<{ deleted: boolean }>(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** R6-S5：立即触发一次。 */
  scheduleTrigger: (id: string) =>
    req<{ result: { ok: boolean; summary: string } }>(`/api/schedules/${encodeURIComponent(id)}/trigger`, {
      method: 'POST',
    }),
  /** R6-S5：执行记录（最新在前）。 */
  scheduleRuns: (id: string) =>
    req<{ runs: ScheduleRunRecord[] }>(`/api/schedules/${encodeURIComponent(id)}/runs`),
  /** R4-A5 数据库浏览器：连接列表。 */
  dbConnections: () =>
    req<{ connections: DbBrowserConnection[] }>('/api/db-browser/connections'),
  /** R4-A5：注册连接（sqlite 路径被服务端 jail 在数据目录内）。 */
  dbRegister: (input: { name: string; kind: 'sqlite'; path: string; env?: string } | { name: string; kind: 'postgres'; host?: string; port?: number; user: string; database: string; env?: string }) =>
    req<DbBrowserConnection>('/api/db-browser/connections', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** R4-A5：注销连接。 */
  dbDeregister: (name: string) =>
    req<{ ok: boolean }>(`/api/db-browser/connections/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  /** R4-A5：查询控制台（单语句，守卫：read/write/destructive/blocked）。 */
  dbQuery: (input: { connection: string; sql: string }) =>
    reqWithStatus<DbBrowserQueryResponse>('/api/db-browser/query', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** R4-A5：表列表。 */
  dbTables: (connection: string) =>
    req<{ tables: Array<{ name: string; type: 'table' | 'view' }> }>(
      `/api/db-browser/tables?connection=${encodeURIComponent(connection)}`,
    ),
  /** R4-A5：表数据分页（过滤/排序走服务端校验）。 */
  dbTablePage: (connection: string, name: string, q: { page?: number; pageSize?: number; orderBy?: string; orderDir?: string; filter?: string }) => {
    const p = new URLSearchParams({ connection, name });
    if (q.page !== undefined) p.set('page', String(q.page));
    if (q.pageSize !== undefined) p.set('pageSize', String(q.pageSize));
    if (q.orderBy) p.set('orderBy', q.orderBy);
    if (q.orderDir) p.set('orderDir', q.orderDir);
    if (q.filter) p.set('filter', q.filter);
    return req<DbBrowserTablePage>(`/api/db-browser/table?${p.toString()}`);
  },
  /** R4-A5：行编辑写回（pk 定位，服务端复读验证）。 */
  dbUpdateRow: (input: { connection: string; table: string; pk: Record<string, unknown>; patch: Record<string, unknown> }) =>
    req<{ row: Record<string, unknown> | null; changes: number }>('/api/db-browser/row', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  /** R4-A5：schema 内省。 */
  dbSchema: (connection: string) =>
    req<DbBrowserSchema>(`/api/db-browser/schema?connection=${encodeURIComponent(connection)}`),
  /** R4-A5：schema 对比（加法 DDL；删除只报告不脚本化）。 */
  dbSchemaDiff: (source: string, target: string) =>
    req<DbBrowserSchemaDiff>('/api/db-browser/schema/diff', {
      method: 'POST',
      body: JSON.stringify({ source, target }),
    }),
  /** R4-A5：DDL 生成。 */
  dbDdl: (connection: string, table?: string) =>
    req<{ ddl: string }>(
      `/api/db-browser/ddl?connection=${encodeURIComponent(connection)}${table ? `&table=${encodeURIComponent(table)}` : ''}`,
    ),
  /** R4-A5：ER 关系图（外键拓扑）。 */
  dbEr: (connection: string) =>
    req<DbBrowserErGraph>(`/api/db-browser/er?connection=${encodeURIComponent(connection)}`),
  /** R4-A5：破坏性语句申请票据（守卫 destructive 才可进）。 */
  dbDestructiveRequest: (input: { connection: string; sql: string }) =>
    req<{ ticketId: string; status: string; approveVia: string }>('/api/db-browser/destructive/request', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** R4-A5：票据批准（decided_by 必填）。 */
  dbDestructiveApprove: (ticketId: string, decidedBy: string) =>
    req<{ ticketId: string; status: string }>('/api/db-browser/destructive/approve', {
      method: 'POST',
      body: JSON.stringify({ ticketId, decided_by: decidedBy }),
    }),
  /** R4-A5：票据执行（单次消费，绑定 connection+语句 sha256）。 */
  dbDestructiveExecute: (input: { ticketId: string; connection: string; sql: string }) =>
    reqWithStatus<{ ok: boolean; changes: number; durationMs: number }>('/api/db-browser/destructive/execute', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /* -- R4-S2 DAP 调试器 ------------------------------------------------ */
  /** 调试配置（GET /api/debug/configs）：读 .vscode/launch.json（viewer）。 */
  debugConfigs: (projectId: string) =>
    req<{ configurations: DebugLaunchConfig[]; note?: string }>(
      `/debug/configs?projectId=${encodeURIComponent(projectId)}`,
    ),
  /** 启动调试会话（POST /api/debug/sessions）：写 operator。 */
  debugStartSession: (input: DebugStartSessionInput) =>
    req<DebugSessionStarted>('/debug/sessions', { method: 'POST', body: JSON.stringify(input) }),
  /** 会话列表（GET /api/debug/sessions）：读 viewer。 */
  debugSessions: () => req<{ sessions: DebugSessionSummary[] }>('/debug/sessions'),
  /** 会话状态（GET /api/debug/sessions/:id）：读 viewer。 */
  debugSession: (sessionId: string) =>
    req<{ session: DebugSessionSummary }>(`/debug/sessions/${encodeURIComponent(sessionId)}`),
  /** 目标输出（GET /api/debug/sessions/:id/output）：读 viewer。 */
  debugOutput: (sessionId: string, since = 0) =>
    req<{ lines: DebugOutputLine[]; latestSeq: number }>(
      `/debug/sessions/${encodeURIComponent(sessionId)}/output?since=${since}`,
    ),
  /** 设置断点（POST /api/debug/sessions/:id/breakpoints）：写 operator。 */
  debugSetBreakpoints: (sessionId: string, breakpoints: DebugBreakpointInput[]) =>
    req<{ breakpoints: DebugBreakpoint[] }>(`/debug/sessions/${encodeURIComponent(sessionId)}/breakpoints`, {
      method: 'POST',
      body: JSON.stringify({ breakpoints }),
    }),
  /** 单步/继续/暂停（POST …/continue|next|step-in|step-out|pause）：写 operator。 */
  debugStep: (sessionId: string, action: 'continue' | 'next' | 'step-in' | 'step-out' | 'pause') =>
    req<{ ok: boolean }>(`/debug/sessions/${encodeURIComponent(sessionId)}/${action}`, { method: 'POST' }),
  /** 调用栈（GET …/stack）：读 viewer。 */
  debugStack: (sessionId: string, threadId = 1) =>
    req<{ stackFrames: DebugStackFrame[]; totalFrames: number }>(
      `/debug/sessions/${encodeURIComponent(sessionId)}/stack?threadId=${threadId}`,
    ),
  /** 作用域（GET …/scopes）：读 viewer。 */
  debugScopes: (sessionId: string, frameId: number) =>
    req<{ scopes: DebugScope[] }>(`/debug/sessions/${encodeURIComponent(sessionId)}/scopes?frameId=${frameId}`),
  /** 变量（GET …/variables）：读 viewer。 */
  debugVariables: (sessionId: string, ref: number) =>
    req<{ variables: DebugVariable[] }>(`/debug/sessions/${encodeURIComponent(sessionId)}/variables?ref=${ref}`),
  /** 求值（POST …/evaluate）：写 operator。 */
  debugEvaluate: (sessionId: string, expression: string, frameId?: number) =>
    req<DebugEvalResult>(`/debug/sessions/${encodeURIComponent(sessionId)}/evaluate`, {
      method: 'POST',
      body: JSON.stringify({ expression, frameId }),
    }),
  /** 结束会话（DELETE /api/debug/sessions/:id）：写 operator。 */
  debugStopSession: (sessionId: string) =>
    req<{ ok: boolean }>(`/debug/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
  /** R5-A4 Git blame：逐行 blame（读 viewer）。 */
  blameFile: (path: string) =>
    req<BlameResponse>(`/api/blame?path=${encodeURIComponent(path)}`),
  /** R5-A4 Timeline：git log × local-history 快照融合（读 viewer）。 */
  timelineFile: (path: string) =>
    req<TimelineResponse>(`/api/timeline?path=${encodeURIComponent(path)}`),
  /** R5-A4 Timeline diff：两点之间的 unified diff（读 viewer）。 */
  timelineDiff: (path: string, from: string, to: string) =>
    req<TimelineDiffResponse>(
      `/api/timeline/diff?path=${encodeURIComponent(path)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
  /** R5-S3 三路合并：列出冲突文件（读 viewer）。 */
  mergeConflicts: (repo?: string) =>
    req<{ repo: string; files: MergeConflictFile[] }>(
      `/api/merge/conflicts${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`,
    ),
  /** R5-S3：分析冲突文件（只读：标记块 + diff3 对齐）。 */
  mergeAnalyze: (repo: string | undefined, file: string) =>
    req<MergeAnalysisResponse>('/api/merge/analyze', {
      method: 'POST',
      body: JSON.stringify({ ...(repo ? { repo } : {}), file }),
    }),
  /** R5-S3：逐块解决并写回（drift 则 409；写前影子检查点）。 */
  mergeResolve: (input: {
    repo?: string;
    file: string;
    sha256: string;
    resolutions: MergeHunkResolution[];
    stage?: boolean;
    taskId?: string;
  }) =>
    req<MergeResolveResponse>('/api/merge/resolve', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** R6-S2 交互式 rebase：base..HEAD 的 todo 行（读 viewer）。 */
  rebaseTodos: (repo: string | undefined, base: string) =>
    req<RebaseTodosResponse>(
      `/api/rebase/todos?${repo ? `repo=${encodeURIComponent(repo)}&` : ''}base=${encodeURIComponent(base)}`,
    ),
  /** R6-S2：rebase 进行中状态（读 viewer）。 */
  rebaseStatus: (repo?: string) =>
    req<RebaseStatusResponse>(`/api/rebase/status${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`),
  /** R6-S2：开始 rebase（脏树/进行中则拒；写前影子检查点）。 */
  rebaseStart: (input: { repo?: string; base: string; todos: RebaseTodoInput[] }) =>
    req<RebaseResultResponse>('/api/rebase/start', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** R6-S2：中止/继续/跳过进行中的 rebase（写 operator）。 */
  rebaseAbort: (repo?: string) =>
    req<RebaseResultResponse>('/api/rebase/abort', {
      method: 'POST',
      body: JSON.stringify({ ...(repo ? { repo } : {}) }),
    }),
  rebaseContinue: (repo?: string) =>
    req<RebaseResultResponse>('/api/rebase/continue', {
      method: 'POST',
      body: JSON.stringify({ ...(repo ? { repo } : {}) }),
    }),
  rebaseSkip: (repo?: string) =>
    req<RebaseResultResponse>('/api/rebase/skip', {
      method: 'POST',
      body: JSON.stringify({ ...(repo ? { repo } : {}) }),
    }),
  /** R6-S2：从影子检查点恢复工作区文件（写 operator）。 */
  rebaseRestore: (repo: string | undefined, checkpointId: string) =>
    req<{ restoredId: string; sha: string; leftInPlace: string[] }>('/api/rebase/restore', {
      method: 'POST',
      body: JSON.stringify({ ...(repo ? { repo } : {}), checkpointId }),
    }),
  /** R6-S2 stash：列表（读 viewer）。 */
  stashList: (repo?: string) =>
    req<{ repo: string; entries: StashEntry[] }>(`/api/stash${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`),
  /** R6-S2 stash：单个 diff（读 viewer）。 */
  stashShow: (repo: string | undefined, index: string) =>
    req<{ repo: string; index: string; diff: string }>(
      `/api/stash/show?${repo ? `repo=${encodeURIComponent(repo)}&` : ''}index=${encodeURIComponent(index)}`,
    ),
  /** R6-S2 stash：存入（写 operator）。 */
  stashPush: (repo: string | undefined, message: string, includeUntracked?: boolean) =>
    req<{ entry: StashEntry }>('/api/stash/push', {
      method: 'POST',
      body: JSON.stringify({ ...(repo ? { repo } : {}), message, includeUntracked: includeUntracked === true }),
    }),
  /** R6-S2 stash：应用/弹出/删除（写 operator）。 */
  stashApply: (repo: string | undefined, index: string) =>
    req<StashApplyResponse>('/api/stash/apply', {
      method: 'POST',
      body: JSON.stringify({ ...(repo ? { repo } : {}), index }),
    }),
  stashPop: (repo: string | undefined, index: string) =>
    req<StashApplyResponse>('/api/stash/pop', {
      method: 'POST',
      body: JSON.stringify({ ...(repo ? { repo } : {}), index }),
    }),
  stashDrop: (repo: string | undefined, index: string) =>
    req<{ dropped: string }>('/api/stash/drop', {
      method: 'POST',
      body: JSON.stringify({ ...(repo ? { repo } : {}), index }),
    }),
  /** R5-S2 声明式任务运行器：列出 .ai-factory/tasks.json 的任务。 */
  tasksList: (root?: string) =>
    req<TasksListResponse>(`/api/tasks/list${root ? `?root=${encodeURIComponent(root)}` : ''}`),
  /** R5-S2：保存 tasks.json（服务端 fail-closed 校验，非法 400）。 */
  tasksSave: (text: string, root?: string) =>
    req<{ ok: boolean; count: number; warnings: string[] }>('/api/tasks', {
      method: 'PUT',
      body: JSON.stringify({ text, ...(root ? { root } : {}) }),
    }),
  /** R5-S2：运行任务（含 dependsOn 链；失败 fail-closed 中断）。 */
  tasksRun: (label: string, projectId: string, root?: string) =>
    req<TaskChainResponse>('/api/tasks/run', {
      method: 'POST',
      body: JSON.stringify({ label, projectId, ...(root ? { root } : {}) }),
    }),
  /** R5-S2：最近的运行记录。 */
  tasksRuns: () => req<TaskRunsResponse>('/api/tasks/runs'),
  /** R6-S4 后台任务队列：提交一个 tasks.json 标签链为后台作业。 */
  queueSubmit: (label: string, projectId: string, root?: string) =>
    req<{ job: QueueJobView }>('/api/taskqueue/submit', {
      method: 'POST',
      body: JSON.stringify({ label, projectId, ...(root ? { root } : {}) }),
    }),
  /** R6-S4：作业列表 + 并发配置 + 计数。 */
  queueJobs: () => req<QueueJobsResponse>('/api/taskqueue/jobs'),
  /** R6-S4：作业详情（逐任务结果 + 作业内诊断）。 */
  queueJob: (id: string) => req<QueueJobDetailResponse>(`/api/taskqueue/jobs/${encodeURIComponent(id)}`),
  /** R6-S4：作业日志（512KB 滑动窗口，超限截断并标记）。 */
  queueLog: (id: string) =>
    req<{ jobId: string; log: string; truncated: boolean; byteLength: number }>(
      `/api/taskqueue/jobs/${encodeURIComponent(id)}/log`,
    ),
  /** R6-S4：取消作业（排队中立即取消；运行中杀进程组）。 */
  queueCancel: (id: string) =>
    req<{ job: QueueJobView; result: string }>(`/api/taskqueue/jobs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  /** R6-S4：并发配置读取/设置（1–32）。 */
  queueConfig: () => req<{ maxConcurrency: number; running: number; queued: number }>('/api/taskqueue/config'),
  queueSetConfig: (maxConcurrency: number) =>
    req<{ maxConcurrency: number; running: number; queued: number }>('/api/taskqueue/config', {
      method: 'PUT',
      body: JSON.stringify({ maxConcurrency }),
    }),
  /** R5-B9 书签：按项目 root 列出。 */
  bookmarksList: (root?: string) =>
    req<{ root: string; bookmarks: BookmarkDto }>(
      `/api/bookmarks${root ? `?root=${encodeURIComponent(root)}` : ''}`,
    ),
  /** R5-B9：新增书签（行书签服务端抓取漂移上下文）。 */
  bookmarksAdd: (input: BookmarkInputDto) =>
    req<{ bookmark: BookmarkDto[0] }>('/api/bookmarks', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** R5-B9：改名/改标签/改助记（mnemonic: null 清除）。 */
  bookmarksPatch: (id: string, patch: BookmarkPatchDto, root?: string) =>
    req<{ bookmark: BookmarkDto[0] }>(
      `/api/bookmarks?id=${encodeURIComponent(id)}${root ? `&root=${encodeURIComponent(root)}` : ''}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),
  /** R5-B9：删除书签。 */
  bookmarksDelete: (id: string, root?: string) =>
    req<{ ok: boolean; removed: string }>(
      `/api/bookmarks?id=${encodeURIComponent(id)}${root ? `&root=${encodeURIComponent(root)}` : ''}`,
      { method: 'DELETE' },
    ),
  /** R5-B9：编辑器一键开关行书签。 */
  bookmarksToggle: (path: string, line: number, root?: string) =>
    req<{ added: boolean; bookmark?: BookmarkDto[0]; removedId?: string }>('/api/bookmarks/toggle', {
      method: 'POST',
      body: JSON.stringify({ path, line, ...(root ? { root } : {}) }),
    }),
  /** R5-B9：跳转解析（漂移检查，绝不静默跳错行）。 */
  bookmarksResolve: (id: string, root?: string) =>
    req<BookmarkResolveDto>('/api/bookmarks/resolve', {
      method: 'POST',
      body: JSON.stringify({ id, ...(root ? { root } : {}) }),
    }),
  /** R6-S3 文件监听联动：列出 watch 规则（+ active 状态）。 */
  watchRules: (root?: string) =>
    req<WatchRulesResponse>(`/api/watch/rules${root ? `?root=${encodeURIComponent(root)}` : ''}`),
  /** R6-S3：新建 watch 规则（服务端 fail-closed 校验，非法 400）。 */
  watchCreate: (rule: WatchRuleInput, root?: string) =>
    req<{ rule: WatchRuleView }>('/api/watch/rules', {
      method: 'POST',
      body: JSON.stringify({ rule, ...(root ? { root } : {}) }),
    }),
  /** R6-S3：替换 watch 规则（active 规则会重启监听）。 */
  watchUpdate: (id: string, rule: WatchRuleInput, root?: string) =>
    req<{ rule: WatchRuleView }>(`/api/watch/rules/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ rule, ...(root ? { root } : {}) }),
    }),
  /** R6-S3：删除 watch 规则（先停监听）。 */
  watchDelete: (id: string, root?: string) =>
    req<{ ok: boolean }>(
      `/api/watch/rules/${encodeURIComponent(id)}${root ? `?root=${encodeURIComponent(root)}` : ''}`,
      { method: 'DELETE' },
    ),
  /** R6-S3：启动一条规则的监听。 */
  watchEnable: (id: string, root?: string) =>
    req<{ ok: boolean; watchedDirs: number }>(`/api/watch/rules/${encodeURIComponent(id)}/enable`, {
      method: 'POST',
      body: JSON.stringify({ ...(root ? { root } : {}) }),
    }),
  /** R6-S3：停止一条规则的监听。 */
  watchDisable: (id: string, root?: string) =>
    req<{ ok: boolean; wasActive: boolean }>(`/api/watch/rules/${encodeURIComponent(id)}/disable`, {
      method: 'POST',
      body: JSON.stringify({ ...(root ? { root } : {}) }),
    }),
  /** R6-S3：启动该项目全部已启用规则。 */
  watchActivate: (root?: string) =>
    req<{ started: string[]; failed: Array<{ id: string; error: string }> }>('/api/watch/activate', {
      method: 'POST',
      body: JSON.stringify({ ...(root ? { root } : {}) }),
    }),
  /** R6-S3：停止该项目全部监听。 */
  watchDeactivate: (root?: string) =>
    req<{ stopped: number }>('/api/watch/deactivate', {
      method: 'POST',
      body: JSON.stringify({ ...(root ? { root } : {}) }),
    }),
  /** R6-S3：触发记录（最新在前）。 */
  watchTriggers: (root?: string) =>
    req<{ triggers: WatchTriggerView[] }>(`/api/watch/triggers${root ? `?root=${encodeURIComponent(root)}` : ''}`),
  /** R6-S3：监听状态摘要。 */
  watchStatus: (root?: string) =>
    req<WatchStatusView>(`/api/watch/status${root ? `?root=${encodeURIComponent(root)}` : ''}`),
};

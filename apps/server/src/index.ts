/**
 * Local backend for the AI Engineering Factory prototype.
 * Plain node:http JSON API (no framework) over the SQLite database.
 * The React UI (and later the Electron main process) talks to this.
 *
 *   GET  /api/health
 *   GET  /api/projects            POST /api/projects {name, description?, path?}
 *                                 (list excludes archived projects unless
 *                                 ?includeArchived=1 or ?status=archived)
 *   POST /api/projects/:id/archive    {actor?}  → lifecycle active → archived
 *   POST /api/projects/:id/unarchive  {actor?}  → archived → active
 *                                 (both idempotent: re-applying the current
 *                                 state returns 200 with changed:false;
 *                                 archived projects refuse NEW facts with
 *                                 409 PROJECT_ARCHIVED — see project-guard.ts)
 *   GET  /api/tasks?projectId=    POST /api/tasks {projectId, title, goal?, ...}
 *   GET  /api/tasks/:id
 *   POST /api/tasks/:id/transition   {to, actor?}   (v1 engine)
 *   POST /api/tasks/:id/v2-transition {toState|to, by|actor, ...}  (v2 engine, §18.2)
 *   GET  /api/tasks/:id/v2-state     (v2 three-state view, §18/§19)
 *   POST /api/tasks/:id/evidence     {type, title, payload?, createdBy?,
 *                                     requirementId?, requirementVersion?}
 *                                     (§16/§18.2: the pair records the
 *                                     requirement version the evidence was
 *                                     collected against; validated to exist)
 *   POST /api/tasks/:id/subtasks     {title, ...}
 *   POST /api/tasks/:id/dependencies {kind, taskId}
 *   POST /api/tasks/:id/request-dispatch    (§17.2: DRAFT → WAITING_HUMAN_DISPATCH)
 *   POST /api/tasks/:id/dispatch            {actor?, assigneeAgentId?, via?, policyRuleId?, ticketId?}
 *                                           (§17.2 Human Dispatch → AUTHORIZED;
 *                                            via=POLICY requires policyRuleId, or a
 *                                            registered ticket via ticketId — G-09)
 *   POST /api/tasks/:id/reject-dispatch     {actor?, reason?} (→ DRAFT)
 *   POST /api/tasks/:id/revoke-authorization {actor?, reason?} (→ REVOKED)
 *   POST /api/tasks/:id/expire-authorization {actor?, reason?} (→ EXPIRED)
 *   GET  /api/agents              POST /api/agents {...}
 *   GET  /api/org
 *   GET  /api/board?projectId=
 *   GET  /api/evidence?taskId=
 *   GET  /api/audit?limit=
 */
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  AgentRegistry,
  AuditLog,
  EvidenceEngine,
  ScopeViolationError,
  Task,
  TaskAuthorizationError,
  TaskManager,
  TaskStatus,
  WorkflowEngine,
  allowedNextStates,
  checkSubtaskScope,
  effectiveAuthorizationStatus,
  nowIso,
  type InitialTaskAuthorizationStatus,
  type TaskAuthorizationStatus,
} from '@ai-factory/core';
import {
  FactoryDatabase,
  seedIfEmpty,
  TICKET_ACTION_DISPATCH,
  ticketCoverageGaps,
  type AuthorizationTicket,
} from '@ai-factory/db';
import { NotificationEngine } from '@ai-factory/notifications';
import { createSecretBrokerFromEnv } from '@ai-factory/secrets';
import { CheckpointLog, OperationLedger } from '@ai-factory/runtime';
import type { StepIntentStore, TargetLedgerQuery } from '@ai-factory/runtime';
import type { RouteContext } from './routes/context';
import {
  BuildRunner,
  buildRunnerConfigFromEnv,
  sbomDirFromEnv,
} from './build-runner';
import { SBOM_FILE_RE } from '@ai-factory/cicd';
import { handleGitRoutes } from './routes/git';
import { handleWorktreeRoutes } from './routes/worktrees';
import { handleQaRoutes } from './routes/qa';
import { handleApprovalRoutes } from './routes/approvals';
import { handleCicdRoutes } from './routes/cicd';
import { handleSkillsRoutes } from './routes/skills';
import { handleMemoryRoutes } from './routes/memory';
import { handleModelRouterRoutes } from './routes/model-router';
import {
  RUNTIME_TOOLS_ENV,
  handleRuntimeRoutes,
  resolveRuntimeToolAllowlist,
  runtimeToolsStartupError,
  setRuntimeCheckpointLog,
  setRuntimeManifestStore,
  setRuntimeRunStore,
} from './routes/runtime';
import { handleOrchestratorRoutes } from './routes/orchestrator';
import { handleWorkforceRoutes } from './routes/workforce';
import { handleMcpRoutes } from './routes/mcp';
import { handleKnowledgeRoutes } from './routes/knowledge';
import { handleEvaluationRoutes } from './routes/evaluation';
import { handleProjectsRoutes } from './routes/projects';
import { handleFinalReportRoutes } from './routes/final-report';
import { handleProjectIoRoutes } from './routes/project-io';
import {
  isProjectArchived,
  isTaskProjectArchived,
  projectArchivedBody,
  projectIdOfTask,
} from './routes/project-guard';
import { handleReviewRoutes } from './routes/review';
import { handleReleaseRoutes } from './routes/releases';
import { handlePolicyRoutes } from './routes/policy';
import { handleExecRoutes } from './routes/exec';
import { handleTerminalRoutes } from './routes/terminal';
import { handleSecretRoutes } from './routes/secrets';
import { handleFileRoutes } from './routes/files';
import { handleChangesRoutes } from './routes/changes';
import { handleSecurityRoutes } from './routes/security';
import { handleRecoveryRoutes } from './routes/recovery';
import { handleResourceRoutes } from './routes/resources';
import { handleAutonomyRoutes } from './routes/autonomy';
import { handleCoordinationRoutes } from './routes/coordination';
import {
  getRequirementManager,
  handleRequirementRoutes,
  initRequirementManager,
} from './routes/requirements';
import { handleProgressRoutes } from './routes/progress';
import { handleIsolationRoutes } from './routes/isolation';
import { handleToolRoutes } from './routes/tools';
import { handleLeaseRoutes } from './routes/leases';
import { handleFactoryControlRoutes } from './routes/factory-control';
import { handleIncidentsRoutes } from './routes/incidents';
import { handleQuotaRoutes } from './routes/quota';
import { handleWatchdogRoutes } from './routes/watchdog';
import { handleTakeoverRoutes } from './routes/takeover';
import { handleDisputeRoutes } from './routes/disputes';
import { handleReportRoutes } from './routes/reports';
import { handleV2TransitionRoutes } from './routes/v2-transitions';
import { handleDashboardRoutes } from './routes/dashboard';
import { handleNotificationRoutes } from './routes/notifications';
import { handleEventRoutes } from './routes/events';
import { handleActivityRoutes } from './routes/activity';
import {
  applyPendingRestore,
  backupDirPath,
  createBackup,
  handleBackupRoutes,
  initBackupService,
  listBackupManifests,
  resolveBackupConfig,
  stagedRestoreBackupId,
} from './routes/backup';
import { handleRetentionRoutes } from './routes/retention';
import { initMcpPersistence } from './routes/mcp';
import {
  backupScheduler,
  handleBackupScheduleRoutes,
  initBackupScheduler,
  TICK_MS,
} from './routes/backup-scheduler';
import { handleAuthorizationTicketRoutes } from './routes/authorization-tickets';
import { EventBus } from '@ai-factory/events';
import {
  API_TOKEN_ENV,
  API_TOKENS_ENV,
  WHOAMI_PATH,
  authMode,
  enforceApiAuth,
  requestRole,
  resolveApiAuthConfig,
  resolveApiToken,
  startupRbacError,
} from './auth';

const PORT = Number(process.env.PORT ?? 3100);
// SPEC §7.4 — the control-plane API binds loopback by default. Override
// only for an explicitly planned deployment (AI_FACTORY_HOST).
const HOST = process.env.AI_FACTORY_HOST ?? '127.0.0.1';
const DB_PATH = process.env.DB_PATH ?? './data/factory.db';
// API authentication (sellable checklist B + Batch 15 RBAC; see ./auth).
// FACTORY_API_TOKEN is the legacy single token (an admin credential);
// FACTORY_API_TOKENS adds role tokens ("viewer:…,operator:…,admin:…").
// Neither set = open local mode on loopback; a non-loopback bind without
// any credential is a fatal startup error, and a malformed
// FACTORY_API_TOKENS value is fatal too — both fail-closed before any
// side effect (no DB open). Error text never echoes a token value.
const API_TOKEN = resolveApiToken();
const authResolution = resolveApiAuthConfig();
if (authResolution.errors.length > 0) {
  for (const e of authResolution.errors) {
    console.error(`[ai-factory] refusing to start: invalid ${API_TOKENS_ENV}: ${e}`);
  }
  process.exit(1);
}
const AUTH_CONFIG = authResolution.config;
const AUTH_MODE = authMode(AUTH_CONFIG);
const authStartupError = startupRbacError(HOST, AUTH_CONFIG);
if (authStartupError) {
  console.error(authStartupError);
  process.exit(1);
}

// Runtime tool allowlist (FACTORY_RUNTIME_TOOLS; see routes/runtime):
// an entry naming an unregistered tool is an operator typo — refuse to
// start (fail-closed, before the DB is opened) instead of silently
// granting a different tool set than the operator configured.
const runtimeToolsError = runtimeToolsStartupError();
if (runtimeToolsError) {
  console.error(runtimeToolsError);
  process.exit(1);
}
const RUNTIME_TOOL_ALLOWLIST = resolveRuntimeToolAllowlist();

function ensureDir(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

ensureDir(DB_PATH);
/**
 * Backup/restore (Batch 13-3): a restore staged by POST /api/restore is
 * applied HERE — before the database is opened — by swapping the staged
 * snapshot into place. The outgoing file is kept as
 * <db>.superseded-<ts> (with its WAL sidecars); the RESTORE_APPLIED
 * audit record is written into the restored database just after the
 * AuditLog is constructed below. See routes/backup.ts for the full
 * semantics (validation → pre-restore backup → stage → apply at boot).
 */
const pendingRestoreApplied = applyPendingRestore(path.resolve(DB_PATH));
if (pendingRestoreApplied.applied) {
  console.log(
    `[ai-factory] staged restore applied (backup ${pendingRestoreApplied.info?.backupId ?? 'unknown'}); ` +
      `previous database kept at ${pendingRestoreApplied.supersededPath}`,
  );
}
const fdb = new FactoryDatabase(DB_PATH);

const tasks = new TaskManager(fdb.tasks);
const evidence = new EvidenceEngine(fdb.evidence);
const audit = new AuditLog(fdb.audit);
/**
 * §40 post-merge build execution (Batch 24). The runner is
 * constructed exactly once, here, from explicit operator
 * configuration. No FACTORY_BUILD_COMMAND → no runner → build
 * records honestly stay NOT_EXECUTED (never a silent downgrade:
 * the absence is the documented default, and BUILD_STARTED never
 * fires without it).
 */
const buildRunnerConfig = buildRunnerConfigFromEnv();
const buildRunner = buildRunnerConfig
  ? new BuildRunner({ fdb, audit, evidence }, buildRunnerConfig)
  : null;
if (buildRunnerConfig) {
  console.log(
    `[ai-factory] post-merge builds (§40): enabled, command=${JSON.stringify(
      buildRunnerConfig.command.slice(0, 80),
    )}, timeoutMs=${buildRunnerConfig.timeoutMs}`,
  );
  /**
   * Batch 27 — orphan workspace reconcile: a previous boot that died
   * mid-build (SIGKILL between `git worktree add` and cleanup) leaves
   * detached worktrees on disk. Reap them now. Fire-and-forget here —
   * pump() awaits the reconcile promise before the first build runs,
   * so ordering is still guaranteed (no top-level await allowed).
   */
  buildRunner?.startReconcile();
}
/**
 * §46.2 Secret Broker (Batch 18; see @ai-factory/secrets).
 * FACTORY_SECRETS_BACKEND selects the primary backend (file vault by
 * default; keychain / memory / env are explicit alternatives), with
 * the FACTORY_SECRET_* env store always behind it in the chain.
 * Misconfiguration is fatal here — most importantly backend=keychain
 * with no keychain tool: §46.2 forbids silently downgrading to
 * weaker storage, so the server refuses to start instead. The audit
 * hook records every broker event by ref; values never pass through
 * it (the event type has no field that could carry one).
 */
let secretBrokerSetup: ReturnType<typeof createSecretBrokerFromEnv>;
try {
  secretBrokerSetup = createSecretBrokerFromEnv({
    audit: (event) =>
      audit.record(event.actor, event.action, 'secret', event.name, {
        ref: event.ref,
        backend: event.backend,
        purpose: event.purpose,
        ...(event.rotated !== undefined ? { rotated: event.rotated } : {}),
        ...(event.error !== undefined ? { error: event.error } : {}),
      }),
  });
} catch (e) {
  console.error(`[ai-factory] refusing to start: secret broker setup failed: ${(e as Error).message}`);
  process.exit(1);
}
if (pendingRestoreApplied.applied) {
  audit.record(
    'system',
    'RESTORE_APPLIED',
    'backup',
    pendingRestoreApplied.info?.backupId ?? 'unknown',
    {
      stagedAt: pendingRestoreApplied.info?.stagedAt ?? null,
      preRestoreBackupId: pendingRestoreApplied.info?.preRestoreBackupId ?? null,
      supersededPath: pendingRestoreApplied.supersededPath ?? null,
    },
    { result: 'APPLIED' },
  );
}
/**
 * §28.1/§28.3 (G-59) — step intents live in the database now: this is
 * the SQLite-backed StepIntentStore from the FactoryDatabase, handed to
 * runAgent via RouteContext (routes/runtime.ts). An embedder without a
 * database injects nothing and runAgent falls back to a fresh in-memory
 * store — wiring only, no durability (see routes/context.ts).
 */
const stepIntentStore: StepIntentStore = fdb.stepIntents;

/**
 * Startup scan (§28.3): every PENDING intent in the DB predates this
 * process — a previous process died between persistIntent and
 * recordResult. The scan only REPORTS: an audit record (always written,
 * count included, so "scan ran and found nothing" is itself on the
 * record) plus the /api/health summary below. It never marks an intent
 * executed and never replays a tool call; disposition (reconcile
 * against the target system, controlled recovery) is an upper-layer
 * decision.
 */
const interruptedAtStartup = fdb.stepIntents.listInterrupted();
audit.record(
  'system',
  'STARTUP_INTERRUPTED_INTENTS',
  'step_intent',
  'startup-scan',
  {
    count: interruptedAtStartup.length,
    intentIds: interruptedAtStartup.map((i) => i.id),
    runIds: [...new Set(interruptedAtStartup.map((i) => i.runId))],
  },
  { result: interruptedAtStartup.length > 0 ? 'FOUND' : 'NONE' },
);
if (interruptedAtStartup.length > 0) {
  console.warn(
    `[ai-factory] startup scan: ${interruptedAtStartup.length} step intent(s) left uncommitted by a previous process (audit: STARTUP_INTERRUPTED_INTENTS)`,
  );
}
const startupIntentScan = {
  at: nowIso(),
  interruptedCount: interruptedAtStartup.length,
};

/**
 * §28.2 (G-59) — the external-operation ledger is durable too: the
 * coordinator constructs it over the SQLite OperationStore from the
 * FactoryDatabase, so operations a previous process prepared or
 * dispatched survive the restart instead of vanishing with its memory.
 * An embedder without a database constructs OperationLedger with no
 * store and gets the in-memory default — wiring only, no durability.
 * (No route consumes the ledger yet; it lives at coordinator level
 * alongside the startup passes below, like the intent scan.)
 */
const operationLedger = new OperationLedger({ store: fdb.operations });

/**
 * §28.3 (G-59, Batch 13) — checkpoints are durable AND consumed: the
 * coordinator builds the runtime CheckpointLog over the SQLite
 * CheckpointStore from the FactoryDatabase, and the runtime run path
 * is its first production consumer — every executed step of an HTTP
 * run captures a CheckpointV2 into this log (routes/runtime.ts,
 * createRunCheckpointCapture), and GET
 * /api/runtime/runs/:id/checkpoints[/latest] serves the captures back
 * as the recovery entry point. The install into the route module
 * (setRuntimeCheckpointLog, below with the other route installs) hands
 * the route THIS log, so the health block below counts exactly what
 * the run path writes: the stored count grows by one per executed
 * run step. Nothing auto-resumes from a checkpoint (§28.4) — a
 * restart serves an interrupted run's latest checkpoint as its
 * recovery point and leaves the decision to a human/controller.
 */
const checkpointLog = new CheckpointLog({ store: fdb.checkpoints });

/**
 * §16 (F2) — requirements are durable too: the shared
 * RequirementManager behind /api/requirements is re-constructed over
 * the SQLite RequirementStore from the FactoryDatabase, so requirement
 * versions, §16 compatibility declarations, promotion holds and entity
 * links survive restarts. Before this the manager was a process-wide
 * in-memory singleton: after a restart, registering evidence with a
 * requirement pin failed ("unknown requirement version") and a task
 * caught mid-STALE-gate could not proceed until an operator recreated
 * the requirement, its versions and the declarations by hand. The swap
 * happens here, before the server accepts requests; every consumer
 * reads the manager through getRequirementManager() per request. The
 * health block below reports the store's live requirement count.
 */
initRequirementManager(fdb.requirements);

/**
 * Run records (walkthrough F4) — the runtime routes' registry is
 * installed over the SQLite RuntimeRunStore, so a run's record survives
 * the restart its step intents and evidence already survived (GET
 * /api/runtime/runs/:id after a restart used to 404). The route module
 * keeps an in-memory default for standalone use; this install is the
 * coordinator's one wiring act, done before the server takes traffic.
 * Records a dead process left mid-flight stay as last persisted —
 * possibly RUNNING, the honest state of an interrupted run; nothing
 * reaps or rewrites them (same report-only philosophy as the scans
 * above).
 */
setRuntimeRunStore(fdb.runs);

/**
 * Run manifests (Batch 15) — the runtime route's manifest store is
 * installed over the SQLite RunManifestStore, so each run's
 * accountability record (creation snapshot + completion accounting)
 * survives restarts alongside the run record it answers for. The
 * route module keeps an in-memory default for standalone use; this
 * install is the coordinator's one wiring act, done before the
 * server takes traffic. Runs created before this wiring have no
 * manifest row — their manifest query answers an honest 404.
 */
setRuntimeManifestStore(fdb.runManifests);

/**
 * Checkpoints (§28.3, Batch 13) — the runtime route's checkpoint log
 * is installed over the coordinator's CheckpointLog above (the one
 * /api/health counts), so run-path captures land in SQLite and
 * survive the restart they exist for. The route module keeps an
 * in-memory default for standalone use; this install is the
 * coordinator's one wiring act, done before the server takes traffic.
 */
setRuntimeCheckpointLog(checkpointLog);

/**
 * Backup/restore (Batch 13-3) — the routes in routes/backup.ts read
 * their config (live DB path, backup dir from FACTORY_BACKUP_DIR or
 * <db dir>/backups, app version) from this install, done before the
 * server takes traffic like the other coordinator wirings above.
 */
initBackupService(resolveBackupConfig(DB_PATH));

/**
 * MCP registry durability (§46, Batch 21): registrations, trust
 * assessments and install records are hydrated from fdb.mcpServers
 * and written through from here on — a restart no longer sends
 * approved servers back to BLOCKED. Health reports are stored but
 * marked stale on hydrate, never trusted as fresh.
 */
initMcpPersistence(fdb);

/**
 * Backup schedules (§47, Batch 20) — the in-process scheduler runs
 * the same createBackup() the manual endpoint uses, on a 30s tick.
 * Schedules are durable rows: boot() reconciles plans whose slot
 * passed while the process was down, marking them MISSED (audited,
 * never backfilled).
 */
initBackupScheduler({
  schedules: fdb.backupSchedules,
  audit: {
    record: (actor, event, entityType, entityId, details) =>
      audit.record(actor, event, entityType, entityId, details),
  },
  runBackup: () => createBackup(fdb, 'scheduled'),
});
backupScheduler().boot();
const backupSchedulerTimer = setInterval(() => {
  try {
    backupScheduler().tick();
  } catch (e) {
    // A tick must never take the process down; the per-schedule
    // failures are already recorded on their rows.
    console.error('backup scheduler tick failed:', (e as Error).message);
  }
}, TICK_MS);
if (typeof backupSchedulerTimer.unref === 'function') backupSchedulerTimer.unref();

/**
 * Startup reconcile (§28.2): every non-terminal operation in the DB
 * predates this process — it was left PREPARED / DISPATCHED / UNKNOWN
 * by a process that died. Each one runs through the ledger's existing
 * reconcile() before anything else can touch it.
 *
 * The target query honestly cannot answer at boot: this server holds
 * no live handle to the target systems (deploy targets, PR hosts), so
 * the query reports "not found" for every key. Under §28.2 that yields
 * exactly the safe dispositions — reversible ⇒ safe-to-retry (the retry
 * reuses the same idempotency key), irreversible ⇒
 * needs-manual-recovery — and with an unanswering target reconcile()
 * adopts nothing and mutates no state (adoption requires a target
 * answer). So this pass CLASSIFIES and reports; disposition beyond
 * that (querying a real target ledger, controlled recovery) is an
 * upper-layer decision, and blind replay never happens here.
 */
const UNANSWERABLE_TARGET: TargetLedgerQuery = {
  findByIdempotencyKey: () => undefined,
};
const opReconcileResults = operationLedger
  .listOperations()
  .filter((op) => op.state !== 'CONFIRMED_SUCCEEDED' && op.state !== 'CONFIRMED_FAILED')
  .map((op) => ({ op, result: operationLedger.reconcile(op.id, UNANSWERABLE_TARGET) }));
const opReconcileCounts = {
  total: opReconcileResults.length,
  safeToRetry: opReconcileResults.filter((r) => r.result.action === 'safe-to-retry').length,
  needsManualRecovery: opReconcileResults.filter(
    (r) => r.result.action === 'needs-manual-recovery',
  ).length,
};
audit.record(
  'system',
  'STARTUP_OPERATION_RECONCILE',
  'external_operation',
  'startup-reconcile',
  {
    ...opReconcileCounts,
    target: 'unavailable-at-boot',
    safeToRetryIds: opReconcileResults
      .filter((r) => r.result.action === 'safe-to-retry')
      .map((r) => r.op.id),
    needsManualRecoveryIds: opReconcileResults
      .filter((r) => r.result.action === 'needs-manual-recovery')
      .map((r) => r.op.id),
  },
  {
    result:
      opReconcileCounts.needsManualRecovery > 0
        ? 'MANUAL_RECOVERY_REQUIRED'
        : opReconcileCounts.total > 0
          ? 'CLASSIFIED'
          : 'NONE',
  },
);
if (opReconcileCounts.needsManualRecovery > 0) {
  console.warn(
    `[ai-factory] startup reconcile: ${opReconcileCounts.needsManualRecovery} external operation(s) need manual recovery (audit: STARTUP_OPERATION_RECONCILE)`,
  );
}
const startupOperationScan = {
  at: nowIso(),
  unresolvedCount: opReconcileCounts.total,
  safeToRetryCount: opReconcileCounts.safeToRetry,
  needsManualRecoveryCount: opReconcileCounts.needsManualRecovery,
};

const agents = new AgentRegistry(fdb.agents);
const engine = new WorkflowEngine({ tasks, evidence, audit });
const notify = new NotificationEngine();
/** System Event Bus — spec §91; shared by all route modules via RouteContext. */
const bus = new EventBus({ retention: 2000 });

seedIfEmpty(fdb);

// ---------------------------------------------------------------- helpers -
function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function taskView(id: string) {
  const t = tasks.get(id);
  return {
    ...t,
    evidence: evidence.listByTask(id),
    nextStates: allowedNextStates(t.status).map((d) => ({
      to: d.to,
      note: d.note,
      requires: d.requires.map((r) => r.label),
    })),
  };
}

// ---------------------------------------------------------------- routes --
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      return res.end();
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // API token gate (checklist B + Batch 15 RBAC): the single
    // pre-dispatch point. Everything under /api except GET /api/health
    // requires a Bearer credential when any is configured; the matched
    // credential fixes the caller's role (viewer/operator/admin) and
    // role-gated surfaces (backup/restore, retention, policy) answer
    // 403. Denials are audited (AUTH_DENIED / RBAC_DENIED) inside
    // enforceApiAuth. OPTIONS preflight above stays open — it carries
    // no credentials and grants nothing.
    if (!enforceApiAuth(req, res, { token: API_TOKEN, roleTokens: AUTH_CONFIG.roleTokens, audit, json })) return;

    // Whoami (Batch 15): the caller's own role + the auth mode, for
    // clients (the desktop top bar) to display. Past the gate, so a
    // configured deployment only answers authenticated callers; the
    // body carries role/mode only — never any token.
    if (method === 'GET' && path === WHOAMI_PATH) {
      const identity = requestRole(req, AUTH_CONFIG);
      if (identity.role === null) return json(res, 401, { error: 'Unauthorized' });
      return json(res, 200, {
        role: identity.role,
        mode: identity.mode,
        authRequired: identity.authRequired,
      });
    }

    // Health — includes the §28.3 startup scan summary (G-59): how many
    // step intents a previous process left uncommitted when this process
    // booted, and when the scan ran. Live intent state is in the audit
    // record STARTUP_INTERRUPTED_INTENTS and the step_intents table.
    // The operations block is the §28.2 counterpart: how many external
    // operations were left non-terminal at boot and how the startup
    // reconcile classified them (audit: STARTUP_OPERATION_RECONCILE,
    // table: external_operations). The checkpoints block is the §28.3
    // durability status: the store backing the coordinator's
    // CheckpointLog and how many checkpoints it currently holds — the
    // run path captures one per executed run step (Batch 13), so the
    // count grows with real run activity (live, read per request). The
    // requirements block is the §16 (F2) counterpart: the durable
    // store backing the shared RequirementManager and how many
    // requirements it currently holds (live count, read per request). The runs
    // block is the F4 counterpart: the store backing the runtime
    // routes' run registry and how many run records it currently
    // holds (live, read per request). The retention block is the §47
    // (Batch 14) counterpart: how many retention policies are
    // configured (of the managed categories) and how many legal holds
    // are currently active — deletion itself only ever happens via
    // POST /api/retention/enforce, never from here. The outbox block
    // is the §18.2 (Batch 17) counterpart: how many committed v2
    // transition/finalize events are stored in outbox_events and still
    // undispatched (pending consumer acknowledgement), live per
    // request — drain only ever happens via the engine's in-process
    // consumers, never from here.
    if (method === 'GET' && path === '/api/health') {
      return json(res, 200, {
        ok: true,
        ts: nowIso(),
        stepIntents: {
          store: 'sqlite',
          startupScanAt: startupIntentScan.at,
          interruptedAtStartup: startupIntentScan.interruptedCount,
        },
        operations: {
          store: 'sqlite',
          startupReconcileAt: startupOperationScan.at,
          unresolvedAtStartup: startupOperationScan.unresolvedCount,
          safeToRetryAtStartup: startupOperationScan.safeToRetryCount,
          needsManualRecoveryAtStartup: startupOperationScan.needsManualRecoveryCount,
        },
        checkpoints: {
          store: 'sqlite',
          stored: checkpointLog.list().length,
        },
        requirements: {
          store: 'sqlite',
          stored: fdb.requirements.listRequirements().length,
        },
        runs: {
          store: 'sqlite',
          stored: fdb.runs.list().length,
        },
        retention: {
          store: 'sqlite',
          policiesConfigured: fdb.retention
            .listPolicies()
            .filter((p) => p.retentionDays !== null && p.retentionDays !== 0)
            .length,
          activeHolds: fdb.retention.activeHolds().length,
        },
        outbox: {
          store: 'sqlite',
          pending: fdb.outbox.countPending(),
        },
        secrets: {
          backend: secretBrokerSetup.backend,
          chain: secretBrokerSetup.chain,
          stored: (await secretBrokerSetup.broker.list()).length,
        },
      });
    }

    // Modular routes: git (§34), qa (§36–§38), approvals (§45, §69),
    // cicd (§39–§41, §77), skills (§47–§49, §74), memory (§54–§58),
    // model-router (§28–§30), runtime (§24–§27), orchestrator (§92–§95, §21),
    // workforce (§14, §18–§20, §59), mcp (§46, §73), knowledge (§50–§53),
    // evaluation (§57–§58).
    // Each handler returns true when it owned the path.
    const routeCtx: RouteContext = {
      tasks, evidence, audit, agents, engine, fdb, stepIntentStore, notify, bus, json, readBody,
      // §47 (Batch 14): retention reads/deletes backup directories and
      // must respect a staged restore — the backup module owns both.
      backupAccess: {
        dir: backupDirPath,
        list: listBackupManifests,
        stagedRestoreBackupId,
      },
      // Batch 26 — SBOM file access for the retention 'sboms'
      // category. Same directory the build runner writes to; wired
      // even when no build command is configured (the directory may
      // still hold files from an earlier configuration).
      sbomAccess: {
        dir: () => sbomDirFromEnv(),
        list: () => {
          const dir = sbomDirFromEnv();
          let entries: string[];
          try {
            entries = fs.readdirSync(dir);
          } catch {
            return [];
          }
          return entries.filter((name) => {
            if (!SBOM_FILE_RE.test(name)) return false;
            try {
              return fs.statSync(`${dir}/${name}`).isFile();
            } catch {
              return false;
            }
          });
        },
      },
      // Batch 14 — the archive guard evaluator for the route modules
      // that cannot import project-guard directly (see context.ts).
      archivedTaskBody: (taskId: string) =>
        isTaskProjectArchived(fdb, taskId)
          ? projectArchivedBody(projectIdOfTask(fdb, taskId) as string)
          : null,
      // §46.2 (Batch 18) — the Secret Broker for /api/secrets and for
      // consumption points (exec secretEnv injection).
      secretBroker: secretBrokerSetup.broker,
      // §40 (Batch 24) — post-merge build runner. Only constructed
      // when FACTORY_BUILD_COMMAND is explicitly configured; otherwise
      // build records honestly stay NOT_EXECUTED.
      ...(buildRunner ? { buildRunner } : {}),
    };
    if (await handleGitRoutes(req, res, url, routeCtx)) return;
    if (await handleWorktreeRoutes(req, res, url, routeCtx)) return;
    if (await handleQaRoutes(req, res, url, routeCtx)) return;
    if (await handleApprovalRoutes(req, res, url, routeCtx)) return;
    if (await handleCicdRoutes(req, res, url, routeCtx)) return;
    if (await handleSkillsRoutes(req, res, url, routeCtx)) return;
    if (await handleMemoryRoutes(req, res, url, routeCtx)) return;
    if (await handleModelRouterRoutes(req, res, url, routeCtx)) return;
    if (await handleRuntimeRoutes(req, res, url, routeCtx)) return;
    if (await handleOrchestratorRoutes(req, res, url, routeCtx)) return;
    if (await handleWorkforceRoutes(req, res, url, routeCtx)) return;
    if (await handleMcpRoutes(req, res, url, routeCtx)) return;
    if (await handleKnowledgeRoutes(req, res, url, routeCtx)) return;
    if (await handleEvaluationRoutes(req, res, url, routeCtx)) return;
    if (await handleProjectsRoutes(req, res, url, routeCtx)) return;
    if (await handleFinalReportRoutes(req, res, url, routeCtx)) return;
    if (await handleProjectIoRoutes(req, res, url, routeCtx)) return;
    if (await handleReviewRoutes(req, res, url, routeCtx)) return;
    if (await handleReleaseRoutes(req, res, url, routeCtx)) return;
    if (await handlePolicyRoutes(req, res, url, routeCtx)) return;
    if (await handleExecRoutes(req, res, url, routeCtx)) return;
    if (await handleTerminalRoutes(req, res, url, routeCtx)) return;
    if (await handleSecretRoutes(req, res, url, routeCtx)) return;
    if (await handleFileRoutes(req, res, url, routeCtx)) return;
    if (await handleChangesRoutes(req, res, url, routeCtx)) return;
    if (await handleSecurityRoutes(req, res, url, routeCtx)) return;
    if (await handleRecoveryRoutes(req, res, url, routeCtx)) return;
    if (await handleResourceRoutes(req, res, url, routeCtx)) return;
    if (await handleAutonomyRoutes(req, res, url, routeCtx)) return;
    if (await handleCoordinationRoutes(req, res, url, routeCtx)) return;
    if (await handleRequirementRoutes(req, res, url, routeCtx)) return;
    if (await handleProgressRoutes(req, res, url, routeCtx)) return;
    if (await handleIsolationRoutes(req, res, url, routeCtx)) return;
    if (await handleToolRoutes(req, res, url, routeCtx)) return;
    if (await handleLeaseRoutes(req, res, url, routeCtx)) return;
    if (await handleFactoryControlRoutes(req, res, url, routeCtx)) return;
    if (await handleIncidentsRoutes(req, res, url, routeCtx)) return;
    if (await handleQuotaRoutes(req, res, url, routeCtx)) return;
    if (await handleWatchdogRoutes(req, res, url, routeCtx)) return;
    if (await handleTakeoverRoutes(req, res, url, routeCtx)) return;
    if (await handleDisputeRoutes(req, res, url, routeCtx)) return;
    if (await handleReportRoutes(req, res, url, routeCtx)) return;
    if (await handleV2TransitionRoutes(req, res, url, routeCtx)) return;
    if (await handleDashboardRoutes(req, res, url, routeCtx)) return;
    if (await handleNotificationRoutes(req, res, url, routeCtx)) return;
    if (await handleEventRoutes(req, res, url, routeCtx)) return;
    if (await handleActivityRoutes(req, res, url, routeCtx)) return;
    if (await handleBackupRoutes(req, res, url, routeCtx)) return;
    if (await handleBackupScheduleRoutes(req, res, url, routeCtx)) return;
    if (await handleRetentionRoutes(req, res, url, routeCtx)) return;
    if (await handleAuthorizationTicketRoutes(req, res, url, routeCtx)) return;

    // Projects
    if (path === '/api/projects' && method === 'GET') {
      // Archive lifecycle (Batch 14): the default listing is the working
      // set — active projects only. Archived projects come back with
      // ?includeArchived=1, or alone with ?status=archived.
      const statusParam = url.searchParams.get('status');
      if (statusParam !== null && statusParam !== 'active' && statusParam !== 'archived') {
        return json(res, 400, { error: `status must be 'active' or 'archived', got: ${statusParam}` });
      }
      const includeArchived =
        url.searchParams.get('includeArchived') === '1' ||
        url.searchParams.get('includeArchived') === 'true';
      return json(res, 200, fdb.listProjects({
        status: statusParam === 'active' || statusParam === 'archived' ? statusParam : undefined,
        includeArchived,
      }));
    }
    if (path === '/api/projects' && method === 'POST') {
      const b = await readBody(req);
      if (!b['name']) return json(res, 400, { error: 'name is required' });
      const p = fdb.createProject({
        id: randomUUID(),
        name: String(b['name']),
        description: String(b['description'] ?? ''),
        path: String(b['path'] ?? ''),
      });
      audit.record('human', 'PROJECT_CREATED', 'project', p.id, { name: p.name });
      return json(res, 201, p);
    }

    // Project lifecycle (Batch 14): POST /api/projects/:id/archive|unarchive.
    // Idempotent — re-applying the state the project is already in returns
    // 200 with changed:false and writes no second audit record. Archiving
    // deletes nothing; it only closes the project to new facts (409
    // PROJECT_ARCHIVED on guarded writes) until unarchived.
    const projectLifecycle = path.match(/^\/api\/projects\/([^/]+)\/(archive|unarchive)$/);
    if (method === 'POST' && projectLifecycle) {
      const projectId = decodeURIComponent(projectLifecycle[1]);
      const target = projectLifecycle[2] === 'archive' ? 'archived' : 'active';
      const existing = fdb.getProject(projectId);
      if (!existing) return json(res, 404, { error: `project not found: ${projectId}` });
      const b = await readBody(req);
      const actor = String(b['actor'] ?? 'human');
      if (existing.status === target) {
        return json(res, 200, { ...existing, changed: false });
      }
      const updated = fdb.setProjectStatus(projectId, target);
      audit.record(actor, target === 'archived' ? 'PROJECT_ARCHIVED' : 'PROJECT_UNARCHIVED', 'project', projectId, {
        name: existing.name,
      });
      return json(res, 200, { ...updated, changed: true });
    }

    // Task board (§85 simplified): tasks grouped by status column.
    if (path === '/api/board' && method === 'GET') {
      const projectId = url.searchParams.get('projectId') ?? 'proj-myapp';
      const all = tasks.listByProject(projectId);
      const columns: Record<string, unknown[]> = {};
      for (const t of all) {
        const list = columns[t.status] ?? (columns[t.status] = []);
        const agent = t.currentAgentId ? agents.get(t.currentAgentId) : null;
        list.push({
          id: t.id, title: t.title, priority: t.priority,
          status: t.status, risk: t.risk,
          agent: agent ? agent.displayName : null,
          agentCount: t.assignedAgentIds.length,
          updatedAt: t.updatedAt,
        });
      }
      return json(res, 200, { projectId, columns });
    }

    // Tasks
    if (path === '/api/tasks' && method === 'GET') {
      const projectId = url.searchParams.get('projectId');
      const all = projectId ? tasks.listByProject(projectId) : tasks.list();
      return json(res, 200, all);
    }
    if (path === '/api/tasks' && method === 'POST') {
      const b = await readBody(req);
      if (!b['projectId'] || !b['title']) {
        return json(res, 400, { error: 'projectId and title are required' });
      }
      // Archived projects are closed to new facts (Batch 14).
      if (isProjectArchived(fdb, String(b['projectId']))) {
        return json(res, 409, projectArchivedBody(String(b['projectId'])));
      }
      // §17.2 (Batch 17) — creation is not execution authorization. The
      // caller may file the task as DRAFT (unsubmitted) or
      // WAITING_HUMAN_DISPATCH (a TODO awaiting a Human Dispatch, the
      // AI-discovered-problem path). Absent the field the task is
      // AUTHORIZED — the human-create-and-dispatch case §17.2 allows,
      // and the behaviour every pre-existing caller relied on.
      const INITIAL_AUTHORIZATIONS: readonly string[] = ['DRAFT', 'WAITING_HUMAN_DISPATCH', 'AUTHORIZED'];
      if (
        b['authorizationStatus'] !== undefined &&
        !INITIAL_AUTHORIZATIONS.includes(b['authorizationStatus'] as string)
      ) {
        return json(res, 400, {
          error: 'authorizationStatus must be DRAFT | WAITING_HUMAN_DISPATCH | AUTHORIZED',
        });
      }
      const initialAuthorization = b['authorizationStatus'] as InitialTaskAuthorizationStatus | undefined;
      const t = tasks.create({
        projectId: String(b['projectId']),
        title: String(b['title']),
        goal: String(b['goal'] ?? ''),
        description: String(b['description'] ?? ''),
        priority: (b['priority'] as Task['priority'] | undefined) ?? 'P2',
        acceptanceCriteria: Array.isArray(b['acceptanceCriteria']) ? (b['acceptanceCriteria'] as string[]) : [],
        constraints: Array.isArray(b['constraints']) ? (b['constraints'] as string[]) : [],
        creator: 'human',
        authorizationStatus: initialAuthorization,
        // §17.4 (Batch 18) — the inheritance carriers are recordable
        // at creation: a root's requirement pin, policy ceiling and
        // budget envelope are what subtask inheritance copies and
        // the Scope Checker judges against, so they must be settable
        // through the same API that creates the root. Malformed
        // values are ignored (the fields stay unrecorded) rather
        // than coerced into a scope the caller never stated.
        ...(typeof b['requirementRef'] === 'string' && b['requirementRef']
          ? { requirementRef: b['requirementRef'] }
          : {}),
        ...(Array.isArray(b['policyCeiling']) &&
        (b['policyCeiling'] as unknown[]).every((e) => typeof e === 'string')
          ? { policyCeiling: b['policyCeiling'] as string[] }
          : {}),
        ...(typeof b['budgetEnvelope'] === 'object' &&
        b['budgetEnvelope'] !== null &&
        !Array.isArray(b['budgetEnvelope']) &&
        Object.values(b['budgetEnvelope'] as Record<string, unknown>).every(
          (v) => typeof v === 'number' && Number.isFinite(v),
        )
          ? { budgetEnvelope: b['budgetEnvelope'] as Record<string, number> }
          : {}),
      });
      audit.record('human', 'TASK_CREATED', 'task', t.id, { title: t.title });
      // §17.2 — a task created straight into AUTHORIZED at the caller's
      // explicit request is the create-and-dispatch case, and the spec
      // wants the dispatch itself on the audit record. (No field = the
      // legacy default; nothing extra is recorded.)
      if (initialAuthorization === 'AUTHORIZED') {
        audit.record('human', 'TASK_DISPATCHED', 'task', t.id, {
          to: 'AUTHORIZED',
          via: 'CREATE',
        });
      }
      bus.emit('TASK_CREATED', { taskId: t.id, title: t.title, projectId: t.projectId }, 'tasks');
      return json(res, 201, taskView(t.id));
    }

    const taskMatch = path.match(/^\/api\/tasks\/([^/]+)(\/.*)?$/);
    if (taskMatch) {
      const id = decodeURIComponent(taskMatch[1]);
      const suffix = taskMatch[2] ?? '';
      if (method === 'GET' && suffix === '') {
        return json(res, 200, taskView(id));
      }
      if (method === 'POST' && suffix === '/transition') {
        if (isTaskProjectArchived(fdb, id)) {
          return json(res, 409, projectArchivedBody(projectIdOfTask(fdb, id) as string));
        }
        const b = await readBody(req);
        const to = b['to'] as TaskStatus;
        const actor = String(b['actor'] ?? 'human');
        if (!to) return json(res, 400, { error: 'to (target state) is required' });
        try {
          const r = engine.requestTransition(id, to, actor);
          if (!r.ok) return json(res, 422, r);
          // Notification trigger (module 30): a task entering BLOCKED pings
          // the human with a HIGH-priority in-app notification.
          if (to === 'BLOCKED') {
            const t = tasks.get(id);
            notify.emit({
              type: 'TASK_BLOCKED',
              actor,
              entity: { kind: 'task', id, label: t.title },
              detail: { from: r.from ?? undefined },
            });
          }
          // §91 — task lifecycle events on the system bus.
          bus.emit(
            'WORKFLOW_TRANSITIONED',
            { taskId: id, from: r.from ?? undefined, to, actor },
            'workflow',
          );
          if (to === 'DONE') {
            bus.emit('TASK_COMPLETED', { taskId: id, actor }, 'workflow');
          }
          return json(res, 200, { ...r, task: taskView(id) });
        } catch (e) {
          return json(res, 404, { error: (e as Error).message });
        }
      }
      // §17.2 (Batch 17) — Human Dispatch flow. Each action validates
      // the authorization state machine in TaskManager (illegal moves
      // → 409 with the observed state), writes exactly one audit event,
      // and — like every task-scoped write — refuses archived projects.
      if (
        method === 'POST' &&
        (suffix === '/request-dispatch' ||
          suffix === '/dispatch' ||
          suffix === '/reject-dispatch' ||
          suffix === '/revoke-authorization' ||
          suffix === '/expire-authorization')
      ) {
        if (isTaskProjectArchived(fdb, id)) {
          return json(res, 409, projectArchivedBody(projectIdOfTask(fdb, id) as string));
        }
        const b = await readBody(req);
        // §17.2 — an operational pre-authorization (via=POLICY) records
        // its triggering policy and Rule ID and must not masquerade as
        // a human click: it requires the Rule ID, and its default audit
        // actor is 'policy', not 'human'.
        const via = b['via'] === 'POLICY' ? 'POLICY' : 'HUMAN';
        const actor = String(b['actor'] ?? (via === 'POLICY' ? 'policy' : 'human'));
        const reason = typeof b['reason'] === 'string' && b['reason'] ? b['reason'] : undefined;
        try {
          const from = effectiveAuthorizationStatus(tasks.get(id));
          if (suffix === '/request-dispatch') {
            const t = tasks.requestDispatch(id);
            audit.record(actor, 'TASK_DISPATCH_REQUESTED', 'task', id, {
              from,
              to: t.authorizationStatus,
            });
            return json(res, 200, { from, to: t.authorizationStatus, task: taskView(id) });
          }
          if (suffix === '/dispatch') {
            let policyRuleId =
              typeof b['policyRuleId'] === 'string' && b['policyRuleId'] ? b['policyRuleId'] : undefined;
            const ticketId =
              typeof b['ticketId'] === 'string' && b['ticketId'] ? b['ticketId'] : undefined;
            // §17.2 (Batch 18, G-09) — a POLICY dispatch may consume a
            // registered pre-authorization ticket instead of presenting
            // a bare Rule ID. The ticket is validated BEFORE anything
            // mutates (exists → effective status ACTIVE → Rule ID
            // agrees with the body → scope covers this task); every
            // refusal is a 400 with the reason in the audit trail, the
            // task is not dispatched and the ticket is not consumed.
            // Consumption itself is recorded only after the dispatch
            // commits, so a dispatch the state machine refuses (409
            // below) never burns a ticket.
            let ticket: AuthorizationTicket | undefined;
            if (ticketId !== undefined) {
              const rejectTicket = (
                error: string,
                details: Record<string, unknown>,
              ) => {
                audit.record(actor, 'AUTHORIZATION_TICKET_REJECTED', 'authorization_ticket', ticketId, {
                  ticketId,
                  taskId: id,
                  ...details,
                });
                return json(res, 400, {
                  error,
                  code: 'AUTHORIZATION_TICKET_INVALID',
                  ticketId,
                  ...details,
                });
              };
              if (via !== 'POLICY') {
                return rejectTicket(
                  'ticketId is only meaningful when via is POLICY (a ticket is an operational pre-authorization)',
                  { reason: 'via_not_policy' },
                );
              }
              const found = fdb.authorizationTickets.get(ticketId);
              if (!found) {
                return rejectTicket('authorization ticket not found', {
                  reason: 'not_found',
                });
              }
              if (found.status !== 'ACTIVE') {
                return rejectTicket(
                  `authorization ticket is ${found.status}, not ACTIVE`,
                  { reason: 'not_active', status: found.status },
                );
              }
              if (policyRuleId !== undefined && policyRuleId !== found.policyRuleId) {
                return rejectTicket(
                  `policyRuleId ${policyRuleId} does not match the ticket's Rule ID ${found.policyRuleId}`,
                  { reason: 'rule_id_mismatch', ticketPolicyRuleId: found.policyRuleId },
                );
              }
              const taskForScope = tasks.get(id);
              const gaps = ticketCoverageGaps(
                found,
                { projectId: taskForScope.projectId, priority: taskForScope.priority },
                TICKET_ACTION_DISPATCH,
              );
              if (gaps.length > 0) {
                return rejectTicket(
                  `authorization ticket scope does not cover this task: ${gaps.join('; ')}`,
                  { reason: 'scope_gap', gaps },
                );
              }
              // The ticket's Rule ID is the recorded trigger — it
              // satisfies (and supersedes) the bare-Rule-ID requirement.
              policyRuleId = found.policyRuleId;
              ticket = found;
            }
            if (via === 'POLICY' && !policyRuleId) {
              return json(res, 400, {
                error: 'policyRuleId is required when via is POLICY (§17.2: a pre-authorization records its triggering policy and Rule ID)',
              });
            }
            const assigneeAgentId =
              typeof b['assigneeAgentId'] === 'string' && b['assigneeAgentId']
                ? b['assigneeAgentId']
                : undefined;
            const t = tasks.dispatch(id, { assigneeAgentId });
            if (ticket) {
              fdb.authorizationTickets.recordConsumption(ticket.id, {
                taskId: id,
                action: TICKET_ACTION_DISPATCH,
                consumedBy: actor,
              });
              audit.record(actor, 'AUTHORIZATION_TICKET_CONSUMED', 'authorization_ticket', ticket.id, {
                ticketId: ticket.id,
                taskId: id,
                policyRuleId: ticket.policyRuleId,
              });
            }
            audit.record(actor, 'TASK_DISPATCHED', 'task', id, {
              from,
              to: t.authorizationStatus,
              via,
              ...(policyRuleId ? { policyRuleId } : {}),
              ...(ticket ? { ticketId: ticket.id } : {}),
              ...(assigneeAgentId ? { assigneeAgentId } : {}),
            });
            return json(res, 200, { from, to: t.authorizationStatus, task: taskView(id) });
          }
          if (suffix === '/reject-dispatch') {
            const t = tasks.rejectDispatch(id);
            audit.record(actor, 'TASK_DISPATCH_REJECTED', 'task', id, {
              from,
              to: t.authorizationStatus,
              ...(reason ? { reason } : {}),
            });
            return json(res, 200, { from, to: t.authorizationStatus, task: taskView(id) });
          }
          if (suffix === '/revoke-authorization') {
            const t = tasks.revokeAuthorization(id);
            audit.record(actor, 'TASK_AUTHORIZATION_REVOKED', 'task', id, {
              from,
              to: t.authorizationStatus,
              ...(reason ? { reason } : {}),
            });
            return json(res, 200, { from, to: t.authorizationStatus, task: taskView(id) });
          }
          const t = tasks.expireAuthorization(id);
          audit.record(actor, 'TASK_AUTHORIZATION_EXPIRED', 'task', id, {
            from,
            to: t.authorizationStatus,
            ...(reason ? { reason } : {}),
          });
          return json(res, 200, { from, to: t.authorizationStatus, task: taskView(id) });
        } catch (e) {
          if (e instanceof TaskAuthorizationError) {
            return json(res, 409, {
              error: e.message,
              code: 'TASK_AUTHORIZATION_STATE',
              authorizationStatus: e.from,
            });
          }
          return json(res, 404, { error: (e as Error).message });
        }
      }
      if (method === 'POST' && suffix === '/evidence') {
        if (isTaskProjectArchived(fdb, id)) {
          return json(res, 409, projectArchivedBody(projectIdOfTask(fdb, id) as string));
        }
        const b = await readBody(req);
        if (!b['type'] || !b['title']) {
          return json(res, 400, { error: 'type and title are required' });
        }
        // §16/§18.2 (Batch 8) — optional requirement context. When the
        // caller supplies requirementId + requirementVersion, the version
        // is persisted on the evidence row as the pin ref it was collected
        // against, and the v2 gate later judges staleness against it. The
        // pair must be supplied together and the version must exist in the
        // shared RequirementManager — a context claim that does not check
        // out is a 400, never silently dropped and never recorded as-is.
        // No context supplied → recorded as null (not tracked, not stale).
        let requirementPin: string | null = null;
        if (b['requirementId'] !== undefined || b['requirementVersion'] !== undefined) {
          const reqId = b['requirementId'];
          const reqVer = b['requirementVersion'];
          if (
            typeof reqId !== 'string' || !reqId ||
            typeof reqVer !== 'number' || !Number.isInteger(reqVer) || reqVer < 1
          ) {
            return json(res, 400, {
              error: 'requirementId (string) and requirementVersion (positive integer) must be supplied together',
            });
          }
          try {
            getRequirementManager().getVersion(reqId, reqVer);
          } catch (e) {
            return json(res, 400, {
              error: `unknown requirement version ${reqId}@${reqVer}: ${(e as Error).message}`,
            });
          }
          requirementPin = `${reqId}@${reqVer}`;
        }
        try {
          const ev = evidence.create({
            taskId: id,
            type: b['type'] as 'plan',
            title: String(b['title']),
            payload: (b['payload'] as Record<string, unknown>) ?? {},
            createdBy: String(b['createdBy'] ?? 'human'),
            requirementVersion: requirementPin,
          });
          audit.record(String(b['createdBy'] ?? 'human'), 'EVIDENCE_ATTACHED', 'evidence', ev.id, {
            taskId: id, type: ev.type,
            ...(requirementPin ? { requirementVersion: requirementPin } : {}),
          });
          return json(res, 201, ev);
        } catch (e) {
          return json(res, 404, { error: (e as Error).message });
        }
      }
      if (method === 'POST' && suffix === '/subtasks') {
        if (isTaskProjectArchived(fdb, id)) {
          return json(res, 409, projectArchivedBody(projectIdOfTask(fdb, id) as string));
        }
        const b = await readBody(req);
        if (!b['title']) return json(res, 400, { error: 'title is required' });
        // §17.4 (Batch 18, G-11) — the Scope Checker's real
        // consumption point: a subtask proposal is judged against
        // its ROOT's recorded authorization scope before anything is
        // created. The check runs only when the caller actually
        // proposes scope-bearing fields (relation / authorization /
        // ceiling / budget / ACs / requirement pin) — a plain
        // title-only creation keeps the pre-existing behaviour
        // exactly, and plain inheritance inside createSubtask can
        // never violate. A refused proposal creates nothing, and the
        // refusal is audited with the structured violations.
        const strArr = (v: unknown): string[] | undefined =>
          Array.isArray(v) && v.every((e) => typeof e === 'string')
            ? (v as string[])
            : undefined;
        const relation =
          typeof b['relation'] === 'string' ? b['relation'] : undefined;
        const rawAuthorization =
          typeof b['authorizationStatus'] === 'string'
            ? b['authorizationStatus']
            : undefined;
        if (
          rawAuthorization !== undefined &&
          !(
            ['DRAFT', 'WAITING_HUMAN_DISPATCH', 'AUTHORIZED'] as string[]
          ).includes(rawAuthorization)
        ) {
          return json(res, 400, {
            error:
              'authorizationStatus at creation must be DRAFT|WAITING_HUMAN_DISPATCH|AUTHORIZED (REVOKED/EXPIRED are reached through the §17.2 transitions, or inherited from a dead root)',
          });
        }
        const requestedAuthorization = rawAuthorization as
          | InitialTaskAuthorizationStatus
          | undefined;
        const policyCeiling = strArr(b['policyCeiling']);
        const acceptanceCriteria = strArr(b['acceptanceCriteria']);
        const budgetEnvelope =
          typeof b['budgetEnvelope'] === 'object' &&
          b['budgetEnvelope'] !== null &&
          !Array.isArray(b['budgetEnvelope']) &&
          Object.values(b['budgetEnvelope'] as Record<string, unknown>).every(
            (v) => typeof v === 'number' && Number.isFinite(v),
          )
            ? (b['budgetEnvelope'] as Record<string, number>)
            : undefined;
        const requirementRef =
          typeof b['requirementRef'] === 'string' ? b['requirementRef'] : undefined;
        const proposesScope =
          relation !== undefined ||
          requestedAuthorization !== undefined ||
          policyCeiling !== undefined ||
          budgetEnvelope !== undefined ||
          acceptanceCriteria !== undefined ||
          requirementRef !== undefined;
        try {
          if (proposesScope) {
            const scope = checkSubtaskScope((tid) => tasks.get(tid), id, {
              relation,
              authorizationStatus: requestedAuthorization,
              policyCeiling,
              budgetEnvelope,
              acceptanceCriteria,
              requirementRef,
            });
            if (!scope.ok) {
              audit.record('human', 'TASK_SUBTASK_SCOPE_REJECTED', 'task', id, {
                parentTaskId: id,
                rootTaskId: scope.rootTaskId,
                violations: scope.violations,
              });
              return json(res, 422, {
                error: 'subtask proposal is outside the root authorization scope (§17.4)',
                code: 'TASK_SCOPE_VIOLATION',
                rootTaskId: scope.rootTaskId,
                violations: scope.violations,
              });
            }
          }
          const sub = tasks.createSubtask(id, {
            title: String(b['title']),
            goal: String(b['goal'] ?? ''),
            priority: (b['priority'] as 'P0' | 'P1' | 'P2' | 'P3' | 'P4') ?? 'P2',
            ...(relation !== undefined ? { parentRelation: relation } : {}),
            ...(requestedAuthorization !== undefined
              ? { authorizationStatus: requestedAuthorization }
              : {}),
            ...(policyCeiling !== undefined ? { policyCeiling } : {}),
            ...(budgetEnvelope !== undefined ? { budgetEnvelope } : {}),
            ...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}),
            ...(requirementRef !== undefined ? { requirementRef } : {}),
          });
          audit.record('human', 'TASK_CREATED', 'task', sub.id, { title: sub.title, parent: id });
          return json(res, 201, sub);
        } catch (e) {
          // createSubtask re-enforces the same rules for programmatic
          // callers; surface its refusal as the same 422 shape.
          if (e instanceof ScopeViolationError) {
            return json(res, 422, {
              error: (e as Error).message,
              code: 'TASK_SCOPE_VIOLATION',
              violations: e.violations,
            });
          }
          return json(res, 404, { error: (e as Error).message });
        }
      }
      if (method === 'POST' && suffix === '/dependencies') {
        if (isTaskProjectArchived(fdb, id)) {
          return json(res, 409, projectArchivedBody(projectIdOfTask(fdb, id) as string));
        }
        const b = await readBody(req);
        try {
          const t = tasks.addDependency(
            id,
            b['kind'] as 'depends_on',
            String(b['taskId']),
          );
          return json(res, 200, t);
        } catch (e) {
          return json(res, 400, { error: (e as Error).message });
        }
      }
    }

    // Agents
    if (path === '/api/agents' && method === 'GET') {
      return json(res, 200, agents.list());
    }
    if (path === '/api/agents' && method === 'POST') {
      const b = await readBody(req);
      try {
        const a = agents.register({
          name: String(b['name'] ?? ''),
          displayName: b['displayName'] ? String(b['displayName']) : undefined,
          jobTitle: String(b['jobTitle'] ?? ''),
          department: b['department'] ? String(b['department']) : undefined,
          parentAgentId: b['parentAgentId'] ? String(b['parentAgentId']) : null,
          mission: b['mission'] ? String(b['mission']) : undefined,
          autonomyLevel: b['autonomyLevel'] as 0 | 1 | 2 | 3 | 4 | 5 | undefined,
          permissions: Array.isArray(b['permissions']) ? (b['permissions'] as never[]) : undefined,
          skills: Array.isArray(b['skills']) ? (b['skills'] as string[]) : undefined,
        });
        audit.record('human', 'AGENT_CREATED', 'agent', a.id, { name: a.name, jobTitle: a.jobTitle });
        bus.emit('AGENT_CREATED', { agentId: a.id, name: a.name, jobTitle: a.jobTitle }, 'workforce');
        return json(res, 201, a);
      } catch (e) {
        return json(res, 400, { error: (e as Error).message });
      }
    }
    if (path === '/api/org' && method === 'GET') {
      return json(res, 200, agents.orgTree());
    }

    // Evidence + audit
    if (path === '/api/evidence' && method === 'GET') {
      const taskId = url.searchParams.get('taskId');
      if (!taskId) return json(res, 400, { error: 'taskId is required' });
      return json(res, 200, evidence.listByTask(taskId));
    }
    if (path === '/api/audit' && method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? 100);
      return json(res, 200, audit.list().slice(-limit).reverse());
    }

    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    return json(res, 500, { error: (e as Error).message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[ai-factory] API listening on http://${HOST}:${PORT} (db: ${DB_PATH})`);
  if (AUTH_MODE === 'rbac') {
    const roleNames = [...new Set(AUTH_CONFIG.roleTokens.map((t) => t.role))].join(', ');
    console.log(
      `[ai-factory] API authentication enabled with role tokens (${API_TOKENS_ENV} is set): ` +
        `${AUTH_CONFIG.roleTokens.length} token(s) for role(s): ${roleNames}` +
        (API_TOKEN ? `; ${API_TOKEN_ENV} also set (admin)` : ''),
    );
  } else if (API_TOKEN) {
    console.log(`[ai-factory] API authentication enabled (${API_TOKEN_ENV} is set)`);
  } else {
    console.warn(
      `[ai-factory] WARNING: API authentication disabled — neither ${API_TOKEN_ENV} nor ` +
        `${API_TOKENS_ENV} is set, so any local process can call this API. Acceptable on ` +
        'the loopback desktop bind only; the server refuses non-loopback binds in this state.',
    );
  }
  if (RUNTIME_TOOL_ALLOWLIST.length > 0) {
    console.log(
      `[ai-factory] Runtime tools granted to HTTP runs (${RUNTIME_TOOLS_ENV}): ` +
        RUNTIME_TOOL_ALLOWLIST.join(', '),
    );
  }
  console.log(
    `[ai-factory] Secret broker (§46.2): backend=${secretBrokerSetup.backend}, ` +
      `chain=${secretBrokerSetup.chain.join(' → ')}` +
      (secretBrokerSetup.vaultPath ? `, vault=${secretBrokerSetup.vaultPath}` : '') +
      (secretBrokerSetup.backend === 'memory'
        ? ' — EPHEMERAL session: secrets die with this process (explicitly configured)'
        : ''),
  );
});

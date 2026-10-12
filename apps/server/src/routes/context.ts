/**
 * Shared context for modular server routes (apps/server/src/routes/*).
 * Each route module exports:
 *   export async function handleXxxRoutes(
 *     req: IncomingMessage, res: ServerResponse, url: URL, ctx: RouteContext,
 *   ): Promise<boolean>   // true when the route was handled
 * The coordinator wires these into apps/server/src/index.ts.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type {
  AgentRegistry,
  AuditLog,
  EvidenceEngine,
  TaskManager,
  WorkflowEngine,
} from '@ai-factory/core';
import type { FactoryDatabase } from '@ai-factory/db';
import type { NotificationEngine } from '@ai-factory/notifications';
import type { BackupManifest } from './backup';
import type { EventBus } from '@ai-factory/events';
import type { StepIntentStore } from '@ai-factory/runtime';

export interface RouteContext {
  tasks: TaskManager;
  evidence: EvidenceEngine;
  audit: AuditLog;
  agents: AgentRegistry;
  engine: WorkflowEngine;
  fdb: FactoryDatabase;
  /**
   * §28.1 (G-59) — the step-intent store runAgent writes through. The
   * coordinator injects the SQLite-backed store (FactoryDatabase), so
   * intents survive restarts. An embedder without a database omits this
   * and runAgent falls back to its fresh in-memory StepIntentStore —
   * wiring only, no durability; that fallback is the documented
   * no-DB behavior, not a silent downgrade of this server.
   */
  stepIntentStore: StepIntentStore;
  /** In-app notification engine (spec module 30). */
  notify: NotificationEngine;
  /**
   * §47 (Batch 14) — backup-directory access for the retention
   * routes: retention ages/deletes backup directories and must never
   * delete the snapshot a pending restore will boot from, and the
   * backup module owns that state. The coordinator injects the backup
   * module's accessors. An embedder without the backup service omits
   * this; the retention backups category then reports itself unwired
   * and deletes nothing (retention never deletes blind).
   */
  backupAccess?: {
    dir(): string;
    list(): BackupManifest[];
    stagedRestoreBackupId(): string | null;
  };
  /**
   * Batch 14 — archived-project write guard, injected by the
   * coordinator (backed by routes/project-guard.ts): returns the
   * uniform 409 body when the task's project is archived, else null.
   * This indirection exists for the two route modules that tests
   * import straight from src (runtime.ts, review.ts): an extensionless
   * VALUE import of './project-guard' does not resolve under Node's
   * type-stripping ESM loader, while the sibling imports they already
   * had are type-only (erased). An embedder that omits this gets no
   * archive refusals from those two modules — the coordinator's own
   * server always injects it.
   */
  archivedTaskBody?: (
    taskId: string,
  ) => { error: string; code: 'PROJECT_ARCHIVED'; projectId: string } | null;
  /** System Event Bus — spec §91, shared singleton created in index.ts. */
  bus: EventBus;
  json(res: ServerResponse, status: number, body: unknown): void;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
}

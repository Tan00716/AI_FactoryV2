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
import type { EventBus } from '@ai-factory/events';

export interface RouteContext {
  tasks: TaskManager;
  evidence: EvidenceEngine;
  audit: AuditLog;
  agents: AgentRegistry;
  engine: WorkflowEngine;
  fdb: FactoryDatabase;
  /** In-app notification engine (spec module 30). */
  notify: NotificationEngine;
  /** System Event Bus — spec §91, shared singleton created in index.ts. */
  bus: EventBus;
  json(res: ServerResponse, status: number, body: unknown): void;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
}

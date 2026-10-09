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

export interface RouteContext {
  tasks: TaskManager;
  evidence: EvidenceEngine;
  audit: AuditLog;
  agents: AgentRegistry;
  engine: WorkflowEngine;
  fdb: FactoryDatabase;
  json(res: ServerResponse, status: number, body: unknown): void;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
}

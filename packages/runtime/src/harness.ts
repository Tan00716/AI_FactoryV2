/**
 * Harness — spec §26 (Harness Engineering).
 *
 * The persistent harness around every agent. Responsibilities implemented
 * here: tool routing with permission checks (denials throw PermissionDenied
 * and are audited via callback), filesystem boundary enforcement, per-step
 * timeouts, evidence collection (forwarded to the caller's EvidenceSink —
 * the runtime never mutates core's evidence store itself), and tracing.
 *
 * The model never directly owns critical workflow control: every tool call
 * passes through this harness.
 */
import * as path from 'node:path';
import type { Permission } from '@ai-factory/core';
import {
  Clock,
  EvidenceInput,
  EvidenceRecord,
  EvidenceSink,
  FilesystemBoundary,
  PermissionDenied,
  StepTimeout,
  systemClock,
  TraceStep,
} from './types';
import type { StepIntentStore } from './durable';

export interface AuditEvent {
  t: number;
  action: string;
  detail: string;
}

export interface HarnessOptions {
  /** Filesystem roots the agent may touch; everything else is denied. */
  allowedRoots: string[];
  /** Per-step timeout in ms, applied to tool and adapter calls. */
  stepTimeoutMs: number;
  /** The agent's granted capability permissions (core Permission type). */
  permissions: Permission[];
  /** Override/extend the default tool → permission mapping. */
  toolPermissions?: Record<string, Permission>;
  clock?: Clock;
  /** Caller's evidence store — the runtime only appends via this interface. */
  evidence: EvidenceSink;
  /** Audit callback; every denial is reported here. */
  onAudit?: (event: AuditEvent) => void;
  onTrace?: (step: TraceStep) => void;
  /**
   * SPEC v2 §28.1 — when provided, the tool-call intent is persisted BEFORE
   * execution and the result committed after. Absent → legacy behavior.
   */
  intentStore?: StepIntentStore;
  /** Run id stamped onto persisted intents. */
  runId?: string;
}

/** Default mapping from tool name to the core Permission it requires. */
export const DEFAULT_TOOL_PERMISSIONS: Record<string, Permission> = {
  read: 'filesystem.read',
  write: 'filesystem.write',
  delete: 'filesystem.delete',
  shell: 'shell.execute',
  commit: 'git.commit',
  push: 'git.push',
  pull_request: 'github.pull_request',
};

export type ToolImpl = (args: unknown) => Promise<unknown> | unknown;

export class Harness {
  readonly allowedRoots: string[];
  private readonly options: HarnessOptions;
  private readonly clock: Clock;
  private readonly evidenceLog: EvidenceRecord[] = [];
  private readonly traceLog: TraceStep[] = [];

  constructor(options: HarnessOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.allowedRoots = options.allowedRoots.map((r) => path.resolve(r));
  }

  /** Drain internally recorded trace steps (also forwarded to onTrace). */
  drainTrace(): TraceStep[] {
    const out = [...this.traceLog];
    this.traceLog.length = 0;
    return out;
  }

  /** Drain evidence collected through this harness. */
  drainEvidence(): EvidenceRecord[] {
    const out = [...this.evidenceLog];
    this.evidenceLog.length = 0;
    return out;
  }

  /** §26 Permissions — deny (and audit) when the agent lacks the permission. */
  checkPermission(tool: string): void {
    const required = { ...DEFAULT_TOOL_PERMISSIONS, ...this.options.toolPermissions }[tool];
    if (!required) {
      this.audit('permission.denied', `unknown tool '${tool}'`);
      throw new PermissionDenied(tool, 'unknown tool — default deny');
    }
    if (!this.options.permissions.includes(required)) {
      this.audit('permission.denied', `tool '${tool}' requires '${required}'`);
      throw new PermissionDenied(tool, `missing permission '${required}'`);
    }
    this.audit('permission.granted', `tool '${tool}' (${required})`);
  }

  /**
   * §26 Filesystem Boundary — resolve the path and require it to sit inside
   * one of the allowed roots. The `path.sep` check blocks the classic
   * sibling-prefix escape (e.g. root /a/ws vs /a/ws-evil).
   */
  assertWithinRoot(p: string): string {
    const resolved = path.resolve(p);
    const ok = this.allowedRoots.some(
      (root) => resolved === root || resolved.startsWith(root + path.sep),
    );
    if (!ok) {
      this.audit('filesystem.denied', resolved);
      throw new FilesystemBoundary(resolved);
    }
    return resolved;
  }

  /** §26 Timeout — race the step against the per-step budget. */
  async withTimeout<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const ms = this.options.stepTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new StepTimeout(label, ms)), ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * §26 Tool Routing — permission check, timeout, evidence, tracing.
   * Denials throw PermissionDenied and are audited.
   */
  async runTool(name: string, args: unknown, impl: ToolImpl): Promise<unknown> {
    this.checkPermission(name);
    this.trace('HARNESS', `tool:${name}`, 'start');
    // §28.1 — persist the intent BEFORE executing the tool.
    const intent = this.options.intentStore?.persistIntent(
      this.options.runId ?? 'unknown-run',
      name,
      args,
    );
    try {
      const result = await this.withTimeout(`tool:${name}`, async () => impl(args));
      if (intent) this.options.intentStore?.recordResult(intent.id, true, { ok: true });
      this.collectEvidence({
        type: 'tool_result',
        title: `tool ${name} ok`,
        payload: { tool: name, ok: true },
      });
      this.trace('HARNESS', `tool:${name}`, 'ok');
      return result;
    } catch (err) {
      if (intent) this.options.intentStore?.recordResult(intent.id, false, { ok: false });
      const message = err instanceof Error ? err.message : String(err);
      this.audit('tool.failed', `${name}: ${message}`);
      this.trace('HARNESS', `tool:${name}`, `fail: ${message}`);
      throw err;
    }
  }

  /** §26 Evidence Collection — forwarded to the caller's sink. */
  collectEvidence(evidence: EvidenceInput): void {
    const record: EvidenceRecord = { ...evidence, t: this.clock.now() };
    this.evidenceLog.push(record);
    this.options.evidence.collect(evidence);
  }

  private audit(action: string, detail: string): void {
    this.options.onAudit?.({ t: this.clock.now(), action, detail });
  }

  private trace(phase: string, action: string, result: string): void {
    const step: TraceStep = { t: this.clock.now(), phase, action, result };
    this.traceLog.push(step);
    this.options.onTrace?.(step);
  }
}

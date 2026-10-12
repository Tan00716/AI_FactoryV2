/**
 * Tool execution with execution-point capability enforcement — SPEC v2 §33.
 *
 * The critical rule: permission is decided by (action, resource) against the
 * caller's CapabilityGrant — never by tool name. An alternate path (python
 * `open`, another MCP server) attempting a denied action gets the same
 * DENIED verdict as the "official" tool.
 *
 * Exit-code truth: a natural-language "success" in output never overrides a
 * non-zero exit code.
 *
 * Outcome separation (§33): input-schema errors and capability/approval
 * failures are DENIED before execution; a non-zero exit is FAILED; a runner
 * that does not settle within the tool timeout is TIMED_OUT; and a clean
 * exit that produced no result payload is EMPTY_RESULT (isEmptyResult) —
 * recorded in the audit log like any other outcome, but never SUCCEEDED,
 * so an empty result cannot be sealed as success evidence downstream.
 */
import { randomUUID } from 'node:crypto';
import { REASON_CODES, type ReasonCode } from '@ai-factory/api-contracts';
import type {
  CapabilityGrant,
  ExecutionOutcome,
  ExecutionRecord,
  ToolCall,
  ToolMetadata,
  ToolPrincipal,
} from './types';
import type { ToolRegistry } from './registry';
import { validateInput } from './schema';

export class ToolDeniedError extends Error {
  readonly code = 'TOOL_DENIED';
  readonly reasonCode: ReasonCode;
  constructor(reasonCode: ReasonCode, message: string) {
    super(`${reasonCode}: ${message}`);
    this.name = 'ToolDeniedError';
    this.reasonCode = reasonCode;
  }
}

export interface RunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  artifacts?: string[];
  /** Runner's own note, e.g. "success" — never overrides exitCode. */
  note?: string;
}

export type ToolRunner = (
  call: ResolvedToolCall,
) => Promise<RunnerResult> | RunnerResult;

export interface ResolvedToolCall extends ToolCall {
  tool: ToolMetadata;
}

export interface ExecutorOptions {
  runner: ToolRunner;
  now?: () => number;
  /** Max chars kept per stream; longer output is truncated with a marker. */
  maxOutputChars?: number;
  /**
   * §23.4 approval gate, injected by the coordinator (e.g. wired to
   * @ai-factory/approvals). When absent, tools at HUMAN_APPROVAL /
   * AI_REVIEW_PLUS_POLICY are DENIED fail-closed and the denial is
   * audit-logged — a sensitive tool must never execute without an
   * approval path.
   */
  approvalChecker?: ApprovalChecker;
}

/**
 * Result of an approval check for a sensitive tool execution — SPEC v2 §23.4.
 * Produced by the coordinator; the executor itself stays dependency-free.
 */
export interface ApprovalCheckResult {
  approved: boolean;
  /** Human/machine-readable rationale for the decision. */
  reason?: string;
  /** Approval record id when approved through the approvals package. */
  approvalId?: string;
}

/**
 * Decides whether a HUMAN_APPROVAL / AI_REVIEW_PLUS_POLICY tool call may
 * proceed. Async to allow human-in-the-loop or policy-engine lookups.
 */
export type ApprovalChecker = (
  call: ToolCall,
  tool: ToolMetadata,
  level: 'HUMAN_APPROVAL' | 'AI_REVIEW_PLUS_POLICY',
) => Promise<ApprovalCheckResult> | ApprovalCheckResult;

/**
 * Empty-result rule (§33) — judged purely on the shape of the raw
 * RunnerResult, before redaction/truncation. A result is EMPTY when BOTH:
 *
 *   1. stdout carries no payload: it is empty or whitespace-only.
 *      (stderr never counts — it is a diagnostic stream, not a result.)
 *   2. no artifacts were produced: `artifacts` is absent or an empty list.
 *
 * Anything else (any non-whitespace stdout, or at least one artifact) is a
 * real payload. The rule is deliberately shape-based: RunnerResult has no
 * structured output value, so a tool that prints a literal "[]" has emitted
 * output and is NOT empty by this rule — emptiness means the execution
 * handed back nothing at all.
 */
export function isEmptyResult(result: RunnerResult): boolean {
  const noStdout = result.stdout.trim().length === 0;
  const noArtifacts = !result.artifacts || result.artifacts.length === 0;
  return noStdout && noArtifacts;
}

const SECRET_PATTERNS: RegExp[] = [
  /secret:\/\/[^\s"'<>]+/g,
  /(?<=password\s*=\s*")[^"]+(?=")/gi,
  /(?<=api[_-]?key\s*=\s*")[^"]+(?=")/gi,
];

function redactText(text: string): { text: string; redacted: boolean } {
  let out = text;
  let redacted = false;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(out)) {
      pattern.lastIndex = 0;
      out = out.replace(pattern, '***');
      redacted = true;
    }
  }
  return { text: out, redacted };
}

function isoNow(now?: () => number): string {
  return new Date(now ? now() : Date.now()).toISOString();
}

export class ToolExecutor {
  private readonly log: ExecutionRecord[] = [];
  private readonly idempotency = new Map<string, string>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly opts: ExecutorOptions,
  ) {}

  /** Full audit log, including DENIED attempts. */
  attempts(): ExecutionRecord[] {
    return this.log.map((r) => ({ ...r }));
  }

  /**
   * Execute a tool call. Always returns a record (denials included);
   * use executeOrThrow() for exception semantics.
   */
  async execute(call: ToolCall): Promise<ExecutionRecord> {
    const startedAt = isoNow(this.opts.now);

    // Idempotency: same key → same record, no re-execution.
    if (call.idempotencyKey) {
      const priorId = this.idempotency.get(call.idempotencyKey);
      if (priorId) {
        const prior = this.log.find((r) => r.id === priorId);
        if (prior) return { ...prior, note: 'idempotent replay — not re-executed' };
      }
    }

    const deny = (reasonCode: ReasonCode, message: string): ExecutionRecord => {
      const record = this.finishRecord(call, null, '', '', {
        outcome: 'DENIED',
        startedAt,
        note: `${reasonCode}: ${message}`,
        toolVersion: 'unknown',
      });
      return record;
    };

    let tool: ToolMetadata;
    try {
      tool = this.registry.get(call.toolId, call.toolVersion);
    } catch {
      return deny('UNSUPPORTED_CAPABILITY', `unknown tool ${call.toolId}`);
    }

    if (tool.approvalPolicy === 'BLOCKED') {
      return deny('POLICY_DENIED', `tool ${tool.id} is BLOCKED by approval policy`);
    }

    // §23.4 approval gate: HUMAN_APPROVAL / AI_REVIEW_PLUS_POLICY tools must
    // pass an injected checker before execution. Fail-closed when no checker
    // is configured — the denial is audit-logged like any other.
    if (
      tool.approvalPolicy === 'HUMAN_APPROVAL' ||
      tool.approvalPolicy === 'AI_REVIEW_PLUS_POLICY'
    ) {
      const checker = this.opts.approvalChecker;
      if (!checker) {
        return deny(
          'POLICY_DENIED',
          `tool ${tool.id} requires ${tool.approvalPolicy} but no approval checker is configured — denied fail-closed`,
        );
      }
      let check: ApprovalCheckResult;
      try {
        check = await checker(call, tool, tool.approvalPolicy);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return deny('POLICY_DENIED', `approval checker error for tool ${tool.id}: ${message}`);
      }
      if (!check.approved) {
        return deny(
          'POLICY_DENIED',
          `tool ${tool.id} denied by approval checker${check.reason ? `: ${check.reason}` : ''}`,
        );
      }
    }

    const issues = validateInput(tool.inputSchema, call.args);
    if (issues.length > 0) {
      return deny(
        'POLICY_DENIED',
        `input schema violations: ${issues.map((i) => `${i.field} ${i.message}`).join('; ')}`,
      );
    }

    const grantIssue = checkGrant(call, tool, this.opts.now);
    if (grantIssue) return deny(grantIssue.code, grantIssue.message);

    const resolved: ResolvedToolCall = { ...call, tool };
    let result: RunnerResult;
    try {
      result = await this.runWithTimeout(resolved, tool.timeoutMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.finishRecord(call, null, '', '', {
        outcome: 'TIMED_OUT',
        startedAt,
        note: message,
        toolVersion: tool.version,
      });
    }

    // Exit-code truth: the runner's note never overrides exitCode, and
    // emptiness never overrides it either — a non-zero exit is FAILED even
    // when nothing was printed. Only a clean exit is split by payload:
    // something came back → SUCCEEDED; nothing at all → EMPTY_RESULT.
    const outcome: ExecutionOutcome =
      result.exitCode !== 0 ? 'FAILED' : isEmptyResult(result) ? 'EMPTY_RESULT' : 'SUCCEEDED';
    return this.finishRecord(call, result.exitCode, result.stdout, result.stderr, {
      outcome,
      startedAt,
      note: result.note,
      toolVersion: tool.version,
      artifacts: result.artifacts,
    });
  }

  /**
   * Throw ToolDeniedError when the outcome is DENIED. Every other outcome —
   * including EMPTY_RESULT, which is not an error — resolves with the
   * record; callers must check `record.outcome` before treating a result
   * as success evidence.
   */
  async executeOrThrow(call: ToolCall): Promise<ExecutionRecord> {
    const record = await this.execute(call);
    if (record.outcome === 'DENIED') {
      const code = record.note?.split(':')[0] as ReasonCode;
      throw new ToolDeniedError(
        (Object.keys(REASON_CODES) as ReasonCode[]).includes(code) ? code : 'POLICY_DENIED',
        record.note ?? 'denied',
      );
    }
    return record;
  }

  private async runWithTimeout(call: ResolvedToolCall, timeoutMs: number): Promise<RunnerResult> {
    return await new Promise<RunnerResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`tool timed out after ${timeoutMs}ms`)), timeoutMs);
      Promise.resolve()
        .then(() => this.opts.runner(call))
        .then((r) => {
          clearTimeout(timer);
          resolve(r);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  private finishRecord(
    call: ToolCall,
    exitCode: number | null,
    stdout: string,
    stderr: string,
    partial: {
      outcome: ExecutionOutcome;
      startedAt: string;
      note?: string;
      toolVersion: string;
      artifacts?: string[];
    },
  ): ExecutionRecord {
    const max = this.opts.maxOutputChars ?? 64_000;
    const trim = (s: string) => (s.length > max ? s.slice(0, max) + '…[truncated]' : s);
    const argvR = redactText(JSON.stringify(call.args));
    const outR = redactText(trim(stdout));
    const errR = redactText(trim(stderr));
    const record: ExecutionRecord = {
      id: randomUUID(),
      toolId: call.toolId,
      toolVersion: partial.toolVersion,
      action: call.action,
      resource: call.resource,
      argv: JSON.parse(argvR.text) as Record<string, unknown>,
      cwd: call.cwd ?? process.cwd(),
      envRef: 'env:default',
      principal: { ...call.principal },
      capabilityId: call.capability.id,
      startedAt: partial.startedAt,
      endedAt: isoNow(this.opts.now),
      exitCode,
      stdout: outR.text,
      stderr: errR.text,
      outcome: partial.outcome,
      redacted: argvR.redacted || outR.redacted || errR.redacted,
      artifacts: partial.artifacts ?? [],
      note: partial.note,
    };
    this.log.push(record);
    if (call.idempotencyKey && partial.outcome !== 'DENIED') {
      this.idempotency.set(call.idempotencyKey, record.id);
    }
    return { ...record };
  }
}

/**
 * Execution-point capability check. Returns null when allowed, otherwise the
 * denial reason. Checked dimensions: grant identity, revocation, expiry,
 * action granted, resource prefix, and the tool actually offering the action.
 */
export function checkGrant(
  call: ToolCall,
  tool: ToolMetadata,
  now?: () => number,
): { code: ReasonCode; message: string } | null {
  const grant: CapabilityGrant = call.capability;
  if (grant.revoked) {
    return { code: 'UNAUTHORIZED', message: `capability ${grant.id} revoked` };
  }
  if (grant.principalId !== call.principal.id) {
    return { code: 'UNAUTHORIZED', message: 'capability does not belong to the caller' };
  }
  if (grant.expiresAt && (now ? now() : Date.now()) >= new Date(grant.expiresAt).getTime()) {
    return { code: 'AUTHORIZATION_EXPIRED', message: `capability ${grant.id} expired` };
  }
  if (!grant.actions.includes(call.action)) {
    return {
      code: 'POLICY_DENIED',
      message: `action '${call.action}' not granted (have: ${grant.actions.join(', ') || 'none'})`,
    };
  }
  const covered = grant.resourcePrefixes.some(
    (prefix) => call.resource === prefix || call.resource.startsWith(prefix),
  );
  if (!covered) {
    return {
      code: 'SCOPE_VIOLATION',
      message: `resource '${call.resource}' outside granted prefixes`,
    };
  }
  if (!tool.capabilities.includes(call.action)) {
    return {
      code: 'UNSUPPORTED_CAPABILITY',
      message: `tool ${tool.id} does not offer action '${call.action}'`,
    };
  }
  return null;
}

/** Re-export for convenience. */
export type { ToolPrincipal as Principal };

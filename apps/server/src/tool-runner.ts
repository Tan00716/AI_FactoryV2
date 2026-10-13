/**
 * Server tool runner — Batch 21 (§33 execution-surface unification).
 *
 * Contract layering (the (b) decision, argued here and in
 * packages/tools/src/executor.ts):
 *
 *   - The Harness (@ai-factory/runtime, §26) is the AGENT execution
 *     surface: model-driven tool calls inside a run, name-based,
 *     Permission-gated, with step intents, budget, retry and
 *     trace/evidence. Used by the run route and agent loops.
 *   - The ToolExecutor (@ai-factory/tools, §33) is the AUDITED DIRECT
 *     execution surface: explicit tool calls with capability grants,
 *     approval gates, input-schema validation, idempotency and
 *     exit-code-truth records. Used by POST /api/tools/execute.
 *
 * A full (a)-style merge was rejected: the call models are
 * incompatible (Harness: runTool(name, args, impl) with host-injected
 * impls and throw-on-deny; ToolExecutor: {toolId, action, resource,
 * principal, capability} with a registered runner and record-on-deny),
 * and the spec keeps §26 and §33 as separate chapters. Merging would
 * break both packages' contracts and their existing tests.
 *
 * What unification DOES mean here, and what this module provides:
 *
 *   1. No fake execution. The previous /api/tools/execute runner was a
 *      prototype that returned exitCode 0 for every tool — a silent
 *      fake success. This runner executes for real where the server
 *      has a real implementation (runtime.echo/add as pure functions;
 *      shell.execute through the SAME command policy the /api/exec
 *      route enforces), and refuses loudly everywhere else:
 *      definition-only tools → DENIED (UNSUPPORTED_CAPABILITY) via
 *      the implementation gate; implemented-but-unwired tools →
 *      FAILED with a stderr that names the owning package. "Not
 *      implemented" can never become "success" on this surface.
 *   2. One shared command policy. shell.execute goes through
 *      checkCommandPolicy (deny patterns + binary whitelist),
 *      commandHitsControlDir (control-plane guard) and resolveExecCwd
 *      (workspace confinement) — the exact functions /api/exec and
 *      /api/terminal use. A policy change in one place applies to
 *      every execution surface; there is no "gate only on one side".
 *   3. One shared audit seam. Every outcome lands in the executor's
 *      attempts log (GET /api/tools/attempts); the route additionally
 *      forwards DENIED/FAILED outcomes into the server audit log so
 *      they sit next to EXEC_DENIED from the other surfaces.
 *
 * Approval note (§23.4): shell.execute's catalog policy is
 * HUMAN_APPROVAL, and this server wires no approval checker — so
 * shell.execute through /api/tools/execute stays DENIED fail-closed
 * until one is configured. That is the specified behavior, not a gap:
 * a sensitive tool must never execute without an approval path.
 */
import { PtyUnavailableError, runCommandPipe, runCommandPty } from '@ai-factory/runtime';
import {
  ToolDeniedError,
  type ImplementationGate,
  type ResolvedToolCall,
  type RunnerResult,
  type ToolRunner,
} from '@ai-factory/tools';
import {
  ExecPolicyDenied,
  checkCommandPolicy,
  commandHitsControlDir,
  resolveExecCwd,
} from './routes/exec';

/**
 * Tool ids this server wires a REAL implementation for. Everything
 * else registered here either hits the implementation gate
 * (definition-only → DENIED) or the runner's loud FAILED below.
 */
export const SERVER_WIRED_TOOLS: ReadonlySet<string> = new Set([
  'shell.execute', // real: @ai-factory/runtime pty/pipe + shared command policy
  'runtime.echo', // real: pure function (mirrors the run route's echo)
  'runtime.add', // real: pure function (mirrors the run route's add)
]);

/**
 * §33 implementation gate for this host: a tool whose registered
 * metadata says definition-only — and which this server does NOT wire
 * a real implementation for — is DENIED with UNSUPPORTED_CAPABILITY.
 * The denial is audit-logged by the executor like any other.
 */
export function createImplementationGate(): ImplementationGate {
  return (tool) => {
    if (SERVER_WIRED_TOOLS.has(tool.id)) return null;
    if (tool.implementationStatus === 'definition-only') {
      return {
        code: 'UNSUPPORTED_CAPABILITY',
        message:
          `tool ${tool.id} is definition-only: its metadata is registered but no ` +
          `implementation is wired on this host — refusing rather than faking execution`,
      };
    }
    return null;
  };
}

export interface ServerToolRunnerOptions {
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * The real ToolRunner for POST /api/tools/execute.
 *
 * Policy refusals throw ToolDeniedError, which the executor converts
 * to DENIED records (not TIMED_OUT) — the runner's voice for "refuse,
 * don't fake".
 */
export function createServerToolRunner(_opts: ServerToolRunnerOptions = {}): ToolRunner {
  return async (call: ResolvedToolCall): Promise<RunnerResult> => {
    switch (call.tool.id) {
      case 'runtime.echo': {
        const msg = (call.args as { msg?: unknown }).msg;
        // No message → empty output → EMPTY_RESULT downstream ("nothing
        // came back" is never sealed as success); a real payload echoes.
        const stdout =
          msg === undefined || msg === null
            ? ''
            : typeof msg === 'string'
              ? msg
              : JSON.stringify(msg);
        return { exitCode: 0, stdout, stderr: '' };
      }
      case 'runtime.add': {
        const { a = 0, b = 0 } = call.args as { a?: number; b?: number };
        if (typeof a !== 'number' || typeof b !== 'number') {
          return { exitCode: 1, stdout: '', stderr: 'runtime.add: a and b must be numbers' };
        }
        return { exitCode: 0, stdout: String(a + b), stderr: '' };
      }
      case 'shell.execute': {
        const args = call.args as { command?: unknown; pty?: unknown; cwd?: unknown };
        const command = typeof args.command === 'string' ? args.command : '';
        let tokens: string[];
        try {
          tokens = checkCommandPolicy(command);
        } catch (err) {
          if (err instanceof ExecPolicyDenied) {
            throw new ToolDeniedError('POLICY_DENIED', err.message);
          }
          throw err;
        }
        let cwd: string;
        try {
          cwd = resolveExecCwd(typeof args.cwd === 'string' ? args.cwd : undefined);
        } catch (err) {
          throw new ToolDeniedError(
            'POLICY_DENIED',
            `cwd refused: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (commandHitsControlDir(cwd, tokens)) {
          throw new ToolDeniedError(
            'POLICY_DENIED',
            'command refused: touches the control-plane data directory',
          );
        }
        const usePty = args.pty === true;
        const run = usePty ? runCommandPty : runCommandPipe;
        let r;
        try {
          r = await run(tokens, {
            cwd,
            timeoutMs: call.tool.timeoutMs,
          });
        } catch (err) {
          // No POSIX pty on this host: a host-capability refusal, not a
          // timeout and not a policy verdict — DENIED, stated plainly.
          if (err instanceof PtyUnavailableError) {
            throw new ToolDeniedError('UNSUPPORTED_CAPABILITY', err.message);
          }
          throw err;
        }
        // Exit-code truth: the runner's note never overrides the code;
        // a signal death is already 128+n by shell convention, and a
        // null code (untrackable child) is -1 — both non-zero → FAILED.
        return {
          exitCode: r.exitCode ?? -1,
          stdout: r.stdout,
          stderr: r.stderr,
          note: r.timedOut ? 'timed out: process tree killed' : undefined,
        };
      }
      default: {
        // Implemented in the catalog but not wired to this server's
        // executor (e.g. git.* live in @ai-factory/git, test.run in
        // @ai-factory/qa): a loud FAILED, never a silent success.
        // The stderr names the gap so the audit log explains itself.
        return {
          exitCode: 1,
          stdout: '',
          stderr:
            `tool ${call.tool.id} is marked implemented in the tool catalog but no ` +
            `implementation is wired into this server's tool executor — refusing to fake execution`,
        };
      }
    }
  };
}

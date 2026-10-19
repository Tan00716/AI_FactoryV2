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
import {
  decideExecSandbox,
  execSandboxConfigFromEnv,
  type ExecSandboxDecision,
} from './exec-sandbox';
import {
  SANDBOX_UNAVAILABLE_CODE,
  checkDangerExec,
  resolveSandboxMode,
  type ApprovalPolicy,
  type DangerGateResult,
} from './sandbox-modes';
import { ApprovalManager } from '@ai-factory/approvals';
import { networkMode } from './network-mode';
import { checkToolRules } from './permission-rules';

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
 * Danger-tier gate for shell.execute. Installed once at server boot in
 * index.ts with a closure over the approvals store. Unlike the
 * human-driven surfaces it ALSO mints: when the agent call carries no
 * (or an invalid) dangerApprovalId, a PENDING ticket bound to the exact
 * command is created so the human sees it in the Approvals tab and the
 * agent can retry with dangerApprovalId. An agent must never approve
 * its own ticket — approval still requires a human decider.
 */
let dangerGateForTools:
  | ((opts: {
      actor: string;
      command: string;
      allowDanger: boolean;
      approvalPolicy: ApprovalPolicy;
      dangerApprovalId?: string;
    }) => DangerGateResult)
  | null = null;

/** Re-exported for tests. */
export function setToolRunnerDangerGate(
  fn: ((opts: {
    actor: string;
    command: string;
    allowDanger: boolean;
    approvalPolicy: ApprovalPolicy;
    dangerApprovalId?: string;
  }) => DangerGateResult) | null,
): void {
  dangerGateForTools = fn;
}

/** Re-exported for tests. */
export function resetToolRunnerDangerGateForTests(): void {
  dangerGateForTools = null;
}

/** Test seam: build the boot-style gate around any ApprovalManager. */
export function makeToolDangerGate(manager: ApprovalManager) {
  return (opts: {
    actor: string;
    command: string;
    allowDanger: boolean;
    approvalPolicy: ApprovalPolicy;
    dangerApprovalId?: string;
  }): DangerGateResult => checkDangerExec({ manager, ...opts });
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
    // Declarative permission rules (deny > ask > allow) — enforced HERE,
    // at the execution choke point, before any tool implementation runs.
    // A deny rule cannot be bypassed by an auto-approve / bypass-permissions
    // mode upstream: even if the executor's approval gate approved (or was
    // skipped), the runner itself refuses. The executor converts the
    // ToolDeniedError into a DENIED record; routes/tools.ts maps the
    // PERMISSION_DENIED_BY_RULE marker to a 403 + audit event.
    //
    // 'ask' has no interactive approval path at this surface, so it fails
    // closed with APPROVAL_REQUIRED and an explicit message — never a
    // silent pass, never a fake approval.
    const ruleVerdict = checkToolRules(call.tool.id, (call.args ?? {}) as Record<string, unknown>);
    if (ruleVerdict !== undefined && ruleVerdict.effect !== 'allow') {
      const where = `'${ruleVerdict.rule.tool}(${ruleVerdict.rule.pattern})' [${ruleVerdict.layer}]`;
      if (ruleVerdict.effect === 'deny') {
        throw new ToolDeniedError(
          'POLICY_DENIED',
          `PERMISSION_DENIED_BY_RULE: rule ${where} denies ${call.tool.id}`,
        );
      }
      // 'ask' has no interactive approval path at this surface, so it
      // fails closed with APPROVAL_REQUIRED and an explicit message —
      // never a silent pass, never a fake approval.
      throw new ToolDeniedError(
        'APPROVAL_REQUIRED',
        `permission rule ${where} requires approval for ${call.tool.id} — ` +
          'no approval path is wired at the tool execution surface, denied fail-closed',
      );
    }
    // NOTE: an 'allow' verdict is a no-op at this choke point — it only
    // matters at the evaluate endpoint and in future approval wiring.
    // Wired tools have no default-deny here for allow to suppress.
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
        const args = call.args as {
          command?: unknown;
          pty?: unknown;
          cwd?: unknown;
          dangerApprovalId?: unknown;
        };
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
        // OS sandbox tiers (exec-sandbox.ts + sandbox-modes.ts): same
        // confinement as /api/exec. The sandbox never permits —
        // policy/approval gates above are unchanged; the tier is
        // reported in `note` so the attempts log never silently claims
        // isolation. Fail-closed: read-only/workspace-write REQUIRE a
        // working bwrap; without it the call is refused
        // (CONFINEMENT_UNAVAILABLE — the fixed reason taxonomy), never
        // run unisolated.
        //
        // Danger tier: the agent must supply a human-minted
        // dangerApprovalId (action 'sandbox.danger-exec', bound to this
        // exact command). No auto-minting here — an agent must never
        // mint its own danger approval; the human creates it via
        // POST /api/approvals or the Approvals tab.
        //
        // Offline mode: force --unshare-net; without bwrap there is no
        // provable network isolation, so the call is refused outright —
        // no fake offline. CONFINEMENT_UNAVAILABLE is the honest code:
        // no qualified isolation backend is available.
        const offline = networkMode().isOffline();
        const resolved = resolveSandboxMode(cwd);
        const dangerApprovalId =
          typeof args.dangerApprovalId === 'string' && args.dangerApprovalId
            ? args.dangerApprovalId
            : undefined;
        let sb: ExecSandboxDecision;
        if (resolved.mode === 'danger-full-access') {
          // Danger tier: the call must carry a human-approved,
          // command-bound dangerApprovalId. Without one the gate
          // refuses — the tool call carries no task to bind a fresh
          // ticket to (approvals.task_id FK), so the server cannot
          // auto-mint here. The denial tells the agent exactly how a
          // human mints the ticket (POST /api/approvals with the
          // candidate_digest); the agent retries with dangerApprovalId
          // after a human approves. The agent never approves its own
          // ticket.
          const gate: DangerGateResult = dangerGateForTools
            ? dangerGateForTools({
                actor: 'agent',
                command,
                allowDanger: resolved.allowDanger,
                approvalPolicy: resolved.approvalPolicy,
                dangerApprovalId,
              })
            : {
                ok: false,
                code: 'DANGER_APPROVAL_INVALID',
                message: 'danger gate is not installed on this server',
              };
          if (!gate.ok) {
            throw new ToolDeniedError(
              'CONFINEMENT_UNAVAILABLE',
              `${gate.code}: danger-full-access shell.execute requires a human-approved, ` +
                `command-bound approval (action 'sandbox.danger-exec'); ${gate.message}.` +
                (gate.approvalId ? ` Approval '${gate.approvalId}' is PENDING.` : '') +
                (gate.candidateDigest && !gate.approvalId
                  ? ` candidate_digest=${gate.candidateDigest}`
                  : ''),
            );
          }
          sb = {
            mode: 'danger-full-access',
            prefix: [],
            reason: null,
            sandboxed: false,
            refused: false,
            refuseCode: null,
          };
        } else {
          const sandboxCfg = execSandboxConfigFromEnv();
          sandboxCfg.mode = resolved.mode;
          if (offline) sandboxCfg.network = false;
          sb = await decideExecSandbox(cwd, sandboxCfg);
        }
        // Refusal precedence: offline mode's NETWORK_OFFLINE first (it
        // names the operator's own intent); SANDBOX_UNAVAILABLE when
        // online. Both fail closed — never run unisolated.
        if (offline && !sb.sandboxed) {
          const detail = sb.reason ? ` (${sb.reason})` : '';
          throw new ToolDeniedError(
            'CONFINEMENT_UNAVAILABLE',
            `NETWORK_OFFLINE: offline mode requires bwrap network isolation, ` +
              `but the sandbox is '${sb.mode}'${detail} — refusing to run unisolated`,
          );
        }
        if (sb.refused) {
          const detail = sb.reason ? ` (${sb.reason})` : '';
          throw new ToolDeniedError(
            'CONFINEMENT_UNAVAILABLE',
            `${SANDBOX_UNAVAILABLE_CODE}: tier '${sb.mode}' requires OS-enforced isolation (bwrap), ` +
              `but no working bwrap was found${detail} — refusing to run unisolated`,
          );
        }
        let r;
        try {
          r = await run(tokens, {
            cwd,
            timeoutMs: call.tool.timeoutMs,
            argvPrefix: sb.prefix,
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
          note:
            (r.timedOut ? 'timed out: process tree killed; ' : '') +
            `sandbox: ${sb.mode}${sb.reason ? ` (${sb.reason})` : ''}` +
            (sb.mode === 'danger-full-access' && dangerApprovalId
              ? ` (approval ${dangerApprovalId})`
              : ''),
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

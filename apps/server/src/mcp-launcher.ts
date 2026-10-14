/**
 * MCP stdio server launcher — server layer ONLY (Batch 19).
 *
 * The @ai-factory/mcp package deliberately ships no spawner (see
 * runtimePolicy.ts: "The package ships no spawner — a launcher that
 * ignores the filter is outside this layer"). This module IS that
 * launcher, and it closes the Batch 18 KNOWN_LIMITATIONS entry
 * "MCP 服务器启动 env 注入未接".
 *
 * What it does, per launch:
 *  1. fail-closed preconditions: server registered + INSTALLED + enabled,
 *     transport === 'stdio', command resolves on PATH (or is absolute).
 *  2. secretEnv {ENV_VAR -> ref}: every ref MUST be declared on the
 *     server's credentialRefs (declaration constrains resolution — a
 *     launch request cannot smuggle an arbitrary secret into an MCP
 *     server). Declared refs are resolved through the Secret Broker
 *     under SHORT-TERM LEASES (not plain resolve).
 *  3. the child env is filterStdioEnv(policy, process.env) overlaid
 *     with the resolved values — values exist in process memory only
 *     for the spawn instant; request bodies, logs and audit records
 *     carry ref NAMES only.
 *  4. stdout/stderr are piped through redactSecretValues() before they
 *     reach the in-memory log ring / any audit detail.
 *
 * Lease semantics (§46.2, stated plainly — the honest OS reality):
 * env is COPIED into the child at spawn; revoking a launcher-side
 * lease (rotation) cannot purge the child's memory. So:
 *   - new launches always resolve fresh values;
 *   - each launch keeps its SecretLease handles and reports
 *     `leasesLive` (all still active) — operators relaunch to pick
 *     up rotated secrets;
 *   - the /api/mcp/gate verdict (route layer) annotates
 *     `secretLeaseState` for the server's launches so callers can
 *     see staleness before dispatching tool calls. Long-lived
 *     connections are NOT force-restarted; the annotation is the
 *     gate's honest statement of the situation.
 *
 * This module never touches packages/mcp internals — it consumes the
 * public McpRegistry/McpManager/filterStdioEnv surface.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  filterStdioEnv,
  defaultRuntimePolicy,
  type McpRuntimePolicy,
  type McpServer,
} from '@ai-factory/mcp';
import type { AuditLog } from '@ai-factory/core';
import {
  SecretNotFoundError,
  redactSecretValuesCounted,
  type SecretBroker,
  type SecretLease,
} from '@ai-factory/secrets';

export const MCP_LAUNCH_LOG_CAP = 65_536;

export class McpLaunchError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'McpLaunchError';
    this.code = code;
    this.status = status;
  }
}

export interface McpLaunchRecord {
  id: string;
  server: string;
  version: string;
  pid: number | null;
  launchedAt: number;
  alive: boolean;
  exitCode: number | null;
  signal: string | null;
  /** ref names declared on the server record (never values) */
  credentialRefs: string[];
  /** ENV_VAR names injected (never values) */
  secretEnvVars: string[];
  /** every lease held for this launch still active */
  leasesLive: boolean;
  logTruncated: boolean;
}

function resolveOnPath(command: string): string | null {
  if (command.includes('/') || command.includes('\\')) {
    try {
      accessSync(command, constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  const pathDirs = (process.env.PATH ?? '').split(delimiter);
  for (const dir of pathDirs) {
    const candidate = dir.replace(/\/$/, '') + '/' + command;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

export interface McpLaunchOptions {
  server: McpServer;
  installed: boolean;
  enabled: boolean;
  command: string;
  args?: string[];
  cwd?: string;
  secretEnv?: Record<string, string>;
  actor: string;
  broker: SecretBroker;
  audit: AuditLog;
  policy?: McpRuntimePolicy;
  now?: () => number;
  /**
   * Batch 42 — redaction-hit detection hook. Called (at most once per
   * chunk) when stdout/stderr redaction replaced ≥1 injected secret
   * value, with the server id and the exact replacement count — never
   * secret content. The launcher stays storage-agnostic: the server
   * layer wires this to the audit chain + §81 aggregation.
   */
  onRedactionHit?: (hit: { source: string; hits: number }) => void;
}

/**
 * Write-through observer for launch-record history (Batch 26).
 * The launcher stays storage-agnostic: it emits lifecycle events,
 * and the server layer (mcp-persistence.ts) persists them.
 */
export interface McpLaunchRecordSink {
  /** Fired right after the child is spawned (status RUNNING). */
  launched(rec: McpLaunchRecord & { command: string; args: string[]; cwd?: string }): void;
  /** Fired when the child exits on its own (status EXITED). */
  launchEnded(id: string, outcome: { exitCode: number | null; signal: string | null }): void;
  /** Fired when the operator stops it via /stop (status STOPPED). */
  launchStopped(id: string): void;
}

export class McpServerLauncher {
  private readonly launches = new Map<string, {
    record: McpLaunchRecord;
    child: ChildProcess;
    leases: SecretLease[];
    values: string[];
    log: string;
    endedEmitted: boolean;
  }>();
  private sink: McpLaunchRecordSink | null = null;

  /** Attach the write-through observer (Batch 26). Set after hydrate. */
  setSink(sink: McpLaunchRecordSink | null): void {
    this.sink = sink;
  }

  /** Launch a stdio MCP server with secret injection. Throws McpLaunchError. */
  async launch(opts: McpLaunchOptions): Promise<McpLaunchRecord> {
    const { server, actor, broker, audit } = opts;
    const idBase = `${server.name}@${server.version}`;

    if (!opts.installed || !opts.enabled) {
      throw new McpLaunchError(
        'MCP_LAUNCH_NOT_INSTALLED', 403,
        `refusing to launch ${idBase}: server is not installed+enabled (install/approval flow first)`,
      );
    }
    if (server.transport !== 'stdio') {
      throw new McpLaunchError(
        'MCP_LAUNCH_UNSUPPORTED_TRANSPORT', 400,
        `refusing to launch ${idBase}: only stdio servers can be launched by this endpoint (transport=${server.transport})`,
      );
    }
    const command = (opts.command ?? '').trim();
    if (!command) {
      throw new McpLaunchError('MCP_LAUNCH_BAD_COMMAND', 400, 'command is required');
    }
    const resolved = resolveOnPath(command);
    if (!resolved) {
      throw new McpLaunchError(
        'MCP_LAUNCH_COMMAND_NOT_FOUND', 400,
        `refusing to launch ${idBase}: command '${command}' not found on PATH`,
      );
    }
    const args = Array.isArray(opts.args) ? opts.args : [];
    if (!args.every((a) => typeof a === 'string')) {
      throw new McpLaunchError('MCP_LAUNCH_BAD_ARGS', 400, 'args must be an array of strings');
    }

    // Declaration constrains resolution: every requested ref must be
    // on the server's credentialRefs. Nothing spawns half-injected.
    const secretEnv = opts.secretEnv ?? {};
    const declared = new Set(server.credentialRefs ?? []);
    const leases: SecretLease[] = [];
    const values: string[] = [];
    const injectedEnv: Record<string, string> = {};
    for (const [varName, ref] of Object.entries(secretEnv)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName) || typeof ref !== 'string' || !ref) {
        throw new McpLaunchError(
          'MCP_LAUNCH_BAD_SECRET_ENV', 400,
          `secretEnv entries must map a valid env var name to a secret name (bad entry: ${varName})`,
        );
      }
      if (!declared.has(ref)) {
        audit.record(actor, 'MCP_LAUNCH_DENIED', 'mcp_server', idBase, {
          reason: 'SECRET_REF_NOT_DECLARED', ref, envVar: varName,
        });
        throw new McpLaunchError(
          'MCP_SECRET_REF_NOT_DECLARED', 403,
          `refusing to launch ${idBase}: secret ref '${ref}' is not declared on the server's credentialRefs`,
        );
      }
      try {
        const lease = await broker.lease(ref, {
          actor,
          purpose: 'mcp stdio launch env injection',
        });
        leases.push(lease);
        const value = lease.value; // throws if the lease died between grant and use
        injectedEnv[varName] = value;
        values.push(value);
      } catch (e) {
        for (const l of leases) { try { l.revoke(); } catch { /* best effort */ } }
        if (e instanceof SecretNotFoundError) {
          audit.record(actor, 'MCP_LAUNCH_DENIED', 'mcp_server', idBase, {
            reason: 'SECRET_NOT_FOUND', ref: e.ref, envVar: varName,
          });
          throw new McpLaunchError('MCP_SECRET_NOT_FOUND', 403, e.message);
        }
        audit.record(actor, 'MCP_LAUNCH_DENIED', 'mcp_server', idBase, {
          reason: 'SECRET_BACKEND_ERROR', error: (e as Error).name,
        });
        throw new McpLaunchError('MCP_SECRET_BACKEND_ERROR', 500, 'secret resolution failed');
      }
    }

    const policy = opts.policy ?? defaultRuntimePolicy('stdio');
    const env = { ...filterStdioEnv(policy, process.env), ...injectedEnv };

    const id = randomUUID();
    const now = opts.now ?? Date.now;
    const child = spawn(resolved, args, {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const entry: {
      record: McpLaunchRecord;
      child: ChildProcess;
      leases: SecretLease[];
      values: string[];
      log: string;
      endedEmitted: boolean;
    } = {
      record: {
        id, server: server.name, version: server.version,
        pid: child.pid ?? null, launchedAt: now(),
        alive: true, exitCode: null, signal: null,
        credentialRefs: [...(server.credentialRefs ?? [])],
        secretEnvVars: Object.keys(injectedEnv),
        leasesLive: true, logTruncated: false,
      },
      child, leases, values, log: '',
      endedEmitted: false,
    };
    this.launches.set(id, entry);
    // The child is already spawned: a persistence failure here must
    // not turn into a lying 500 (the launch happened) nor leak
    // silently — audit it loudly and keep the in-memory record as
    // the authority for the live launch.
    try {
      this.sink?.launched({
        ...entry.record,
        command: resolved,
        args,
        cwd: opts.cwd,
      });
    } catch (err) {
      audit.record('system', 'MCP_LAUNCH_RECORD_WRITE_FAILED', 'mcp_server', idBase, {
        launchId: id,
        error: (err as Error).name,
        detail: (err as Error).message.slice(0, 200),
      });
    }

    const emitEnded = (code: number | null, signal: string | null) => {
      if (entry.endedEmitted) return;
      entry.endedEmitted = true;
      this.sink?.launchEnded(id, { exitCode: code, signal });
    };
    const onData = (chunk: Buffer) => {
      const r = redactSecretValuesCounted(chunk.toString('utf8'), entry.values);
      if (r.hits > 0) opts.onRedactionHit?.({ source: idBase, hits: r.hits });
      const redacted = r.text;
      entry.log += redacted;
      if (entry.log.length > MCP_LAUNCH_LOG_CAP) {
        entry.log = entry.log.slice(-MCP_LAUNCH_LOG_CAP);
        entry.record.logTruncated = true;
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', (code, signal) => {
      entry.record.alive = false;
      entry.record.exitCode = code;
      entry.record.signal = signal;
      emitEnded(code, signal);
      audit.record('system', 'MCP_SERVER_EXIT', 'mcp_server', idBase, {
        launchId: id, exitCode: code, signal,
      });
    });
    child.on('error', (err) => {
      entry.record.alive = false;
      emitEnded(null, null);
      audit.record('system', 'MCP_SERVER_EXIT', 'mcp_server', idBase, {
        launchId: id, error: err.name, detail: err.message.slice(0, 200),
      });
    });

    audit.record(actor, 'MCP_SERVER_LAUNCH', 'mcp_server', idBase, {
      launchId: id,
      pid: child.pid ?? null,
      command: resolved,
      credentialRefs: [...(server.credentialRefs ?? [])],
      secretEnvVars: Object.keys(injectedEnv),
    });
    return this.snapshot(id);
  }

  list(): McpLaunchRecord[] {
    return [...this.launches.keys()].map((id) => this.snapshot(id));
  }

  logs(id: string): { logs: string; truncated: boolean } | null {
    const entry = this.launches.get(id);
    if (!entry) return null;
    return { logs: entry.log, truncated: entry.record.logTruncated };
  }

  /** Lease liveness for every launch of one server (the gate annotation). */
  secretLeaseState(server: string, version?: string): 'active' | 'revoked' | 'no-launch' {
    const matches = [...this.launches.values()].filter(
      (e) => e.record.server === server && (!version || e.record.version === version),
    );
    if (matches.length === 0) return 'no-launch';
    return matches.every((e) => e.leases.every((l) => l.active)) ? 'active' : 'revoked';
  }

  stop(id: string, actor: string, audit: AuditLog): boolean {
    const entry = this.launches.get(id);
    if (!entry) return false;
    audit.record(actor, 'MCP_SERVER_STOPPED', 'mcp_server',
      `${entry.record.server}@${entry.record.version}`, { launchId: id });
    this.sink?.launchStopped(id);
    try { entry.child.kill('SIGTERM'); } catch { /* already gone */ }
    setTimeout(() => { try { entry.child.kill('SIGKILL'); } catch { /* gone */ } }, 2_000).unref();
    return true;
  }

  private snapshot(id: string): McpLaunchRecord {
    const entry = this.launches.get(id)!;
    entry.record.leasesLive = entry.leases.every((l) => l.active);
    return { ...entry.record };
  }
}

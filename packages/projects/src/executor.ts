/**
 * WorkspaceExecutor — policy-controlled shell execution inside a sandbox
 * root (spec §6 permissions, §31 local execution).
 *
 * Guarantees:
 *  - first-token command whitelist (configurable, read-only + build-ish by
 *    default); dangerous patterns (rm -rf /, fork bombs, `| sh`, raw
 *    device writes…) are always rejected;
 *  - network-capable commands need the NETWORK permission;
 *  - cwd is forced to stay inside `root` (resolves and rejects `../`
 *    escapes);
 *  - a kill timer aborts over-long commands (default 30s);
 *  - stdout/stderr are truncated to a byte cap;
 *  - every attempt — allowed or rejected — emits an audit event.
 *
 * Zero external deps; node built-ins only.
 */
import { spawn } from 'node:child_process';
import { resolve, sep } from 'node:path';
import type {
  AuditEvent,
  ExecOptions,
  ExecResult,
  WorkspaceExecutorOptions,
  WorkspacePermission,
} from './types';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 262_144;

/**
 * Read-only + build/test tooling allowed by default. Network-capable
 * install/fetch/push commands are gated separately via the NETWORK
 * permission (see NETWORK_SUBCOMMANDS).
 */
export const DEFAULT_ALLOWED_COMMANDS: readonly string[] = [
  'ls',
  'cat',
  'pwd',
  'echo',
  'printf',
  'tree',
  'head',
  'tail',
  'wc',
  'grep',
  'find',
  'diff',
  'which',
  'node',
  'npx',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'tsc',
  'vitest',
  'jest',
  'pytest',
  'python',
  'python3',
  'pip',
  'poetry',
  'git',
  'go',
  'cargo',
  'rustc',
  'mvn',
  'gradle',
  'dotnet',
  'java',
  'javac',
  'cmake',
  'make',
  'docker',
  'kubectl',
  'env',
  'sleep',
  'date',
];

/**
 * First-token commands that always require the NETWORK permission,
 * even when whitelisted via `allowedCommands`.
 */
const NETWORK_FIRST_TOKENS: ReadonlySet<string> = new Set(['curl', 'wget']);

/**
 * (first-token, subcommand) pairs that download from the network or push
 * state outward. Blocked unless the NETWORK permission is granted.
 */
const NETWORK_SUBCOMMANDS: ReadonlyArray<[string, RegExp]> = [
  ['npm', /\b(install|i|ci|publish|add)\b/],
  ['pnpm', /\b(install|i|add|publish)\b/],
  ['yarn', /\b(add|install|publish)\b/],
  ['bun', /\b(add|install|publish)\b/],
  ['pip', /\binstall\b/],
  ['poetry', /\b(add|install)\b/],
  ['git', /\b(clone|fetch|pull|push)\b/],
  ['go', /\b(get|install)\b/],
  ['cargo', /\b(publish)\b/],
  ['npx', /\b(-y\b|--yes\b)/],
  ['docker', /\b(pull|push)\b/],
];

/**
 * Always rejected, no matter the whitelist or permissions — destructive
 * or sandbox-escaping patterns.
 */
const DANGEROUS_PATTERNS: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /\brm\b[^&|;]*\s-rf?\s+\//, why: 'recursive delete rooted at /' },
  { re: /\brm\b[^&|;]*\s--no-preserve-root\b/, why: 'rm with --no-preserve-root' },
  { re: /\bdd\b\s+if=/, why: 'raw disk write (dd)' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, why: 'fork bomb' },
  { re: /\|\s*(sh|bash|zsh|dash)\b/, why: 'piping to a shell' },
  { re: />\s*\/dev\/(sda|hda|nvme|mem|kmem|null)\b/, why: 'write to a device' },
  { re: /\bmkfs\b/, why: 'filesystem format' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, why: 'host power control' },
  { re: /\bchmod\b[^&|;]*\s+[0-7]{3,4}\s+\//, why: 'chmod rooted at /' },
  { re: /\bchown\b[^&|;]*\s+\/\s/, why: 'chown rooted at /' },
  { re: /\bsudo\b/, why: 'privilege escalation (sudo)' },
  { re: /\bsu\b\s+-/, why: 'privilege escalation (su)' },
];

function firstToken(command: string): string {
  const m = command.trim().match(/^([^\s|&;]+)/);
  if (!m) return '';
  return m[1].split('/').pop() ?? '';
}

export class WorkspaceExecutor {
  readonly root: string;
  readonly permissions: ReadonlySet<WorkspacePermission>;
  readonly agentId: string;
  private readonly onAudit?: (event: AuditEvent) => void;
  private readonly allowed: ReadonlySet<string>;
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(opts: WorkspaceExecutorOptions) {
    this.root = resolve(opts.root);
    this.permissions = new Set(opts.permissions);
    this.agentId = opts.agentId;
    this.onAudit = opts.onAudit;
    const merged = new Set<string>(DEFAULT_ALLOWED_COMMANDS);
    for (const c of opts.allowedCommands ?? []) merged.add(c);
    this.allowed = merged;
    this.defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  get timeoutMs(): number {
    return this.defaultTimeoutMs;
  }

  /** Resolve `cwd` and verify it stays inside the sandbox root. */
  resolveCwd(cwd?: string): string {
    const resolved = cwd ? resolve(this.root, cwd) : this.root;
    if (resolved !== this.root && !resolved.startsWith(this.root + sep)) {
      throw new Error(
        `cwd escapes the sandbox root: ${cwd} (root: ${this.root})`,
      );
    }
    return resolved;
  }

  private audit(partial: Omit<AuditEvent, 'ts'>): void {
    this.onAudit?.({ ...partial, ts: new Date().toISOString() });
  }

  /** Policy check. Throws when the command is not allowed. */
  private checkPolicy(command: string): void {
    const trimmed = command.trim();
    if (!trimmed) throw new Error('empty command');
    for (const { re, why } of DANGEROUS_PATTERNS) {
      if (re.test(trimmed)) {
        throw new Error(`command rejected: ${why}`);
      }
    }
    const token = firstToken(trimmed);
    if (!this.allowed.has(token)) {
      throw new Error(
        `command not in whitelist: '${token}' (agent ${this.agentId})`,
      );
    }
    if (NETWORK_FIRST_TOKENS.has(token) && !this.permissions.has('NETWORK')) {
      throw new Error(
        `'${token}' requires the NETWORK permission (agent ${this.agentId})`,
      );
    }
    for (const [cmd, re] of NETWORK_SUBCOMMANDS) {
      if (token === cmd && re.test(trimmed) && !this.permissions.has('NETWORK')) {
        throw new Error(
          `'${trimmed}' performs a network operation and requires the NETWORK permission`,
        );
      }
    }
  }

  /**
   * Run a whitelisted command inside the sandbox. Rejects on policy
   * violation, escapes, timeout or spawn failure; every attempt is
   * audited via onAudit.
   */
  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const started = Date.now();
    const fail = (reason: string, cwd = this.root): never => {
      this.audit({
        agentId: this.agentId,
        kind: 'exec_rejected',
        command,
        cwd,
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - started,
        reason,
      });
      throw new Error(reason);
    };

    let cwd: string = this.root;
    try {
      cwd = this.resolveCwd(opts.cwd);
    } catch (err) {
      fail((err as Error).message);
    }
    try {
      this.checkPolicy(command);
    } catch (err) {
      fail((err as Error).message, cwd);
    }

    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const outCap = this.maxOutputBytes;
    const child = spawn(command, {
      cwd,
      shell: '/bin/sh',
      env: { ...process.env, ...(opts.env ?? {}) },
      windowsHide: true,
      // Own process group so a timeout kills the whole tree (e.g. the
      // `sleep` child of `/bin/sh -c "sleep 5"`), not just the shell.
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    const append = (chunk: Buffer, which: 'out' | 'err'): void => {
      const text = chunk.toString('utf8');
      if (which === 'out') {
        if (stdout.length + text.length > outCap) {
          truncated = true;
          stdout += text.slice(0, Math.max(0, outCap - stdout.length));
        } else {
          stdout += text;
        }
      } else {
        if (stderr.length + text.length > outCap) {
          truncated = true;
          stderr += text.slice(0, Math.max(0, outCap - stderr.length));
        } else {
          stderr += text;
        }
      }
    };
    child.stdout.on('data', (d: Buffer) => append(d, 'out'));
    child.stderr.on('data', (d: Buffer) => append(d, 'err'));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole process group; fall back to the direct child.
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const exitCode: number | null = await new Promise((resolveExit) => {
      child.on('error', () => resolveExit(null));
      child.on('close', (code) => resolveExit(code));
    });
    clearTimeout(timer);

    const result: ExecResult = {
      command,
      cwd,
      exitCode,
      stdout,
      stderr,
      timedOut,
      truncated,
      durationMs: Date.now() - started,
    };
    this.audit({
      agentId: this.agentId,
      kind: 'exec',
      command,
      cwd,
      exitCode,
      timedOut,
      durationMs: result.durationMs,
    });
    return result;
  }

  /** Convenience guard used by the server route layer. */
  hasPermission(p: WorkspacePermission): boolean {
    return this.permissions.has(p);
  }
}

/**
 * Lifecycle hooks (W-B) — deterministic PreToolUse / PostToolUse / Stop.
 *
 * Operators configure shell commands that run at tool-lifecycle points:
 *   PreToolUse   — runs BEFORE a tool executes; a deny vetoes the call
 *                  (the security-checkpoint semantic: non-zero exit or a
 *                  {"decision":"deny"} stdout verdict denies).
 *   PostToolUse  — runs AFTER a tool completes; failures are logged, never fatal.
 *   Stop         — runs when an agent work unit stops (plan finish); same
 *                  non-fatal semantics as PostToolUse.
 *
 * Determinism: hooks are plain shell commands run with a timeout, a capped
 * output buffer, and the event payload delivered as JSON on STDIN (never
 * interpolated into argv — hook commands are operator-authored, but the
 * payload may carry attacker-influenced tool arguments). A hook that times
 * out or cannot be parsed is treated as deny for PreToolUse (fail-closed)
 * and as a logged failure otherwise.
 *
 * Persistence: AI_FACTORY_DATA_DIR/hooks.json. Fail-open on corrupt file
 * for reads would silently drop security hooks — so a corrupt file makes
 * the loader throw and the routes answer 500 until the operator fixes it.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop';

export interface HookConfig {
  id: string;
  event: HookEvent;
  /** Optional tool-name matcher; omitted = matches every tool. */
  tool?: string;
  /** Shell command to run (operator-authored). */
  command: string;
  timeoutMs: number;
  enabled: boolean;
  description?: string;
  createdAt: string;
}

export const HOOK_EVENTS: HookEvent[] = ['PreToolUse', 'PostToolUse', 'Stop'];
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;
export const MAX_HOOK_TIMEOUT_MS = 120_000;
export const MAX_HOOK_OUTPUT = 64 * 1024;

export function hooksPath(): string {
  const fromEnv = process.env.AI_FACTORY_HOOKS_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'hooks.json');
}

function isHookEvent(v: unknown): v is HookEvent {
  return v === 'PreToolUse' || v === 'PostToolUse' || v === 'Stop';
}

export function loadHooks(): HookConfig[] {
  const path = hooksPath();
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { hooks?: HookConfig[] };
  const hooks = (raw.hooks ?? []).filter(
    (h): h is HookConfig =>
      !!h && typeof h.id === 'string' && isHookEvent(h.event)
      && typeof h.command === 'string' && h.command.trim().length > 0,
  );
  return hooks;
}

export function saveHooks(hooks: HookConfig[]): void {
  const path = hooksPath();
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ hooks }, null, 2), 'utf8');
}

export function createHook(input: {
  event: unknown;
  tool?: unknown;
  command: unknown;
  timeoutMs?: unknown;
  description?: unknown;
  enabled?: unknown;
}): HookConfig {
  if (!isHookEvent(input.event)) {
    throw new Error(`event must be one of ${HOOK_EVENTS.join('|')}`);
  }
  if (typeof input.command !== 'string' || !input.command.trim()) {
    throw new Error('command is required');
  }
  if (input.command.length > 8000) throw new Error('command too long (max 8000 chars)');
  let timeoutMs = DEFAULT_HOOK_TIMEOUT_MS;
  if (input.timeoutMs !== undefined) {
    if (typeof input.timeoutMs !== 'number' || input.timeoutMs <= 0 || input.timeoutMs > MAX_HOOK_TIMEOUT_MS) {
      throw new Error(`timeoutMs must be 1..${MAX_HOOK_TIMEOUT_MS}`);
    }
    timeoutMs = Math.floor(input.timeoutMs);
  }
  const tool = typeof input.tool === 'string' && input.tool.trim() ? input.tool.trim() : undefined;
  const hook: HookConfig = {
    id: randomUUID(),
    event: input.event,
    tool,
    command: input.command,
    timeoutMs,
    enabled: input.enabled !== false,
    description: typeof input.description === 'string' ? input.description : undefined,
    createdAt: new Date().toISOString(),
  };
  const hooks = loadHooks();
  hooks.push(hook);
  saveHooks(hooks);
  return hook;
}

export function deleteHook(id: string): boolean {
  const hooks = loadHooks();
  const kept = hooks.filter((h) => h.id !== id);
  if (kept.length === hooks.length) return false;
  saveHooks(kept);
  return true;
}

export interface HookPayload {
  event: HookEvent;
  tool: string;
  [key: string]: unknown;
}

export interface HookRunResult {
  hookId: string;
  event: HookEvent;
  ok: boolean;
  timedOut: boolean;
  exitCode: number | null;
  /** Parsed verdict: 'allow' | 'deny' | null (no verdict given). */
  verdict: 'allow' | 'deny' | null;
  reason: string | null;
  stdout: string;
  stderr: string;
}

/**
 * Run one hook. The payload goes in as JSON on stdin; stdout may carry an
 * optional JSON verdict {"decision":"allow"|"deny","reason":"…"}. A
 * non-zero exit also counts as deny. Output is capped.
 */
export function runHook(hook: HookConfig, payload: HookPayload): Promise<HookRunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'sh',
      ['-c', hook.command],
      { timeout: hook.timeoutMs, maxBuffer: MAX_HOOK_OUTPUT },
      (error, stdout, stderr) => {
        const out = String(stdout ?? '').slice(0, MAX_HOOK_OUTPUT);
        const errOut = String(stderr ?? '').slice(0, MAX_HOOK_OUTPUT);
        const timedOut = !!error && (error as { killed?: boolean }).killed === true;
        const exitCode = typeof (error as { code?: unknown } | null)?.code === 'number'
          ? (error as { code: number }).code
          : error ? 1 : 0;
        let verdict: 'allow' | 'deny' | null = null;
        let reason: string | null = null;
        const firstLine = out.split('\n')[0]?.trim() ?? '';
        if (firstLine.startsWith('{')) {
          try {
            const v = JSON.parse(firstLine) as { decision?: unknown; reason?: unknown };
            if (v.decision === 'deny' || v.decision === 'allow') {
              verdict = v.decision;
              reason = typeof v.reason === 'string' ? v.reason : null;
            }
          } catch {
            /* not JSON — no verdict */
          }
        }
        if (timedOut) {
          // Fail-closed: a hook that never finished cannot vouch for the call.
          verdict = 'deny';
          reason = `hook timed out after ${hook.timeoutMs}ms`;
        } else if (verdict === null && exitCode !== 0) {
          verdict = 'deny';
          reason = reason ?? `hook exited with code ${exitCode}`;
        }
        resolve({
          hookId: hook.id,
          event: hook.event,
          ok: exitCode === 0 && !timedOut,
          timedOut,
          exitCode,
          verdict,
          reason,
          stdout: out,
          stderr: errOut,
        });
      },
    );
    try {
      // A hook that exits without reading stdin (e.g. `echo …`) closes
      // the pipe — the resulting EPIPE arrives as an async 'error'
      // event, so it must be swallowed via a listener, not try/catch.
      const stdin = child.stdin;
      if (stdin) {
        stdin.on('error', () => {
          /* hook ignored stdin — fine */
        });
        stdin.write(JSON.stringify(payload));
        stdin.end();
      }
    } catch {
      /* stdin write failure surfaces via the callback */
    }
  });
}

export interface HookEvaluation {
  allowed: boolean;
  /** Set when a PreToolUse hook vetoed. */
  veto?: { hookId: string; reason: string };
  runs: HookRunResult[];
}

/**
 * Evaluate all enabled hooks for an event (+ optional tool matcher).
 * PreToolUse: first deny vetoes (fail-closed on timeout/parse failure).
 * PostToolUse/Stop: every matching hook runs; failures never veto.
 */
export async function evaluateHooks(
  event: HookEvent,
  payload: { tool: string; [key: string]: unknown },
  hooks: HookConfig[] = loadHooks(),
): Promise<HookEvaluation> {
  const matching = hooks.filter(
    (h) => h.enabled && h.event === event && (!h.tool || h.tool === payload.tool),
  );
  const runs: HookRunResult[] = [];
  const full: HookPayload = { ...payload, event };
  for (const hook of matching) {
    const run = await runHook(hook, full);
    runs.push(run);
    if (event === 'PreToolUse') {
      const denied = run.verdict === 'deny' || run.timedOut;
      if (denied) {
        return {
          allowed: false,
          veto: {
            hookId: hook.id,
            reason: run.reason ?? (run.timedOut ? `hook timed out after ${hook.timeoutMs}ms` : 'hook denied'),
          },
          runs,
        };
      }
    }
  }
  return { allowed: true, runs };
}

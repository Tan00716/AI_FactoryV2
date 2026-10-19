/**
 * One-tap offline mode — the network gate for privacy-sensitive work.
 *
 * When offline mode is ON, every external network egress on the server
 * fails CLOSED with the machine-readable code NETWORK_OFFLINE instead
 * of timing out or leaking:
 *
 *   - POST /api/search (web search providers)
 *   - the web_search runtime tool
 *   - MCP remote connect/call (Streamable HTTP to third-party servers)
 *   - scheduler webhook jobs (fireJob returns a skipped result)
 *   - /api/exec one-shots, interactive terminals, tool-runner shell.execute:
 *     forced bwrap --unshare-net; if bwrap is unavailable the call is
 *     REFUSED outright — never run unisolated on the host and called
 *     "offline" (no fake offline).
 *
 * What this is NOT (honest boundaries):
 *
 *   - NOT a firewall. It gates the server's own egress code paths; it
 *     does not block the host's network, the user's browser, or any
 *     other process. A determined exfiltration path outside these gates
 *     (e.g. an agent smuggling data through a task title to a
 *     webhook…) is policy's job, not this switch's.
 *   - Plugin install is local-only (sourceDir on disk); there is no
 *     remote plugin fetch to gate. If a remote marketplace is added
 *     later, it MUST check this gate.
 *   - Local operations (code search, tasks, runs, git, backups,
 *     checkpoints, audit) are unaffected — offline mode only removes
 *     network egress, it doesn't freeze the app.
 *   - MCP stdio servers and MCP server mode are local processes and
 *     stay usable. Only REMOTE (http transport) MCP is gated.
 *
 * Persistence: <AI_FACTORY_DATA_DIR|data>/network-mode.json, atomic
 * temp+rename write. Corrupt file → fail OPEN to online (the previous
 * default) and get overwritten on the next set — a mode switch must
 * never brick the server into a state nobody can turn off.
 *
 * Env override: FACTORY_NETWORK_OFFLINE=1 forces offline regardless of
 * the file (cannot be cleared via the API while set — documented so
 * nobody is surprised).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const NETWORK_MODE_FILE_ENV = 'AI_FACTORY_NETWORK_MODE_FILE';
export const NETWORK_DATA_DIR_ENV = 'AI_FACTORY_DATA_DIR';
/** Env override that forces offline mode regardless of the persisted file. */
export const NETWORK_OFFLINE_ENV = 'FACTORY_NETWORK_OFFLINE';
/** Machine-readable code returned by every gated egress while offline. */
export const NETWORK_OFFLINE_CODE = 'NETWORK_OFFLINE';

export interface NetworkModeState {
  offline: boolean;
  updatedAt: string;
  updatedBy: string;
}

function defaultFile(): string {
  const fromEnv = process.env[NETWORK_MODE_FILE_ENV];
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env[NETWORK_DATA_DIR_ENV] ?? 'data';
  return resolve(dataDir, 'network-mode.json');
}

const DEFAULT_STATE: NetworkModeState = {
  offline: false,
  updatedAt: new Date(0).toISOString(),
  updatedBy: 'default',
};

function isTruthySwitch(v: string): boolean {
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export class NetworkModeStore {
  private readonly file: string;
  private state: NetworkModeState;

  constructor(file?: string) {
    this.file = file ?? defaultFile();
    this.state = this.load();
  }

  private load(): NetworkModeState {
    try {
      const raw = readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<NetworkModeState>;
      if (typeof parsed.offline !== 'boolean') return { ...DEFAULT_STATE };
      return {
        offline: parsed.offline,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : DEFAULT_STATE.updatedAt,
        updatedBy: typeof parsed.updatedBy === 'string' ? parsed.updatedBy : 'unknown',
      };
    } catch {
      // Missing or corrupt → fail open to online (the previous default).
      return { ...DEFAULT_STATE };
    }
  }

  /** True when offline mode is active (env override wins over the file). */
  isOffline(env: NodeJS.ProcessEnv = process.env): boolean {
    const forced = env[NETWORK_OFFLINE_ENV];
    if (forced != null && isTruthySwitch(forced)) return true;
    return this.state.offline;
  }

  /** Current persisted state (the env override is NOT reflected here). */
  get(): NetworkModeState {
    return { ...this.state };
  }

  /** Flip the switch; atomic temp+rename write. Returns the new state. */
  setOffline(enabled: boolean, actor: string): NetworkModeState {
    const next: NetworkModeState = {
      offline: enabled,
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
    };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    renameSync(tmp, this.file);
    this.state = next;
    return this.get();
  }
}

/** Module singleton for the production server (lazy — created on first use). */
let singleton: NetworkModeStore | null = null;

export function networkMode(): NetworkModeStore {
  if (!singleton) singleton = new NetworkModeStore();
  return singleton;
}

/** Re-exported for tests: drop the singleton so the next call re-reads. */
export function resetNetworkModeForTests(): void {
  singleton = null;
}

/**
 * Plain Error carrying the NETWORK_OFFLINE code. Runtime tools must
 * throw plain Errors (never FactoryError) so the irrecoverable-env-error
 * HTTP boundary is unaffected — the code travels as a property.
 */
export function networkOfflineError(what: string): Error & { code: string } {
  const e = new Error(`${what} is unavailable: offline mode is enabled`) as Error & { code: string };
  e.code = NETWORK_OFFLINE_CODE;
  return e;
}

/** Throw networkOfflineError(what) when offline; no-op when online. */
export function assertOnline(what: string, env?: NodeJS.ProcessEnv): void {
  if (networkMode().isOffline(env)) throw networkOfflineError(what);
}

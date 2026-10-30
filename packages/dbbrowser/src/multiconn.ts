/**
 * R7-#8 multi-connection metadata for the database browser.
 *
 * R4-A5 already had session-scoped connections (name -> driver + env).
 * What was missing: a metadata layer on top — which connection is
 * active, which drivers are actually available, and a write-mode gate.
 *
 * Write-mode semantics (read-only by default, per the R7 brief):
 *   - Every connection starts with writeMode OFF: write-verdict
 *     statements are refused with WRITE_MODE_DISABLED until the
 *     operator explicitly enables write mode with confirm: true.
 *   - Prod connections can NEVER enable write mode (PROD_WRITE_NEVER);
 *     the pre-existing prod write refusal stays the prod path.
 *   - Read-only (driver-level) connections can never enable write mode
 *     either (READONLY_CONNECTION) — the gate must not promise a write
 *     the driver will refuse.
 *   - Destructive statements are NOT gated here: they already have
 *     their own approval-ticket path, which is the confirmation.
 *
 * Driver availability is honest, not aspirational: only sqlite (full,
 * node:sqlite) and postgres (minimal wire client, trust auth, never
 * verified against a live server) have drivers in this repo. Anything
 * else is reported unavailable with a note, and registration of an
 * unavailable kind is refused at the route layer.
 *
 * Secrets: this module never accepts, stores, or logs credentials.
 * Postgres uses trust auth only, so there is no password field anywhere
 * in the connection metadata. stripSecretFields() is a defensive scrub
 * for audit details: any password-like key in a caller-supplied object
 * is dropped before the object reaches an audit record or a response.
 */

import { DbBlockedError } from './browser.js';
import type { DbEnvironment } from './browser.js';

export type DbKind = 'sqlite' | 'postgres';

export interface DriverInfo {
  kind: string;
  available: boolean;
  note: string;
}

/** Driver catalog: available drivers first, unavailable kinds labeled. */
export const DRIVER_CATALOG: readonly DriverInfo[] = [
  { kind: 'sqlite', available: true, note: 'Built-in node:sqlite driver; fully supported.' },
  {
    kind: 'postgres',
    available: true,
    note: 'Minimal wire-protocol client (trust auth only, no SSL, simple-query only); verified against a protocol stub, never against a live server.',
  },
  { kind: 'mysql', available: false, note: 'No MySQL driver bundled; registration is refused.' },
  { kind: 'mariadb', available: false, note: 'No MariaDB driver bundled; registration is refused.' },
  { kind: 'mssql', available: false, note: 'No SQL Server driver bundled; registration is refused.' },
  { kind: 'sqlserver', available: false, note: 'No SQL Server driver bundled; registration is refused.' },
  { kind: 'oracle', available: false, note: 'No Oracle driver bundled; registration is refused.' },
];

export function driverInfo(kind: string): DriverInfo | null {
  return DRIVER_CATALOG.find((d) => d.kind === kind) ?? null;
}

export interface ConnectionMeta {
  name: string;
  kind: DbKind;
  env: DbEnvironment;
  /** Driver-level read-only (prod sqlite opens read-only). */
  readOnly: boolean;
  /** Operator-enabled write mode; default false for every connection. */
  writeMode: boolean;
  createdAt: number;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Process-scoped connection metadata. The underlying DbBrowser
 * connections are session-scoped too, so the two registries move
 * together: register/deregister in the route layer touches both.
 */
export class MultiConnectionManager {
  private readonly metas = new Map<string, ConnectionMeta>();
  private activeName: string | null = null;
  private readonly now: () => number;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? Date.now;
  }

  register(name: string, kind: DbKind, env: DbEnvironment, readOnly: boolean): ConnectionMeta {
    if (!IDENT_RE.test(name)) throw new DbBlockedError('BAD_NAME', `connection name "${name}" is not a safe identifier.`);
    const meta: ConnectionMeta = { name, kind, env, readOnly, writeMode: false, createdAt: this.now() };
    this.metas.set(name, meta);
    if (this.activeName === null) this.activeName = name;
    return meta;
  }

  remove(name: string): void {
    this.metas.delete(name);
    if (this.activeName === name) {
      const next = [...this.metas.keys()][0];
      this.activeName = next ?? null;
    }
  }

  get(name: string): ConnectionMeta {
    const m = this.metas.get(name);
    if (!m) throw new DbBlockedError('UNKNOWN_CONNECTION', `Unknown db-browser connection "${name}".`);
    return m;
  }

  has(name: string): boolean {
    return this.metas.has(name);
  }

  list(): ConnectionMeta[] {
    return [...this.metas.values()];
  }

  /** Active connection (null when none registered). Falls back to first. */
  active(): ConnectionMeta | null {
    if (this.activeName !== null) {
      const m = this.metas.get(this.activeName);
      if (m) return m;
    }
    const first = [...this.metas.values()][0];
    this.activeName = first ? first.name : null;
    return first ?? null;
  }

  activeNameOnly(): string | null {
    const a = this.active();
    return a ? a.name : null;
  }

  setActive(name: string): ConnectionMeta {
    const m = this.get(name);
    this.activeName = name;
    return m;
  }

  /**
   * Toggle write mode. Enabling requires an explicit confirm flag;
   * prod and driver-read-only connections can never enable it.
   */
  setWriteMode(name: string, enabled: boolean, confirm: boolean): ConnectionMeta {
    const m = this.get(name);
    if (enabled) {
      if (!confirm) {
        throw new DbBlockedError('CONFIRM_REQUIRED', `Enabling write mode on "${name}" requires confirm: true.`);
      }
      if (m.env === 'prod') {
        throw new DbBlockedError('PROD_WRITE_NEVER', `Prod connection "${name}" can never enable write mode.`);
      }
      if (m.readOnly) {
        throw new DbBlockedError('READONLY_CONNECTION', `Read-only connection "${name}" can never enable write mode.`);
      }
    }
    m.writeMode = enabled;
    return m;
  }

  /**
   * Write gate for write-verdict statements. Read verdicts pass; write
   * verdicts pass only when the connection is non-prod, non-read-only,
   * and write mode is enabled. Destructive/blocked verdicts are not
   * decided here (approval path / guard own them).
   */
  assertWriteAllowed(meta: ConnectionMeta, verdict: string): void {
    if (verdict !== 'write') return;
    if (meta.env === 'prod') {
      throw new DbBlockedError(
        'PROD_WRITE_REFUSED',
        `Refusing to write to prod connection "${meta.name}". The only prod write path is /api/db-time-travel/promote.`,
      );
    }
    if (meta.readOnly) {
      throw new DbBlockedError('READONLY_CONNECTION', `Connection "${meta.name}" is read-only; writes are refused.`);
    }
    if (!meta.writeMode) {
      throw new DbBlockedError(
        'WRITE_MODE_DISABLED',
        `Connection "${meta.name}" is read-only by default; enable write mode with confirm: true before writing.`,
      );
    }
  }
}

const SECRET_KEY_RE = /password|passwd|pwd|secret|token|api[-_]?key/i;

/** Deep-clone an object with password-like keys dropped (audit safety). */
export function stripSecretFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => stripSecretFields(v));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) continue;
      out[k] = stripSecretFields(v);
    }
    return out;
  }
  return value;
}

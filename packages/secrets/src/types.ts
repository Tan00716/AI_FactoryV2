/**
 * Secret Broker core types — spec §46.2.
 *
 * The discipline this package enforces:
 *  - Callers circulate only opaque references (`secret://name`). The
 *    plaintext lives inside a backend store and is handed, transiently,
 *    to a consumption point (process env, tool call) — never to a DB
 *    row, prompt, log line, audit record, URL or response body.
 *  - Audit events name the ref, the actor, the action and the outcome.
 *    They never carry a value, and error messages never carry one
 *    either.
 *  - A missing ref produces ONE uniform error shape, whatever the
 *    backends hold: the message names only the ref the caller itself
 *    supplied and says nothing about other refs or which backend was
 *    consulted.
 *  - No silent plaintext fallback (§46.2): a backend that cannot
 *    decrypt or reach its store fails loudly; nothing degrades to
 *    storing or returning plaintext anywhere else.
 */

export type Clock = { now: () => number };

/** Same name grammar as @ai-factory/security's SecretRef. */
export const SECRET_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function isValidSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

/** Validate a bare secret name; returns it or throws SecretNameError. */
export function assertSecretName(name: string): string {
  if (!isValidSecretName(name)) {
    throw new SecretNameError(
      `invalid secret name: ${JSON.stringify(name)} ` +
        `(expected ${SECRET_NAME_PATTERN.source})`,
    );
  }
  return name;
}

/**
 * Accept `name` or `secret://name` and return the bare name. Anything
 * else (other URL schemes, empty, embedded whitespace) is a name error,
 * not a lookup miss — a ref is a controlled vocabulary, not free text.
 */
export function parseSecretRef(input: string): string {
  const bare = input.startsWith('secret://') ? input.slice('secret://'.length) : input;
  return assertSecretName(bare);
}

export function secretRef(name: string): string {
  return `secret://${assertSecretName(name)}`;
}

/* ------------------------------------------------------------------ */
/* Errors — none of these ever embed a secret value.                   */
/* ------------------------------------------------------------------ */

export class SecretNameError extends Error {
  readonly code = 'SECRET_NAME_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'SecretNameError';
  }
}

/**
 * The uniform not-found error. The message depends ONLY on the ref the
 * caller asked for — never on what the backends contain — so a caller
 * cannot probe which other refs exist by comparing errors.
 */
export class SecretNotFoundError extends Error {
  readonly code = 'SECRET_NOT_FOUND';
  readonly ref: string;
  constructor(name: string) {
    super(`secret not found: secret://${name}`);
    this.name = 'SecretNotFoundError';
    this.ref = `secret://${name}`;
  }
}

/** No configured backend can persist secrets (e.g. env-only chain). */
export class SecretReadOnlyError extends Error {
  readonly code = 'SECRET_BACKEND_READ_ONLY';
  constructor(message: string) {
    super(message);
    this.name = 'SecretReadOnlyError';
  }
}

/** A backend was configured but is unusable (missing keyring tool,
 *  missing key file for an existing vault, ...). Fail-closed: callers
 *  must surface this, never fall back to plaintext handling. */
export class SecretBackendUnavailableError extends Error {
  readonly code = 'SECRET_BACKEND_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'SecretBackendUnavailableError';
  }
}

/** A stored value could not be decrypted (wrong key / wrong machine /
 *  tampered ciphertext). Distinct from "not found": the entry exists
 *  but is unreadable, and pretending otherwise would hide corruption. */
export class SecretDecryptionError extends Error {
  readonly code = 'SECRET_DECRYPTION_FAILED';
  constructor(message: string) {
    super(message);
    this.name = 'SecretDecryptionError';
  }
}

/** A lease was read after expiry or revocation (§46.2: rotation /
 *  revocation invalidates outstanding capabilities). */
export class SecretLeaseExpiredError extends Error {
  readonly code = 'SECRET_LEASE_EXPIRED';
  constructor(message: string) {
    super(message);
    this.name = 'SecretLeaseExpiredError';
  }
}

/* ------------------------------------------------------------------ */
/* Backend seam                                                        */
/* ------------------------------------------------------------------ */

/**
 * One secret backend. Implementations:
 *  - EnvSecretStore   — process env (FACTORY_SECRET_*), read-only.
 *  - FileVaultStore   — AES-256-GCM vault file + separate key file.
 *  - KeychainStore    — OS keychain via platform CLI (probed).
 *  - MemorySecretStore— ephemeral, explicitly configured sessions/tests.
 *
 * `get` returns undefined ONLY for a clean miss. Backend failures
 * (undecryptable entry, keyring tool error) throw — a miss and a
 * failure must never be conflated.
 */
export interface SecretStore {
  /** Stable backend id: 'env' | 'file-vault' | 'os-keychain' | 'memory'. */
  readonly id: string;
  /** Whether this backend persists writes. */
  readonly writable: boolean;
  get(name: string): Promise<string | undefined>;
  set?(name: string, value: string, meta?: { purpose?: string }): Promise<void>;
  delete?(name: string): Promise<boolean>;
  /** Names this backend can enumerate (names only, never values).
   *  Backends that cannot enumerate (OS keychain) return []. */
  list(): Promise<string[]>;
  /** Optional non-secret metadata about one entry. */
  purposeOf?(name: string): Promise<string | undefined>;
  updatedAtOf?(name: string): Promise<string | undefined>;
}

/* ------------------------------------------------------------------ */
/* Broker-facing shapes                                                */
/* ------------------------------------------------------------------ */

/** Metadata is all the API/UI ever shows (§46.2: 用途/状态 only). */
export interface SecretMetadata {
  name: string;
  ref: string;
  /** Backend that holds the entry (first in resolution order), or
   *  null when no backend holds it. */
  backend: string | null;
  exists: boolean;
  purpose: string | null;
  updatedAt: string | null;
}

export type SecretAuditAction =
  | 'SECRET_SET'
  | 'SECRET_DELETED'
  | 'SECRET_RESOLVED'
  | 'SECRET_LEASED'
  | 'SECRET_LEASE_REVOKED'
  | 'SECRET_NOT_FOUND'
  | 'SECRET_BACKEND_ERROR';

/**
 * One broker audit event. Fields are identifiers and outcomes only —
 * there is deliberately no field that could carry a value.
 */
export interface SecretAuditEvent {
  action: SecretAuditAction;
  actor: string;
  name: string;
  ref: string;
  backend: string | null;
  /** Why the caller wanted the secret (e.g. 'exec env injection'). */
  purpose: string | null;
  /** True when a set overwrote an existing entry (rotation). */
  rotated?: boolean;
  /** Error class name on failure events — never the error's payload. */
  error?: string;
  at: string;
}

export interface SecretAccessOptions {
  /** Who is asking (goes to audit; never a credential). */
  actor: string;
  /** Why (goes to audit; e.g. the consumption point). */
  purpose?: string;
}

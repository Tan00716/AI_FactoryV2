/**
 * Credential isolation — spec §71 (Credential isolation, Token encryption,
 * Secret redaction, Audit logs).
 *
 * Rules:
 *  - Plaintext secrets are NEVER stored in application state, logs, or
 *    evidence. Only opaque `secret://name` references circulate.
 *  - Anything that reaches a log/audit trail passes through `redactSecrets`
 *    first (see `createRedactingAudit`).
 */

export type Clock = { now: () => number };

/**
 * Opaque reference to a secret. The plaintext lives only inside the
 * credential store / resolver; this object carries `secret://name` and
 * redacts itself in every string/JSON form.
 */
export class SecretRef {
  private constructor(readonly name: string) {}

  static create(name: string): SecretRef {
    if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name)) {
      throw new Error(`invalid secret name: ${JSON.stringify(name)}`);
    }
    return new SecretRef(name);
  }

  get ref(): string {
    return `secret://${this.name}`;
  }

  /**
   * Resolve the plaintext via a caller-supplied resolver. The value must
   * not be stored — use it transiently and drop it.
   */
  deref(resolver: (name: string) => string | undefined): string {
    const v = resolver(this.name);
    if (v === undefined) throw new Error(`secret not found: ${this.name}`);
    return v;
  }

  /** Never leak the reference target either — logs only see `***`. */
  toString(): string {
    return '***';
  }

  toJSON(): { ref: string } {
    return { ref: this.ref };
  }
}

/** True when a string is a secret:// reference (not a plaintext secret). */
export function isSecretRef(s: string): boolean {
  return /^secret:\/\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(s);
}

interface RedactRule {
  name: string;
  pattern: RegExp;
  replace: string;
}

/**
 * Heuristic secret patterns. Order matters: specific token formats first,
 * generic key=value assignments after. secret:// references are deliberately
 * NOT redacted — they are the safe form.
 */
const RULES: RedactRule[] = [
  { name: 'openai', pattern: /\bsk-[A-Za-z0-9]{16,}\b/g, replace: 'sk-***' },
  {
    name: 'github',
    pattern: /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g,
    replace: '$1_***',
  },
  { name: 'aws', pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: 'AKIA***' },
  {
    name: 'slack',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g,
    replace: 'xox***',
  },
  {
    name: 'bearer',
    pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g,
    replace: 'Bearer ***',
  },
  {
    name: 'pem',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: '-----BEGIN PRIVATE KEY----- *** -----END PRIVATE KEY-----',
  },
  {
    name: 'kv',
    // Handles key=value, key: value, and JSON "key": "value". The (?!://)
    // guard keeps secret:// references intact (they are the safe form).
    pattern: /\b(api[-_ ]?key|secret([-_ ]?(key|token))?|password|passwd|pwd|pw|access[-_ ]?token|client[-_ ]?secret|auth[-_ ]?token)\b(?!\s*:\/\/)\s*["']?\s*[:=]\s*["']?[^\s"'`,;}]+/gi,
    replace: '$1=***',
  },
  {
    name: 'url-embedded',
    pattern: /(\bhttps?:\/\/[^/\s:]+:)[^@\s/]+(@)/g,
    replace: '$1***$2',
  },
];

/** Replace secret-looking fragments in text with `***`. Idempotent. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const r of RULES) {
    r.pattern.lastIndex = 0;
    out = out.replace(r.pattern, r.replace);
  }
  return out;
}

/** Deep-redact every string inside an arbitrary JSON-ish value. */
export function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    if (value instanceof SecretRef) return '***';
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * Minimal audit-sink shape (matches @ai-factory/core AuditLog#record
 * signature). Wrap any sink so that record details are redacted BEFORE the
 * write happens — the raw text never reaches the store.
 */
export interface AuditSink {
  record(
    actor: string,
    action: string,
    entityType: string,
    entityId: string,
    details?: Record<string, unknown>,
  ): unknown;
}

/** Audit-log hook: redacts details before delegating to the real sink. */
export function createRedactingAudit<T extends AuditSink>(sink: T): T {
  const wrapped = Object.create(Object.getPrototypeOf(sink));
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(sink))) {
    if (key === 'constructor') continue;
    const v = (sink as Record<string, unknown>)[key];
    if (typeof v === 'function') {
      (wrapped as Record<string, unknown>)[key] = v.bind(sink);
    }
  }
  Object.assign(wrapped, sink);
  wrapped.record = (
    actor: string,
    action: string,
    entityType: string,
    entityId: string,
    details: Record<string, unknown> = {},
  ): unknown => sink.record(actor, action, entityType, entityId, redactDeep(details) as Record<string, unknown>);
  return wrapped as T;
}

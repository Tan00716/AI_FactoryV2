/**
 * Secret redaction for traces and run details — spec §68:
 * "Sensitive credentials must never appear in traces."
 *
 * Deep-clones a value and replaces any string (or scalar) sitting under a
 * sensitive-looking key with '***'. Keys are matched case-insensitively
 * against a credential pattern; the input is never mutated.
 */
const SENSITIVE_KEY =
  /password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|bearer|session[_-]?key|cookie|auth|signing[_-]?key/i;

export const REDACTED = '***';

/** Deep-clone `value`, replacing sensitive values with '***'. */
export function redactSecrets<T>(value: T): T {
  return redactValue(value) as T;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactValue(v);
    }
    return out;
  }
  return value;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Best-effort redaction for free-text traces: masks `key=value` / `key: value`
 * pairs whose key looks sensitive (e.g. "api_key=sk-...").
 */
export function redactText(text: string): string {
  return text.replace(
    /([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|credential|bearer)[A-Za-z0-9_.-]*)\s*[:=]\s*\S+/gi,
    '$1=' + REDACTED,
  );
}

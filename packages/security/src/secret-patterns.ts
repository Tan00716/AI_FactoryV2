/**
 * Canonical secret-pattern library — the "~20 pattern families" used by the
 * repo secret scanner (inspections) AND the R4-S1 pre-send prompt gate.
 *
 * Single source of truth: `apps/server/src/inspections.ts` used to own this
 * table; it now imports it from here so the prompt gate
 * (`@ai-factory/runtime` pre-send-scan) can reuse the exact same engine
 * without an apps/ ← packages/ dependency inversion.
 *
 * `kind: 'specific'` — unambiguous token shapes (AWS keys, ghp_…); safe to
 * fire anywhere, even in test fixtures.
 * `kind: 'generic'` — assignment-shaped heuristics; the repo scanner skips
 * them in test files and the prompt gate skips placeholder-looking values
 * (see isPlaceholderValue). No entropy scoring: entropy finds too many
 * false positives to be useful without a model to arbitrate.
 */
export interface SecretPattern {
  /** Stable rule id, e.g. 'aws-access-key'. */
  name: string;
  re: RegExp;
  kind: 'specific' | 'generic';
}

export const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'aws-access-key', kind: 'specific', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'aws-secret-key', kind: 'specific', re: /aws_secret_access_key\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}["']?/ },
  { name: 'github-pat-classic', kind: 'specific', re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: 'github-pat-fine-grained', kind: 'specific', re: /\bgithub_pat_[A-Za-z0-9_]{82}\b/ },
  { name: 'github-token', kind: 'specific', re: /\b(?:gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { name: 'private-key', kind: 'specific', re: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'slack-token', kind: 'specific', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'slack-webhook', kind: 'specific', re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{8,}\/B[A-Z0-9]{8,}\/[A-Za-z0-9]{24,}/ },
  { name: 'stripe-live-key', kind: 'specific', re: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  { name: 'google-api-key', kind: 'specific', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'jwt-token', kind: 'specific', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'sendgrid-key', kind: 'specific', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
  { name: 'npm-token', kind: 'specific', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'pypi-token', kind: 'specific', re: /\bpypi-[A-Za-z0-9_-]{40,}\b/ },
  { name: 'telegram-bot-token', kind: 'specific', re: /\b[0-9]{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { name: 'openai-key', kind: 'specific', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: 'generic-api-key', kind: 'generic', re: /\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key)\s*[:=]\s*["']?([^"'\s]{8,})["']?/i },
  { name: 'generic-password', kind: 'generic', re: /\b(password|passwd|pwd)\s*[:=]\s*["']([^"'\s]{8,})["']/i },
  { name: 'bearer-token', kind: 'generic', re: /\bAuthorization\s*[:=]\s*["']Bearer\s+[A-Za-z0-9._~-]{16,}["']/i },
  { name: 'basic-auth-url', kind: 'generic', re: /:\/\/[^/\s:@]+:[^/\s:@]{4,}@/ },
  { name: 'db-connection-string', kind: 'generic', re: /\b(?:mongodb|postgres|mysql|redis):\/\/[^/\s:@]+:[^/\s:@]{4,}@/i },
];

const PLACEHOLDER_RE =
  /example|sample|placeholder|dummy|xxx|\.\.\.|<[^>]*>|\$\{|process\.env|your[_-]|changeme|redacted|\*\*\*/i;

/** True when the matched text looks like documentation, not a real secret. */
export function isPlaceholderValue(s: string): boolean {
  return PLACEHOLDER_RE.test(s);
}

/** Mask a matched secret for safe display/audit: first 4 + last 2 only. */
export function maskSecret(s: string): string {
  if (s.length <= 8) return s.slice(0, 2) + '…' + s.slice(-1);
  return s.slice(0, 4) + '…' + s.slice(-2);
}

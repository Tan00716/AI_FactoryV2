/**
 * Redaction for diagnostics bundles (V3-#10).
 *
 * Rules are NOT invented here: every pattern comes from the shared
 * @ai-factory/security SECRET_PATTERNS table (the same table the repo
 * secret scanner and the pre-send prompt gate use).
 *
 * - `specific` shapes (token formats, private-key headers, JWTs) are
 *   replaced wholesale with [REDACTED:<name>]: even a masked fragment of
 *   a token is more disclosure than a support bundle needs.
 * - `generic` assignment shapes (api_key=..., password="...") keep the
 *   key name — it is diagnostic — and mask only the value with the
 *   shared maskSecret (first 4 + last 2, same convention as the .env
 *   list). Masked values are under 8 characters, so they cannot
 *   re-trigger the generic patterns in the self-check.
 * - Patterns are re-compiled with the global flag on every call: the
 *   table's regexes are stateless and must never be shared with a
 *   sticky lastIndex across calls.
 */
import { SECRET_PATTERNS, maskSecret } from '@ai-factory/security';

export const REDACTED_TOKEN = '[REDACTED]';

/**
 * Redact every secret-shaped substring in free text. Returns the text
 * with specific shapes replaced and generic assignment values masked.
 */
export function redactText(text: string): string {
  if (!text) return text;
  let out = text;
  for (const p of SECRET_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g');
    out = out.replace(re, (match, ...args: unknown[]) => {
      if (p.kind !== 'generic') return `[REDACTED:${p.name}]`;
      // Generic patterns carry the value in their LAST capture group
      // when the shape has one (api_key/password: group 1 is the key
      // name, group 2 the value); keep the key name, mask the value.
      // Otherwise replace the whole match.
      const groups = args.slice(0, -2) as Array<string | undefined>;
      const defined = groups.filter((g) => typeof g === 'string' && g.length > 0);
      const value = defined.length > 1 ? defined[defined.length - 1] : undefined;
      if (value === undefined) return `[REDACTED:${p.name}]`;
      const idx = match.lastIndexOf(value);
      if (idx < 0) return `[REDACTED:${p.name}]`;
      return match.slice(0, idx) + maskSecret(value) + match.slice(idx + value.length);
    });
  }
  return out;
}

/**
 * Self-check: scan serialized text for any remaining secret-pattern
 * match. Returns the matched pattern names (empty = clean). A bundle
 * that fails this check must be refused, never shipped.
 */
export function selfCheckSecretPatterns(serialized: string): string[] {
  const hit: string[] = [];
  for (const p of SECRET_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g');
    if (re.test(serialized)) hit.push(p.name);
  }
  return hit;
}

/** Mask a single config-ish value with the shared convention. */
export function maskValue(value: string): string {
  return maskSecret(value);
}

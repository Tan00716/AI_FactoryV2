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
 * R17 N3 — strip the userinfo (embedded credentials) from a clone URL
 * before it is written to the audit chain. `https://user:password@host/x`
 * becomes `https://host/x` (host, port and path preserved); URLs without
 * userinfo, scp-like `git@host:x` forms, file:// URLs and local paths pass
 * through unchanged. Unparseable input is returned unchanged.
 *
 * 口径说明（既有链）: the audit chain is append-only and cannot be
 * rewritten, so PROJECT_CLONE_FAILED / PROJECT_CLONED records written
 * before this fix may still carry a raw userinfo segment. Only records
 * written from this fix onward are stripped; nothing here rewrites history.
 * The project record itself keeps the raw URL in `repository_refs` (it is
 * the asserted source for future fetches) — only the audit copy is stripped.
 *
 * Canonical home (R18 (o)): these two helpers used to live in
 * apps/server/src/routes/projects.ts; they are generic audit-redaction
 * utilities, so they live here next to redactText and are re-exported from
 * the routes module for backward compatibility.
 */
export function stripCloneUrlUserinfo(repoUrl: string): string {
  try {
    const u = new URL(repoUrl);
    if (u.username === '' && u.password === '') return repoUrl;
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return repoUrl;
  }
}

/**
 * R17 N3 (Red Team S4) — strip embedded credentials from free text that
 * may carry a clone URL, e.g. a child-process error message. git strips
 * credentials from its own stderr on a reachable host answering 401
 * (`fatal: Authentication failed for 'http://host/repo.git/'`), but
 * Node's `Command failed: git clone http://user:password@host/repo.git …`
 * prefix echoes the full argv, so the message must be scrubbed before it
 * is stored in the audit `reason` field or returned in the 502 response.
 * Only `scheme://…@` segments before the first `/` are touched; URLs
 * without userinfo and plain text pass through unchanged.
 *
 * R18 N7 / (o)(c): the original regex only recognised lowercase http(s),
 * so `HTTPS://` (uppercase scheme) and `ssh://`, `git://`, `ftp://` URLs
 * with passwords leaked through `reason` and the 502 response. The pattern
 * is now case-insensitive and matches any scheme (`[a-z][a-z0-9+.-]*://`).
 * This is NOT a substitute for redactText on these fields: redactText only
 * masks URL userinfo when the password is >= 4 characters, so a short
 * password survives it — the strip must run first.
 */
export function stripUserinfoFromText(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi, '$1');
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

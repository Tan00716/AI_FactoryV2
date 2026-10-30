/**
 * @ai-factory/httpclient — auth profile application + header redaction
 * (round-7 task R7-#9).
 *
 * A profile never carries its own secret: the caller resolves the secret
 * (from the secrets file or a process env var) and passes it in. That
 * keeps this module pure and keeps secrets out of every stored object.
 *
 * OAuth2 is a placeholder by design (round-7 checklist): a profile of
 * kind 'oauth2' is accepted for bookkeeping but applying it fails
 * closed with code 'oauth2-placeholder' — no token flow is faked.
 */
import { HttpClientError } from './types';
import type { AuthKind } from './collections';

export interface ResolvedAuthProfile {
  kind: AuthKind;
  username?: string;
  headerName?: string;
}

/**
 * Apply an auth profile to a header map. Returns a NEW map; the input
 * is never mutated. Throws HttpClientError when the secret is missing
 * (fail-closed: no request goes out half-authenticated).
 */
export function applyAuth(
  headers: Record<string, string>,
  profile: ResolvedAuthProfile,
  secret: string | null,
): Record<string, string> {
  const out: Record<string, string> = { ...headers };
  // A caller-supplied Authorization header always loses to the profile:
  // two credential sources must never mix silently.
  delete out['Authorization'];
  switch (profile.kind) {
    case 'bearer': {
      if (!secret) throw new HttpClientError('bearer auth profile has no secret', 'auth-no-secret');
      out['Authorization'] = `Bearer ${secret}`;
      return out;
    }
    case 'basic': {
      if (!secret) throw new HttpClientError('basic auth profile has no secret', 'auth-no-secret');
      if (!profile.username) throw new HttpClientError('basic auth profile has no username', 'auth-no-username');
      out['Authorization'] = `Basic ${Buffer.from(`${profile.username}:${secret}`, 'utf8').toString('base64')}`;
      return out;
    }
    case 'apikey': {
      if (!secret) throw new HttpClientError('apikey auth profile has no secret', 'auth-no-secret');
      out[profile.headerName ?? 'X-Api-Key'] = secret;
      return out;
    }
    case 'oauth2':
      throw new HttpClientError(
        'OAuth2 is a placeholder in this version: no token flow is implemented (configure bearer/basic/apikey instead)',
        'oauth2-placeholder',
      );
  }
}

/**
 * Redact credential headers for display/history: Authorization and any
 * configured api-key header name become `<redacted>`. Anything else
 * passes through untouched.
 */
export function redactHeaders(headers: Record<string, string>, apiKeyHeaderNames: string[] = []): Record<string, string> {
  const blocked = new Set(['authorization', ...apiKeyHeaderNames.map((h) => h.toLowerCase())]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = blocked.has(k.toLowerCase()) ? '<redacted>' : v;
  }
  return out;
}

/**
 * @ai-factory/mcp — runtime security policy (§34.3).
 *
 * "限制 subprocess/stdio 继承环境、HTTP credentials、redirect、OAuth
 * audience/scope、TLS、动态 URL 和资源大小" — §34.3 is a list of
 * RUNTIME restrictions. The install-time trust assessment (security.ts)
 * cannot enforce any of them; this module models each one as policy
 * data on the server record plus a pure pre-flight check, and the
 * tool-call gate enforces the checks that are decidable before a call
 * (OAuth audience/scope, payload size).
 *
 * What is REAL enforcement here vs modelled declaration — stated
 * plainly, per surface:
 *  - stdio env filtering: filterStdioEnv() actually strips the
 *    environment; any launcher built on this package MUST spawn with
 *    its output. (The package ships no spawner — a launcher that
 *    ignores the filter is outside this layer, see KNOWN_LIMITATIONS.)
 *  - redirect / URL / TLS decisions: evaluateRedirect() and
 *    evaluateServerUrl() are the decision functions an HTTP transport
 *    must consult; the credential-forwarding rule they encode
 *    (credentials never cross to an unlisted host) is the enforcement
 *    point once the transport calls them. TLS itself is negotiated by
 *    the transport/OS stack — this layer can only model the
 *    requirement (tlsMode, requireTlsForCredentials) and refuse
 *    credential-bearing plain-HTTP URLs; it cannot perform or verify a
 *    handshake.
 *  - OAuth audience/scope: checked for real in the gate when the
 *    caller presents the token's audience/scopes.
 *  - resource size: checked for real in the gate when the caller
 *    declares the payload size up front; a transport should also
 *    apply maxResourceBytes while streaming (modelled here).
 *
 * All numeric defaults below are LOCAL policy defaults, not spec
 * numbers — the spec names the restrictions, not their values.
 */
import { McpRuntimePolicy, McpServer, Transport } from './types';

export type { McpRuntimePolicy };

/** Local defaults (see header): minimal stdio inheritance, no redirects, TLS for credentials, 1 MiB payloads. */
export function defaultRuntimePolicy(transport: Transport): McpRuntimePolicy {
  return {
    stdioEnvAllowlist: ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR'],
    allowedCredentialHeaders: ['authorization'],
    followRedirects: false,
    tlsMode: 'system',
    requireTlsForCredentials: true,
    allowDynamicUrl: false,
    maxResourceBytes: 1_048_576,
  };
}

/* ------------------------------------------------------------ checks -- */

export interface PolicyVerdict {
  allowed: boolean;
  reason: string;
}

/** Strip a parent environment down to the policy allowlist (+ fixed values). Real filtering — use its output to spawn. */
export function filterStdioEnv(
  policy: McpRuntimePolicy,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of policy.stdioEnvAllowlist) {
    const v = env[name];
    if (typeof v === 'string') out[name] = v;
  }
  return { ...out, ...(policy.stdioEnvFixed ?? {}) };
}

export interface RedirectVerdict extends PolicyVerdict {
  /** may credential headers be attached to the redirected request? */
  forwardCredentials: boolean;
}

/**
 * Decide a redirect. Credentials NEVER cross hosts unless the target
 * host is allowlisted, and no redirect is followed at all unless the
 * policy opts in.
 */
export function evaluateRedirect(
  policy: McpRuntimePolicy,
  fromUrl: string,
  toUrl: string,
  opts: { credentialsPresent: boolean },
): RedirectVerdict {
  let from: URL;
  let to: URL;
  try {
    from = new URL(fromUrl);
    to = new URL(toUrl);
  } catch {
    return { allowed: false, forwardCredentials: false, reason: 'redirect decision denied: unparseable URL' };
  }
  if (!policy.followRedirects) {
    return { allowed: false, forwardCredentials: false, reason: 'redirect denied: policy does not follow redirects' };
  }
  const sameHost = from.host === to.host;
  const listed = (policy.redirectHostAllowlist ?? []).includes(to.host);
  if (!opts.credentialsPresent) {
    return { allowed: true, forwardCredentials: false, reason: 'redirect allowed (no credentials attached)' };
  }
  if (sameHost) {
    return { allowed: true, forwardCredentials: true, reason: 'redirect allowed: same host, credentials may be forwarded' };
  }
  if (listed) {
    return { allowed: true, forwardCredentials: true, reason: `redirect allowed: host ${to.host} is on the credential-forwarding allowlist` };
  }
  // The redirect itself may be followed by a transport, but stripped of
  // credentials it is a different (unauthenticated) request — this
  // layer's verdict for a credential-bearing call is denial.
  return {
    allowed: false,
    forwardCredentials: false,
    reason: `redirect denied: credentials must not be forwarded to unlisted host ${to.host}`,
  };
}

/**
 * Decide whether a server URL may be used: dynamic changes need the
 * policy opt-in (a changed URL is a changed server — re-approval
 * territory, §34.3), and credential-bearing plain-HTTP is refused
 * while requireTlsForCredentials stands.
 */
export function evaluateServerUrl(
  policy: McpRuntimePolicy,
  url: string,
  opts: { credentialsPresent: boolean },
): PolicyVerdict {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'server URL denied: unparseable URL' };
  }
  if (policy.serverUrl && policy.serverUrl !== url && !policy.allowDynamicUrl) {
    return {
      allowed: false,
      reason: `server URL denied: '${url}' differs from the pinned URL and dynamic URLs are not allowed (re-registration/re-approval required)`,
    };
  }
  if (opts.credentialsPresent && policy.requireTlsForCredentials && parsed.protocol !== 'https:' && parsed.protocol !== 'wss:') {
    return {
      allowed: false,
      reason: `server URL denied: credentials require TLS but the URL is ${parsed.protocol}`,
    };
  }
  return { allowed: true, reason: 'ok' };
}

/** Check a presented OAuth token (audience + granted scopes) against the policy's expectations. */
export function evaluateOAuth(
  policy: McpRuntimePolicy,
  token: { audience?: string; scopes: string[] },
): PolicyVerdict & { missingScopes: string[] } {
  const oauth = policy.oauth;
  if (!oauth) return { allowed: true, reason: 'ok (no OAuth expectations configured)', missingScopes: [] };
  if (oauth.audience !== undefined && token.audience !== oauth.audience) {
    return {
      allowed: false,
      reason: `OAuth denied: token audience '${token.audience ?? '(none)'}' does not match required audience '${oauth.audience}'`,
      missingScopes: [],
    };
  }
  const held = new Set(token.scopes);
  const missingScopes = oauth.requiredScopes.filter((s) => !held.has(s));
  if (missingScopes.length > 0) {
    return { allowed: false, reason: `OAuth denied: token is missing required scopes: ${missingScopes.join(', ')}`, missingScopes };
  }
  return { allowed: true, reason: 'ok', missingScopes: [] };
}

/** Check a declared payload size against the resource limit. */
export function checkResourceSize(policy: McpRuntimePolicy, bytes: number): PolicyVerdict {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return { allowed: false, reason: 'resource size denied: size is not a non-negative number' };
  }
  if (bytes > policy.maxResourceBytes) {
    return { allowed: false, reason: `resource size denied: ${bytes} bytes exceeds the ${policy.maxResourceBytes}-byte limit` };
  }
  return { allowed: true, reason: 'ok' };
}

/** Configuration sanity: returns human-readable problems (empty = sane). */
export function validateRuntimePolicy(policy: McpRuntimePolicy): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(policy.maxResourceBytes) || policy.maxResourceBytes <= 0) {
    problems.push('maxResourceBytes must be a positive number');
  }
  if (policy.tlsMode === 'insecure-declared' && policy.requireTlsForCredentials) {
    problems.push("tlsMode 'insecure-declared' contradicts requireTlsForCredentials — pick one stance and record it");
  }
  if (policy.followRedirects && policy.redirectHostAllowlist === undefined) {
    problems.push('followRedirects is on but no redirectHostAllowlist is recorded — cross-host credential forwarding stays denied, same-host only');
  }
  return problems;
}

/** Attach (or replace) the runtime policy on a server record. Kept as a helper so hosts set it in one place. */
export function withRuntimePolicy(server: McpServer, policy: McpRuntimePolicy): McpServer {
  server.runtimePolicy = policy;
  return server;
}

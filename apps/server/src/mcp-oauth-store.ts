/**
 * Secrets-backed OAuth token store (W-A).
 *
 * Implements the @ai-factory/mcp OAuthTokenStore on the server's
 * SecretBroker, so issued OAuth tokens (access + refresh) are stored
 * in the vault — encrypted at rest by the configured backend, covered
 * by the broker's audit log and redaction — never in the MCP registry
 * rows, logs, or the flag file.
 *
 * Issuer isolation (MCP 2026-07-28): every key is scoped to the
 * token's issuer via oauthStoreKey() — credentials are NEVER shared
 * across issuers, even for the same MCP server. A server whose OAuth
 * issuer changes must re-authorize; the old issuer's tokens are simply
 * unreachable under the new key (not deleted, not reused).
 */
import type { SecretBroker } from '@ai-factory/secrets';
import { oauthStoreKey } from '@ai-factory/mcp';
import type { McpOAuthConfig, OAuthTokenStore, StoredOAuthToken } from '@ai-factory/mcp';

/**
 * The issuer identity string used for key scoping: the configured
 * issuer, else the token endpoint (the party that mints the token),
 * else the authorization endpoint, else 'direct'.
 */
export function oauthIssuerRef(oauth: McpOAuthConfig | undefined): string {
  return oauth?.issuer ?? oauth?.tokenEndpoint ?? oauth?.authorizationEndpoint ?? 'direct';
}

/** Issuer-scoped vault key for a server's OAuth tokens. */
export function oauthSecretName(name: string, version: string, oauth: McpOAuthConfig | undefined): string {
  return oauthStoreKey(name, version, oauthIssuerRef(oauth));
}

/** Client-secret vault name for a confidential OAuth client. */
export function oauthClientSecretName(name: string, version: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+/, '').slice(0, 60);
  return `mcp-oauth-${clean(name) || 'x'}-${clean(version) || 'x'}-client-secret`;
}

export class SecretsBackedOAuthTokenStore implements OAuthTokenStore {
  private readonly broker: SecretBroker;
  private readonly actor: string;

  constructor(broker: SecretBroker, actor = 'mcp-oauth') {
    this.broker = broker;
    this.actor = actor;
  }

  async save(key: string, token: StoredOAuthToken): Promise<void> {
    assertKey(key);
    await this.broker.set(key, JSON.stringify(token), {
      actor: this.actor,
      purpose: 'mcp-oauth-token',
    });
  }

  async load(key: string): Promise<StoredOAuthToken | null> {
    assertKey(key);
    let raw: string;
    try {
      raw = await this.broker.resolve(key, { actor: this.actor, purpose: 'mcp-oauth-token' });
    } catch {
      return null; // unknown name → no token stored
    }
    try {
      const t = JSON.parse(raw) as Partial<StoredOAuthToken>;
      if (!t || typeof t.accessToken !== 'string' || !t.accessToken) return null;
      return {
        accessToken: t.accessToken,
        refreshToken: typeof t.refreshToken === 'string' ? t.refreshToken : undefined,
        tokenType: typeof t.tokenType === 'string' ? t.tokenType : 'Bearer',
        scope: typeof t.scope === 'string' ? t.scope : undefined,
        obtainedAt: typeof t.obtainedAt === 'number' ? t.obtainedAt : 0,
        expiresIn: typeof t.expiresIn === 'number' ? t.expiresIn : undefined,
      };
    } catch {
      return null;
    }
  }

  async clear(key: string): Promise<void> {
    assertKey(key);
    await this.broker.delete(key, { actor: this.actor });
  }
}

function assertKey(key: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(key)) {
    throw new Error(`oauth: invalid token-store key '${key}'`);
  }
}

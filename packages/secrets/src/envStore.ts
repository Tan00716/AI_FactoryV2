/**
 * Environment backend — secrets supplied as FACTORY_SECRET_<NAME>
 * process env vars (local dev / CI friendly).
 *
 * Read-only by design: the broker cannot write back into a parent
 * process's environment, so `writable` is false and the broker routes
 * writes to another backend (or refuses when this is the only one).
 *
 * Name mapping: `github-token` → FACTORY_SECRET_GITHUB_TOKEN
 * (upper-case; every run of non-alphanumerics collapses to one '_').
 * Listing reverses the mapping canonically (lower-case, '_' → '-'),
 * so an env-provided `github.token` and `github-token` are the same
 * canonical entry — the forward lookup is the exact one and both
 * spellings resolve.
 */
import {
  SECRET_NAME_PATTERN,
  assertSecretName,
  type SecretStore,
} from './types';

export const SECRET_ENV_PREFIX = 'FACTORY_SECRET_';

export function envVarForSecret(name: string): string {
  return SECRET_ENV_PREFIX + name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

export class EnvSecretStore implements SecretStore {
  readonly id = 'env';
  readonly writable = false;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async get(name: string): Promise<string | undefined> {
    assertSecretName(name);
    const v = this.env[envVarForSecret(name)];
    // Unset and empty are the same "no secret" (mirrors the API token
    // resolution in apps/server/src/auth.ts).
    return v === undefined || v === '' ? undefined : v;
  }

  async list(): Promise<string[]> {
    const names: string[] = [];
    for (const key of Object.keys(this.env)) {
      if (!key.startsWith(SECRET_ENV_PREFIX)) continue;
      const suffix = key.slice(SECRET_ENV_PREFIX.length);
      if (!suffix) continue;
      const name = suffix.toLowerCase().replace(/_/g, '-');
      if (SECRET_NAME_PATTERN.test(name) && !names.includes(name)) names.push(name);
    }
    return names.sort();
  }
}

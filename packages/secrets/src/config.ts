/**
 * Environment-driven broker construction (used by the server).
 *
 *   FACTORY_SECRETS_BACKEND  file (default) | keychain | memory | env
 *   FACTORY_SECRETS_DIR      vault directory for backend=file
 *                           (default <baseDir>/secrets; vault.json and
 *                           vault.key are separate files inside it)
 *
 * The chain is always [primary, env] (env deduplicated when it IS the
 * primary): environment-provided secrets stay resolvable everywhere,
 * while writes go to the primary. Selection is EXPLICIT — backend=
 * keychain with no keychain tool throws here (fail-closed, §46.2:
 * never silently downgrade), and backend=memory is the spec's
 * explicitly-configured ephemeral session, chosen on purpose.
 */
import { join } from 'node:path';
import { SecretBroker } from './broker';
import { EnvSecretStore } from './envStore';
import { FileVaultStore } from './fileVault';
import { KeychainStore } from './keychain';
import { MemorySecretStore } from './memoryStore';
import {
  SecretBackendUnavailableError,
  type Clock,
  type SecretAuditEvent,
  type SecretStore,
} from './types';

export const SECRET_BACKEND_ENV = 'FACTORY_SECRETS_BACKEND';
export const SECRET_DIR_ENV = 'FACTORY_SECRETS_DIR';

export interface SecretBrokerSetup {
  broker: SecretBroker;
  /** Primary backend id (what the operator configured). */
  backend: string;
  /** Full resolution chain, primary first. */
  chain: string[];
  /** Where the file vault lives (backend=file only). */
  vaultPath?: string;
  keyPath?: string;
}

export function createSecretBrokerFromEnv(opts: {
  env?: NodeJS.ProcessEnv;
  baseDir?: string;
  audit?: (event: SecretAuditEvent) => void;
  clock?: Clock;
} = {}): SecretBrokerSetup {
  const env = opts.env ?? process.env;
  const backend = (env[SECRET_BACKEND_ENV] ?? 'file').trim().toLowerCase();
  const envStore = new EnvSecretStore(env);

  let primary: SecretStore;
  let vaultPath: string | undefined;
  let keyPath: string | undefined;

  switch (backend) {
    case 'file': {
      const dir = env[SECRET_DIR_ENV] ?? join(opts.baseDir ?? join(process.cwd(), 'data'), 'secrets');
      vaultPath = join(dir, 'vault.json');
      keyPath = join(dir, 'vault.key');
      primary = new FileVaultStore({ vaultPath, keyPath, clock: opts.clock });
      break;
    }
    case 'keychain': {
      primary = new KeychainStore();
      if (!primary.writable) {
        throw new SecretBackendUnavailableError(
          `${SECRET_BACKEND_ENV}=keychain but the OS keychain is unavailable: ` +
            `${(primary as KeychainStore).detection.reason}. Refusing to start the ` +
            `secret broker rather than silently falling back to weaker storage (§46.2).`,
        );
      }
      break;
    }
    case 'memory': {
      primary = new MemorySecretStore(opts.clock);
      break;
    }
    case 'env': {
      primary = envStore;
      break;
    }
    default:
      throw new SecretBackendUnavailableError(
        `unknown ${SECRET_BACKEND_ENV} value ${JSON.stringify(backend)} ` +
          `(expected file | keychain | memory | env)`,
      );
  }

  const stores = primary === envStore ? [envStore] : [primary, envStore];
  const broker = new SecretBroker({ stores, audit: opts.audit, clock: opts.clock });
  return { broker, backend: primary.id, chain: stores.map((s) => s.id), vaultPath, keyPath };
}

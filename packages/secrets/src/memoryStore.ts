/**
 * Ephemeral in-memory backend.
 *
 * §46.2 allows exactly one alternative when no persistent store is
 * usable: an *explicitly configured* ephemeral session. This store is
 * that — values live in this process's memory only and die with it.
 * It is never selected implicitly: the factory picks it only when
 * FACTORY_SECRETS_BACKEND=memory says so, and the server logs that
 * choice at startup. Also the natural backend for tests.
 */
import { assertSecretName, type Clock, type SecretStore } from './types';

interface MemoryEntry {
  value: string;
  purpose?: string;
  updatedAt: string;
}

export class MemorySecretStore implements SecretStore {
  readonly id = 'memory';
  readonly writable = true;
  private readonly entries = new Map<string, MemoryEntry>();

  constructor(private readonly clock: Clock = { now: () => Date.now() }) {}

  async get(name: string): Promise<string | undefined> {
    assertSecretName(name);
    return this.entries.get(name)?.value;
  }

  async set(name: string, value: string, meta?: { purpose?: string }): Promise<void> {
    assertSecretName(name);
    this.entries.set(name, {
      value,
      purpose: meta?.purpose,
      updatedAt: new Date(this.clock.now()).toISOString(),
    });
  }

  async delete(name: string): Promise<boolean> {
    assertSecretName(name);
    return this.entries.delete(name);
  }

  async list(): Promise<string[]> {
    return [...this.entries.keys()].sort();
  }

  async purposeOf(name: string): Promise<string | undefined> {
    return this.entries.get(name)?.purpose;
  }

  async updatedAtOf(name: string): Promise<string | undefined> {
    return this.entries.get(name)?.updatedAt;
  }
}

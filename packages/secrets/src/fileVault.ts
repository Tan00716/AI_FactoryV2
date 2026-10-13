/**
 * Encrypted file vault backend.
 *
 * Layout (two separate files, both mode 0600):
 *   vault file — JSON: { version, entries: { name: { iv, tag, data,
 *                purpose?, updatedAt } } }, values AES-256-GCM encrypted.
 *   key file   — 32 random bytes (base64), generated on first use.
 *
 * The encryption key is DERIVED (HKDF-SHA256) from the key-file bytes
 * plus this machine's id, so a vault copied to another machine — or a
 * key file copied without the machine — does not decrypt: it fails
 * with SecretDecryptionError, loudly. Per §46.2 there is no plaintext
 * fallback path at all: a vault whose key is missing/corrupt makes the
 * store unavailable instead of degrading.
 *
 * Honest strength label: this is NOT an OS keychain. It protects
 * secrets at rest against casual disclosure (stolen DB/backup, vault
 * file committed by accident, vault copied off-machine). Anyone who
 * can read BOTH files AND run code as this user on this machine can
 * decrypt — §46.1 already places a compromised local admin outside
 * what a local sandbox can guarantee.
 */
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { hostname, platform, arch } from 'node:os';
import {
  SecretBackendUnavailableError,
  SecretDecryptionError,
  assertSecretName,
  type Clock,
  type SecretStore,
} from './types';

export interface FileVaultOptions {
  vaultPath: string;
  keyPath: string;
  /** Machine binding input. Default: /etc/machine-id when present,
   *  else hostname+platform+arch. Injectable for tests. */
  machineId?: string;
  clock?: Clock;
}

interface VaultEntry {
  iv: string;
  tag: string;
  data: string;
  purpose?: string;
  updatedAt: string;
}

interface VaultFile {
  version: 1;
  entries: Record<string, VaultEntry>;
}

const HKDF_INFO = Buffer.from('ai-factory-secret-vault-v1', 'utf8');

export function defaultMachineId(): string {
  try {
    const id = readFileSync('/etc/machine-id', 'utf8').trim();
    if (id) return id;
  } catch {
    /* not Linux / not readable — fall through */
  }
  return `${hostname()}|${platform()}|${arch()}`;
}

export class FileVaultStore implements SecretStore {
  readonly id = 'file-vault';
  readonly writable = true;
  private readonly clock: Clock;
  private readonly key: Buffer;
  private vault: VaultFile;

  constructor(private readonly opts: FileVaultOptions) {
    this.clock = opts.clock ?? { now: () => Date.now() };
    mkdirSync(dirname(opts.vaultPath), { recursive: true });
    mkdirSync(dirname(opts.keyPath), { recursive: true });
    this.key = this.loadOrCreateKey();
    this.vault = this.loadVault();
  }

  /* ------------------------------------------------------------ key */

  private loadOrCreateKey(): Buffer {
    const { keyPath } = this.opts;
    let raw: Buffer;
    if (existsSync(keyPath)) {
      raw = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64');
      if (raw.length < 16) {
        throw new SecretBackendUnavailableError(
          `secret vault key file ${keyPath} is corrupt (too short); ` +
            `refusing to continue — restore the key or remove the vault, ` +
            `there is no plaintext fallback`,
        );
      }
    } else {
      // Refuse to mint a fresh key over an existing vault: every entry
      // would become undecryptable while looking "fine".
      if (existsSync(this.opts.vaultPath)) {
        throw new SecretBackendUnavailableError(
          `secret vault ${this.opts.vaultPath} exists but its key file ${keyPath} is missing; ` +
            `refusing to mint a new key over existing entries — restore the key file`,
        );
      }
      raw = randomBytes(32);
      writeFileSync(keyPath, raw.toString('base64') + '\n', { mode: 0o600 });
      chmodSync(keyPath, 0o600);
    }
    const machineId = this.opts.machineId ?? defaultMachineId();
    return Buffer.from(hkdfSync('sha256', raw, Buffer.from(machineId, 'utf8'), HKDF_INFO, 32));
  }

  /* ---------------------------------------------------------- vault */

  private loadVault(): VaultFile {
    const { vaultPath } = this.opts;
    if (!existsSync(vaultPath)) return { version: 1, entries: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(vaultPath, 'utf8'));
    } catch {
      throw new SecretBackendUnavailableError(
        `secret vault ${vaultPath} is not valid JSON; refusing to overwrite it`,
      );
    }
    const v = parsed as Partial<VaultFile>;
    if (v.version !== 1 || typeof v.entries !== 'object' || v.entries === null) {
      throw new SecretBackendUnavailableError(
        `secret vault ${vaultPath} has an unsupported shape (version ${String(v.version)}); refusing to use it`,
      );
    }
    return { version: 1, entries: v.entries as Record<string, VaultEntry> };
  }

  private persist(): void {
    const tmp = `${this.opts.vaultPath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.vault, null, 2) + '\n', { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.opts.vaultPath);
  }

  private encrypt(plaintext: string): Omit<VaultEntry, 'updatedAt' | 'purpose'> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
  }

  private decrypt(name: string, entry: VaultEntry): string {
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(entry.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(entry.data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // GCM authentication failed: wrong key, wrong machine, or the
      // ciphertext was tampered with. Never return partial plaintext.
      throw new SecretDecryptionError(
        `secret secret://${name} could not be decrypted ` +
          `(key/machine mismatch or tampered vault entry in ${this.opts.vaultPath})`,
      );
    }
  }

  /* ---------------------------------------------------------- store */

  async get(name: string): Promise<string | undefined> {
    assertSecretName(name);
    const entry = this.vault.entries[name];
    return entry ? this.decrypt(name, entry) : undefined;
  }

  async set(name: string, value: string, meta?: { purpose?: string }): Promise<void> {
    assertSecretName(name);
    const enc = this.encrypt(value);
    this.vault.entries[name] = {
      ...enc,
      purpose: meta?.purpose,
      updatedAt: new Date(this.clock.now()).toISOString(),
    };
    this.persist();
  }

  async delete(name: string): Promise<boolean> {
    assertSecretName(name);
    if (!(name in this.vault.entries)) return false;
    delete this.vault.entries[name];
    this.persist();
    return true;
  }

  async list(): Promise<string[]> {
    return Object.keys(this.vault.entries).sort();
  }

  async purposeOf(name: string): Promise<string | undefined> {
    return this.vault.entries[name]?.purpose;
  }

  async updatedAtOf(name: string): Promise<string | undefined> {
    return this.vault.entries[name]?.updatedAt;
  }
}

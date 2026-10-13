/**
 * File vault backend: AES-256-GCM at rest, machine-bound key
 * derivation, 0600 files, and loud failure (never plaintext fallback)
 * on tamper / wrong machine / lost key.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileVaultStore,
  SecretBackendUnavailableError,
  SecretDecryptionError,
} from '../src/index';

const SENTINEL = 'vault-sentinel-51de08-plaintext-must-not-rest';

function vaultIn(dir: string, machineId = 'machine-A') {
  return new FileVaultStore({
    vaultPath: join(dir, 'vault.json'),
    keyPath: join(dir, 'vault.key'),
    machineId,
  });
}

describe('FileVaultStore', () => {
  it('round-trips values across instances (same machine)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'secrets-vault-'));
    try {
      const a = vaultIn(dir);
      await a.set('deploy-key', SENTINEL, { purpose: 'prod deploys' });
      const b = vaultIn(dir);
      assert.equal(await b.get('deploy-key'), SENTINEL);
      assert.equal(await b.get('absent'), undefined);
      assert.deepEqual(await b.list(), ['deploy-key']);
      assert.equal(await b.purposeOf('deploy-key'), 'prod deploys');
      assert.equal(await b.delete('deploy-key'), true);
      assert.equal(await vaultIn(dir).get('deploy-key'), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores ciphertext only — the vault file never contains plaintext', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'secrets-vault-'));
    try {
      const store = vaultIn(dir);
      await store.set('deploy-key', SENTINEL);
      const raw = readFileSync(join(dir, 'vault.json'), 'utf8');
      assert.ok(!raw.includes(SENTINEL), 'vault file must not contain the plaintext');
      assert.ok(!raw.includes(Buffer.from(SENTINEL).toString('base64')), 'nor its base64');
      const keyRaw = readFileSync(join(dir, 'vault.key'), 'utf8');
      assert.ok(!keyRaw.includes(SENTINEL));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates key and vault files with mode 0600', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'secrets-vault-'));
    try {
      const store = vaultIn(dir);
      await store.set('k', 'v');
      for (const f of ['vault.key', 'vault.json']) {
        const mode = statSync(join(dir, f)).mode & 0o777;
        assert.equal(mode, 0o600, `${f} mode should be 0600, got ${mode.toString(8)}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is machine-bound: a vault copied to another machine does not decrypt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'secrets-vault-'));
    try {
      await vaultIn(dir, 'machine-A').set('k', SENTINEL);
      const other = vaultIn(dir, 'machine-B');
      await assert.rejects(() => other.get('k'), SecretDecryptionError);
      // …and the error does not leak the value either.
      const err = await other.get('k').catch((e) => e);
      assert.ok(!(err as Error).message.includes(SENTINEL));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects tampering via GCM authentication', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'secrets-vault-'));
    try {
      await vaultIn(dir).set('k', SENTINEL);
      const path = join(dir, 'vault.json');
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      const data = Buffer.from(parsed.entries.k.data, 'base64');
      data[0] = data[0] ^ 0xff;
      parsed.entries.k.data = data.toString('base64');
      writeFileSync(path, JSON.stringify(parsed));
      await assert.rejects(() => vaultIn(dir).get('k'), SecretDecryptionError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to mint a new key over an existing vault (no silent loss)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'secrets-vault-'));
    try {
      await vaultIn(dir).set('k', SENTINEL);
      rmSync(join(dir, 'vault.key'));
      assert.throws(() => vaultIn(dir), SecretBackendUnavailableError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a corrupt vault file instead of overwriting it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'secrets-vault-'));
    try {
      writeFileSync(join(dir, 'vault.json'), 'not json {{{');
      assert.throws(() => vaultIn(dir), SecretBackendUnavailableError);
      // And a too-short key file is likewise fatal, not a fallback.
      writeFileSync(join(dir, 'vault.json'), JSON.stringify({ version: 1, entries: {} }));
      writeFileSync(join(dir, 'vault.key'), 'AAAA');
      chmodSync(join(dir, 'vault.key'), 0o600);
      assert.throws(() => vaultIn(dir), /corrupt/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('key file lives separately from the vault file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'secrets-vault-'));
    const otherDir = mkdtempSync(join(tmpdir(), 'secrets-key-'));
    try {
      const store = new FileVaultStore({
        vaultPath: join(dir, 'vault.json'),
        keyPath: join(otherDir, 'vault.key'),
        machineId: 'm1',
      });
      await store.set('k', SENTINEL);
      assert.ok(existsSync(join(otherDir, 'vault.key')));
      assert.ok(!existsSync(join(dir, 'vault.key')));
      assert.equal(await store.get('k'), SENTINEL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

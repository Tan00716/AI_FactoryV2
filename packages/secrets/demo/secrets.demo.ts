/**
 * Secret Broker demo (§46.2) — metadata only ever printed.
 *
 * Exercises: file-vault + env chain, set/resolve/lease, rotation
 * revoking a lease, metadata listing, redaction of a resolved value
 * from captured output. The one value used is a demo literal created
 * and consumed inside this process; nothing real is read or stored.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EnvSecretStore,
  FileVaultStore,
  MemorySecretStore,
  SecretBroker,
  redactSecretValues,
  type SecretAuditEvent,
} from '../src/index';

async function main(): Promise<void> {
  const events: SecretAuditEvent[] = [];
  const audit = (e: SecretAuditEvent) => events.push(e);

  const dir = mkdtempSync(join(tmpdir(), 'secrets-demo-'));
  try {
    const vault = new FileVaultStore({
      vaultPath: join(dir, 'vault.json'),
      keyPath: join(dir, 'vault.key'),
    });
    const broker = new SecretBroker({
      stores: [vault, new EnvSecretStore({ FACTORY_SECRET_FROM_ENV: 'env-demo-value' })],
      audit,
    });

    console.log('backends (resolution order):', broker.backends.join(' → '));

    const meta = await broker.set('demo-deploy-key', 'demo-value-not-a-real-secret', {
      actor: 'demo',
      purpose: 'demonstration',
    });
    console.log('set →', meta);

    const lease = await broker.lease('secret://demo-deploy-key', { actor: 'demo-tool', purpose: 'demo run' });
    console.log(`lease active=${lease.active} backend=${lease.backend} expiresAt=${new Date(lease.expiresAt).toISOString()}`);

    // Rotation invalidates the outstanding lease (§46.2).
    await broker.set('demo-deploy-key', 'demo-value-rotated', { actor: 'demo' });
    console.log(`after rotation, lease active=${lease.active} (value access now throws)`);

    console.log('env-backed secret metadata:', await broker.describe('from-env'));
    console.log('missing secret metadata:', await broker.describe('never-existed'));
    console.log('list:', (await broker.list()).map((m) => `${m.ref} [${m.backend}]`).join(', '));

    const captured = 'tool output mentioning demo-value-rotated verbatim';
    console.log('redacted output:', redactSecretValues(captured, ['demo-value-rotated']));

    console.log('audit actions:', events.map((e) => e.action).join(', '));
    const blob = JSON.stringify(events);
    if (blob.includes('demo-value')) throw new Error('audit leaked a value!');
    console.log('audit contains no secret values: OK');

    // Ephemeral session backend (§46.2's explicitly configured option).
    const ephemeral = new SecretBroker({ stores: [new MemorySecretStore()] });
    await ephemeral.set('scratch', 'gone-with-the-process', { actor: 'demo' });
    console.log('ephemeral backend:', ephemeral.backends.join(','));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

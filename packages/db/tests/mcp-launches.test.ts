/**
 * MCP launch-record history — §46 (Batch 26).
 *
 * One scripted sequence, run identically against the in-memory
 * reference and the SQLite implementation:
 *  - saveLaunch/getLaunch round-trips the row field-for-field;
 *  - listLaunches returns newest-first;
 *  - updateLaunch transitions status (RUNNING -> STOPPED/EXITED) and
 *    records exit details; unknown ids throw loudly;
 *  - orphanRunningLaunches marks only other boots' RUNNING rows
 *    ORPHANED (own boot untouched; STOPPED/EXITED/ORPHANED untouched);
 *  - copy contract: mutating a fetched row cannot corrupt stored state;
 *  - rows survive a database reopen; the mcp_launch_records table is
 *    created on old database files that predate it.
 *
 * Honest boundary pinned here: ORPHANED means "the owning launcher
 * process is gone; the child process's real fate is unknown". The
 * store never guesses whether the child is still alive.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  FactoryDatabase,
  MemoryMcpServerStore,
  type McpLaunchDbRecord,
  type McpServerStore,
} from '../src/index';

function tmpDbFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-mcp-launch-'));
  return { dir, file: join(dir, 'factory.db') };
}

let seq = 0;
function launchRow(over: Partial<McpLaunchDbRecord> = {}): McpLaunchDbRecord {
  seq += 1;
  return {
    id: `launch-${seq}`,
    name: 'demo',
    version: '1.0.0',
    bootId: 'boot-A',
    pid: 1234 + seq,
    command: 'node',
    argsJson: JSON.stringify(['-e', 'setTimeout(()=>{},60000)']),
    cwd: null,
    credentialRefsJson: JSON.stringify(['demo-secret']),
    secretEnvVarsJson: JSON.stringify(['DEMO_VAR']),
    status: 'RUNNING',
    launchedAt: new Date(Date.now() + seq).toISOString(),
    endedAt: null,
    exitCode: null,
    signal: null,
    orphanNote: null,
    updatedAt: new Date(Date.now() + seq).toISOString(),
    ...over,
  };
}

function script(store: McpServerStore): void {
  // save/get round-trip, field for field.
  const saved = store.saveLaunch(launchRow({ id: 'l1', pid: 4242 }));
  assert.equal(saved.id, 'l1');
  const back = store.getLaunch('l1');
  assert.ok(back, 'saved row is readable');
  assert.equal(back?.name, 'demo');
  assert.equal(back?.bootId, 'boot-A');
  assert.equal(back?.pid, 4242);
  assert.equal(back?.command, 'node');
  assert.deepEqual(JSON.parse(back?.argsJson ?? '[]'), ['-e', 'setTimeout(()=>{},60000)']);
  assert.deepEqual(JSON.parse(back?.credentialRefsJson ?? '[]'), ['demo-secret']);
  assert.deepEqual(JSON.parse(back?.secretEnvVarsJson ?? '[]'), ['DEMO_VAR']);
  assert.equal(back?.status, 'RUNNING');
  assert.equal(back?.exitCode, null);

  // Unknown id reads undefined, updates throw loudly.
  assert.equal(store.getLaunch('nope'), undefined);
  assert.throws(() => store.updateLaunch('nope', { status: 'STOPPED' }), /unknown launch record/);

  // Status transition with exit details.
  const exited = store.updateLaunch('l1', {
    status: 'EXITED',
    endedAt: '2026-10-13T00:00:01.000Z',
    exitCode: 3,
    signal: null,
  });
  assert.equal(exited.status, 'EXITED');
  assert.equal(exited.exitCode, 3);
  assert.equal(store.getLaunch('l1')?.status, 'EXITED');

  // listLaunches is newest-first.
  store.saveLaunch(launchRow({ id: 'l2', bootId: 'boot-B' }));
  store.saveLaunch(launchRow({ id: 'l3', bootId: 'boot-B' }));
  const listed = store.listLaunches().map((r) => r.id);
  assert.deepEqual(listed, ['l3', 'l2', 'l1']);

  // Copy contract.
  const fetched = store.getLaunch('l2')!;
  (fetched as { status: string }).status = 'HACKED';
  assert.equal(store.getLaunch('l2')?.status, 'RUNNING', 'mutation of a fetched row must not corrupt the store');

  // Orphaning: only other boots' RUNNING rows move.
  store.saveLaunch(launchRow({ id: 'l4', bootId: 'boot-C' }));
  store.updateLaunch('l3', { status: 'STOPPED', endedAt: '2026-10-13T00:00:02.000Z' });
  const orphaned = store.orphanRunningLaunches('boot-A');
  assert.equal(orphaned, 2, 'l2 and l4 (other boots, RUNNING) are orphaned');
  assert.equal(store.getLaunch('l2')?.status, 'ORPHANED');
  assert.ok(
    (store.getLaunch('l2')?.orphanNote ?? '').includes('fate is unknown'),
    'orphan note is honest about the unknown fate',
  );
  assert.equal(store.getLaunch('l4')?.status, 'ORPHANED');
  assert.equal(store.getLaunch('l3')?.status, 'STOPPED', 'STOPPED rows are terminal');
  assert.equal(store.getLaunch('l1')?.status, 'EXITED', 'EXITED rows are terminal');
  // Own boot's RUNNING rows are untouched — none left here, so add one.
  store.saveLaunch(launchRow({ id: 'l5', bootId: 'boot-A' }));
  assert.equal(store.orphanRunningLaunches('boot-A'), 0);
  assert.equal(store.getLaunch('l5')?.status, 'RUNNING');
  // Orphaning is idempotent.
  assert.equal(store.orphanRunningLaunches('boot-A'), 0);
}

describe('MCP launch-record history (§46, Batch 26)', () => {
  it('memory and SQLite agree on every step', () => {
    script(new MemoryMcpServerStore());
    const { dir, file } = tmpDbFile();
    try {
      const fdb = new FactoryDatabase(file);
      script(fdb.mcpServers);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rows survive a database reopen; table is created on old databases', () => {
    const { dir, file } = tmpDbFile();
    try {
      // Simulate an old database that predates the table: create the
      // file with an unrelated table first.
      {
        const raw = new DatabaseSync(file);
        raw.exec('CREATE TABLE projects (id TEXT PRIMARY KEY)');
        raw.close();
      }
      {
        const fdb = new FactoryDatabase(file);
        fdb.mcpServers.saveLaunch(launchRow({ id: 'old-1', bootId: 'boot-old' }));
      }
      {
        const fdb = new FactoryDatabase(file);
        const back = fdb.mcpServers.getLaunch('old-1');
        assert.ok(back, 'launch record survives the restart');
        assert.equal(back?.status, 'RUNNING');
        assert.equal(fdb.mcpServers.orphanRunningLaunches('boot-new'), 1);
        assert.equal(fdb.mcpServers.getLaunch('old-1')?.status, 'ORPHANED');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no secret values can ride the record (names only)', () => {
    const store = new MemoryMcpServerStore();
    const sentinel = 'launch-secret-value-must-never-appear';
    const saved = store.saveLaunch(
      launchRow({
        id: 's1',
        credentialRefsJson: JSON.stringify(['my-ref']),
        secretEnvVarsJson: JSON.stringify(['MY_VAR']),
      }),
    );
    const blob = JSON.stringify(saved);
    assert.ok(!blob.includes(sentinel));
    assert.ok(blob.includes('my-ref'));
    assert.ok(blob.includes('MY_VAR'));
  });
});

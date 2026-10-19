/**
 * Auto-backup policy tests.
 *
 * Dual-mode import rule (AGENTS.md): src/auto-backup.ts value-imports
 * the sibling './scheduler' extensionless, which node's type-stripping
 * ESM loader cannot resolve from a .ts test import — so this file
 * imports the compiled ../dist/auto-backup.js instead. Run the root
 * build first.
 *
 *   - validatePolicyInput: field validation, cron/interval rules
 *   - policy persistence: round-trip, corrupt fail-closed
 *   - syncPolicySchedule: create/noop/recreate/remove against a real
 *     ScheduleStore on a temp path
 *   - runGuardedBackup: health-check skip (no backup, audited),
 *     success path
 *   - pruneOldBackups: keep-newest-N, exemptions (manual, pre-restore,
 *     staged-restore, legal hold, unsafe id)
 *   - e2e: real server — GET/PUT /api/auto-backup RBAC, POST
 *     /api/auto-backup/run creates a real backup, enabling the policy
 *     creates the owned schedule in /api/schedules
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/auto-backup.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AutoBackupError,
  AUTO_BACKUP_SCHEDULE_NAME,
  DEFAULT_RETAIN_COUNT,
  defaultAutoBackupPolicy,
  loadPolicy,
  pruneOldBackups,
  runGuardedBackup,
  syncPolicySchedule,
  validatePolicyInput,
  validateScheduleSpec,
  writePolicyFile,
  type AutoBackupPolicy,
  type GuardedBackupDeps,
} from '../dist/auto-backup.js';
import { ScheduleStore } from '../dist/scheduler.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');

function tmpFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'ab-test-')), name);
}

interface AuditRec {
  actor: string;
  event: string;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown>;
}

function makeManifest(backupId: string, kind: string, createdAt: string): any {
  return { backupId, kind, createdAt, format: 'ai-factory-backup/1' };
}

function makeDeps(overrides: Partial<GuardedBackupDeps> = {}): {
  deps: GuardedBackupDeps;
  audits: AuditRec[];
  calls: { backups: number; backupKinds: Array<'manual' | 'scheduled'>; deleted: string[] };
  manifests: any[];
  setManifests(m: any[]): void;
} {
  const audits: AuditRec[] = [];
  const calls = { backups: 0, backupKinds: [] as Array<'manual' | 'scheduled'>, deleted: [] as string[] };
  let manifests: any[] = [];
  const deps: GuardedBackupDeps = {
    policyPath: tmpFile('policy.json'),
    audit: {
      record: (actor, event, entityType, entityId, details) => {
        audits.push({ actor, event, entityType, entityId, details });
      },
    },
    createBackup: (kind: 'manual' | 'scheduled') => {
      calls.backups += 1;
      calls.backupKinds.push(kind);
      return { backupId: `backup-${calls.backups}` };
    },
    listBackups: () => manifests,
    deleteBackupDir: (id: string) => {
      calls.deleted.push(id);
    },
    stagedRestoreBackupId: () => null,
    activeHoldCount: () => 0,
    checkLiveDbIntegrity: () => 'ok',
    ...overrides,
  };
  return { deps, audits, calls, manifests, setManifests: (m: any[]) => { manifests = m; } };
}

function writePolicy(p: string, policy: AutoBackupPolicy): void {
  writePolicyFile(p, policy);
}

function enabledPolicy(overrides: Partial<AutoBackupPolicy> = {}): AutoBackupPolicy {
  return { ...defaultAutoBackupPolicy(), enabled: true, ...overrides };
}

// ------------------------------------------------------------- validation --

test('validatePolicyInput: accepts a full valid patch', () => {
  const p = validatePolicyInput({
    enabled: true,
    kind: 'cron',
    cronExpr: '0 3 * * *',
    intervalMs: null,
    retainCount: 7,
    healthCheck: true,
  });
  assert.equal(p.enabled, true);
  assert.equal(p.kind, 'cron');
  assert.equal(p.cronExpr, '0 3 * * *');
  assert.equal(p.retainCount, 7);
});

test('validatePolicyInput: rejects bad cron, small interval, bad retain', () => {
  assert.throws(() => validatePolicyInput({ cronExpr: 'not a cron' }), AutoBackupError);
  assert.throws(() => validatePolicyInput({ intervalMs: 1000 }), AutoBackupError);
  assert.throws(() => validatePolicyInput({ intervalMs: 1.5 }), AutoBackupError);
  assert.throws(() => validatePolicyInput({ retainCount: 0 }), AutoBackupError);
  assert.throws(() => validatePolicyInput({ retainCount: 366 }), AutoBackupError);
  assert.throws(() => validatePolicyInput({ retainCount: 2.5 }), AutoBackupError);
  assert.throws(() => validatePolicyInput({ enabled: 'yes' }), AutoBackupError);
  assert.throws(() => validatePolicyInput({ kind: 'daily' }), AutoBackupError);
  assert.throws(() => validatePolicyInput(null), AutoBackupError);
});

test('validateScheduleSpec: cross-field cadence rules', () => {
  assert.throws(
    () => validateScheduleSpec({ kind: 'cron', cronExpr: null, intervalMs: null }),
    AutoBackupError,
  );
  assert.throws(
    () => validateScheduleSpec({ kind: 'interval', cronExpr: null, intervalMs: null }),
    AutoBackupError,
  );
  assert.throws(
    () => validateScheduleSpec({ kind: 'interval', cronExpr: null, intervalMs: 30_000 }),
    AutoBackupError,
  );
  // no throw:
  validateScheduleSpec({ kind: 'cron', cronExpr: '0 3 * * *', intervalMs: null });
  validateScheduleSpec({ kind: 'interval', cronExpr: null, intervalMs: 3_600_000 });
});

// ------------------------------------------------------------ persistence --

test('policy persistence: round-trip; missing file → disabled defaults', () => {
  const p = tmpFile('policy.json');
  const { policy, corrupt } = loadPolicy(p);
  assert.equal(corrupt, false);
  assert.equal(policy.enabled, false);
  assert.equal(policy.retainCount, DEFAULT_RETAIN_COUNT);

  const next: AutoBackupPolicy = {
    ...policy,
    enabled: true,
    kind: 'cron',
    cronExpr: '15 2 * * *',
    intervalMs: null,
    retainCount: 14,
  };
  writePolicyFile(p, next);
  const re = loadPolicy(p);
  assert.equal(re.corrupt, false);
  assert.equal(re.policy.enabled, true);
  assert.equal(re.policy.cronExpr, '15 2 * * *');
  assert.equal(re.policy.retainCount, 14);
});

test('policy persistence: corrupt file fails closed', () => {
  const p = tmpFile('policy.json');
  writeFileSync(p, '{not valid json', 'utf8');
  const { policy, corrupt } = loadPolicy(p);
  assert.equal(corrupt, true);
  assert.equal(policy.enabled, false);
  assert.throws(() => writePolicyFile(p, defaultAutoBackupPolicy()), AutoBackupError);
});

test('policy persistence: invalid stored values fail closed', () => {
  const p = tmpFile('policy.json');
  writeFileSync(p, JSON.stringify({ policy: { enabled: true, retainCount: -5 } }), 'utf8');
  assert.equal(loadPolicy(p).corrupt, true);
});

// ------------------------------------------------------------------ sync --

function syncDeps(policyPath: string, store: ScheduleStore, audits: AuditRec[]): GuardedBackupDeps & { store: ScheduleStore } {
  return {
    policyPath,
    store,
    audit: {
      record: (actor, event, entityType, entityId, details) => {
        audits.push({ actor, event, entityType, entityId, details });
      },
    },
    createBackup: () => ({ backupId: 'x' }),
    listBackups: () => [],
    deleteBackupDir: () => {},
    stagedRestoreBackupId: () => null,
    activeHoldCount: () => 0,
    checkLiveDbIntegrity: () => 'ok',
  };
}

test('syncPolicySchedule: disabled → no schedule; enable → created; noop; change → recreated; disable → removed', () => {
  const policyPath = tmpFile('policy.json');
  const storePath = tmpFile('schedules.json');
  const store = new ScheduleStore(storePath);
  const audits: AuditRec[] = [];
  const deps = syncDeps(policyPath, store, audits);

  // Disabled: nothing scheduled.
  let r = syncPolicySchedule(deps);
  assert.equal(r.action, 'noop');
  assert.equal(store.list().length, 0);

  // Enable with an interval: schedule created.
  writePolicy(policyPath, enabledPolicy({ intervalMs: 3_600_000 }));
  r = syncPolicySchedule(deps);
  assert.equal(r.action, 'created');
  assert.ok(r.scheduleId);
  const created = store.get(r.scheduleId!);
  assert.equal(created?.name, AUTO_BACKUP_SCHEDULE_NAME);
  assert.equal((created?.job as { type: string }).type, 'backup');
  assert.equal(created?.intervalMs, 3_600_000);
  const firstId = r.scheduleId;

  // Same policy again: noop.
  r = syncPolicySchedule(deps);
  assert.equal(r.action, 'noop');
  assert.equal(r.scheduleId, firstId);

  // Change cadence (like a real PUT: merge onto the stored policy,
  // keeping scheduleId): recreated with a new id.
  const cur = loadPolicy(policyPath).policy;
  writePolicy(policyPath, {
    ...cur,
    kind: 'cron',
    cronExpr: '0 4 * * *',
    intervalMs: null,
    updatedAt: new Date().toISOString(),
  });
  r = syncPolicySchedule(deps);
  assert.equal(r.action, 'recreated');
  assert.ok(r.scheduleId && r.scheduleId !== firstId);
  assert.equal(store.list().length, 1);

  // Disable: removed, scheduleId cleared.
  writePolicy(policyPath, { ...enabledPolicy(), enabled: false });
  r = syncPolicySchedule(deps);
  assert.equal(r.action, 'removed');
  assert.equal(store.list().length, 0);
  assert.equal(loadPolicy(policyPath).policy.scheduleId, null);
});

test('syncPolicySchedule: orphaned schedule (lost scheduleId) is adopted, not duplicated', () => {
  const policyPath = tmpFile('policy.json');
  const store = new ScheduleStore(tmpFile('schedules.json'));
  const audits: AuditRec[] = [];
  const deps = syncDeps(policyPath, store, audits);

  writePolicy(policyPath, enabledPolicy({ intervalMs: 3_600_000 }));
  const first = syncPolicySchedule(deps);
  assert.equal(first.action, 'created');

  // Simulate a hand-edited policy file that lost scheduleId.
  const cur = loadPolicy(policyPath).policy;
  writePolicy(policyPath, { ...cur, scheduleId: null });
  const second = syncPolicySchedule(deps);
  assert.equal(second.action, 'noop');
  assert.equal(second.scheduleId, first.scheduleId);
  assert.equal(store.list().length, 1);
  // And disabling now still removes it (no orphan left behind).
  writePolicy(policyPath, { ...loadPolicy(policyPath).policy, enabled: false });
  const third = syncPolicySchedule(deps);
  assert.equal(third.action, 'removed');
  assert.equal(store.list().length, 0);
});

test('syncPolicySchedule: dangling scheduleId is recreated, not crashed on', () => {
  const policyPath = tmpFile('policy.json');
  const store = new ScheduleStore(tmpFile('schedules.json'));
  const audits: AuditRec[] = [];
  // scheduleId points at a schedule that no longer exists.
  writePolicy(policyPath, enabledPolicy({ intervalMs: 3_600_000, scheduleId: 'gone' }));
  const r = syncPolicySchedule(syncDeps(policyPath, store, audits));
  assert.equal(r.action, 'created');
  assert.ok(r.scheduleId && r.scheduleId !== 'gone');
});

test('syncPolicySchedule: corrupt policy file → skipped, audited', () => {
  const policyPath = tmpFile('policy.json');
  writeFileSync(policyPath, 'garbage', 'utf8');
  const store = new ScheduleStore(tmpFile('schedules.json'));
  const audits: AuditRec[] = [];
  const r = syncPolicySchedule(syncDeps(policyPath, store, audits));
  assert.equal(r.action, 'skipped-corrupt');
  assert.ok(audits.some((a) => a.event === 'AUTO_BACKUP_POLICY_CORRUPT'));
  assert.equal(store.list().length, 0);
});

// ---------------------------------------------------------------- guarded --

test('runGuardedBackup: health-check failure skips the backup and audits', () => {
  const { deps, audits, calls } = makeDeps({
    checkLiveDbIntegrity: () => 'quick_check: *** in database main ***',
  });
  writePolicy(deps.policyPath!, enabledPolicy());
  assert.throws(() => runGuardedBackup(deps), AutoBackupError);
  assert.equal(calls.backups, 0);
  assert.ok(audits.some((a) => a.event === 'AUTO_BACKUP_SKIPPED'));
  assert.ok(!audits.some((a) => a.event === 'AUTO_BACKUP_COMPLETED'));
});

test('runGuardedBackup: success audits completion and prunes when enabled', () => {
  const { deps, audits, calls, setManifests } = makeDeps();
  // 9 scheduled + 1 manual + 1 pre-restore; retain 7 → prune 2 oldest scheduled.
  const manifests = [
    makeManifest('manual-1', 'manual', '2026-10-19T10:00:00.000Z'),
    makeManifest('pre-1', 'pre-restore', '2026-10-19T09:00:00.000Z'),
  ];
  for (let i = 1; i <= 9; i++) {
    manifests.push(makeManifest(`sched-${i}`, 'scheduled', `2026-10-19T0${i}:00:00.000Z`));
  }
  setManifests(manifests);
  writePolicy(deps.policyPath!, enabledPolicy({ retainCount: 7 }));
  const { backupId, pruned } = runGuardedBackup(deps);
  assert.ok(backupId);
  assert.equal(calls.backups, 1);
  assert.deepEqual(pruned.sort(), ['sched-1', 'sched-2']);
  assert.deepEqual(calls.deleted.sort(), ['sched-1', 'sched-2']);
  assert.ok(audits.some((a) => a.event === 'AUTO_BACKUP_COMPLETED'));
  assert.ok(audits.some((a) => a.event === 'AUTO_BACKUP_PRUNED'));
});

test('runGuardedBackup: no retention when the policy is disabled', () => {
  const { deps, calls, setManifests } = makeDeps();
  const manifests: any[] = [];
  for (let i = 1; i <= 10; i++) {
    manifests.push(makeManifest(`sched-${i}`, 'scheduled', `2026-10-19T0${i}:00:00.000Z`));
  }
  setManifests(manifests);
  writePolicy(deps.policyPath!, { ...defaultAutoBackupPolicy(), enabled: false });
  runGuardedBackup(deps);
  assert.equal(calls.backups, 1);
  assert.equal(calls.deleted.length, 0);
});

test('runGuardedBackup: kind param — manual trigger is never retention-pruned', () => {
  const { deps, calls, setManifests } = makeDeps();
  // A manual backup plus scheduled ones; retain 1 → only the single
  // newest scheduled survives, the manual one is exempt.
  setManifests([
    makeManifest('manual-1', 'manual', '2026-10-19T08:00:00.000Z'),
    makeManifest('sched-1', 'scheduled', '2026-10-19T09:00:00.000Z'),
    makeManifest('sched-2', 'scheduled', '2026-10-19T10:00:00.000Z'),
  ]);
  writePolicy(deps.policyPath!, enabledPolicy({ retainCount: 1 }));
  const { pruned } = runGuardedBackup(deps, 'manual');
  assert.deepEqual(calls.backupKinds, ['manual']);
  assert.ok(!pruned.includes('manual-1'));
  assert.ok(!calls.deleted.includes('manual-1'));
  assert.deepEqual(pruned, ['sched-1']);
});

test('pruneOldBackups: staged-restore backup is never deleted', () => {
  const stagedId = 'sched-staged';
  const { deps, calls, setManifests } = makeDeps({ stagedRestoreBackupId: () => stagedId });
  const manifests: any[] = [makeManifest(stagedId, 'scheduled', '2026-10-19T01:00:00.000Z')];
  for (let i = 2; i <= 9; i++) {
    manifests.push(makeManifest(`sched-${i}`, 'scheduled', `2026-10-19T0${i}:00:00.000Z`));
  }
  setManifests(manifests);
  const pruned = pruneOldBackups(deps, 7);
  assert.ok(!pruned.includes(stagedId));
  assert.ok(!calls.deleted.includes(stagedId));
});

test('pruneOldBackups: active legal hold defers all pruning', () => {
  const { deps, audits, calls, setManifests } = makeDeps({ activeHoldCount: () => 1 });
  const manifests: any[] = [];
  for (let i = 1; i <= 10; i++) {
    manifests.push(makeManifest(`sched-${i}`, 'scheduled', `2026-10-19T0${i}:00:00.000Z`));
  }
  setManifests(manifests);
  const pruned = pruneOldBackups(deps, 7);
  assert.deepEqual(pruned, []);
  assert.equal(calls.deleted.length, 0);
  assert.ok(audits.some((a) => a.event === 'AUTO_BACKUP_PRUNE_DEFERRED'));
});

test('pruneOldBackups: unsafe backup id is rejected, never deleted', () => {
  const { deps, audits, calls, setManifests } = makeDeps();
  setManifests([
    makeManifest('../evil', 'scheduled', '2026-10-19T01:00:00.000Z'),
    makeManifest('sched-ok', 'scheduled', '2026-10-19T02:00:00.000Z'),
  ]);
  const pruned = pruneOldBackups(deps, 1);
  assert.ok(!calls.deleted.includes('../evil'));
  assert.ok(audits.some((a) => a.event === 'AUTO_BACKUP_PRUNE_REJECTED'));
  assert.deepEqual(pruned, []);
});

// --------------------------------------------------------------------- e2e --

interface Running {
  port: number;
  proc: ChildProcess;
  dir: string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close();
        reject(new Error('no port'));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(): Promise<Running> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-autobackup-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_SECRETS_DIR: path.join(dir, 'secrets'),
    FACTORY_API_TOKENS: 'viewer:e2e-viewer,operator:e2e-operator',
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_RUNTIME_TOOLS']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error('server did not come up');
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { port, proc, dir };
}

const bearer = (role: string) => ({ Authorization: `Bearer e2e-${role}` });

test('e2e: GET default policy, PUT RBAC, enable creates owned schedule, run-now backs up', async () => {
  const running = await startServer();
  try {
    const base = `http://127.0.0.1:${running.port}`;

    // Default policy: disabled.
    let r = await fetch(`${base}/api/auto-backup`, { headers: bearer('viewer') });
    assert.equal(r.status, 200);
    let body = (await r.json()) as { policy: AutoBackupPolicy };
    assert.equal(body.policy.enabled, false);

    // Viewer cannot write.
    r = await fetch(`${base}/api/auto-backup`, {
      method: 'PUT',
      headers: { ...bearer('viewer'), 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(r.status, 403);

    // Enabling without a complete cadence → 400 (default policy has
    // intervalMs set, so this uses kind cron without cronExpr).
    r = await fetch(`${base}/api/auto-backup`, {
      method: 'PUT',
      headers: { ...bearer('operator'), 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, kind: 'cron', cronExpr: null, intervalMs: null }),
    });
    assert.equal(r.status, 400);

    // Enable with a 60s interval, retain 2.
    r = await fetch(`${base}/api/auto-backup`, {
      method: 'PUT',
      headers: { ...bearer('operator'), 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, kind: 'interval', intervalMs: 60_000, retainCount: 2 }),
    });
    assert.equal(r.status, 200);
    body = (await r.json()) as { policy: AutoBackupPolicy; sync: string };
    assert.equal(body.policy.enabled, true);
    assert.equal(body.sync, 'created');
    assert.ok(body.policy.scheduleId);

    // The owned schedule is visible in /api/schedules.
    r = await fetch(`${base}/api/schedules`, { headers: bearer('viewer') });
    assert.equal(r.status, 200);
    const schedules = ((await r.json()) as { schedules: Array<{ id: string; name: string }> }).schedules;
    assert.ok(schedules.some((s) => s.id === body.policy.scheduleId && s.name === AUTO_BACKUP_SCHEDULE_NAME));

    // Run one backup now (operator).
    r = await fetch(`${base}/api/auto-backup/run`, {
      method: 'POST',
      headers: { ...bearer('operator'), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 200);
    const run = (await r.json()) as { backupId: string; pruned: string[] };
    assert.ok(run.backupId);
    assert.deepEqual(run.pruned, []);

    // The backup landed on disk under the server's backup dir.
    const backupDir = path.join(path.dirname(path.join(running.dir, 'factory.db')), 'backups', run.backupId);
    assert.ok(fs.existsSync(path.join(backupDir, 'manifest.json')), 'backup manifest on disk');

    // Disabling the policy removes the owned schedule.
    r = await fetch(`${base}/api/auto-backup`, {
      method: 'PUT',
      headers: { ...bearer('operator'), 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(r.status, 200);
    const off = (await r.json()) as { sync: string };
    assert.equal(off.sync, 'removed');
    r = await fetch(`${base}/api/schedules`, { headers: bearer('viewer') });
    const after = ((await r.json()) as { schedules: Array<{ name: string }> }).schedules;
    assert.ok(!after.some((s) => s.name === AUTO_BACKUP_SCHEDULE_NAME));
  } finally {
    running.proc.kill('SIGKILL');
  }
});

/**
 * SPEC v2 §33 browser profile isolation tests:
 * independent identity + independent user-data dir per profile,
 * bounded download directory (escape rejected), lifecycle + audit,
 * no driver shipped (honest available:false), no OS sandboxing claimed.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BrowserProfileRegistry,
  type BrowserAuditIntent,
} from '../src/index';

const NOW = 1_700_000_000_000;

let root: string;

function freshRoot(): string {
  const dir = join(tmpdir(), `factory-browser-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function collector() {
  const intents: BrowserAuditIntent[] = [];
  return {
    intents,
    registry: new BrowserProfileRegistry({
      profileRoot: root,
      now: () => NOW,
      auditSink: (i) => intents.push(i),
    }),
  };
}

beforeEach(() => {
  root = freshRoot();
});

afterEach(() => {
  // Best-effort cleanup of the temp root.
  rmSync(root, { recursive: true, force: true });
});

describe('browser profile isolation (§33)', () => {
  it('createProfile gives an independent identity with its own user-data and downloads dirs', () => {
    const { registry, intents } = collector();
    const p = registry.createProfile({ name: 'agent-a' });
    assert.match(p.id, /^[0-9a-f-]{36}$/);
    assert.equal(p.name, 'agent-a');
    assert.equal(p.createdAt, new Date(NOW).toISOString());
    assert.ok(existsSync(p.userDataDir), 'user-data dir exists on disk');
    assert.ok(existsSync(p.downloadDir), 'downloads dir exists on disk');
    assert.equal(intents.length, 1);
    assert.equal(intents[0].type, 'BROWSER_PROFILE_CREATED');
    assert.equal(intents[0].profileName, 'agent-a');
    assert.equal(intents[0].at, new Date(NOW).toISOString());
  });

  it('two profiles never share a user-data dir (real cookie isolation)', () => {
    const { registry } = collector();
    const a = registry.createProfile({ name: 'agent-a' });
    const b = registry.createProfile({ name: 'agent-b' });
    assert.notEqual(a.userDataDir, b.userDataDir);
    assert.notEqual(a.id, b.id);
    // Write a "cookie" under A — it must not be visible under B.
    writeFileSync(join(a.userDataDir, 'Cookies'), 'session=AAA');
    assert.throws(() => readFileSync(join(b.userDataDir, 'Cookies'), 'utf8'), /ENOENT/);
  });

  it('rejects invalid and duplicate names', () => {
    const { registry } = collector();
    for (const bad of ['', '../evil', 'a/b', 'a\\b', '..', '.hidden', 'x'.repeat(65), 'has space']) {
      assert.throws(() => registry.createProfile({ name: bad }), /invalid profile name/);
    }
    registry.createProfile({ name: 'ok-name_1' });
    assert.throws(() => registry.createProfile({ name: 'ok-name_1' }), /already exists/);
  });

  it('returned descriptors are deep copies — external mutation cannot corrupt the registry', () => {
    const { registry } = collector();
    const p = registry.createProfile({ name: 'a' });
    (p as { name: string }).name = 'tampered';
    (p as { userDataDir: string }).userDataDir = '/tmp/evil';
    const again = registry.getProfile('a')!;
    assert.equal(again.name, 'a');
    assert.notEqual(again.userDataDir, '/tmp/evil');
  });

  it('userDataDirFor returns the profile dir; unknown names throw (fail-closed)', () => {
    const { registry } = collector();
    const p = registry.createProfile({ name: 'a' });
    assert.equal(registry.userDataDirFor('a'), p.userDataDir);
    assert.throws(() => registry.userDataDirFor('nope'), /unknown browser profile/);
  });

  it('resolveDownloadPath stays inside the bounded downloads dir', () => {
    const { registry } = collector();
    const p = registry.createProfile({ name: 'a' });
    const resolved = registry.resolveDownloadPath('a', 'report.pdf');
    assert.equal(resolved, join(p.downloadDir, 'report.pdf'));
    for (const bad of ['../escape.pdf', '..', '/abs/path.pdf', 'sub/dir.pdf', 'a\\b.pdf', '', '.']) {
      assert.throws(() => registry.resolveDownloadPath('a', bad), /escape|non-empty|unknown/);
    }
    // Long names rejected too.
    assert.throws(() => registry.resolveDownloadPath('a', 'x'.repeat(256)), /at most 255/);
    // Unknown profile cannot resolve anything.
    assert.throws(() => registry.resolveDownloadPath('nope', 'f.pdf'), /unknown browser profile/);
  });

  it('destroyProfile really deletes the directory and audits', () => {
    const { registry, intents } = collector();
    const p = registry.createProfile({ name: 'a' });
    assert.ok(registry.destroyProfile('a'));
    assert.ok(!existsSync(p.userDataDir), 'user-data dir gone from disk');
    assert.ok(!existsSync(p.downloadDir), 'downloads dir gone from disk');
    assert.equal(registry.getProfile('a'), undefined);
    assert.equal(intents[intents.length - 1].type, 'BROWSER_PROFILE_DESTROYED');
    assert.equal(registry.destroyProfile('a'), false, 'destroying twice is a no-op false');
  });

  it('cleanupOrphanedProfiles deletes only pattern-matching unregistered dirs, never blind', () => {
    const { registry, intents } = collector();
    const live = registry.createProfile({ name: 'live' });
    // Plant an orphan: a valid-pattern dir that is NOT registered.
    const orphanDir = join(registry.profilesRoot, 'orphan-deadbeef');
    mkdirSync(join(orphanDir, 'user-data'), { recursive: true });
    // Plant a non-matching dir — must survive.
    const otherDir = join(registry.profilesRoot, 'someone-elses-data');
    mkdirSync(otherDir, { recursive: true });
    const cleaned = registry.cleanupOrphanedProfiles();
    assert.deepEqual(cleaned, ['orphan-deadbeef']);
    assert.ok(!existsSync(orphanDir), 'orphan deleted');
    assert.ok(existsSync(live.userDataDir), 'live profile untouched');
    assert.ok(existsSync(otherDir), 'non-pattern dir untouched');
    assert.equal(intents[intents.length - 1].type, 'BROWSER_PROFILE_ORPHAN_CLEANED');
  });

  it('cleanupOrphanedProfiles is a no-op when the root does not exist yet', () => {
    const { registry } = collector();
    assert.deepEqual(registry.cleanupOrphanedProfiles(), []);
  });

  it('driverAvailability honestly reports no driver ships', () => {
    const { registry } = collector();
    const avail = registry.driverAvailability();
    assert.equal(avail.available, false);
    assert.match(avail.reason, /no browser driver ships/i);
  });

  it('listProfiles reflects lifecycle', () => {
    const { registry } = collector();
    registry.createProfile({ name: 'a' });
    registry.createProfile({ name: 'b' });
    assert.deepEqual(registry.listProfiles().map((p) => p.name).sort(), ['a', 'b']);
    registry.destroyProfile('a');
    assert.deepEqual(registry.listProfiles().map((p) => p.name), ['b']);
  });
});

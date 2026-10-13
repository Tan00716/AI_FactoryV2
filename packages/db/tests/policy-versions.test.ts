/**
 * Versioned policy documents — SPEC v2 §48.2 Authorization domain
 * (Batch 34).
 *
 * Pinned on the REAL node:sqlite file (and the in-memory reference):
 *  - append-only: versions are per-policy monotonic integers starting
 *    at 1, assigned by the store inside one BEGIN IMMEDIATE
 *    transaction; the caller never supplies a version number;
 *  - immutable published versions: no update/delete API; CURRENT is
 *    derived (highest version), never stored or rewritten;
 *  - memory/SQLite behavior parity; copy contract; rows survive a
 *    database reopen; the table is created on old files (IF NOT EXISTS
 *    in SCHEMA); corrupt rows fail loudly, never guessed;
 *  - contentHash is sha256 over the exact content bytes.
 *
 * This file runs from dist (see package conventions in AGENTS.md).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  FactoryDatabase,
  InMemoryPolicyVersionStore,
  hashPolicyContent,
  statusOf,
  type PolicyVersionRecord,
  type PolicyVersionStore,
  type RegisterPolicyVersionInput,
} from '../src/index';

function tmpDbFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-pv-'));
  return { dir, file: join(dir, 'factory.db') };
}

function input(
  policyId: string,
  content: unknown,
  createdAt: number,
  createdBy = 'operator-1',
): RegisterPolicyVersionInput {
  return {
    policyId,
    contentJson: typeof content === 'string' ? content : JSON.stringify(content),
    createdBy,
    createdAt,
  };
}

function withParity(body: (store: PolicyVersionStore) => void): void {
  const memory = new InMemoryPolicyVersionStore();
  const { dir, file } = tmpDbFile();
  const fdb = new FactoryDatabase(file);
  try {
    body(memory);
    body(fdb.policyVersions);
  } finally {
    fdb.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('policy_versions — dual implementation parity', () => {
  it('versions start at 1 and increment per policy, independently', () => {
    withParity((store) => {
      const v1 = store.registerPolicyVersion(input('authz', { rules: ['a'] }, 1000));
      const v2 = store.registerPolicyVersion(input('authz', { rules: ['a', 'b'] }, 1001));
      const other = store.registerPolicyVersion(input('gates', { x: 1 }, 1002));
      assert.equal(v1.version, 1);
      assert.equal(v2.version, 2);
      assert.equal(other.version, 1, 'independent version space per policy');
    });
  });

  it('contentHash is sha256 over the exact content bytes', () => {
    withParity((store) => {
      const rec = store.registerPolicyVersion(input('authz', { k: 'v' }, 1000));
      const expected = createHash('sha256').update(rec.contentJson, 'utf8').digest('hex');
      assert.equal(rec.contentHash, expected);
      assert.equal(rec.contentHash, hashPolicyContent(rec.contentJson));
    });
  });

  it('published versions are immutable: registering v2 leaves v1 byte-identical; no update/delete API', () => {
    withParity((store) => {
      const before = store.registerPolicyVersion(input('authz', { rules: 1 }, 1000));
      const beforeSnapshot = { ...before };
      store.registerPolicyVersion(input('authz', { rules: 2 }, 1001));
      const after = store.getPolicyVersion('authz', 1);
      assert.deepEqual(after, beforeSnapshot, 'v1 must be byte-identical after v2 exists');
      const proto = Object.getPrototypeOf(store) as Record<string, unknown>;
      const names = Object.getOwnPropertyNames(proto);
      assert.ok(
        !names.some((n) => /update|delete|mutate|edit/i.test(n)),
        'no mutation API may exist',
      );
    });
  });

  it('status is derived: highest version CURRENT, lower SUPERSEDED — never stored', () => {
    withParity((store) => {
      const v1 = store.registerPolicyVersion(input('authz', { a: 1 }, 1000));
      const v2 = store.registerPolicyVersion(input('authz', { a: 2 }, 1001));
      const all = store.listPolicyVersions('authz');
      assert.equal(statusOf(v1, all), 'SUPERSEDED');
      assert.equal(statusOf(v2, all), 'CURRENT');
    });
  });

  it('list is newest-first', () => {
    withParity((store) => {
      store.registerPolicyVersion(input('p', { v: 1 }, 1000));
      store.registerPolicyVersion(input('p', { v: 2 }, 1001));
      store.registerPolicyVersion(input('p', { v: 3 }, 1002));
      const listed = store.listPolicyVersions('p');
      assert.deepEqual(listed.map((r) => r.version), [3, 2, 1]);
    });
  });

  it('getPolicyVersion returns undefined for unknown policy/version', () => {
    withParity((store) => {
      assert.equal(store.getPolicyVersion('nope', 1), undefined);
      store.registerPolicyVersion(input('p', { v: 1 }, 1000));
      assert.equal(store.getPolicyVersion('p', 99), undefined);
    });
  });

  it('reads are deep copies', () => {
    withParity((store) => {
      store.registerPolicyVersion(input('p', { v: 1 }, 1000));
      const a = store.getPolicyVersion('p', 1) as PolicyVersionRecord;
      a.contentJson = 'MUTATED';
      const b = store.getPolicyVersion('p', 1) as PolicyVersionRecord;
      assert.notEqual(b.contentJson, 'MUTATED');
    });
  });

  it('input validation: empty policyId/content/createdBy or bad createdAt throws', () => {
    withParity((store) => {
      const base = input('p', { v: 1 }, 1000);
      assert.throws(
        () => store.registerPolicyVersion({ ...base, policyId: '' }),
        /policyId/,
      );
      assert.throws(
        () => store.registerPolicyVersion({ ...base, contentJson: '' }),
        /contentJson/,
      );
      assert.throws(
        () => store.registerPolicyVersion({ ...base, createdBy: '' }),
        /createdBy/,
      );
      assert.throws(
        () => store.registerPolicyVersion({ ...base, createdAt: -1 }),
        /createdAt/,
      );
    });
  });
});

describe('policy_versions — SQLite specifics', () => {
  it('two writers on separate connections keep monotonic versions (UNIQUE arbiter)', () => {
    const { dir, file } = tmpDbFile();
    const fda = new FactoryDatabase(file);
    const fdb = new FactoryDatabase(file);
    try {
      fda.policyVersions.registerPolicyVersion(input('p', { w: 'a' }, 1000));
      fdb.policyVersions.registerPolicyVersion(input('p', { w: 'b' }, 1001));
      fda.policyVersions.registerPolicyVersion(input('p', { w: 'a2' }, 1002));
      const versions = fdb.policyVersions
        .listPolicyVersions('p')
        .map((r) => r.version)
        .sort((x, y) => x - y);
      assert.deepEqual(versions, [1, 2, 3], 'no duplicate or skipped versions across writers');
    } finally {
      fda.close();
      fdb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('corrupt rows fail loudly, never guessed', () => {
    const { dir, file } = tmpDbFile();
    const fdb = new FactoryDatabase(file);
    try {
      fdb.policyVersions.registerPolicyVersion(input('p', { v: 1 }, 1000));
      const raw = new DatabaseSync(file);
      raw.prepare('UPDATE policy_versions SET version = 0 WHERE policy_id = ?').run('p');
      raw.close();
      assert.throws(() => fdb.policyVersions.listPolicyVersions('p'), /corrupt policy_versions row/);
    } finally {
      fdb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rows survive a database reopen; the table is created on old files', () => {
    const { dir, file } = tmpDbFile();
    try {
      {
        const fdb = new FactoryDatabase(file);
        fdb.policyVersions.registerPolicyVersion(input('authz', { rules: 1 }, 1000));
        fdb.close();
      }
      // An "old" database file: predating the Batch-34 policy_versions
      // table (drop it, then reopen — IF NOT EXISTS recreates it).
      const raw = new DatabaseSync(file);
      raw.exec('DROP TABLE policy_versions;');
      raw.close();
      {
        const reopened = new FactoryDatabase(file);
        const rec = reopened.policyVersions.registerPolicyVersion(input('authz', { rules: 2 }, 2000));
        assert.equal(rec.version, 1, 'fresh table on old DB starts at 1 — honest, not invented history');
        reopened.close();
      }
      {
        const reopened = new FactoryDatabase(file);
        const rec = reopened.policyVersions.registerPolicyVersion(input('authz', { rules: 3 }, 3000));
        assert.equal(rec.version, 2, 'version sequence continues across reopen');
        const v1 = reopened.policyVersions.getPolicyVersion('authz', 1);
        assert.equal(v1?.contentJson, JSON.stringify({ rules: 2 }));
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

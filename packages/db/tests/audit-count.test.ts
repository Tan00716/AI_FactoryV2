/**
 * Batch 41 — SqliteAuditStore.countByActorAction parity with the
 * in-memory reference (packages/core).
 *
 * Pinned:
 *  - COUNT(*) by actor + action set answers without hydrating rows;
 *  - empty action set → 0 (no SQL syntax hazard from empty IN ());
 *  - counts survive a database reopen (the emission path counts over
 *    the persisted chain, not process memory).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, InMemoryAuditStore } from '@ai-factory/core';
import { FactoryDatabase } from '../src/index';

function seed(log: AuditLog) {
  log.record('g1', 'RELATIVE_CEILING_DENIED', 'agent', 'e1');
  log.record('g1', 'RELATIVE_CEILING_DENIED', 'agent', 'e2');
  log.record('g1', 'TASK_SCOPE_CEILING_DENIED', 'agent', 'e3');
  log.record('g2', 'RELATIVE_CEILING_DENIED', 'agent', 'e4');
  log.record('g1', 'EMPLOYEE_CREATED', 'agent', 'e5');
}

const KINDS = ['RELATIVE_CEILING_DENIED', 'TASK_SCOPE_CEILING_DENIED'];

describe('SqliteAuditStore.countByActorAction (Batch 41)', () => {
  it('matches the in-memory reference, including across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-count-'));
    try {
      const mem = new AuditLog(new InMemoryAuditStore());
      seed(mem);
      const file = join(dir, 'factory.db');
      const db1 = new FactoryDatabase(file);
      const sql1 = new AuditLog(db1.audit);
      seed(sql1);
      for (const actor of ['g1', 'g2', 'nobody']) {
        for (const actions of [KINDS, ['RELATIVE_CEILING_DENIED'], []]) {
          assert.equal(
            sql1.countByActorAction(actor, actions),
            mem.countByActorAction(actor, actions),
            `actor=${actor} actions=${actions.join(',')}`,
          );
        }
      }
      db1.close();
      // Reopen: counts come from the persisted chain.
      const db2 = new FactoryDatabase(file);
      const sql2 = new AuditLog(db2.audit);
      assert.equal(sql2.countByActorAction('g1', KINDS), 3);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

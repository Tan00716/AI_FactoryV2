/**
 * Durable requirements — SPEC v2 §16 (first-run walkthrough F2).
 *
 * The RequirementManager behind /api/requirements used to be a bare
 * in-memory singleton: a server restart lost requirement versions and
 * §16 compatibility declarations, so registering evidence with a
 * requirement pin failed ("unknown requirement version") and a task
 * caught mid-STALE-gate was stuck until an operator recreated the
 * requirement by hand. The manager now sits behind the
 * RequirementStore seam (@ai-factory/requirements), and this file pins
 * the SQLite implementation:
 *
 *  - behavior parity: the same scripted manager sequence driven over
 *    the in-memory store and over SQLite produces identical results at
 *    every step — versions, links, holds, declarations, auto-ids;
 *  - fidelity across instances: a new FactoryDatabase over the same
 *    file hands a fresh manager the complete state (every version
 *    field, links, an active hold, a compatibility declaration), and
 *    writes made by the resumed manager persist for a third instance;
 *  - old databases gain the requirement tables on open.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryRequirementStore,
  RequirementManager,
  type RequirementStore,
} from '@ai-factory/requirements';
import { FactoryDatabase } from '../src/index';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function norm(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value).replace(UUID_RE, '<uuid>'));
}

function tickClock(): () => number {
  let t = 1_700_000_000_000;
  return () => (t += 1000);
}

function tmpDbFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-req-'));
  return { dir, file: join(dir, 'factory.db') };
}

type Trace = Array<[string, unknown]>;

/** One identical scripted sequence, driven through a store-backed manager. */
function script(store: RequirementStore): { trace: Trace; manager: RequirementManager } {
  const m = new RequirementManager({ now: tickClock(), store });
  const trace: Trace = [];
  const rec = (label: string, fn: () => unknown): void => {
    try {
      trace.push([label, norm(structuredClone(fn()))]);
    } catch (e) {
      trace.push([label, norm(`ERR: ${(e as Error).message}`)]);
    }
  };

  rec('create', () =>
    m.create({
      id: 'REQ-001',
      businessGoal: 'ship the feature',
      rationale: 'initial rationale',
      projectCategory: 'PRODUCTION_SOFTWARE',
      acceptanceCriteria: [
        {
          id: 'AC-001',
          description: 'the feature works',
          verificationType: 'AUTOMATED_TEST',
          verifiedBy: 'INDEPENDENT_QA',
          expectedEvidence: 'qa_result with verdict PASS',
          applicableEnvironments: ['DEV'],
        },
      ],
      budget: { amount: 500, currency: 'USD' },
      createdBy: 'human',
    }),
  );
  rec('create-auto', () =>
    m.create({
      businessGoal: 'auto id',
      acceptanceCriteria: [
        {
          id: 'AC-001',
          description: 'y',
          verificationType: 'AUTOMATED_TEST',
          verifiedBy: 'CI',
          expectedEvidence: 'ci_result',
          applicableEnvironments: [],
        },
      ],
      createdBy: 'human',
    }).id,
  );
  rec('new-version', () =>
    m.newVersion('REQ-001', 'CORRECTION', 'fix rationale typo', 'human', (d) => {
      d.rationale = 'corrected rationale';
    }),
  );
  rec('ac-refinement', () =>
    m.proposeAcRefinement('REQ-001', 'AC-001', { description: 'works end to end' }, 'pm-ai'),
  );
  rec('link', () => {
    m.linkEntities('REQ-001', 1, { taskIds: ['task-1'], evidenceIds: ['ev-1'] });
    return m.getLinks('REQ-001', 1);
  });
  let holdId = '';
  rec('impact', () => {
    const impact = m.analyzeImpact('REQ-001', 1, 2, 'human');
    holdId = impact.suspendedPromotions[0]?.id ?? '';
    return impact;
  });
  rec('holds', () => m.listHolds('task-1'));
  rec('compat', () => {
    m.checkEvidenceCompatibility('ev-1', 'REQ-001', 2, true, 'ACs unchanged', 'human');
    return m.canReuseEvidence('ev-1', 'REQ-001', 2);
  });
  rec('release', () => m.releaseHold(holdId, 'human', 're-validated against v2'));
  rec('read-back', () => ({
    req: m.get('REQ-001'),
    v1: m.getVersion('REQ-001', 1),
    links: m.getLinks('REQ-001', 1),
  }));
  return { trace, manager: m };
}

describe('SqliteRequirementStore behavior parity (§16, F2)', () => {
  it('the same scripted sequence yields identical results on memory and SQLite stores', () => {
    const { dir, file } = tmpDbFile();
    try {
      const fdb = new FactoryDatabase(file);
      try {
        const mem = script(new InMemoryRequirementStore());
        const sql = script(fdb.requirements);
        assert.deepEqual(sql.trace, mem.trace);
      } finally {
        fdb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hands back fresh deep copies: mutating a read-back cannot corrupt stored rows', () => {
    const { dir, file } = tmpDbFile();
    try {
      const fdb = new FactoryDatabase(file);
      try {
        const { manager } = script(fdb.requirements);
        const back = fdb.requirements.listRequirements()[0]!;
        back.versions.length = 0;
        back.id = 'tampered';
        const again = fdb.requirements.listRequirements();
        assert.equal(again[0]!.id, 'REQ-001');
        assert.equal(again[0]!.versions.length, manager.get('REQ-001').versions.length);
        const links = fdb.requirements.listLinks();
        links[0]!.links.taskIds.push('evil');
        assert.deepEqual(fdb.requirements.listLinks()[0]!.links.taskIds, ['task-1']);
      } finally {
        fdb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SqliteRequirementStore durability (§16, F2)', () => {
  it('a fresh manager over a reopened database resumes the full state', () => {
    const { dir, file } = tmpDbFile();
    try {
      const fdb1 = new FactoryDatabase(file);
      const first = script(fdb1.requirements).manager;
      const before = {
        req: first.get('REQ-001'),
        links: first.getLinks('REQ-001', 1),
        holds: first.listHolds(),
        reuse: first.canReuseEvidence('ev-1', 'REQ-001', 2),
      };
      fdb1.close();

      const fdb2 = new FactoryDatabase(file);
      try {
        const resumed = new RequirementManager({ store: fdb2.requirements });
        // Every version, field for field — the pin target a restarted
        // server must be able to resolve (F2's 400 came from this get).
        assert.deepEqual(resumed.get('REQ-001'), before.req);
        assert.equal(resumed.getVersion('REQ-001', 1).rationale, 'initial rationale');
        assert.equal(resumed.latest('REQ-001').version, 3);
        assert.deepEqual(resumed.getLinks('REQ-001', 1), before.links);
        // Holds survive — released state included — and so does the
        // compatibility declaration the STALE gate consults.
        assert.deepEqual(resumed.listHolds(), before.holds);
        assert.equal(resumed.canReuseEvidence('ev-1', 'REQ-001', 2), before.reuse);
        // Auto-id sequence continues across the restart: the script's
        // auto attempt collided with the explicit REQ-001 and consumed
        // seq=1 (the trace pins that error), so the next auto id the
        // resumed manager hands out is REQ-002 — it neither collides
        // with REQ-001 nor restarts the sequence.
        const next = resumed.create({
          businessGoal: 'after restart',
          acceptanceCriteria: [
            {
              id: 'AC-001',
              description: 'z',
              verificationType: 'AUTOMATED_TEST',
              verifiedBy: 'CI',
              expectedEvidence: 'ci_result',
              applicableEnvironments: [],
            },
          ],
          createdBy: 'human',
        });
        assert.equal(next.id, 'REQ-002');
        // Writes through the resumed manager persist too.
        resumed.newVersion('REQ-001', 'CORRECTION', 'post-restart note', 'human', (d) => {
          d.rationale = 'post-restart rationale';
        });
      } finally {
        fdb2.close();
      }

      const fdb3 = new FactoryDatabase(file);
      try {
        const third = new RequirementManager({ store: fdb3.requirements });
        assert.equal(third.latest('REQ-001').version, 4);
        assert.equal(third.latest('REQ-001').rationale, 'post-restart rationale');
        assert.equal(third.getVersion('REQ-001', 1).rationale, 'initial rationale');
      } finally {
        fdb3.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a pre-F2 database (no requirement tables) gains them on open', () => {
    const { dir, file } = tmpDbFile();
    try {
      const raw = new DatabaseSync(file);
      raw.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY)');
      raw.close();

      const fdb = new FactoryDatabase(file);
      try {
        for (const table of [
          'requirements',
          'requirement_links',
          'promotion_holds',
          'evidence_compatibility',
          'requirement_store_meta',
        ]) {
          const cols = (
            fdb.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
          ).map((c) => c.name);
          assert.ok(cols.length > 0, `${table} exists on open`);
        }
        const m = new RequirementManager({ store: fdb.requirements });
        m.create({
          id: 'REQ-001',
          businessGoal: 'backfilled db works',
          acceptanceCriteria: [
            {
              id: 'AC-001',
              description: 'x',
              verificationType: 'AUTOMATED_TEST',
              verifiedBy: 'CI',
              expectedEvidence: 'ci_result',
              applicableEnvironments: [],
            },
          ],
          createdBy: 'human',
        });
        assert.equal(m.getVersion('REQ-001', 1).businessGoal, 'backfilled db works');
      } finally {
        fdb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

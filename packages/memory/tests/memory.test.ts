/**
 * Unit tests for the memory engine — SPEC v2 §43 (Structured Memory Engine).
 * Run from the package dir: npx tsc -p tsconfig.json && node --test dist/tests/*.test.js
 *
 * Covers: §43.2 schema defaults, §43.3 ACL-first retrieve, classification
 * filtering, cross-project reuse, contradiction marking + authority-based
 * resolution, purge with registry proof, §43.4 prohibitions (secrets,
 * skip-approval conclusions, manager claims, authorization claims),
 * plus the v1-carried lifecycle (dedup/merge, expiry, decay, verify,
 * lessonFromEvaluation) updated to the v2 status set.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EvaluationInput,
  MemoryError,
  MemoryRefRegistry,
  MemoryStore,
  NewMemoryEntry,
  RequestorIdentity,
  assertMemoryNeverAuthorizes,
  lessonFromEvaluation,
  sourceAuthorityScore,
} from '../src/index';

function makeStore(startMs = 1_000_000, registry?: MemoryRefRegistry) {
  let now = startMs;
  const store = new MemoryStore({ now: () => now, registry });
  return {
    store,
    setNow: (ms: number) => {
      now = ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function lesson(partial: Partial<NewMemoryEntry> = {}): NewMemoryEntry {
  return {
    scope: 'project',
    scopeId: 'proj-1',
    type: 'Lesson',
    title: 'Always test duplicate payment callbacks',
    content: 'Async state updates caused the last payment bug.',
    source: 'evaluation:task-7',
    confidence: 0.8,
    createdBy: 'backend-01',
    evidenceIds: ['ev-1'],
    applicableScope: 'project:proj-1',
    expiresAt: null,
    ...partial,
  };
}

const acmeRequestor: RequestorIdentity = {
  id: 'backend-01',
  scopes: ['project:proj-1'],
  clearance: 'internal',
};

// ------------------------------------------------------- §43.2 schema ------

describe('§43.2 schema defaults', () => {
  it('fills ACL, classification, reuse, confidence kind and refs on write', () => {
    const { store } = makeStore();
    const e = store.write(lesson());
    assert.deepEqual(e.accessScope, ['project:proj-1'], 'ACL defaults to scope:scopeId');
    assert.equal(e.dataClassification, 'internal');
    assert.deepEqual(e.crossProjectReusable, { allowed: false }, 'non-public defaults to not reusable');
    assert.equal(e.confidenceKind, 'model-self-assessed');
    assert.deepEqual(e.supersedes, []);
    assert.deepEqual(e.contradicts, []);
    assert.deepEqual(e.sourceRefs, []);
    assert.deepEqual(e.taskRefs, []);
    assert.equal(e.indexVersion, 'v1');
    assert.equal(e.status, 'ACTIVE');
  });

  it('defaults system-scope ACL to public and public entries to reusable', () => {
    const { store } = makeStore();
    const e = store.write(
      lesson({
        scope: 'system',
        scopeId: 'global',
        dataClassification: 'public',
        title: 'Idempotent handlers prevent double charge',
      }),
    );
    assert.deepEqual(e.accessScope, ['*']);
    assert.deepEqual(e.crossProjectReusable, { allowed: true });
  });

  it('uses the v2 status set PROPOSED/VALIDATED/ACTIVE/STALE/CONTRADICTED/RETIRED', () => {
    const { store } = makeStore();
    const e = store.write(lesson());
    assert.ok(
      (['PROPOSED', 'VALIDATED', 'ACTIVE', 'STALE', 'CONTRADICTED', 'RETIRED'] as string[]).includes(
        e.status,
      ),
    );
    assert.equal(store.markStale(e.id)?.status, 'STALE');
    assert.equal(store.retire(e.id)?.status, 'RETIRED');
  });
});

// ------------------------------------------------- §43.3 secure retrieve ---

describe('§43.3 retrieve(): security filter first', () => {
  it('denies cross-project retrieval without authorization (entry never returned)', () => {
    const { store } = makeStore();
    store.write(lesson({ title: 'acme secret sauce', scopeId: 'proj-1' }));
    store.write(lesson({ title: 'beta internals', scopeId: 'proj-2' }));

    const acmeOnly: RequestorIdentity = {
      id: 'e-1',
      scopes: ['project:proj-1'],
      clearance: 'internal',
    };
    // Cross-project query for proj-2 by an unauthorized requestor: denied.
    const denied = store.retrieve({ scope: 'project', scopeId: 'proj-2' }, acmeOnly);
    assert.deepEqual(denied, [], 'unauthorized entries are not returned at all');

    // Unscoped retrieval only surfaces ACL-authorized entries.
    const visible = store.retrieve({ scope: 'project' }, acmeOnly);
    assert.deepEqual(
      visible.map((e) => e.title),
      ['acme secret sauce'],
    );
  });

  it('filters by data classification against requestor clearance', () => {
    const { store } = makeStore();
    store.write(lesson({ title: 'public runbook', dataClassification: 'public' }));
    store.write(
      lesson({ title: 'internal design doc', dataClassification: 'internal', accessScope: ['project:proj-1'] }),
    );
    store.write(
      lesson({
        title: 'confidential incident notes',
        dataClassification: 'confidential',
        accessScope: ['project:proj-1'],
      }),
    );

    const internalReq: RequestorIdentity = {
      id: 'e-1',
      scopes: ['project:proj-1'],
      clearance: 'internal',
    };
    const seen = store.retrieve({ scope: 'project' }, internalReq).map((e) => e.title);
    assert.ok(seen.includes('public runbook'));
    assert.ok(seen.includes('internal design doc'));
    assert.ok(!seen.includes('confidential incident notes'), 'above-clearance entry not returned');

    const clearedReq: RequestorIdentity = { ...internalReq, clearance: 'confidential' };
    const seenCleared = store.retrieve({ scope: 'project' }, clearedReq).map((e) => e.title);
    assert.ok(seenCleared.includes('confidential incident notes'));
  });

  it('gates cross-project visibility on crossProjectReusable', () => {
    const { store } = makeStore();
    store.write(
      lesson({
        title: 'sanitized reusable pattern',
        scopeId: 'proj-1',
        accessScope: ['project:proj-1', 'project:proj-2'],
        crossProjectReusable: { allowed: true, conditions: 'sanitized, no customer identifiers' },
      }),
    );
    store.write(
      lesson({
        title: 'proj-1 private lesson',
        scopeId: 'proj-1',
        accessScope: ['project:proj-1', 'project:proj-2'],
        crossProjectReusable: { allowed: false },
      }),
    );

    const betaReq: RequestorIdentity = {
      id: 'e-2',
      scopes: ['project:proj-2'],
      clearance: 'internal',
    };
    const seen = store.retrieve({ scope: 'project', scopeId: 'proj-2' }, betaReq);
    assert.deepEqual(
      seen.map((e) => e.title),
      ['sanitized reusable pattern'],
      'only the reusable entry crosses the project boundary',
    );
  });

  it('hides RETIRED and CONTRADICTED entries unless explicitly included', () => {
    const { store } = makeStore();
    const live = store.write(lesson({ title: 'live lesson' }));
    const retired = store.write(lesson({ title: 'retired lesson' }));
    store.retire(retired.id);

    const base = store.retrieve({ scope: 'project' }, acmeRequestor);
    assert.deepEqual(base.map((e) => e.id), [live.id]);

    const withRetired = store.retrieve({ scope: 'project', includeRetired: true }, acmeRequestor);
    assert.equal(withRetired.length, 2);
  });

  it('still sorts by confidence desc, recency desc after filtering', () => {
    const { store, advance } = makeStore();
    store.write(lesson({ title: 'low', confidence: 0.3 }));
    advance(10);
    store.write(lesson({ title: 'high', confidence: 0.95 }));
    const got = store.retrieve({ scope: 'project' }, acmeRequestor);
    assert.deepEqual(got.map((e) => e.title), ['high', 'low']);
  });
});

// -------------------------------------------------- §43.3 contradictions --

describe('§43.3 contradictions', () => {
  it('marks the old ACTIVE entry CONTRADICTED and stores the new one as PROPOSED', () => {
    const { store } = makeStore();
    const old = store.write(
      lesson({ title: 'Deploy freeze every Friday', source: 'human:cto', confidence: 0.9 }),
    );
    assert.equal(old.status, 'ACTIVE');

    const fresh = store.write(
      lesson({
        title: 'Friday deploys allowed with canary',
        source: 'spec',
        confidence: 0.8,
        contradicts: [old.id],
      }),
    );
    assert.equal(fresh.status, 'PROPOSED', 'contradicting write lands as PROPOSED');
    assert.deepEqual(fresh.contradicts, [old.id]);

    const marked = store.get(old.id)!;
    assert.equal(marked.status, 'CONTRADICTED');
    assert.ok(marked.contradicts.includes(fresh.id), 'back-reference recorded');
  });

  it('verify() does not verify away a CONTRADICTED entry; PROPOSED verifies to VALIDATED', () => {
    const { store } = makeStore();
    const old = store.write(lesson({ title: 'old claim' }));
    const fresh = store.write(lesson({ title: 'new claim', contradicts: [old.id] }));

    assert.equal(store.verify(old.id, 'human')?.status, 'CONTRADICTED', 'contradiction survives verify');
    assert.equal(store.verify(fresh.id, 'human')?.status, 'VALIDATED', 'PROPOSED verifies to VALIDATED');
  });

  it('resolveContradiction: winner ACTIVE + supersedes, losers RETIRED', () => {
    const { store } = makeStore();
    const old = store.write(lesson({ title: 'old claim' }));
    const fresh = store.write(lesson({ title: 'new claim', contradicts: [old.id] }));

    const { winner, losers } = store.resolveContradiction(fresh.id, [old.id], 'human');
    assert.equal(winner.status, 'ACTIVE');
    assert.ok(winner.supersedes.includes(old.id));
    assert.equal(losers.length, 1);
    assert.equal(losers[0].status, 'RETIRED');
    assert.equal(store.get(old.id)?.status, 'RETIRED');
  });

  it('resolveBySourceAuthority: authoritative source wins, not newest/highest score', () => {
    const { store, advance } = makeStore();
    // Older, lower-confidence, but human-authoritative.
    const humanEntry = store.write(
      lesson({
        title: 'human: deploy freeze stays',
        source: 'human:cto',
        confidence: 0.5,
        evidenceIds: ['ev-ctx'],
      }),
    );
    advance(1000);
    // Newer, higher-confidence manager claim WITH evidence (passes the §43.4 guard).
    const managerEntry = store.write(
      lesson({
        title: 'manager: freeze lifted, trust me',
        source: 'manager-claim:standup',
        confidence: 0.95,
        evidenceIds: ['ev-standup'],
        contradicts: [humanEntry.id],
      }),
    );

    assert.ok(sourceAuthorityScore('human:cto') > sourceAuthorityScore('manager-claim:standup'));

    const { winnerId, winner, losers } = store.resolveBySourceAuthority(
      [humanEntry.id, managerEntry.id],
      'human',
    );
    assert.equal(winnerId, humanEntry.id, 'authority beats recency and confidence');
    assert.equal(winner.status, 'ACTIVE');
    assert.equal(losers[0].id, managerEntry.id);
    assert.equal(losers[0].status, 'RETIRED');
  });

  it('rejects contradicts referencing unknown ids', () => {
    const { store } = makeStore();
    assert.throws(
      () => store.write(lesson({ title: 'x', contradicts: ['mem_nope'] })),
      (err: unknown) => err instanceof MemoryError && err.code === 'ENTRY_NOT_FOUND',
    );
  });
});

// --------------------------------------------------------- §43.3 purge -----

describe('§43.3 purge()', () => {
  it('removes entries and cleans index/cache/backup refs — registry proves it', () => {
    const registry = new MemoryRefRegistry();
    const { store } = makeStore(1_000_000, registry);
    const a = store.write(lesson({ title: 'a', scopeId: 'proj-x' }));
    const b = store.write(lesson({ title: 'b', scopeId: 'proj-x' }));
    const c = store.write(lesson({ title: 'c', scopeId: 'proj-x' }));
    store.write(lesson({ title: 'kept', scopeId: 'proj-y' }));

    assert.equal(registry.totalRefs(), 12, '3 refs x 4 entries tracked');

    const report = store.purge('proj-x');
    assert.equal(report.scopeId, 'proj-x');
    assert.equal(report.removedCount, 3);
    assert.deepEqual(report.removedEntryIds.sort(), [a.id, b.id, c.id].sort());
    assert.deepEqual(report.cleanedRefs, { index: 3, cache: 3, backup: 3 });
    assert.equal(report.registryClean, true, 'registry holds zero refs for purged ids');
    for (const id of [a.id, b.id, c.id]) {
      assert.equal(registry.refsFor(id).total, 0, `no refs remain for ${id}`);
    }

    assert.equal(store.size(), 1, 'other scopes untouched');
    assert.equal(registry.totalRefs(), 3, 'only the surviving entry keeps refs');
    const visible = store.retrieve(
      { scope: 'project' },
      { id: 'e-1', scopes: ['project:proj-y'], clearance: 'internal' },
    );
    assert.deepEqual(visible.map((e) => e.title), ['kept']);
  });

  it('purge of an empty scope reports zero removals and a clean registry', () => {
    const registry = new MemoryRefRegistry();
    const { store } = makeStore(1_000_000, registry);
    const report = store.purge('proj-nothing');
    assert.equal(report.removedCount, 0);
    assert.deepEqual(report.cleanedRefs, { index: 0, cache: 0, backup: 0 });
    assert.equal(report.registryClean, true);
  });

  it('works without a registry wired in', () => {
    const { store } = makeStore();
    store.write(lesson({ title: 'a', scopeId: 'proj-x' }));
    const report = store.purge('proj-x');
    assert.equal(report.removedCount, 1);
    assert.equal(report.registryClean, true);
  });
});

// ---------------------------------------------------- §43.4 prohibitions ---

describe('§43.4 prohibitions', () => {
  it('refuses to store raw secrets', () => {
    const { store } = makeStore();
    const secrets = [
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...',
      'aws key AKIAIOSFODNN7EXAMPLE leaked in the log',
      'token ghp_abcdefghij1234567890 should not be here',
      'deploy failed, password: hunter2hunter was in the env dump',
    ];
    for (const content of secrets) {
      assert.throws(
        () => store.write(lesson({ title: `secret case`, content })),
        (err: unknown) => err instanceof MemoryError && err.code === 'SECRET_DETECTED',
        `must reject: ${content.slice(0, 40)}`,
      );
    }
    assert.equal(store.size(), 0, 'no secret ever landed in the store');
  });

  it('refuses "skip approval next time" conclusions', () => {
    const { store } = makeStore();
    assert.throws(
      () => store.write(lesson({ title: 'deploy retro', content: 'Deploy succeeded, 下次可跳过审批' })),
      (err: unknown) => err instanceof MemoryError && err.code === 'PROHIBITED_CONCLUSION',
    );
    assert.throws(
      () =>
        store.write(
          lesson({ title: 'deploy retro', content: 'All green — we can skip approval next time' }),
        ),
      (err: unknown) => err instanceof MemoryError && err.code === 'PROHIBITED_CONCLUSION',
    );
    assert.equal(store.size(), 0);
  });

  it('refuses unevidenced manager claims as test results', () => {
    const { store } = makeStore();
    assert.throws(
      () =>
        store.write(
          lesson({ title: 'manager says tests pass', source: 'manager-claim', evidenceIds: [] }),
        ),
      (err: unknown) => err instanceof MemoryError && err.code === 'MANAGER_CLAIM_NEEDS_EVIDENCE',
    );
    // With evidence it is storable (still marked by its source for authority ranking).
    const withEvidence = store.write(
      lesson({
        title: 'manager claim with evidence',
        source: 'manager-claim:standup',
        evidenceIds: ['ev-standup'],
      }),
    );
    assert.equal(withEvidence.status, 'ACTIVE');
    // Non-test-result types are not test results.
    const pref = store.write(
      lesson({ title: 'manager prefers standup async', source: 'manager-claim', type: 'Preference' }),
    );
    assert.equal(pref.status, 'ACTIVE');
  });

  it('assertMemoryNeverAuthorizes rejects permission/AC/policy claims, standalone and at write', () => {
    assert.throws(
      () =>
        assertMemoryNeverAuthorizes({
          title: 'Grant admin access to the deploy bot',
          content: 'so it can push without review',
          type: 'Decision',
        }),
      (err: unknown) => err instanceof MemoryError && err.code === 'AUTHORIZATION_FORBIDDEN',
    );
    assert.throws(
      () =>
        assertMemoryNeverAuthorizes({
          title: 'Policy update',
          content: 'Override the policy for Friday deploys',
          type: 'Decision',
        }),
      (err: unknown) => err instanceof MemoryError && err.code === 'AUTHORIZATION_FORBIDDEN',
    );
    // And write() runs the same guard:
    const { store } = makeStore();
    assert.throws(
      () =>
        store.write(
          lesson({
            title: 'AC change approved',
            content: '修改访问控制，放开 deploy 权限',
          }),
        ),
      (err: unknown) => err instanceof MemoryError && err.code === 'AUTHORIZATION_FORBIDDEN',
    );
    assert.equal(store.size(), 0);
    // Ordinary entries pass the guard.
    assert.doesNotThrow(() =>
      assertMemoryNeverAuthorizes({
        title: 'Retry DB writes with backoff',
        content: 'Transient deadlocks clear on the second attempt.',
        type: 'Pattern',
      }),
    );
  });
});

// ------------------------------------------------- lifecycle (v1 carried) --

describe('write + dedup merge', () => {
  it('merges same scope+scopeId+type+normalized title instead of duplicating', () => {
    const { store } = makeStore();
    const first = store.write(lesson());
    const second = store.write(
      lesson({
        title: '  ALWAYS test duplicate   payment callbacks ', // different case/whitespace
        content: 'Second corroborating report from the on-call.',
        confidence: 0.9,
        evidenceIds: ['ev-2'],
        source: 'human:oncall',
      }),
    );

    assert.equal(second.id, first.id, 'dedup must return the same entry id');
    assert.equal(store.size(), 1, 'no duplicate row created');
    assert.ok(second.content.includes('Async state updates'), 'original content kept');
    assert.ok(second.content.includes('Second corroborating report'), 'new content appended');
    assert.equal(second.confidence, 0.9, 'confidence is the max of both writes');
    assert.deepEqual(second.evidenceIds, ['ev-1', 'ev-2'], 'evidence ids unioned');
    assert.ok(second.source.includes('evaluation:task-7') && second.source.includes('human:oncall'));
  });

  it('treats different scope/type/title as distinct entries', () => {
    const { store } = makeStore();
    store.write(lesson());
    store.write(lesson({ scope: 'employee', scopeId: 'backend-01' }));
    store.write(lesson({ type: 'Failure' }));
    store.write(lesson({ title: 'A different lesson' }));
    assert.equal(store.size(), 4);
  });

  it('clamps confidence into 0..1', () => {
    const { store } = makeStore();
    assert.equal(store.write(lesson({ confidence: 2 })).confidence, 1);
    assert.equal(store.write(lesson({ title: 'other', confidence: -5 })).confidence, 0);
  });

  it('does not merge into a RETIRED entry — a fresh entry takes over the dedup key', () => {
    const { store } = makeStore();
    const first = store.write(lesson());
    store.retire(first.id);
    const second = store.write(lesson({ content: 'Fresh take after retirement.' }));
    assert.notEqual(second.id, first.id);
    assert.equal(second.status, 'ACTIVE');
    assert.equal(store.size(), 2);
  });
});

describe('query filters + ordering (legacy low-level path)', () => {
  it('filters by scope/scopeId/type/minConfidence and sorts confidence desc, recency desc', () => {
    const { store, advance } = makeStore();
    store.write(lesson({ title: 'low', confidence: 0.3 }));
    advance(10);
    store.write(lesson({ title: 'high', confidence: 0.95 }));
    advance(10);
    store.write(lesson({ title: 'mid', confidence: 0.6 }));
    store.write(lesson({ title: 'other project', scopeId: 'proj-2', confidence: 0.99 }));
    store.write(lesson({ title: 'fact', type: 'Fact', confidence: 0.9 }));

    const all = store.query({ scope: 'project', scopeId: 'proj-1' });
    assert.deepEqual(
      all.map((e) => e.title),
      ['high', 'fact', 'mid', 'low'],
      'confidence desc',
    );

    const typed = store.query({ scope: 'project', scopeId: 'proj-1', type: 'Fact' });
    assert.deepEqual(typed.map((e) => e.title), ['fact']);

    const confident = store.query({ scope: 'project', scopeId: 'proj-1', minConfidence: 0.6 });
    assert.deepEqual(confident.map((e) => e.title), ['high', 'fact', 'mid']);

    // Recency tiebreak: same confidence → later write first.
    const { store: s2, advance: adv2 } = makeStore();
    s2.write(lesson({ title: 'older', confidence: 0.7 }));
    adv2(50);
    s2.write(lesson({ title: 'newer', confidence: 0.7 }));
    const tied = s2.query({ scope: 'project', scopeId: 'proj-1' });
    assert.deepEqual(tied.map((e) => e.title), ['newer', 'older']);
  });
});

describe('expiry auto-marking', () => {
  it('marks past-expiresAt entries RETIRED and hides them unless includeExpired', () => {
    const start = 1_000_000;
    const { store } = makeStore(start);
    const past = new Date(start - 1_000).toISOString();
    const written = store.write(lesson({ expiresAt: past }));

    assert.equal(written.status, 'ACTIVE', 'write itself does not sweep');
    const fetched = store.get(written.id);
    assert.equal(fetched?.status, 'RETIRED', 'read path auto-marks RETIRED');

    assert.deepEqual(store.query({ scope: 'project', scopeId: 'proj-1' }), [], 'hidden by default');
    const withExpired = store.query({
      scope: 'project',
      scopeId: 'proj-1',
      includeExpired: true,
    });
    assert.equal(withExpired.length, 1);
    assert.equal(withExpired[0].status, 'RETIRED');
  });
});

describe('confidence decay', () => {
  it('loses 0.2 past half the TTL, exactly once per half-TTL window', () => {
    const start = 1_000_000;
    const { store, advance } = makeStore(start);
    // TTL = 1000ms, half = 500ms.
    const written = store.write(
      lesson({ confidence: 0.8, expiresAt: new Date(start + 1_000).toISOString() }),
    );
    assert.equal(written.confidence, 0.8);

    advance(400);
    assert.equal(store.get(written.id)?.confidence, 0.8, 'no decay before half TTL');

    advance(200); // t = +600, past half TTL
    assert.equal(store.get(written.id)?.confidence, 0.6, 'decay of 0.2 applied');

    advance(100);
    assert.equal(
      store.get(written.id)?.confidence,
      0.6,
      'decay does not re-apply within the same window',
    );
  });

  it('floors decayed confidence at 0', () => {
    const start = 1_000_000;
    const { store, advance } = makeStore(start);
    const written = store.write(
      lesson({ confidence: 0.1, expiresAt: new Date(start + 1_000).toISOString() }),
    );
    advance(600);
    assert.equal(store.get(written.id)?.confidence, 0);
  });

  it('never decays entries without an expiry', () => {
    const { store, advance } = makeStore();
    const written = store.write(lesson({ confidence: 0.8, expiresAt: null }));
    advance(10_000_000);
    assert.equal(store.get(written.id)?.confidence, 0.8);
  });
});

describe('verify()', () => {
  it('restores confidence, stamps lastVerifiedAt and keeps status ACTIVE', () => {
    const start = 1_000_000;
    const { store, advance } = makeStore(start);
    const written = store.write(
      lesson({ confidence: 0.8, expiresAt: new Date(start + 1_000).toISOString() }),
    );
    advance(600);
    assert.equal(store.get(written.id)?.confidence, 0.6, 'precondition: decayed');

    advance(100);
    const verified = store.verify(written.id, 'tech-lead');
    assert.ok(verified);
    assert.equal(verified.confidence, 0.7, '+0.1 restore');
    assert.equal(verified.lastVerifiedAt, new Date(start + 700).toISOString());
    assert.equal(verified.status, 'ACTIVE');

    // Decay clock restarted: no immediate re-decay on the next read.
    assert.equal(store.get(written.id)?.confidence, 0.7);
  });

  it('caps confidence at 1', () => {
    const { store } = makeStore();
    const written = store.write(lesson({ confidence: 0.95 }));
    assert.equal(store.verify(written.id, 'human')?.confidence, 1);
  });

  it('returns undefined for unknown ids', () => {
    const { store } = makeStore();
    assert.equal(store.verify('mem_nope', 'human'), undefined);
    assert.equal(store.get('mem_nope'), undefined);
  });
});

describe('lessonFromEvaluation', () => {
  const input: EvaluationInput = {
    taskId: 'task-101',
    projectId: 'proj-1',
    employeeId: 'backend-01',
    summary: 'Migrated the payment callback to idempotent handlers.',
    metrics: { success: true, testPassRate: 0.92, repairLoops: 1 },
    failures: ['flaky webhook test timed out once', 'staging deploy needed one retry'],
  };

  it('emits one Lesson plus one Failure per failure, in task scope, with v2 fields', () => {
    const entries = lessonFromEvaluation(input);
    assert.equal(entries.length, 3);

    const [l, f1, f2] = entries;
    assert.equal(l.scope, 'task');
    assert.equal(l.scopeId, 'task-101');
    assert.equal(l.type, 'Lesson');
    assert.equal(l.createdBy, 'backend-01');
    assert.equal(l.source, 'evaluation:task-101');
    assert.equal(l.applicableScope, 'project:proj-1');
    assert.deepEqual(l.accessScope, ['project:proj-1'], 'ACL points at the owning project');
    assert.equal(l.dataClassification, 'internal');
    assert.equal(l.confidenceKind, 'evaluation-derived');
    assert.deepEqual(l.taskRefs, ['task-101']);
    assert.ok(l.content.includes('Migrated the payment callback'));
    assert.ok(l.content.includes('testPassRate=0.92'));

    assert.equal(f1.type, 'Failure');
    assert.equal(f1.scope, 'task');
    assert.ok(f1.title.includes('task-101'));
    assert.ok(f1.content.includes('flaky webhook'));
    assert.ok(f2.content.includes('staging deploy'));

    for (const e of entries) {
      assert.ok(e.confidence >= 0 && e.confidence <= 1, 'confidence in range');
    }
  });

  it('lowers confidence for failed, failure-heavy tasks', () => {
    const bad: EvaluationInput = {
      ...input,
      taskId: 'task-102',
      metrics: { success: false, testPassRate: 0.2, repairLoops: 5 },
      failures: ['a', 'b', 'c', 'd', 'e', 'f'],
    };
    const [goodLesson] = lessonFromEvaluation(input);
    const [badLesson] = lessonFromEvaluation(bad);
    assert.ok(badLesson.confidence < goodLesson.confidence);
  });

  it('defaults createdBy to evaluation-engine and merges cleanly in the store', () => {
    const { store } = makeStore();
    const noEmployee: EvaluationInput = { ...input, employeeId: undefined };
    const entries = lessonFromEvaluation(noEmployee);
    assert.equal(entries[0].createdBy, 'evaluation-engine');

    const ids = entries.map((e) => store.write(e).id);
    const idsAgain = lessonFromEvaluation(noEmployee).map((e) => store.write(e).id);
    assert.deepEqual(idsAgain, ids, 're-evaluating the same task merges, not duplicates');
    assert.equal(store.size(), 3);
  });
});

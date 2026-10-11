/**
 * Tests for the artifact system (spec §39.1: 27 types = 19 v1 + 8 v2).
 * Run: node --test dist/tests/artifacts.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTIFACT_TYPES,
  Artifact,
  ArtifactNotFoundError,
  ArtifactSealedError,
  ArtifactStore,
  ArtifactType,
  ArtifactValidationError,
  ArtifactWorkflowHooks,
  getSchema,
  listSchemas,
} from '../src/index';

/** Minimal valid payload for every one of the 27 types. */
const VALID_FIELDS: Record<ArtifactType, Record<string, unknown>> = {
  PLAN: { objective: 'ship v1', steps: ['design', 'code', 'test'] },
  TASK_BREAKDOWN: { subtasks: ['a', 'b'] },
  DESIGN: { title: 'design', summary: 'what and why' },
  ARCHITECTURE: { components: ['api', 'db'] },
  CODE_CHANGE: { filesChanged: ['src/a.ts'], diffSummary: 'adds feature', changeType: 'feature' },
  COMMIT: { sha: 'abc123', message: 'feat: x', author: 'dev' },
  PULL_REQUEST: { prNumber: 42, title: 'feat', sourceBranch: 'f', targetBranch: 'main' },
  CODE_REVIEW: { reviewer: 'r', verdict: 'approve', findings: [] },
  TEST_PLAN: { testCases: ['t1'], environment: 'ci' },
  TEST_RESULT: { suite: 'unit', passed: 10, failed: 0, summary: 'all green' },
  SECURITY_REPORT: { scanner: 's', severity: 'low', findings: [] },
  BUILD_ARTIFACT: { artifactName: 'app', version: '1.0.0', location: 's3://b/app' },
  DEPLOYMENT: { environment: 'prod', version: '1.0.0', status: 'success' },
  SMOKE_TEST: { environment: 'prod', checksPassed: 5, checksFailed: 0 },
  UAT_RESULT: { tester: 'u', verdict: 'accept', signOff: true },
  RELEASE: { version: '1.0.0', releaseNotes: 'first release' },
  INCIDENT: { severity: 'sev3', title: 'blip', description: 'brief outage', status: 'resolved' },
  ROLLBACK: { rollbackToVersion: '0.9.0', reason: 'regression', status: 'success' },
  FINAL_REPORT: { title: 'report', summary: 'done', outcomes: ['shipped'] },
  // §39.1 v2 additions
  REQUIREMENT_VERSION: { requirementId: 'REQ-001', version: '2', acceptanceCriteria: ['a1'] },
  DELEGATION: { from: 'mgr', to: 'coder', scope: 'implement login' },
  MANAGEMENT_REPORT: { reportId: 'r-1', taskId: 'task-1', summary: 'on track' },
  RISK_ASSESSMENT: { level: 'MEDIUM', factors: ['auth change'] },
  OUTCOME_RESULT: { outcomeId: 'o-1', verdict: 'MET' },
  HANDOFF: { from: 'coder', to: 'qa', summary: 'code ready' },
  CHECKPOINT: { runId: 'run-1', snapshotRef: 'snap-1' },
  IMPROVEMENT_PROPOSAL: { title: 'cache builds', rationale: 'save CI minutes' },
};

function store(): ArtifactStore {
  return new ArtifactStore({ now: () => 1_700_000_000_000 });
}

function make(type: ArtifactType, s: ArtifactStore = store(), fields: Record<string, unknown> = VALID_FIELDS[type]): Artifact {
  return s.create({ taskId: 'task-1', type, title: `${type} title`, fields, createdBy: 'tester' });
}

describe('schemas', () => {
  it('declares exactly 27 types matching the spec list (19 v1 + 8 v2)', () => {
    assert.equal(ARTIFACT_TYPES.length, 27);
    assert.deepEqual([...ARTIFACT_TYPES].sort(), Object.keys(VALID_FIELDS).sort());
    assert.equal(listSchemas().length, 27);
  });

  it('every type has a non-empty required field list', () => {
    for (const t of ARTIFACT_TYPES) {
      const schema = getSchema(t);
      assert.ok(schema.required.length > 0, `${t} must declare required fields`);
      assert.ok(schema.description.length > 0, `${t} must have a description`);
    }
  });
});

describe('create', () => {
  for (const type of ARTIFACT_TYPES) {
    it(`creates a valid ${type}`, () => {
      const s = store();
      const a = make(type, s);
      assert.equal(a.type, type);
      assert.equal(a.status, 'DRAFT');
      assert.equal(a.taskId, 'task-1');
      assert.equal(a.sealedAt, null);
      assert.deepEqual(a.fields, VALID_FIELDS[type]);
      assert.ok(a.id.length > 0);
      assert.equal(a.createdAt, new Date(1_700_000_000_000).toISOString());
      assert.deepEqual(s.get(a.id), a);
    });
  }

  it('rejects a missing required field and names it', () => {
    const s = store();
    assert.throws(
      () => make('CODE_CHANGE', s, { filesChanged: ['a.ts'], changeType: 'fix' }),
      (e) => {
        assert.ok(e instanceof ArtifactValidationError);
        assert.ok(e.message.includes('CODE_CHANGE'));
        assert.ok(e.message.includes('diffSummary'), 'message must name the missing field');
        assert.deepEqual(e.missing, ['diffSummary']);
        return true;
      },
    );
  });

  it('names every missing field when several are absent', () => {
    const s = store();
    assert.throws(
      () => make('TEST_RESULT', s, { suite: 'unit' }),
      (e) => {
        assert.ok(e instanceof ArtifactValidationError);
        assert.deepEqual(e.missing, ['passed', 'failed', 'summary']);
        for (const f of ['passed', 'failed', 'summary']) assert.ok(e.message.includes(f));
        return true;
      },
    );
  });

  it('rejects a mistyped field and names expected vs actual', () => {
    const s = store();
    assert.throws(
      () => make('PULL_REQUEST', s, { ...VALID_FIELDS.PULL_REQUEST, prNumber: 'forty-two' }),
      (e) => {
        assert.ok(e instanceof ArtifactValidationError);
        assert.equal(e.typeErrors.length, 1);
        assert.equal(e.typeErrors[0].field, 'prNumber');
        assert.equal(e.typeErrors[0].expected, 'number');
        assert.ok(e.message.includes('prNumber'));
        assert.ok(e.message.includes('number'));
        return true;
      },
    );
  });

  it('rejects non-string items inside a string[] field', () => {
    const s = store();
    assert.throws(
      () => make('PLAN', s, { objective: 'x', steps: ['ok', 7] }),
      (e) => e instanceof ArtifactValidationError,
    );
  });

  it('rejects an unparseable isoDate', () => {
    const s = store();
    assert.throws(
      () => make('DEPLOYMENT', s, { ...VALID_FIELDS.DEPLOYMENT, deployedAt: 'not-a-date' }),
      (e) => e instanceof ArtifactValidationError,
    );
  });

  it('treats blank strings as missing', () => {
    const s = store();
    assert.throws(
      () => make('FINAL_REPORT', s, { title: '  ', summary: 's', outcomes: [] }),
      (e) => {
        assert.ok(e instanceof ArtifactValidationError);
        assert.deepEqual(e.missing, ['title']);
        return true;
      },
    );
  });

  it('allows extra fields beyond the schema', () => {
    const a = make('COMMIT', store(), { ...VALID_FIELDS.COMMIT, jira: 'JIRA-1' });
    assert.equal(a.fields.jira, 'JIRA-1');
  });

  it('returns defensive copies: mutating the result does not corrupt the store', () => {
    const s = store();
    const a = make('PLAN', s);
    (a.fields as Record<string, unknown>).objective = 'tampered';
    a.relatedIds.push('x');
    const fresh = s.get(a.id)!;
    assert.equal(fresh.fields.objective, 'ship v1');
    assert.deepEqual(fresh.relatedIds, []);
  });
});

describe('query', () => {
  it('get returns undefined for unknown ids', () => {
    assert.equal(store().get('nope'), undefined);
  });

  it('queries by taskId + type', () => {
    const s = store();
    const c1 = make('CODE_CHANGE', s);
    make('TEST_RESULT', s);
    const other = s.create({
      taskId: 'task-2',
      type: 'CODE_CHANGE',
      title: 'other',
      fields: VALID_FIELDS.CODE_CHANGE,
      createdBy: 't',
    });
    assert.deepEqual(s.listByTaskAndType('task-1', 'CODE_CHANGE').map((a) => a.id), [c1.id]);
    assert.equal(s.listByTask('task-1').length, 2);
    assert.deepEqual(s.listByTask('task-2').map((a) => a.id), [other.id]);
    assert.equal(s.query({ status: 'DRAFT' }).length, 3);
  });

  it('unknown ids throw ArtifactNotFoundError on update/seal/delete/link', () => {
    const s = store();
    assert.throws(() => s.update('nope', { title: 'x' }), ArtifactNotFoundError);
    assert.throws(() => s.seal('nope'), ArtifactNotFoundError);
    assert.throws(() => s.delete('nope'), ArtifactNotFoundError);
    assert.throws(() => s.link('nope', 'nope2'), ArtifactNotFoundError);
  });
});

describe('update', () => {
  it('updates title and merges fields, re-validating', () => {
    const s = store();
    const a = make('TEST_RESULT', s);
    const updated = s.update(a.id, {
      title: 'new title',
      fields: { passed: 11, extra: 'note' },
    });
    assert.equal(updated.title, 'new title');
    assert.equal(updated.fields.passed, 11);
    assert.equal(updated.fields.failed, 0);
    assert.equal(updated.fields.extra, 'note');
  });

  it('refuses an update that would break validation', () => {
    const s = store();
    const a = make('PLAN', s);
    assert.throws(
      () => s.update(a.id, { fields: { objective: '' } }),
      (e) => e instanceof ArtifactValidationError,
    );
    assert.equal(s.get(a.id)!.fields.objective, 'ship v1');
  });
});

describe('seal', () => {
  it('seals a draft and stamps sealedAt', () => {
    const s = store();
    const a = make('COMMIT', s);
    const sealed = s.seal(a.id);
    assert.equal(sealed.status, 'SEALED');
    assert.equal(sealed.sealedAt, new Date(1_700_000_000_000).toISOString());
  });

  it('seal is idempotent', () => {
    const s = store();
    const a = make('COMMIT', s);
    s.seal(a.id);
    const again = s.seal(a.id);
    assert.equal(again.status, 'SEALED');
  });

  it('refuses update on a sealed artifact', () => {
    const s = store();
    const a = make('COMMIT', s);
    s.seal(a.id);
    assert.throws(() => s.update(a.id, { title: 'x' }), ArtifactSealedError);
  });

  it('refuses delete on a sealed artifact but allows it on drafts', () => {
    const s = store();
    const sealed = make('COMMIT', s);
    s.seal(sealed.id);
    assert.throws(() => s.delete(sealed.id), ArtifactSealedError);
    assert.ok(s.get(sealed.id), 'sealed artifact still present');
    const draft = make('COMMIT', s);
    s.delete(draft.id);
    assert.equal(s.get(draft.id), undefined);
  });

  it('refuses linking to/from a sealed artifact', () => {
    const s = store();
    const sealed = make('CODE_CHANGE', s);
    const draft = make('TEST_RESULT', s);
    s.seal(sealed.id);
    assert.throws(() => s.link(sealed.id, draft.id), ArtifactSealedError);
    assert.throws(() => s.link(draft.id, sealed.id), ArtifactSealedError);
  });
});

describe('link', () => {
  it('creates bidirectional links and resolves via related()', () => {
    const s = store();
    const code = make('CODE_CHANGE', s);
    const test = make('TEST_RESULT', s);
    s.link(code.id, test.id);
    assert.deepEqual(s.get(code.id)!.relatedIds, [test.id]);
    assert.deepEqual(s.get(test.id)!.relatedIds, [code.id]);
    assert.deepEqual(s.related(code.id).map((a) => a.id), [test.id]);
    assert.deepEqual(s.related(test.id).map((a) => a.id), [code.id]);
  });

  it('is idempotent and ignores self-links', () => {
    const s = store();
    const a = make('PLAN', s);
    const b = make('DESIGN', s);
    s.link(a.id, b.id);
    s.link(a.id, b.id);
    s.link(a.id, a.id);
    assert.deepEqual(s.get(a.id)!.relatedIds, [b.id]);
  });

  it('links relatedIds given at creation time', () => {
    const s = store();
    const a = make('CODE_CHANGE', s);
    const b = s.create({
      taskId: 'task-1',
      type: 'TEST_RESULT',
      title: 't',
      fields: VALID_FIELDS.TEST_RESULT,
      createdBy: 't',
      relatedIds: [a.id],
    });
    assert.deepEqual(s.related(b.id).map((x) => x.id), [a.id]);
    assert.deepEqual(s.related(a.id).map((x) => x.id), [b.id]);
  });

  it('delete cleans up edges on the other side', () => {
    const s = store();
    const a = make('PLAN', s);
    const b = make('DESIGN', s);
    s.link(a.id, b.id);
    s.delete(a.id);
    assert.deepEqual(s.get(b.id)!.relatedIds, []);
  });
});

describe('workflow hooks', () => {
  function hooks(): { s: ArtifactStore; h: ArtifactWorkflowHooks } {
    const s = store();
    return { s, h: new ArtifactWorkflowHooks(s, { now: () => 1_700_000_000_000 }) };
  }

  it('TASK_COMPLETED auto-generates a FINAL_REPORT draft', () => {
    const { s, h } = hooks();
    const out = h.onWorkflowEvent({
      kind: 'TASK_COMPLETED',
      taskId: 'task-9',
      payload: { summary: 'shipped feature', outcomes: ['code', 'tests'] },
    });
    assert.equal(out.length, 1);
    const [report] = out;
    assert.equal(report.type, 'FINAL_REPORT');
    assert.equal(report.status, 'DRAFT');
    assert.equal(report.taskId, 'task-9');
    assert.equal(report.fields.summary, 'shipped feature');
    assert.deepEqual(report.fields.outcomes, ['code', 'tests']);
    assert.equal(s.listByTaskAndType('task-9', 'FINAL_REPORT').length, 1);
  });

  it('TASK_COMPLETED with empty payload still produces a valid draft (defaults filled)', () => {
    const { h } = hooks();
    const [report] = h.onWorkflowEvent({ kind: 'TASK_COMPLETED', taskId: 'task-9' });
    assert.equal(report.type, 'FINAL_REPORT');
    assert.ok((report.fields.title as string).length > 0);
    assert.ok((report.fields.summary as string).length > 0);
  });

  it('TEST_RUN_FINISHED maps payload fields onto TEST_RESULT', () => {
    const { h } = hooks();
    const [r] = h.onWorkflowEvent({
      kind: 'TEST_RUN_FINISHED',
      taskId: 't',
      payload: { suite: 'unit', passed: 20, failed: 1, summary: 'one flaky' },
    });
    assert.equal(r.type, 'TEST_RESULT');
    assert.equal(r.fields.suite, 'unit');
    assert.equal(r.fields.passed, 20);
    assert.equal(r.fields.failed, 1);
  });

  it('DEPLOY_FINISHED auto-generates a DEPLOYMENT', () => {
    const { h } = hooks();
    const [d] = h.onWorkflowEvent({
      kind: 'DEPLOY_FINISHED',
      taskId: 't',
      payload: { environment: 'prod', version: '2.0.0', status: 'success' },
    });
    assert.equal(d.type, 'DEPLOYMENT');
    assert.equal(d.fields.version, '2.0.0');
  });

  it('INCIDENT_RAISED and ROLLBACK_EXECUTED generate their artifacts', () => {
    const { h } = hooks();
    const [i] = h.onWorkflowEvent({
      kind: 'INCIDENT_RAISED',
      taskId: 't',
      payload: { severity: 'sev2', title: 'outage', description: 'db down', status: 'open' },
    });
    assert.equal(i.type, 'INCIDENT');
    const [r] = h.onWorkflowEvent({
      kind: 'ROLLBACK_EXECUTED',
      taskId: 't',
      payload: { rollbackToVersion: '1.9.0', reason: 'bad deploy', status: 'success' },
    });
    assert.equal(r.type, 'ROLLBACK');
  });

  it('unknown event kinds are a no-op (decoupled)', () => {
    const { s, h } = hooks();
    assert.deepEqual(h.onWorkflowEvent({ kind: 'SOMETHING_ELSE', taskId: 't' }), []);
    assert.equal(s.size(), 0);
  });

  it('auto-links payload.relatedArtifactIds to the generated artifact', () => {
    const { s, h } = hooks();
    const code = s.create({
      taskId: 't',
      type: 'CODE_CHANGE',
      title: 'c',
      fields: VALID_FIELDS.CODE_CHANGE,
      createdBy: 'dev',
    });
    const [report] = h.onWorkflowEvent({
      kind: 'TASK_COMPLETED',
      taskId: 't',
      payload: { relatedArtifactIds: [code.id] },
    });
    assert.deepEqual(s.get(report.id)!.relatedIds, [code.id]);
    assert.deepEqual(s.get(code.id)!.relatedIds, [report.id]);
  });

  it('register() overrides a default handler and adds new kinds', () => {
    const { s, h } = hooks();
    h.register('TASK_COMPLETED', (event, ctx) => [
      ctx.store.create({
        taskId: event.taskId,
        type: 'FINAL_REPORT',
        title: 'custom report',
        fields: { title: 'custom report', summary: 'custom', outcomes: [] },
        createdBy: 'custom-handler',
      }),
    ]);
    const [r] = h.onWorkflowEvent({ kind: 'TASK_COMPLETED', taskId: 't' });
    assert.equal(r.createdBy, 'custom-handler');
    h.register('CUSTOM_KIND', (event, ctx) => []);
    assert.deepEqual(h.onWorkflowEvent({ kind: 'CUSTOM_KIND', taskId: 't' }), []);
    assert.ok(h.registeredKinds().includes('TASK_COMPLETED'));
    assert.ok(h.registeredKinds().includes('CUSTOM_KIND'));
    assert.equal(s.size(), 1);
  });
});

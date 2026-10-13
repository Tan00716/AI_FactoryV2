/**
 * Attestation retention — SPEC v2 §47 (Batch 39).
 *
 * attestation-<buildId>.json files live in the same directory the
 * build runner writes SBOMs to, but they are evaluated as their own
 * retention category ('attestations'), mirroring the sboms
 * semantics exactly:
 *
 *  1. No policy = keep forever: evaluate reports zero candidates
 *     for attestations and enforce deletes nothing; enforce without
 *     the exact confirm text is a 400.
 *  2. PUT validation: keepCount is accepted for 'attestations' (and
 *     'backups'/'sboms') but 400 for DB categories; deleteOrphans
 *     must be a boolean and is 400 for any category but
 *     'sboms'/'attestations'.
 *  3. Count axis: keepCount keeps the newest N by record age
 *     regardless of the days axis; the oldest attestation file is
 *     swept, the sweep is audited (RETENTION_ENFORCED), and the
 *     builds record's attestationRef is NOT rewritten (dangling by
 *     design — builds rows are insert-only history).
 *  4. Days axis: only referenced attestations older than the policy
 *     are candidates; newer ones are untouched.
 *  5. Orphans (attestation-*.json files no builds record references)
 *     are KEPT by default (reported via orphanFiles) and swept only
 *     when the policy opts in with deleteOrphans: true.
 *  6. Files that do not match the attestation-<uuid>.json shape are
 *     never touched, even with orphan sweeping on (retention never
 *     deletes blind). SBOM files are never touched by the
 *     attestations category either.
 *  7. ANY active legal hold exempts every attestation deletion.
 *  8. Read-path honesty: after enforcement deletes a file, the
 *     builds read surface still returns attestationRef unchanged
 *     (same absolute path — semantics unchanged) AND reports
 *     attestationFile: 'missing' instead of fabricating presence;
 *     a surviving file reports 'present'.
 *
 * The route modules are imported from src (like sbom-retention.test.ts);
 * their value imports are node builtins and compiled packages only,
 * so node type-stripping resolves them.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FactoryDatabase } from '@ai-factory/db';
import { handleRetentionRoutes } from '../src/routes/retention.ts';
import { handleBuildsRoutes } from '../src/routes/builds.ts';
import type { RouteContext } from '../src/routes/context.ts';

const OLD_ISO = '2020-01-01T00:00:00.000Z';
const CONFIRM = { confirm: 'DELETE_EXPIRED' };
const REV = 'a'.repeat(40);

interface World {
  dir: string;
  sbomDir: string;
  fdb: FactoryDatabase;
  audits: Array<{ action: string; details: unknown }>;
}

function makeWorld(): World {
  const dir = mkdtempSync(join(tmpdir(), 'att-ret-'));
  const sbomDir = join(dir, 'sboms');
  mkdirSync(sbomDir, { recursive: true });
  const fdb = new FactoryDatabase(join(dir, 'factory.db'));
  const audits: World['audits'] = [];
  return { dir, sbomDir, fdb, audits };
}

function closeWorld(w: World): void {
  w.fdb.close();
  rmSync(w.dir, { recursive: true, force: true });
}

/** Write an attestation-<uuid>.json file; returns { buildId, abs }. */
function writeAttestationFile(
  w: World,
  buildId = randomUUID(),
): { buildId: string; abs: string } {
  const name = `attestation-${buildId}.json`;
  const abs = join(w.sbomDir, name);
  writeFileSync(
    abs,
    JSON.stringify({
      _type: 'https://in-toto.io/Statement/v1',
      devOnly: true,
      subject: [{ name: 'build-digest', digest: { sha256: 'd'.repeat(64) } }],
    }),
  );
  return { buildId, abs };
}

/** Record a build and mark it SUCCEEDED with the given attestationRef/completedAt. */
function seedBuild(
  w: World,
  opts: { attestationAbs: string | null; completedAt?: string },
): string {
  const rec = w.fdb.builds.record({
    revision: REV,
    repo: '/r',
    prId: 'pr-1',
    sourceBranch: 'feat',
    targetBranch: 'main',
    builtBy: 'human',
  });
  w.fdb.builds.markSucceeded(rec.id, {
    digest: 'd'.repeat(64),
    digestNote: '',
    definition: '{}',
    definitionNote: '',
    sbomRef: null,
    sbomNote: 'no lockfile',
    attestationRef: opts.attestationAbs,
    exitCode: 0,
    completedAt: opts.completedAt,
  });
  return rec.id;
}

function makeCall(w: World) {
  return async (
    handler: 'retention' | 'builds',
    method: string,
    path: string,
    body: Record<string, unknown> = {},
  ): Promise<{ status: number; body: any }> => {
    const calls: Array<{ status: number; body: unknown }> = [];
    const ctx = {
      fdb: w.fdb,
      audit: {
        record: (actor: string, action: string, kind: string, id: string, details: unknown) => {
          w.audits.push({ action, details });
        },
      },
      // Deliberately naive accessor (no filename filtering): the
      // route's own ATTESTATION_FILE_RE guard must do the protecting.
      sbomAccess: {
        dir: () => w.sbomDir,
        list: () => {
          try {
            return readdirSync(w.sbomDir);
          } catch {
            return [];
          }
        },
      },
      json: (_res: unknown, status: number, b: unknown) => {
        calls.push({ status, body: b });
      },
      readBody: async () => body,
    } as unknown as RouteContext;
    const handled =
      handler === 'retention'
        ? await handleRetentionRoutes(
            { method } as never,
            {} as never,
            new URL(`http://localhost${path}`),
            ctx,
          )
        : await handleBuildsRoutes(
            { method } as never,
            {} as never,
            new URL(`http://localhost${path}`),
            ctx,
          );
    assert.equal(handled, true, `${method} ${path} not handled`);
    assert.equal(calls.length, 1);
    return calls[0] as { status: number; body: any };
  };
}

function attestationCategory(body: any) {
  return (body.categories as any[]).find((c) => c.category === 'attestations');
}

describe('attestation retention', () => {
  let w: World;
  let call: ReturnType<typeof makeCall>;
  beforeEach(() => {
    w = makeWorld();
    call = makeCall(w);
  });
  afterEach(() => closeWorld(w));

  it('no policy: evaluate is keep-forever, enforce deletes nothing, confirm is mandatory', async () => {
    const { abs } = writeAttestationFile(w);
    seedBuild(w, { attestationAbs: abs, completedAt: OLD_ISO });

    const ev = await call('retention', 'POST', '/api/retention/evaluate');
    assert.equal(ev.status, 200);
    assert.equal(attestationCategory(ev.body).candidates, 0);

    const noConfirm = await call('retention', 'POST', '/api/retention/enforce', {});
    assert.equal(noConfirm.status, 400);
    const en = await call('retention', 'POST', '/api/retention/enforce', CONFIRM);
    assert.equal(en.status, 200);
    assert.equal(en.body.deleted['attestations'], 0);
    assert.ok(existsSync(abs), 'file untouched without a policy');
  });

  it('PUT validation: keepCount/deleteOrphans scoping covers attestations', async () => {
    const badCount = await call('retention', 'PUT', '/api/retention/policies', {
      policies: { runtime_runs: { days: 7, keepCount: 5 } },
    });
    assert.equal(badCount.status, 400);

    const badOrphan = await call('retention', 'PUT', '/api/retention/policies', {
      policies: { backups: { days: 7, deleteOrphans: true } },
    });
    assert.equal(badOrphan.status, 400);

    const badOrphanType = await call('retention', 'PUT', '/api/retention/policies', {
      policies: { attestations: { days: 7, deleteOrphans: 'yes' } },
    });
    assert.equal(badOrphanType.status, 400);

    const ok = await call('retention', 'PUT', '/api/retention/policies', {
      policies: { attestations: { days: 30, keepCount: 100, deleteOrphans: true } },
    });
    assert.equal(ok.status, 200);
    const stored = (ok.body.policies as any[]).find((p) => p.category === 'attestations');
    assert.equal(stored.keepCount, 100);
    assert.equal(stored.deleteOrphans, true);
  });

  it('count axis: oldest swept + audited, record ref untouched, read path honest', async () => {
    const times = [
      '2020-01-01T00:00:00.000Z',
      '2021-01-01T00:00:00.000Z',
      '2022-01-01T00:00:00.000Z',
    ];
    const files: string[] = [];
    const ids: string[] = [];
    for (const t of times) {
      const { abs } = writeAttestationFile(w);
      ids.push(seedBuild(w, { attestationAbs: abs, completedAt: t }));
      files.push(abs);
    }
    // days: null would be keep-forever — keepCount alone still sweeps.
    await call('retention', 'PUT', '/api/retention/policies', {
      policies: { attestations: { days: null, keepCount: 2 } },
    });
    const ev = await call('retention', 'POST', '/api/retention/evaluate');
    assert.equal(attestationCategory(ev.body).candidates, 1);

    const en = await call('retention', 'POST', '/api/retention/enforce', CONFIRM);
    assert.equal(en.body.deleted['attestations'], 1);
    assert.ok(!existsSync(files[0]), 'oldest attestation swept');
    assert.ok(existsSync(files[1]) && existsSync(files[2]), 'newest two kept');
    assert.ok(
      w.audits.some((a) => a.action === 'RETENTION_ENFORCED'),
      'enforcement audited',
    );

    // The builds row is insert-only history: attestationRef dangles by design.
    const row = w.fdb.builds.listByPr('pr-1').find((r) => r.attestationRef === files[0]);
    assert.ok(row, 'builds row still exists');
    assert.equal(
      row?.attestationRef,
      files[0],
      'attestationRef not rewritten — dangling is the documented state',
    );

    // Read path: ref semantics unchanged (same absolute path), and the
    // surface honestly reports the file as missing instead of
    // fabricating presence.
    const gone = await call('builds', 'GET', `/api/builds/${ids[0]}`);
    assert.equal(gone.status, 200);
    assert.equal(gone.body['build']['attestationRef'], files[0]);
    assert.equal(gone.body['build']['attestationFile'], 'missing');

    // A surviving file reports present.
    const kept = await call('builds', 'GET', `/api/builds/${ids[2]}`);
    assert.equal(kept.status, 200);
    assert.equal(kept.body['build']['attestationRef'], files[2]);
    assert.equal(kept.body['build']['attestationFile'], 'present');

    // The list endpoint reports the same honest signal (single/list agree).
    const list = await call('builds', 'GET', '/api/builds?limit=200');
    assert.equal(list.status, 200);
    const byId = new Map((list.body['items'] as any[]).map((b) => [b.id, b]));
    assert.equal(byId.get(ids[0])['attestationFile'], 'missing');
    assert.equal(byId.get(ids[2])['attestationFile'], 'present');

    // A build that never had an attestation carries no invented field.
    const noAttId = seedBuild(w, { attestationAbs: null });
    const noAtt = await call('builds', 'GET', `/api/builds/${noAttId}`);
    assert.equal(noAtt.body['build']['attestationRef'], null);
    assert.ok(!('attestationFile' in noAtt.body['build']), 'absence stays absent');
  });

  it('days axis: only expired referenced attestations are candidates', async () => {
    const old = writeAttestationFile(w);
    seedBuild(w, { attestationAbs: old.abs, completedAt: OLD_ISO });
    const fresh = writeAttestationFile(w);
    seedBuild(w, { attestationAbs: fresh.abs });

    await call('retention', 'PUT', '/api/retention/policies', {
      policies: { attestations: { days: 30 } },
    });
    const ev = await call('retention', 'POST', '/api/retention/evaluate');
    const cat = attestationCategory(ev.body);
    assert.equal(cat.candidates, 1);
    assert.deepEqual(cat.sampleIds, [`attestation-${old.buildId}.json`]);
    assert.ok(existsSync(old.abs) && existsSync(fresh.abs), 'dry run deletes nothing');

    const en = await call('retention', 'POST', '/api/retention/enforce', CONFIRM);
    assert.equal(en.body.deleted['attestations'], 1);
    assert.ok(!existsSync(old.abs), 'expired file deleted');
    assert.ok(existsSync(fresh.abs), 'fresh file kept');
  });

  it('orphans are kept by default and reported, swept only with deleteOrphans', async () => {
    const orphan = writeAttestationFile(w); // no builds record references it
    const ref = writeAttestationFile(w);
    seedBuild(w, { attestationAbs: ref.abs }); // recent

    await call('retention', 'PUT', '/api/retention/policies', {
      policies: { attestations: { days: 30, deleteOrphans: false } },
    });
    const ev = await call('retention', 'POST', '/api/retention/evaluate');
    const cat = attestationCategory(ev.body);
    assert.equal(cat.candidates, 0);
    assert.equal(cat.orphanFiles, 1, 'orphan accumulation is visible, not silent');
    const en = await call('retention', 'POST', '/api/retention/enforce', CONFIRM);
    assert.equal(en.body.deleted['attestations'], 0);
    assert.ok(existsSync(orphan.abs), 'orphan kept: unknown references block cleanup');

    await call('retention', 'PUT', '/api/retention/policies', {
      policies: { attestations: { days: 30, deleteOrphans: true } },
    });
    const ev2 = await call('retention', 'POST', '/api/retention/evaluate');
    assert.equal(attestationCategory(ev2.body).candidates, 1);
    const en2 = await call('retention', 'POST', '/api/retention/enforce', CONFIRM);
    assert.equal(en2.body.deleted['attestations'], 1);
    assert.ok(!existsSync(orphan.abs), 'opted-in orphan swept');
    assert.ok(existsSync(ref.abs), 'referenced file never treated as orphan');
  });

  it('wrong-shaped files and SBOM files are never touched by the attestations category', async () => {
    const notes = join(w.sbomDir, 'notes.txt');
    writeFileSync(notes, 'do not delete');
    const evil = join(w.sbomDir, 'attestation-evil.json');
    writeFileSync(evil, '{}');
    const sbom = join(w.sbomDir, `sbom-${randomUUID()}.json`);
    writeFileSync(sbom, '{}');

    await call('retention', 'PUT', '/api/retention/policies', {
      policies: { attestations: { days: 1, deleteOrphans: true } },
    });
    const en = await call('retention', 'POST', '/api/retention/enforce', CONFIRM);
    assert.equal(en.status, 200);
    assert.equal(en.body.deleted['attestations'], 0);
    assert.ok(existsSync(notes), 'non-matching file kept');
    assert.ok(existsSync(evil), 'wrong-shaped attestation name kept');
    assert.ok(existsSync(sbom), 'sbom file untouched by the attestations category');
  });

  it('any active legal hold exempts every attestation deletion', async () => {
    const { abs } = writeAttestationFile(w);
    seedBuild(w, { attestationAbs: abs, completedAt: OLD_ISO });
    const orphan = writeAttestationFile(w);

    const hold = await call('retention', 'POST', '/api/retention/holds', {
      scope: 'GLOBAL',
      reason: 'test hold',
    });
    assert.equal(hold.status, 201);

    await call('retention', 'PUT', '/api/retention/policies', {
      policies: { attestations: { days: 30, deleteOrphans: true } },
    });
    const ev = await call('retention', 'POST', '/api/retention/evaluate');
    const cat = attestationCategory(ev.body);
    assert.equal(cat.candidates, 0);
    assert.equal(cat.heldExempt, 1, 'expired referenced file exempt under hold');
    assert.equal(cat.orphanFiles, 1, 'orphan reported, not swept, under hold');

    const en = await call('retention', 'POST', '/api/retention/enforce', CONFIRM);
    assert.equal(en.body.deleted['attestations'], 0);
    assert.ok(existsSync(abs) && existsSync(orphan.abs), 'hold exempts everything');
  });
});

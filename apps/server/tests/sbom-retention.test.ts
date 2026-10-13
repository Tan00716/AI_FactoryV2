/**
 * SBOM retention — SPEC v2 §47 (Batch 26).
 *
 * What this pins:
 *  1. No policy = keep forever: evaluate reports zero candidates for
 *     sboms and enforce deletes nothing; enforce without the exact
 *     confirm text is a 400.
 *  2. PUT validation: keepCount is accepted for 'sboms' (and
 *     'backups') but 400 for DB categories; deleteOrphans must be a
 *     boolean and is 400 for any category but 'sboms'.
 *  3. Days axis: only referenced SBOMs older than the policy are
 *     candidates; newer ones are untouched.
 *  4. Count axis: keepCount keeps the newest N by record age
 *     regardless of the days axis.
 *  5. Orphans (sbom-*.json files no builds record references) are
 *     KEPT by default (reported via orphanFiles) and swept only when
 *     the policy opts in with deleteOrphans: true. A referenced file
 *     is never treated as an orphan — the association is verified
 *     from the live builds table before anything is a candidate.
 *  6. Files that do not match the sbom-<uuid>.json shape are never
 *     touched, even with orphan sweeping on (retention never deletes
 *     blind).
 *  7. ANY active legal hold exempts every SBOM deletion.
 *  8. evaluate is a pure dry run; enforce deletes exactly the
 *     evaluated files, writes RETENTION_ENFORCED, and leaves the
 *     builds rows alone (sbomRef may dangle by design — builds rows
 *     are insert-only history).
 *
 * The route module is imported from src (like retention.test.ts);
 * its value imports are node builtins and compiled packages only,
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
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FactoryDatabase } from '@ai-factory/db';
import { handleRetentionRoutes } from '../src/routes/retention.ts';
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
  const dir = mkdtempSync(join(tmpdir(), 'sbom-ret-'));
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

/** Write a sbom-<uuid>.json file; returns { buildId, abs }. */
function writeSbomFile(w: World, buildId = randomUUID()): { buildId: string; abs: string } {
  const name = `sbom-${buildId}.json`;
  const abs = join(w.sbomDir, name);
  writeFileSync(abs, JSON.stringify({ bomFormat: 'CycloneDX', components: [] }));
  return { buildId, abs };
}

/** Record a build and mark it SUCCEEDED with the given sbomRef/completedAt. */
function seedBuild(
  w: World,
  opts: { sbomAbs: string | null; completedAt?: string },
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
    sbomRef: opts.sbomAbs,
    sbomNote: opts.sbomAbs ? '' : 'no lockfile',
    exitCode: 0,
    completedAt: opts.completedAt,
  });
  return rec.id;
}

function makeCall(w: World) {
  return async (
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
      // route's own SBOM_FILE_RE guard must do the protecting.
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
    const handled = await handleRetentionRoutes(
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

function sbomCategory(body: any) {
  return (body.categories as any[]).find((c) => c.category === 'sboms');
}

describe('sbom retention', () => {
  let w: World;
  let call: ReturnType<typeof makeCall>;
  beforeEach(() => {
    w = makeWorld();
    call = makeCall(w);
  });
  afterEach(() => closeWorld(w));

  it('no policy: evaluate is keep-forever, enforce deletes nothing, confirm is mandatory', async () => {
    const { abs } = writeSbomFile(w);
    seedBuild(w, { sbomAbs: abs, completedAt: OLD_ISO });

    const ev = await call('POST', '/api/retention/evaluate');
    assert.equal(ev.status, 200);
    assert.equal(sbomCategory(ev.body).candidates, 0);

    const noConfirm = await call('POST', '/api/retention/enforce', {});
    assert.equal(noConfirm.status, 400);
    const en = await call('POST', '/api/retention/enforce', CONFIRM);
    assert.equal(en.status, 200);
    assert.equal(en.body.deleted['sboms'], 0);
    assert.ok(existsSync(abs), 'file untouched without a policy');
  });

  it('PUT validation: keepCount/deleteOrphans scoping', async () => {
    const badCount = await call('PUT', '/api/retention/policies', {
      policies: { runtime_runs: { days: 7, keepCount: 5 } },
    });
    assert.equal(badCount.status, 400);

    const badOrphan = await call('PUT', '/api/retention/policies', {
      policies: { backups: { days: 7, deleteOrphans: true } },
    });
    assert.equal(badOrphan.status, 400);

    const badOrphanType = await call('PUT', '/api/retention/policies', {
      policies: { sboms: { days: 7, deleteOrphans: 'yes' } },
    });
    assert.equal(badOrphanType.status, 400);

    const ok = await call('PUT', '/api/retention/policies', {
      policies: { sboms: { days: 30, keepCount: 100, deleteOrphans: true } },
    });
    assert.equal(ok.status, 200);
    const stored = (ok.body.policies as any[]).find((p) => p.category === 'sboms');
    assert.equal(stored.keepCount, 100);
    assert.equal(stored.deleteOrphans, true);
  });

  it('days axis: only expired referenced SBOMs are candidates; rows are never rewritten', async () => {
    const old = writeSbomFile(w);
    seedBuild(w, { sbomAbs: old.abs, completedAt: OLD_ISO });
    const fresh = writeSbomFile(w);
    const freshId = seedBuild(w, { sbomAbs: fresh.abs });

    await call('PUT', '/api/retention/policies', { policies: { sboms: { days: 30 } } });
    const ev = await call('POST', '/api/retention/evaluate');
    const cat = sbomCategory(ev.body);
    assert.equal(cat.candidates, 1);
    assert.deepEqual(cat.sampleIds, [`sbom-${old.buildId}.json`]);
    // Dry run: nothing deleted yet.
    assert.ok(existsSync(old.abs) && existsSync(fresh.abs));

    const en = await call('POST', '/api/retention/enforce', CONFIRM);
    assert.equal(en.status, 200);
    assert.equal(en.body.deleted['sboms'], 1);
    assert.ok(!existsSync(old.abs), 'expired file deleted');
    assert.ok(existsSync(fresh.abs), 'fresh file kept');

    // The builds row is insert-only history: sbomRef dangles by design.
    const row = w.fdb.builds.listByPr('pr-1').find((r) => r.sbomRef === old.abs);
    assert.ok(row, 'builds row still exists');
    assert.equal(row?.sbomRef, old.abs, 'sbomRef not rewritten — dangling is the documented state');
    assert.ok(
      w.audits.some((a) => a.action === 'RETENTION_ENFORCED'),
      'enforcement audited',
    );
    // The fresh record is intact.
    assert.equal(w.fdb.builds.get(freshId)?.sbomRef, fresh.abs);
  });

  it('count axis: keepCount keeps the newest N by record age regardless of days', async () => {
    const ids: string[] = [];
    const times = [
      '2020-01-01T00:00:00.000Z',
      '2021-01-01T00:00:00.000Z',
      '2022-01-01T00:00:00.000Z',
    ];
    const files: string[] = [];
    for (const t of times) {
      const { abs } = writeSbomFile(w);
      seedBuild(w, { sbomAbs: abs, completedAt: t });
      files.push(abs);
      ids.push(abs);
    }
    // days: null would be keep-forever — keepCount alone still sweeps.
    await call('PUT', '/api/retention/policies', {
      policies: { sboms: { days: null, keepCount: 2 } },
    });
    const ev = await call('POST', '/api/retention/evaluate');
    assert.equal(sbomCategory(ev.body).candidates, 1);

    const en = await call('POST', '/api/retention/enforce', CONFIRM);
    assert.equal(en.body.deleted['sboms'], 1);
    assert.ok(!existsSync(files[0]), 'oldest swept despite no days axis');
    assert.ok(existsSync(files[1]) && existsSync(files[2]), 'newest two kept');
    assert.ok(ids.length === 3);
  });

  it('orphans are kept by default and reported, swept only with deleteOrphans', async () => {
    const orphan = writeSbomFile(w); // no builds record references it
    const ref = writeSbomFile(w);
    seedBuild(w, { sbomAbs: ref.abs }); // recent

    await call('PUT', '/api/retention/policies', {
      policies: { sboms: { days: 30, deleteOrphans: false } },
    });
    const ev = await call('POST', '/api/retention/evaluate');
    const cat = sbomCategory(ev.body);
    assert.equal(cat.candidates, 0);
    assert.equal(cat.orphanFiles, 1, 'orphan accumulation is visible, not silent');
    const en = await call('POST', '/api/retention/enforce', CONFIRM);
    assert.equal(en.body.deleted['sboms'], 0);
    assert.ok(existsSync(orphan.abs), 'orphan kept: unknown references block cleanup');

    await call('PUT', '/api/retention/policies', {
      policies: { sboms: { days: 30, deleteOrphans: true } },
    });
    const ev2 = await call('POST', '/api/retention/evaluate');
    assert.equal(sbomCategory(ev2.body).candidates, 1);
    const en2 = await call('POST', '/api/retention/enforce', CONFIRM);
    assert.equal(en2.body.deleted['sboms'], 1);
    assert.ok(!existsSync(orphan.abs), 'opted-in orphan swept');
    assert.ok(existsSync(ref.abs), 'referenced file never treated as orphan');
  });

  it('non-sbom-shaped files are never touched, even with orphan sweeping on', async () => {
    const notes = join(w.sbomDir, 'notes.txt');
    writeFileSync(notes, 'do not delete');
    const evil = join(w.sbomDir, 'sbom-evil.json');
    writeFileSync(evil, '{}');
    const subdir = join(w.sbomDir, 'sbom-subdir');
    mkdirSync(subdir);

    await call('PUT', '/api/retention/policies', {
      policies: { sboms: { days: 1, deleteOrphans: true } },
    });
    const en = await call('POST', '/api/retention/enforce', CONFIRM);
    assert.equal(en.status, 200);
    assert.equal(en.body.deleted['sboms'], 0);
    assert.ok(existsSync(notes), 'non-matching file kept');
    assert.ok(existsSync(evil), 'wrong-shaped sbom name kept');
    assert.ok(statSync(subdir).isDirectory(), 'subdirectory kept');
  });

  it('any active legal hold exempts every sbom deletion', async () => {
    const { abs } = writeSbomFile(w);
    seedBuild(w, { sbomAbs: abs, completedAt: OLD_ISO });
    const orphan = writeSbomFile(w);

    const hold = await call('POST', '/api/retention/holds', {
      scope: 'GLOBAL',
      reason: 'test hold',
    });
    assert.equal(hold.status, 201);

    await call('PUT', '/api/retention/policies', {
      policies: { sboms: { days: 30, deleteOrphans: true } },
    });
    const ev = await call('POST', '/api/retention/evaluate');
    const cat = sbomCategory(ev.body);
    assert.equal(cat.candidates, 0);
    assert.ok(cat.heldExempt >= 1, 'expired + orphan both held-exempt');
    const en = await call('POST', '/api/retention/enforce', CONFIRM);
    assert.equal(en.body.deleted['sboms'], 0);
    assert.ok(existsSync(abs) && existsSync(orphan.abs), 'hold exempts everything');

    // Releasing the hold makes them eligible again.
    const rel = await call('POST', `/api/retention/holds/${hold.body.hold.id}/release`, {});
    assert.equal(rel.status, 200);
    const ev2 = await call('POST', '/api/retention/evaluate');
    assert.equal(sbomCategory(ev2.body).candidates, 2);
  });

  it('referenced-file safety: association is verified from the live builds table', async () => {
    // A file whose name looks right but whose buildId is unknown must
    // not be deleted as "referenced-expired" — only as an orphan with
    // the explicit opt-in, and never when a record points at it.
    const { abs } = writeSbomFile(w);
    const id = seedBuild(w, { sbomAbs: abs, completedAt: OLD_ISO });
    // Sanity: the association resolves through the record.
    const rec = w.fdb.builds.get(id);
    assert.equal(resolve(rec?.sbomRef ?? ''), resolve(abs));

    await call('PUT', '/api/retention/policies', {
      policies: { sboms: { days: 30, deleteOrphans: true } },
    });
    const ev = await call('POST', '/api/retention/evaluate');
    // Exactly one candidate: the expired REFERENCED file (not an orphan).
    assert.equal(sbomCategory(ev.body).candidates, 1);
    assert.equal(sbomCategory(ev.body).orphanFiles, undefined);
    const content = readFileSync(abs, 'utf8');
    assert.ok(content.includes('CycloneDX'));
  });
});

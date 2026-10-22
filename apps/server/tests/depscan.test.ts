/**
 * Dependency-advisor route tests (round-4 task R4-B10) — imports
 * ../src/routes/depscan.ts straight from src under node's type-stripping
 * ESM loader. The route value-imports only node builtins +
 * @ai-factory/depscan, so it resolves (dual-mode import rule in AGENTS.md);
 * everything else crosses via setter injection, faked here.
 *
 * Covers: snapshot advise with grading (patch/minor/major/unknown),
 * CVE cross-reference injection, wanted-vs-latest, missing projectId,
 * bad dir jail, missing package.json, bad JSON, live-disabled (501),
 * egress-blocked live (403), snapshot metadata endpoint.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/depscan.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handleDepscanRoutes,
  setDepscanInspectionRootResolver,
  setDepscanCveMatcher,
  setDepscanRegistryProvider,
  setDepscanLiveRegistryGate,
} from '../src/routes/depscan.ts';
import { bundledSnapshotProvider } from '@ai-factory/depscan';

interface Captured {
  status: number;
  body: any;
}

function makeCtx(body: unknown) {
  const captured: Captured = { status: 0, body: null };
  const audits: any[] = [];
  const res = {};
  const ctx: any = {
    json(_res: unknown, status: number, b: unknown) {
      captured.status = status;
      captured.body = b;
    },
    async readBody() {
      return body;
    },
    audit: {
      record(actor: string, event: string, area: string, target: string, details: unknown) {
        audits.push({ actor, event, area, target, details });
      },
    },
  };
  return { ctx, res, captured, audits };
}

function fixtureProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'depscan-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      dependencies: {
        'tiny-patch': '^1.0.0',
        'mid-minor': '~1.2.0',
        'big-major': '^2.0.0',
        'fresh': '^5.0.0',
        'ghost-pkg': '^0.1.0',
      },
      devDependencies: { 'dev-tool': '^3.0.0' },
    }),
  );
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({
      name: 'fixture',
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { 'tiny-patch': '^1.0.0' } },
        'node_modules/tiny-patch': { version: '1.0.0' },
        'node_modules/mid-minor': { version: '1.2.0' },
        'node_modules/big-major': { version: '2.0.0' },
        'node_modules/fresh': { version: '5.0.0' },
        'node_modules/ghost-pkg': { version: '0.1.0' },
        'node_modules/dev-tool': { version: '3.0.0' },
      },
    }),
  );
  return dir;
}

function fixtureRegistry() {
  const m = new Map();
  m.set('tiny-patch', { name: 'tiny-patch', versions: ['1.0.0', '1.0.5'], latest: '1.0.5', changelogUrl: 'https://example.test/tp' });
  m.set('mid-minor', { name: 'mid-minor', versions: ['1.2.0', '1.4.2'], latest: '1.4.2' });
  m.set('big-major', { name: 'big-major', versions: ['2.0.0', '3.1.0'], latest: '3.1.0' });
  m.set('fresh', { name: 'fresh', versions: ['5.0.0'], latest: '5.0.0' });
  m.set('dev-tool', { name: 'dev-tool', versions: ['3.0.0', '3.0.9'], latest: '3.0.9' });
  return {
    source: 'test-fixture',
    snapshotDate: '2026-10-22',
    packageCount: m.size,
    fetch: async (names: string[]) => {
      const out = new Map();
      for (const n of names) if (m.has(n)) out.set(n, m.get(n));
      return out;
    },
  };
}

function wireAll(dir: string) {
  setDepscanInspectionRootResolver(() => dir);
  setDepscanCveMatcher((name, version) =>
    name === 'big-major' && version === '2.0.0'
      ? [{ id: 'CVE-2099-0001', severity: 'error', note: 'fixture' }]
      : [],
  );
  setDepscanRegistryProvider(fixtureRegistry() as any);
  setDepscanLiveRegistryGate(null);
}

function unwireAll() {
  setDepscanInspectionRootResolver(null);
  setDepscanCveMatcher(null);
  setDepscanRegistryProvider(null);
  setDepscanLiveRegistryGate(null);
}

async function postAdvise(body: unknown) {
  const { ctx, res, captured, audits } = makeCtx(body);
  const req: any = { method: 'POST' };
  const url = new URL('http://x/api/depscan/advise');
  const handled = await handleDepscanRoutes(req, res, url, ctx);
  return { handled, captured, audits };
}

test('advise grades patch/minor/major/up-to-date/unknown + CVE cross-ref', async () => {
  const dir = fixtureProject();
  wireAll(dir);
  try {
    const { handled, captured, audits } = await postAdvise({ projectId: 'p1' });
    assert.equal(handled, true);
    assert.equal(captured.status, 200);
    const plan = captured.body.plan;
    const byName = new Map(plan.advisories.map((a: any) => [a.name, a]));
    assert.equal(byName.get('tiny-patch').grade, 'patch');
    assert.equal(byName.get('tiny-patch').changelogUrl, 'https://example.test/tp');
    assert.equal(byName.get('mid-minor').grade, 'minor');
    assert.equal(byName.get('mid-minor').wanted, '1.2.0');
    assert.equal(byName.get('big-major').grade, 'major');
    assert.equal(byName.get('big-major').reviewFirst, true);
    assert.equal(byName.get('big-major').cves[0].id, 'CVE-2099-0001');
    assert.equal(byName.get('fresh').grade, 'up-to-date');
    assert.equal(byName.get('ghost-pkg').grade, 'unknown');
    assert.equal(byName.get('dev-tool').dev, true);
    assert.deepEqual(plan.summary, {
      total: 6, upToDate: 1, patch: 2, minor: 1, major: 1, unknown: 1, cveAffected: 1,
    });
    assert.ok(plan.commands.length > 0);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].event, 'DEPSCAN_ADVISED');
  } finally {
    unwireAll();
  }
});

test('missing projectId → 400', async () => {
  const dir = fixtureProject();
  wireAll(dir);
  try {
    const { captured } = await postAdvise({});
    assert.equal(captured.status, 400);
    assert.equal(captured.body.code, 'DEPSCAN_NO_PROJECT');
  } finally {
    unwireAll();
  }
});

test('jail refusal from the resolver → 400', async () => {
  setDepscanInspectionRootResolver(() => {
    throw new Error('path escapes inspection root');
  });
  setDepscanRegistryProvider(fixtureRegistry() as any);
  try {
    const { captured } = await postAdvise({ projectId: 'p1', dir: '../../etc' });
    assert.equal(captured.status, 400);
    assert.equal(captured.body.code, 'DEPSCAN_BAD_DIR');
  } finally {
    unwireAll();
  }
});

test('missing package.json → 404; bad JSON → 400', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'depscan-empty-'));
  wireAll(empty);
  try {
    const r1 = await postAdvise({ projectId: 'p1' });
    assert.equal(r1.captured.status, 404);
    assert.equal(r1.captured.body.code, 'DEPSCAN_NO_MANIFEST');
    writeFileSync(join(empty, 'package.json'), '{not json');
    const r2 = await postAdvise({ projectId: 'p1' });
    assert.equal(r2.captured.status, 400);
    assert.equal(r2.captured.body.code, 'DEPSCAN_BAD_JSON');
  } finally {
    unwireAll();
  }
});

test('live source without a wired gate → 501', async () => {
  const dir = fixtureProject();
  wireAll(dir); // live gate left null
  setDepscanRegistryProvider(null); // no override: exercise the live branch
  try {
    const { captured } = await postAdvise({ projectId: 'p1', source: 'live' });
    assert.equal(captured.status, 501);
    assert.equal(captured.body.code, 'DEPSCAN_LIVE_DISABLED');
  } finally {
    unwireAll();
  }
});

test('live source with a denying gate → 403', async () => {
  const dir = fixtureProject();
  wireAll(dir);
  setDepscanRegistryProvider(null); // no override: exercise the live branch
  setDepscanLiveRegistryGate(() => {
    const e = new Error("egress blocked: registry.npmjs.org not in allowlist") as Error & { code: string };
    e.code = 'EGRESS_BLOCKED';
    throw e;
  });
  try {
    const { captured } = await postAdvise({ projectId: 'p1', source: 'live' });
    assert.equal(captured.status, 403);
    assert.equal(captured.body.code, 'DEPSCAN_EGRESS_BLOCKED');
  } finally {
    unwireAll();
  }
});

test('snapshot endpoint discloses source honestly', async () => {
  const dir = fixtureProject();
  wireAll(dir);
  try {
    const { ctx, res, captured } = makeCtx({});
    const handled = await handleDepscanRoutes(
      { method: 'GET' } as any,
      res,
      new URL('http://x/api/depscan/snapshot'),
      ctx,
    );
    assert.equal(handled, true);
    assert.equal(captured.status, 200);
    assert.equal(captured.body.snapshotDate, '2026-10-22');
    assert.ok(captured.body.honestBoundary);
  } finally {
    unwireAll();
  }
});

test('real bundled snapshot loads offline and covers the CVE set', async () => {
  const provider = bundledSnapshotProvider();
  assert.ok(provider.snapshotDate);
  const metas = await provider.fetch(['lodash', 'axios', 'qs', 'no-such-pkg-xyz']);
  assert.ok(metas.get('lodash'));
  assert.equal(metas.get('lodash')!.latest, '4.17.21');
  assert.ok(metas.get('axios')!.changelogUrl);
  assert.equal(metas.has('no-such-pkg-xyz'), false);
  assert.ok((provider.packageCount ?? 0) >= 15);
});

test('non-depscan paths are not handled', async () => {
  const { ctx, res, captured } = makeCtx({});
  const handled = await handleDepscanRoutes(
    { method: 'GET' } as any,
    res,
    new URL('http://x/api/mutation/latest'),
    ctx,
  );
  assert.equal(handled, false);
  assert.equal(captured.status, 0);
});

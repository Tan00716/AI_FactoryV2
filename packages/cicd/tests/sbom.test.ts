/**
 * SBOM generation — SPEC v2 §40 (Batch 25).
 *
 * What this pins:
 *  - each supported lockfile format parses to real name@version
 *    components (fixtures are real-format lockfiles);
 *  - duplicates collapse, output is deterministically sorted;
 *  - malformed/unsupported lockfiles are skipped with named reasons,
 *    never a crash and never silent;
 *  - no lockfile → document null + note naming the gap;
 *  - the document says what it is: declared/resolved dependencies,
 *    not an installed-tree scan (provenance property).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSbom } from '../src/sbom';

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'sbom-'));
}

const REV = 'a'.repeat(40);

const PACKAGE_LOCK_V3 = JSON.stringify({
  name: 'demo',
  lockfileVersion: 3,
  packages: {
    '': { name: 'demo', version: '1.0.0' },
    'node_modules/left-pad': { version: '1.3.0' },
    'node_modules/@scope/right-pad': { version: '2.0.1' },
    'node_modules/left-pad/node_modules/nested': { version: '0.0.1' },
  },
});

const PACKAGE_LOCK_V1 = JSON.stringify({
  name: 'demo',
  lockfileVersion: 1,
  dependencies: {
    'left-pad': { version: '1.3.0' },
    'no-version': {},
  },
});

const YARN_LOCK = `"left-pad@^1.3.0":
  version "1.3.0"
  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz#6dc2487d1c76d5a1f7d2a2e0c5f7b8d8b2a3b8c"

"@scope/right-pad@^2.0.0":
  version "2.0.1"
`;

const PNPM_LOCK = `lockfileVersion: '9.0'
packages:
  left-pad@1.3.0:
    resolution: {integrity: sha512-xyz}
  /@scope/right-pad@2.0.1:
    resolution: {integrity: sha512-abc}

snapshots:
  left-pad@1.3.0: {}
`;

const CARGO_LOCK = `[[package]]
name = "serde"
version = "1.0.200"

[[package]]
name = "serde"
version = "1.0.200"

[[package]]
name = "tokio"
version = "1.41.0"
`;

describe('sbom generation', () => {
  it('parses package-lock.json v3 (packages map, scoped + nested)', () => {
    const d = dir();
    try {
      writeFileSync(join(d, 'package-lock.json'), PACKAGE_LOCK_V3);
      const r = generateSbom(d, REV, { now: () => '2026-10-13T00:00:00.000Z' });
      assert.ok(r.document, 'document generated');
      assert.equal(r.note, '');
      const names = r.document.components.map((c) => `${c.name}@${c.version}`);
      assert.ok(names.includes('left-pad@1.3.0'));
      assert.ok(names.includes('@scope/right-pad@2.0.1'));
      assert.ok(names.includes('nested@0.0.1'), 'nested node_modules resolved to the real package');
      assert.equal(r.document.bomFormat, 'CycloneDX');
      assert.equal(r.document.specVersion, '1.5');
      assert.equal(r.document.metadata.component['bom-ref'], `build:${REV}`);
      // Deterministic order.
      const refs = r.document.components.map((c) => c['bom-ref']);
      assert.deepEqual(refs, [...refs].sort());
      // Provenance says what this is — and what it is not.
      const prov = r.document.metadata.properties.find(
        (p) => p.name === 'ai-factory:sbom:provenance',
      );
      assert.ok(prov && prov.value.includes('not a scan of installed files'));
      assert.equal(r.sources.length, 1);
      assert.equal(r.sources[0].ecosystem, 'npm');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('parses package-lock.json v1 (dependencies map), skips version-less entries', () => {
    const d = dir();
    try {
      writeFileSync(join(d, 'package-lock.json'), PACKAGE_LOCK_V1);
      const r = generateSbom(d, REV);
      assert.ok(r.document);
      const names = r.document.components.map((c) => c.name);
      assert.ok(names.includes('left-pad'));
      assert.ok(!names.includes('no-version'), 'entries without a version are not invented');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('parses yarn classic, pnpm and cargo lockfiles', () => {
    const d = dir();
    try {
      writeFileSync(join(d, 'yarn.lock'), YARN_LOCK);
      const ry = generateSbom(d, REV);
      assert.ok(ry.document);
      assert.ok(ry.document.components.some((c) => c.name === 'left-pad' && c.version === '1.3.0'));
      assert.ok(ry.document.components.some((c) => c.name === '@scope/right-pad'));

      rmSync(join(d, 'yarn.lock'));
      writeFileSync(join(d, 'pnpm-lock.yaml'), PNPM_LOCK);
      const rp = generateSbom(d, REV);
      assert.ok(rp.document);
      assert.ok(rp.document.components.some((c) => c.name === 'left-pad'));

      rmSync(join(d, 'pnpm-lock.yaml'));
      writeFileSync(join(d, 'Cargo.lock'), CARGO_LOCK);
      const rc = generateSbom(d, REV);
      assert.ok(rc.document);
      const serde = rc.document.components.filter((c) => c.name === 'serde');
      assert.equal(serde.length, 1, 'duplicate name@version collapses');
      assert.equal(serde[0]['bom-ref'], 'pkg:cargo/serde@1.0.200');
      assert.ok(rc.document.components.some((c) => c.name === 'tokio'));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('skips malformed and unsupported lockfiles loudly, never crashes', () => {
    const d = dir();
    try {
      writeFileSync(join(d, 'package-lock.json'), '{ not json');
      writeFileSync(join(d, 'go.sum'), 'module example.com/demo\n');
      const r = generateSbom(d, REV);
      assert.equal(r.document, null, 'no parsable lockfile → no document');
      assert.equal(r.sources.length, 0);
      assert.equal(r.skipped.length, 2);
      assert.ok(r.skipped.some((s) => s.lockfile === 'package-lock.json' && s.reason.includes('unparseable')));
      assert.ok(r.skipped.some((s) => s.lockfile === 'go.sum' && s.reason.includes('unsupported')));
      assert.ok(r.note.length > 0, 'the gap is named, not silent');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('no lockfile → null document with a named reason', () => {
    const d = dir();
    try {
      const r = generateSbom(d, REV);
      assert.equal(r.document, null);
      assert.ok(r.note.includes('no lockfile'), `got: ${r.note}`);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('truncates beyond the cap and says so', () => {
    const d = dir();
    try {
      const pkgs: Record<string, { version: string }> = {};
      for (let i = 0; i < 10; i++) pkgs[`node_modules/dep-${i}`] = { version: '1.0.0' };
      writeFileSync(
        join(d, 'package-lock.json'),
        JSON.stringify({ lockfileVersion: 3, packages: pkgs }),
      );
      const r = generateSbom(d, REV, { maxComponents: 4 });
      assert.ok(r.document);
      assert.equal(r.document.components.length, 4);
      assert.equal(r.document.metadata.truncated, true);
      assert.ok(r.note.includes('truncated'), `got: ${r.note}`);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

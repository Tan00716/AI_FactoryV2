/**
 * Tests for untrusted import — SPEC v2 §52.3.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapIdConflicts,
  remapPermissionsToLocal,
  stageUntrustedImport,
  validateUntrustedPackage,
  type UntrustedPackage,
} from '../src/index';

function pkg(files: Record<string, string>, meta: UntrustedPackage['meta'] = { source: 'test' }): UntrustedPackage {
  return { files, meta };
}

describe('validateUntrustedPackage (§52.3)', () => {
  it('rejects path traversal', () => {
    const issues = validateUntrustedPackage(pkg({ '../../etc/passwd': 'x' }));
    assert.ok(issues.some((i) => i.message.includes('traversal')));
  });

  it('rejects absolute paths and windows drives', () => {
    const issues = validateUntrustedPackage(pkg({ '/etc/shadow': 'x', 'C:/Windows/a': 'y' }));
    assert.equal(issues.filter((i) => i.message.includes('traversal')).length, 2);
  });

  it('enforces zip-bomb guards', () => {
    const big = 'x'.repeat(6 * 1024 * 1024);
    const issues = validateUntrustedPackage(pkg({ '.ai/export/big.json': big }));
    assert.ok(issues.some((i) => i.message.includes('zip-bomb')));
  });

  it('rejects executables', () => {
    const issues = validateUntrustedPackage(pkg({ '.ai/skills/evil.exe': 'MZ...' }));
    assert.ok(issues.some((i) => i.message.includes('executable')));
  });

  it('verifies claimed hashes', () => {
    const issues = validateUntrustedPackage(
      pkg(
        { '.ai/project.json': '{"a":1}' },
        { source: 'test', fileHashes: { '.ai/project.json': '0'.repeat(64) } },
      ),
    );
    assert.ok(issues.some((i) => i.message.includes('tampered')));
  });

  it('rejects unimportable licenses', () => {
    const issues = validateUntrustedPackage(
      pkg({ '.ai/project.json': '{}' }, { source: 'test', declaredLicense: 'unknown' }),
    );
    assert.ok(issues.some((i) => i.message.includes('license')));
  });

  it('accepts a clean package', () => {
    const issues = validateUntrustedPackage(
      pkg({ '.ai/export/project.json': '{"id":"p1"}' }, { source: 'test', declaredLicense: 'MIT' }),
    );
    assert.deepEqual(issues, []);
  });
});

describe('stageUntrustedImport (§52.3)', () => {
  it('forces employee/mcp/skill into QUARANTINED, never ACTIVE', () => {
    const staged = stageUntrustedImport(
      pkg({
        '.ai/agents/coder.json': '{"id":"coder"}',
        '.ai/mcp/gh.json': '{"id":"gh"}',
        '.ai/skills/s1.json': '{"id":"s1"}',
        '.ai/workflows/w1.json': '{"id":"w1"}',
      }),
    );
    const byId = new Map(staged.staged.map((s) => [s.id, s]));
    assert.equal(byId.get('coder')!.status, 'QUARANTINED');
    assert.equal(byId.get('gh')!.status, 'QUARANTINED');
    assert.equal(byId.get('s1')!.status, 'QUARANTINED');
    assert.equal(byId.get('w1')!.status, 'DRAFT');
    assert.ok(!staged.staged.some((s) => s.status === ('ACTIVE' as never)));
    assert.ok(staged.warnings.length >= 3);
  });
});

describe('remapPermissionsToLocal (§52.3)', () => {
  it('never inherits Admin/Owner from the package', () => {
    const { grants, dropped } = remapPermissionsToLocal(
      [
        { principalId: 'mallory', role: 'admin' },
        { principalId: 'mallory2', role: 'Owner' },
        { principalId: 'dev', role: 'developer' },
        { principalId: 'v', role: 'viewer' },
      ],
      'local-authority',
    );
    assert.equal(dropped.length, 2);
    assert.ok(grants.every((g) => g.principalId !== 'mallory' && g.principalId !== 'mallory2'));
    assert.deepEqual(grants.find((g) => g.principalId === 'v')!.capabilities, ['read']);
  });
});

describe('mapIdConflicts (§52.3)', () => {
  it('remaps conflicts and records the mapping — never silent overwrite', () => {
    const staged = stageUntrustedImport(pkg({ '.ai/export/project.json': '{"id":"p1"}' }));
    const out = mapIdConflicts(staged, new Set(['p1']), (old) => `${old}-imported`);
    assert.equal(out.staged[0].id, 'p1-imported');
    assert.deepEqual(out.idMapping, { p1: 'p1-imported' });
  });

  it('leaves non-conflicting ids alone', () => {
    const staged = stageUntrustedImport(pkg({ '.ai/export/project.json': '{"id":"p9"}' }));
    const out = mapIdConflicts(staged, new Set(['p1']), (old) => `${old}-imported`);
    assert.equal(out.staged[0].id, 'p9');
    assert.deepEqual(out.idMapping, {});
  });
});

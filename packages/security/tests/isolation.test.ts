/**
 * Isolation backend tests — SPEC v2 §7.
 *
 * node:test + node:assert/strict. Deterministic clock injected.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ConfinementUnavailableError,
  IsolationBackend,
  LocalDevBackend,
  UnverifiedBackend,
  assertConfinementForAutonomousShell,
  createWorkspaceRecord,
  detectPathThreats,
  resolveConfinedPathSync,
  sandboxTierBackend,
} from '../src/index';

const FIXED_NOW = 1_700_000_000_000;
const now = () => FIXED_NOW;

/** A test-only backend that honestly passes (stands in for a qualified VM). */
class AttestedBackend implements IsolationBackend {
  readonly name = 'test-attested';
  readonly kind = 'vm' as const;
  verifyConfinement() {
    return {
      backend: this.name,
      kind: this.kind,
      verified: true,
      verified_at: new Date(now()).toISOString(),
      checks: [{ name: 'test', passed: true, detail: 'attested in test' }],
      limitations: [],
    };
  }
}

describe('fail-closed gate (§7.5)', () => {
  it('UnverifiedBackend refuses autonomous shell with CONFINEMENT_UNAVAILABLE', () => {
    const backend = new UnverifiedBackend(now);
    assert.throws(
      () => assertConfinementForAutonomousShell(backend),
      (err: unknown) => {
        assert.ok(err instanceof ConfinementUnavailableError);
        assert.equal(err.code, 'CONFINEMENT_UNAVAILABLE');
        assert.equal(err.reasonCode, 'CONFINEMENT_UNAVAILABLE');
        return true;
      },
    );
  });

  it('LocalDevBackend without OS attestation does not verify (honest)', () => {
    const backend = new LocalDevBackend({ workspaceRoot: tmpdir(), now });
    const report = backend.verifyConfinement();
    assert.equal(report.verified, false);
    assert.equal(report.verified_at, null);
    assert.ok(report.limitations.length > 0, 'limitations must be listed');
    assert.throws(() => assertConfinementForAutonomousShell(backend), ConfinementUnavailableError);
  });

  it('LocalDevBackend with attestation + clean prefixes verifies', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    const backend = new LocalDevBackend({
      workspaceRoot: root,
      forbiddenPrefixes: ['/etc/ai-factory-control-plane'],
      osBoundaryAttested: true,
      now,
    });
    const report = backend.verifyConfinement();
    assert.equal(report.verified, true);
    assert.equal(report.verified_at, new Date(FIXED_NOW).toISOString());
    const returned = assertConfinementForAutonomousShell(backend);
    assert.equal(returned.verified, true);
  });

  it('forbidden prefix inside the root fails verification', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    const backend = new LocalDevBackend({
      workspaceRoot: root,
      forbiddenPrefixes: [join(root, 'control-plane-db')],
      osBoundaryAttested: true,
      now,
    });
    assert.equal(backend.verifyConfinement().verified, false);
  });

  it('sandbox tier adapter stays unverified (policy checks are not OS isolation)', () => {
    const backend = sandboxTierBackend('strong', tmpdir(), { now });
    const report = backend.verifyConfinement();
    assert.equal(report.verified, false);
    assert.ok(
      report.limitations.some((l) => l.includes('not OS isolation')),
      'must say plainly it is not OS isolation',
    );
  });
});

describe('WorkspaceRecord (§7.2)', () => {
  it('records all §7.2 fields; verified_at comes from the backend report', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    const rec = createWorkspaceRecord({
      id: 'ws-1',
      authorized_roots: [root],
      owner: 'human:tan',
      backend: new AttestedBackend(),
      network_profile: { mode: 'deny' },
      now,
    });
    assert.equal(rec.id, 'ws-1');
    assert.deepEqual(rec.authorized_roots, [resolve(root)]);
    assert.ok(Array.isArray(rec.allowed_readonly_mounts));
    assert.ok(Array.isArray(rec.runtime_support_mounts));
    assert.ok(Array.isArray(rec.writable_temp_roots));
    assert.deepEqual(rec.network_profile, { mode: 'deny' });
    assert.equal(rec.owner, 'human:tan');
    assert.equal(rec.boundary_version, 1);
    assert.equal(rec.isolation_backend, 'test-attested');
    assert.equal(rec.confinement_verified_at, new Date(FIXED_NOW).toISOString());
  });

  it('unverified backend → confinement_verified_at is null (never hand-written)', () => {
    const rec = createWorkspaceRecord({
      id: 'ws-2',
      authorized_roots: [tmpdir()],
      owner: 'human:tan',
      backend: new UnverifiedBackend(now),
      now,
    });
    assert.equal(rec.confinement_verified_at, null);
  });
});

describe('path-threat analysis (§7.3)', () => {
  it('flags UNC, device, unicode, escape and .git paths', () => {
    const unc = detectPathThreats('\\\\server\\share\\x');
    assert.ok(unc.some((t) => t.kind === 'unc'));
    const dev = detectPathThreats('\\\\.\\C:\\x');
    assert.ok(dev.some((t) => t.kind === 'device-path'));
    const uni = detectPathThreats('src/раyload.ts');
    assert.ok(uni.some((t) => t.kind === 'unicode'));
    const esc = detectPathThreats('../../etc/passwd');
    assert.ok(esc.some((t) => t.kind === 'escape'));
    const git = detectPathThreats('.git/hooks/pre-commit');
    assert.ok(git.some((t) => t.kind === 'git-common-dir'));
    const nul = detectPathThreats('a\0b');
    assert.ok(nul.some((t) => t.kind === 'null-byte'));
  });

  it('clean relative path has no threats', () => {
    assert.deepEqual(detectPathThreats('src/index.ts'), []);
  });

  it('symlink inside root pointing outside is rejected', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'x');
    symlinkSync(outside, join(root, 'link'));
    assert.throws(
      () => resolveConfinedPathSync(root, join('link', 'secret.txt')),
      (err: unknown) => (err as Error).name === 'SandboxViolationError',
    );
  });

  it('normal nested path resolves inside the root', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    const resolved = resolveConfinedPathSync(root, join('a', 'b', 'new-file.txt'));
    assert.equal(resolved, join(resolve(root), 'a', 'b', 'new-file.txt'));
  });

  it('null byte is rejected', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    assert.throws(() => resolveConfinedPathSync(root, 'a\0b'));
  });
});

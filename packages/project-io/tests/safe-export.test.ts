/**
 * Tests for sanitized export — SPEC v2 §52.2.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSanitizedManifest,
  DEFAULT_EXPORT_EXCLUSIONS,
  ExportDeniedError,
  type ExportPermission,
} from '../src/index';

const allowAll: ExportPermission = { canExport: () => true };
const denyAll: ExportPermission = { canExport: () => false };

const data = {
  project: { id: 'p1', name: 'demo' },
  secrets: { apiKey: 'live-key-123' },
  oauth: { refreshToken: 'rt-abc' },
  capabilities: { deploy: ['prod'] },
  activeLeases: { 'ws-1': { owner: 'run-1' } },
  privateSessions: { s1: { transcript: '...' } },
  code: { 'index.js': 'console.log(1)' },
  agents: [{ id: 'a1', name: 'coder', api_key: 'should-be-redacted' }],
};

describe('sanitized export (§52.2)', () => {
  it('excludes secrets/oauth/capabilities/leases/sessions by default', () => {
    const m = buildSanitizedManifest(
      { actor: { id: 'h1', kind: 'HUMAN' }, scope: { userIds: ['u1'], projectIds: ['p1'] }, data },
      allowAll,
    );
    const text = Object.values(m.files).join('\n');
    assert.ok(!text.includes('live-key-123'), 'secret value leaked');
    assert.ok(!text.includes('rt-abc'), 'oauth token leaked');
    assert.ok(!text.includes('prod'), 'capability leaked');
    assert.ok(!text.includes('run-1'), 'active lease leaked');
    for (const k of DEFAULT_EXPORT_EXCLUSIONS) {
      assert.ok(m.excluded.includes(k), `${k} listed as excluded`);
    }
  });

  it('redacts secret-looking values that survive as fields', () => {
    const m = buildSanitizedManifest(
      { actor: { id: 'h1', kind: 'HUMAN' }, scope: { userIds: ['u1'], projectIds: ['p1'] }, data },
      allowAll,
    );
    const text = Object.values(m.files).join('\n');
    assert.ok(!text.includes('should-be-redacted'));
    assert.ok(text.includes('***REDACTED***'));
  });

  it('code/evidence are opt-in only', () => {
    const without = buildSanitizedManifest(
      { actor: { id: 'h1', kind: 'HUMAN' }, scope: { userIds: ['u1'], projectIds: ['p1'] }, data },
      allowAll,
    );
    assert.ok(!Object.values(without.files).join().includes('console.log(1)'));
    const withCode = buildSanitizedManifest(
      {
        actor: { id: 'h1', kind: 'HUMAN' },
        scope: { userIds: ['u1'], projectIds: ['p1'] },
        data,
        includeCode: true,
      },
      allowAll,
    );
    assert.ok(Object.values(withCode.files).join().includes('console.log(1)'));
  });

  it('denies export when the actor lacks rights in any touched scope', () => {
    assert.throws(
      () =>
        buildSanitizedManifest(
          { actor: { id: 'mallory', kind: 'HUMAN' }, scope: { userIds: ['u1'], projectIds: ['p1'] }, data },
          denyAll,
        ),
      (e: unknown) => e instanceof ExportDeniedError,
    );
  });

  it('emits per-file hashes for import-side verification', () => {
    const m = buildSanitizedManifest(
      { actor: { id: 'h1', kind: 'HUMAN' }, scope: { userIds: ['u1'], projectIds: ['p1'] }, data },
      allowAll,
    );
    assert.equal(Object.keys(m.fileHashes).length, Object.keys(m.files).length);
    for (const h of Object.values(m.fileHashes)) assert.equal(h.length, 64);
  });
});

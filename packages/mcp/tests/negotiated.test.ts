/**
 * Tests for §34.2 [S4]: the registry MUST persist the negotiated protocol
 * version and extension set from a successful handshake.
 * Run: node --test dist/tests/negotiated.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpRegistry } from '../src/index';

function fresh() {
  return new McpRegistry({ clock: { now: () => 1000 } });
}

const def = {
  name: 'fs-mcp',
  version: '2.1.0',
  provider: 'Acme',
  transport: 'stdio' as const,
};

describe('§34.2 [S4] negotiated version + extension set', () => {
  it('register() persists negotiatedVersion and extensionSet from the handshake', () => {
    const reg = fresh();
    const s = reg.register(def, {
      negotiatedVersion: '2026-07-28',
      extensionSet: ['tasks', 'elicitation'],
    });
    assert.equal(s.negotiatedVersion, '2026-07-28');
    assert.deepEqual(s.extensionSet, ['tasks', 'elicitation']);
    // visible again through get()
    const got = reg.get('fs-mcp', '2.1.0');
    assert.equal(got?.negotiatedVersion, '2026-07-28');
    assert.deepEqual(got?.extensionSet, ['tasks', 'elicitation']);
  });

  it('re-registration without handshake data preserves the saved negotiation', () => {
    const reg = fresh();
    reg.register(def, { negotiatedVersion: '2026-07-28', extensionSet: ['tasks'] });
    const s2 = reg.register(def); // e.g. metadata refresh, no new handshake
    assert.equal(s2.negotiatedVersion, '2026-07-28');
    assert.deepEqual(s2.extensionSet, ['tasks']);
  });

  it('a new handshake overwrites the saved negotiation', () => {
    const reg = fresh();
    reg.register(def, { negotiatedVersion: '2026-07-28', extensionSet: ['tasks'] });
    const s2 = reg.register(def, { negotiatedVersion: '2026-10-05', extensionSet: [] });
    assert.equal(s2.negotiatedVersion, '2026-10-05');
    assert.deepEqual(s2.extensionSet, []);
  });

  it('servers registered without a handshake have no negotiation data', () => {
    const reg = fresh();
    const s = reg.register(def);
    assert.equal(s.negotiatedVersion, undefined);
    assert.equal(s.extensionSet, undefined);
  });
});

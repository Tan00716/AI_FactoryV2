/**
 * @ai-factory/plugins tests (W-F): manifest validation + copy jail.
 * Run: node --test packages/plugins/dist/tests/*.test.js (after build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  copyPluginDir,
  PluginManifestError,
  readManifest,
  validateManifest,
} from '../src/index.js';

function goodManifest(over: Record<string, unknown> = {}) {
  return {
    name: 'demo-plugin',
    version: '1.2.3',
    description: 'A demo plugin',
    permissions: ['network.access'],
    capabilities: {
      skills: [
        { id: 'demo-skill', version: '0.1.0', description: 'd', instructions: 'do things' },
      ],
      slashCommands: [{ name: 'demo', description: 'd', template: 'run {args}' }],
      hooks: [{ event: 'PreToolUse', command: 'echo hi', description: 'd' }],
      mcpServers: [
        { name: 'demo-mcp', version: '1.0.0', transport: 'stdio', command: 'node', args: ['s.js'] },
      ],
    },
    ...over,
  };
}

describe('validateManifest', () => {
  it('accepts a full valid manifest', () => {
    const m = validateManifest(goodManifest());
    assert.equal(m.name, 'demo-plugin');
    assert.equal(m.capabilities.skills.length, 1);
    assert.equal(m.capabilities.slashCommands.length, 1);
    assert.equal(m.capabilities.hooks.length, 1);
    assert.equal(m.capabilities.mcpServers.length, 1);
  });

  it('accepts a minimal manifest (empty capabilities)', () => {
    const m = validateManifest({ name: 'xy', version: '0.0.1', description: 'd' });
    assert.deepEqual(m.capabilities, { skills: [], slashCommands: [], hooks: [], mcpServers: [] });
    assert.deepEqual(m.permissions, []);
  });

  it('rejects bad names, versions, permissions', () => {
    assert.throws(() => validateManifest(goodManifest({ name: 'Bad Name!' })), PluginManifestError);
    assert.throws(() => validateManifest(goodManifest({ version: 'v1' })), PluginManifestError);
    assert.throws(
      () => validateManifest(goodManifest({ permissions: ['root.sudo'] })),
      PluginManifestError,
    );
  });

  it('rejects duplicate capability ids and bad hook events', () => {
    const dup = goodManifest();
    (dup.capabilities as Record<string, unknown[]>)['slashCommands'] = [
      { name: 'a', description: 'd', template: 't' },
      { name: 'a', description: 'd', template: 't' },
    ];
    assert.throws(() => validateManifest(dup), PluginManifestError);
    const badEvent = goodManifest();
    (badEvent.capabilities as Record<string, unknown[]>)['hooks'] = [
      { event: 'OnBoot', command: 'x' },
    ];
    assert.throws(() => validateManifest(badEvent), PluginManifestError);
  });

  it('rejects stdio mcp server without command / http without url', () => {
    const noCmd = goodManifest();
    (noCmd.capabilities as Record<string, unknown[]>)['mcpServers'] = [
      { name: 'm', version: '1.0.0', transport: 'stdio' },
    ];
    assert.throws(() => validateManifest(noCmd), PluginManifestError);
    const noUrl = goodManifest();
    (noUrl.capabilities as Record<string, unknown[]>)['mcpServers'] = [
      { name: 'm', version: '1.0.0', transport: 'http' },
    ];
    assert.throws(() => validateManifest(noUrl), PluginManifestError);
  });

  it('keeps the marketplace block as a reserved extension point', () => {
    const m = validateManifest(
      goodManifest({ marketplace: { homepage: 'https://example.com' } }),
    );
    assert.equal(m.marketplace?.homepage, 'https://example.com');
  });
});

describe('readManifest + copyPluginDir', () => {
  it('reads plugin.json from a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plug-src-'));
    try {
      writeFileSync(join(dir, 'plugin.json'), JSON.stringify(goodManifest()));
      const m = readManifest(dir);
      assert.equal(m.name, 'demo-plugin');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses symlinks in the source tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plug-src-'));
    const dest = join(mkdtempSync(join(tmpdir(), 'plug-dest-')), 'demo-plugin');
    try {
      writeFileSync(join(dir, 'plugin.json'), JSON.stringify(goodManifest()));
      symlinkSync('/etc/passwd', join(dir, 'evil'));
      assert.throws(() => copyPluginDir(dir, dest), PluginManifestError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('copies a clean tree into the destination', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plug-src-'));
    const destBase = mkdtempSync(join(tmpdir(), 'plug-dest-'));
    const dest = join(destBase, 'demo-plugin');
    try {
      writeFileSync(join(dir, 'plugin.json'), JSON.stringify(goodManifest()));
      mkdirSync(join(dir, 'assets'));
      writeFileSync(join(dir, 'assets', 'note.txt'), 'hi');
      copyPluginDir(dir, dest);
      const m = readManifest(dest);
      assert.equal(m.name, 'demo-plugin');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(destBase, { recursive: true, force: true });
    }
  });
});

/**
 * §33 taxonomy tests — the 11 categories as a first-class enum, registry
 * category normalization/inference, listByCategory, and the definition
 * completeness validator.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_CATEGORIES,
  ToolRegistry,
  inferToolCategory,
  isToolCategory,
  validateToolMetadata,
  type ToolMetadata,
} from '../src/index';

function legacyMeta(overrides: Partial<ToolMetadata> = {}): ToolMetadata {
  // The pre-taxonomy shape: no category, no implementationStatus.
  return {
    id: 'some.tool',
    version: '1.0.0',
    source: 'test',
    inputSchema: {},
    outputSchema: {},
    capabilities: ['filesystem.write'],
    sideEffect: 'write',
    networkRequirements: [],
    filesystemRequirements: [],
    timeoutMs: 1_000,
    idempotency: false,
    cancelable: false,
    reconcilable: false,
    health: 'unknown',
    approvalPolicy: 'AUTO',
    ...overrides,
  };
}

describe('§33 category taxonomy', () => {
  it('has exactly the 11 categories, verbatim and in spec order', () => {
    assert.deepEqual([...TOOL_CATEGORIES], [
      'Filesystem',
      'Shell',
      'Git',
      'Package Manager',
      'Test/Build Runner',
      'Browser',
      'Database',
      'CI',
      'Deploy',
      'MCP',
      'Custom',
    ]);
    assert.equal(isToolCategory('Filesystem'), true);
    assert.equal(isToolCategory('filesystem'), false);
    assert.equal(isToolCategory('Custom Tools'), false);
    assert.equal(isToolCategory(42), false);
  });

  it('infers category from the first capability action prefix', () => {
    assert.equal(inferToolCategory({ capabilities: ['filesystem.read'] }), 'Filesystem');
    assert.equal(inferToolCategory({ capabilities: ['shell.execute'] }), 'Shell');
    assert.equal(inferToolCategory({ capabilities: ['git.commit'] }), 'Git');
    assert.equal(inferToolCategory({ capabilities: ['github.pull_request'] }), 'Git');
    assert.equal(inferToolCategory({ capabilities: ['test.execute'] }), 'Test/Build Runner');
    assert.equal(inferToolCategory({ capabilities: ['deploy.execute'] }), 'Deploy');
    assert.equal(inferToolCategory({ capabilities: ['mcp.call'] }), 'MCP');
    assert.equal(inferToolCategory({ capabilities: ['something.else'] }), 'Custom');
    assert.equal(inferToolCategory({ capabilities: [] }), 'Custom');
  });
});

describe('registry category handling', () => {
  it('normalizes a legacy definition: inferred category, definition-only status', () => {
    const registry = new ToolRegistry();
    registry.register(legacyMeta());
    const stored = registry.get('some.tool');
    assert.equal(stored.category, 'Filesystem');
    assert.equal(stored.implementationStatus, 'definition-only');
  });

  it('never overrides an explicit category or status', () => {
    const registry = new ToolRegistry();
    registry.register(
      legacyMeta({ category: 'Custom', implementationStatus: 'implemented' }),
    );
    const stored = registry.get('some.tool');
    assert.equal(stored.category, 'Custom');
    assert.equal(stored.implementationStatus, 'implemented');
  });

  it('rejects an invalid category at register time', () => {
    const registry = new ToolRegistry();
    assert.throws(
      () => registry.register(legacyMeta({ category: 'Files' as never })),
      /invalid category/,
    );
  });

  it('listByCategory returns latest versions in that category only', () => {
    const registry = new ToolRegistry();
    registry.register(legacyMeta({ id: 'a', capabilities: ['filesystem.read'] }));
    registry.register(legacyMeta({ id: 'a', version: '2.0.0', capabilities: ['filesystem.read'] }));
    registry.register(legacyMeta({ id: 'b', capabilities: ['git.push'] }));
    registry.register(legacyMeta({ id: 'c', capabilities: ['odd.action'] }));
    assert.deepEqual(
      registry.listByCategory('Filesystem').map((m) => `${m.id}@${m.version}`),
      ['a@2.0.0'],
    );
    assert.deepEqual(registry.listByCategory('Git').map((m) => m.id), ['b']);
    assert.deepEqual(registry.listByCategory('Custom').map((m) => m.id), ['c']);
    assert.deepEqual(registry.listByCategory('Browser'), []);
  });
});

describe('validateToolMetadata', () => {
  it('accepts a complete definition (with or without taxonomy fields)', () => {
    assert.deepEqual(validateToolMetadata(legacyMeta()), []);
    assert.deepEqual(validateToolMetadata(legacyMeta({ category: 'Git' })), []);
  });

  it('reports every missing or malformed §33 field', () => {
    const broken = legacyMeta({
      source: '',
      category: 'Files' as never,
      implementationStatus: 'real' as never,
      capabilities: [],
      sideEffect: 'oops' as never,
      timeoutMs: -5,
      approvalPolicy: 'SOMETIMES' as never,
      health: 'fine' as never,
      inputSchema: { path: { type: 'text' as never } },
      networkRequirements: 'none' as never,
    });
    const fields = validateToolMetadata(broken).map((i) => i.field);
    for (const expected of [
      'source',
      'category',
      'implementationStatus',
      'capabilities',
      'sideEffect',
      'timeoutMs',
      'approvalPolicy',
      'health',
      'inputSchema.path',
      'networkRequirements',
    ]) {
      assert.ok(fields.includes(expected), `expected an issue for ${expected}, got: ${fields.join(', ')}`);
    }
  });

  it('flags a malformed nested field schema', () => {
    const issues = validateToolMetadata(
      legacyMeta({
        inputSchema: {
          opts: { type: 'object', properties: { level: { type: 'loud' as never } } },
        },
      }),
    );
    assert.ok(issues.some((i) => i.field === 'inputSchema.opts.properties.level'));
  });
});

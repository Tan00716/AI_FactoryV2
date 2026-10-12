/**
 * §33 builtin catalog tests — every category has definitions, every
 * definition is complete and honest about its implementation status.
 * The implemented set is PINNED: promoting a tool to 'implemented'
 * requires a real implementation to exist (see BUILTIN_TOOL_NOTES).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_TOOLS,
  BUILTIN_TOOL_NOTES,
  TOOL_CATEGORIES,
  createBuiltinToolRegistry,
  summarizeBuiltinTools,
  validateToolMetadata,
} from '../src/index';

describe('builtin tool catalog (§33)', () => {
  it('covers all 11 categories with at least one definition each', () => {
    const summary = summarizeBuiltinTools();
    assert.deepEqual(Object.keys(summary), [...TOOL_CATEGORIES]);
    for (const category of TOOL_CATEGORIES) {
      const bucket = summary[category];
      assert.ok(
        bucket.implemented.length + bucket.definitionOnly.length >= 1,
        `category ${category} has no builtin definition`,
      );
    }
  });

  it('pins the implemented set to surfaces that really exist in the factory', () => {
    const summary = summarizeBuiltinTools();
    const implemented = TOOL_CATEGORIES.flatMap((c) => summary[c].implemented).sort();
    assert.deepEqual(implemented, [
      'ci.pipeline',
      'deploy.run',
      'git.commit',
      'git.pull_request',
      'git.push',
      'runtime.add',
      'runtime.echo',
      'test.run',
    ]);
  });

  it('every builtin declares category + status explicitly and validates clean', () => {
    for (const meta of BUILTIN_TOOLS) {
      assert.ok(meta.category, `${meta.id} must declare its category explicitly`);
      assert.ok(
        meta.implementationStatus === 'implemented' || meta.implementationStatus === 'definition-only',
        `${meta.id} must declare its implementation status`,
      );
      assert.deepEqual(validateToolMetadata(meta), [], `${meta.id} must be a complete §33 definition`);
      assert.equal(typeof BUILTIN_TOOL_NOTES[meta.id], 'string', `${meta.id} needs an honesty note`);
    }
    const ids = BUILTIN_TOOLS.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, 'builtin ids are unique');
  });

  it('registers into a fresh registry and answers category queries', () => {
    const registry = createBuiltinToolRegistry();
    assert.equal(registry.list().length, BUILTIN_TOOLS.length);
    assert.deepEqual(
      registry.listByCategory('Git').map((m) => m.id).sort(),
      ['git.commit', 'git.pull_request', 'git.push'],
    );
    assert.deepEqual(
      registry.listByCategory('Filesystem').map((m) => m.id).sort(),
      ['fs.delete', 'fs.read', 'fs.write'],
    );
    // Definition-only placeholders are queryable as what they are.
    const browser = registry.get('browser.open');
    assert.equal(browser.category, 'Browser');
    assert.equal(browser.implementationStatus, 'definition-only');
  });
});

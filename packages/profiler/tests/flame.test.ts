import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  foldFlameTree,
  countFlameNodes,
  flameDepth,
  type SampledStack,
} from '../src/index';

function stack(names: string[], weight: number): SampledStack {
  return {
    frames: names.map((n, i) => ({ name: n, url: 'file:///a.js', line: i + 1 })),
    weight,
  };
}

test('foldFlameTree aggregates weights and sorts widest-first', () => {
  const tree = foldFlameTree([
    stack(['main', 'slow'], 100),
    stack(['main', 'slow'], 50),
    stack(['main', 'fast'], 10),
  ]);
  assert.equal(tree.name, '(all)');
  assert.equal(tree.value, 160);
  assert.equal(tree.children.length, 1);
  const main = tree.children[0];
  assert.equal(main.value, 160);
  assert.equal(main.children.length, 2);
  // Widest first: slow (150) before fast (10).
  assert.ok(main.children[0].name.startsWith('slow @'));
  assert.equal(main.children[0].value, 150);
  assert.equal(main.children[0].self, 150);
  assert.equal(main.children[1].value, 10);
  assert.equal(main.self, 0, 'interior nodes carry no self time');
});

test('foldFlameTree skips empty and zero-weight stacks', () => {
  const tree = foldFlameTree([
    { frames: [], weight: 100 },
    stack(['a'], 0),
    stack(['a'], 5),
  ]);
  assert.equal(tree.value, 5);
  assert.equal(countFlameNodes(tree), 2);
  assert.equal(flameDepth(tree), 2);
});

test('flameDepth counts nesting', () => {
  const tree = foldFlameTree([stack(['a', 'b', 'c'], 7)]);
  assert.equal(flameDepth(tree), 4); // (all) -> a -> b -> c
  assert.equal(countFlameNodes(tree), 4);
});

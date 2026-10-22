/**
 * Flame-tree folding: turns sampled stacks (root -> leaf) into the nested
 * tree the UI renders as an SVG flame graph. Pure and deterministic.
 */
import type { FlameNode, SampledStack } from './types';

export function foldFlameTree(stacks: SampledStack[]): FlameNode {
  const root: FlameNode = { name: '(all)', value: 0, self: 0, children: [] };
  for (const stack of stacks) {
    if (stack.frames.length === 0 || stack.weight <= 0) continue;
    root.value += stack.weight;
    let node = root;
    for (let i = 0; i < stack.frames.length; i++) {
      const f = stack.frames[i];
      const name = `${f.name || '(anonymous)'} @ ${shortUrl(f.url)}:${f.line}`;
      let child = node.children.find((c) => c.name === name);
      if (!child) {
        child = { name, value: 0, self: 0, children: [] };
        node.children.push(child);
      }
      child.value += stack.weight;
      if (i === stack.frames.length - 1) child.self += stack.weight;
      node = child;
    }
  }
  // Widest-first so the flame graph reads left-to-right by weight.
  sortTree(root);
  return root;
}

function sortTree(node: FlameNode): void {
  node.children.sort((a, b) => b.value - a.value);
  for (const c of node.children) sortTree(c);
}

function shortUrl(url: string): string {
  if (!url) return '(native)';
  const idx = url.lastIndexOf('/');
  return idx >= 0 ? url.slice(idx + 1) : url;
}

/** Count nodes in a folded tree (used by tests / honesty metadata). */
export function countFlameNodes(node: FlameNode): number {
  let n = 1;
  for (const c of node.children) n += countFlameNodes(c);
  return n;
}

/** Max depth of a folded tree. */
export function flameDepth(node: FlameNode): number {
  if (node.children.length === 0) return 1;
  return 1 + Math.max(...node.children.map(flameDepth));
}

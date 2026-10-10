/**
 * Organization designer — spec §14 (AI Organization).
 *
 * A logical organization graph (not a static hard-coded role list) of the
 * PERSISTENT organization: long-lived roles like PM, Tech Lead, QA Lead.
 * Contrast with TaskSquad (squad.ts, spec §20): temporary, archived on
 * task completion. This designer is where the durable org structure is
 * shaped; squads borrow agents from it for the duration of a task.
 */

import type { Agent } from '@ai-factory/core';

export interface OrgNode {
  id: string;
  agentId: string | null;
  title: string;
  parentId: string | null;
  status: Agent['status'];
}

export interface OrgGraph {
  nodes: OrgNode[];
}

export interface OrgValidation {
  ok: boolean;
  errors: string[];
}

export class OrgDesignError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'OrgDesignError';
  }
}

/** The persistent-organization designer: add/remove/move nodes + validate. */
export class OrganizationDesigner {
  private nodes = new Map<string, OrgNode>();

  constructor(graph?: OrgGraph) {
    for (const n of graph?.nodes ?? []) {
      this.nodes.set(n.id, { ...n });
    }
  }

  addNode(node: OrgNode): OrgNode {
    if (!node.id?.trim()) throw new OrgDesignError('node id is required');
    if (this.nodes.has(node.id)) {
      throw new OrgDesignError(`node ${node.id} already exists`);
    }
    // A dangling parent is allowed at design time; validate() reports it.
    if (node.parentId === node.id) {
      throw new OrgDesignError('a node cannot be its own parent');
    }
    const stored = { ...node };
    this.nodes.set(node.id, stored);
    return { ...stored };
  }

  /**
   * Remove a node. Its children are re-parented to the removed node's
   * parent so no agent is orphaned by the edit.
   */
  removeNode(id: string): void {
    const node = this.nodes.get(id);
    if (!node) throw new OrgDesignError(`node ${id} does not exist`);
    for (const n of this.nodes.values()) {
      if (n.parentId === id) n.parentId = node.parentId;
    }
    this.nodes.delete(id);
  }

  /** Move a node under a new parent (null = make it the root). */
  moveNode(id: string, newParentId: string | null): void {
    const node = this.nodes.get(id);
    if (!node) throw new OrgDesignError(`node ${id} does not exist`);
    if (newParentId === id) throw new OrgDesignError('a node cannot be its own parent');
    if (newParentId !== null && !this.nodes.has(newParentId)) {
      throw new OrgDesignError(`parent ${newParentId} does not exist`);
    }
    node.parentId = newParentId;
  }

  getNode(id: string): OrgNode {
    const n = this.nodes.get(id);
    if (!n) throw new OrgDesignError(`node ${id} does not exist`);
    return { ...n };
  }

  toGraph(): OrgGraph {
    return { nodes: [...this.nodes.values()].map((n) => ({ ...n })) };
  }

  /**
   * Validate the graph: exactly one root, every parent exists, no cycles.
   */
  validate(): OrgValidation {
    const errors: string[] = [];
    const nodes = [...this.nodes.values()];

    const roots = nodes.filter((n) => n.parentId === null);
    if (roots.length === 0) errors.push('graph has no root (exactly one node with parentId null is required)');
    if (roots.length > 1) {
      errors.push(
        `graph has ${roots.length} roots (${roots.map((r) => r.id).join(', ')}) — exactly one root is required`,
      );
    }

    for (const n of nodes) {
      if (n.parentId !== null && !this.nodes.has(n.parentId)) {
        errors.push(`node ${n.id} references missing parent ${n.parentId}`);
      }
    }

    // Cycle detection: follow parent chains; a revisit means a cycle.
    for (const n of nodes) {
      const seen = new Set<string>([n.id]);
      let current = n.parentId;
      while (current !== null && this.nodes.has(current)) {
        if (seen.has(current)) {
          errors.push(`cycle detected: ${[...seen, current].join(' → ')}`);
          break;
        }
        seen.add(current);
        current = this.nodes.get(current)!.parentId;
      }
    }

    return { ok: errors.length === 0, errors };
  }

  toJSON(): string {
    return JSON.stringify(this.toGraph(), null, 2);
  }

  static fromJSON(json: string): OrganizationDesigner {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new OrgDesignError('invalid JSON');
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as { nodes?: unknown }).nodes)
    ) {
      throw new OrgDesignError('invalid org graph JSON: expected { nodes: [...] }');
    }
    return new OrganizationDesigner(parsed as OrgGraph);
  }
}

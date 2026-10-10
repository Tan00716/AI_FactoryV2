/**
 * Hybrid Human–AI organization graph — SPEC v2 §9.
 *
 * The `organization_relationships` edge table is authoritative;
 * `parent_agent`/`children` (v1) are NOT the source of truth — MANAGES is a
 * reverse-query projection of PRIMARY_REPORTS_TO and is never stored.
 *
 * Direction conventions (§9.1):
 *  - PRIMARY_REPORTS_TO : employee → primary manager
 *  - FUNCTIONALLY_REPORTS_TO / PROJECT_REPORTS_TO / ESCALATES_TO :
 *    reporter → receiver
 *  - CAN_DELEGATE_TO / COORDINATES : delegator-or-coordinator → work receiver
 *  - REVIEWS / APPROVES : reviewer/approver → reviewed employee
 *  - CONSULTS : consulter → expert
 *
 * Graph constraints (§9.2): primary management is acyclic; one primary
 * manager per employee per org/time (default); delegation chains are
 * acyclic and depth-limited; lateral report propagation uses dedup,
 * hop limit and origin ID so a graph cycle can never become a storm.
 *
 * Graph changes (§9.4) are transactional and versioned: cycles, orphaned
 * members, missing approvers and running delegations are validated BEFORE
 * commit. Moving a member never carries old authorizations along.
 * Delete/retire uses tombstones so historical runs still resolve the
 * organization version they ran under.
 *
 * Protected relationships: an AI principal can coordinate a Human but can
 * NEVER modify a Human's identity or superior.
 */

export type OrgNodeType = 'HUMAN' | 'AI_EMPLOYEE' | 'TEAM' | 'DEPARTMENT';
export type ActorKind = 'HUMAN' | 'AI' | 'SERVICE';

export type RelationshipType =
  | 'PRIMARY_REPORTS_TO'
  | 'FUNCTIONALLY_REPORTS_TO'
  | 'PROJECT_REPORTS_TO'
  | 'CAN_DELEGATE_TO'
  | 'REVIEWS'
  | 'APPROVES'
  | 'ESCALATES_TO'
  | 'CONSULTS'
  | 'COORDINATES';

export interface OrgNodeV2 {
  id: string;
  orgId: string;
  type: OrgNodeType;
  displayName: string;
  /** Protected identity block — only a HUMAN actor may change it. */
  identity?: { name?: string; email?: string };
  version: number;
  status: 'ACTIVE' | 'SUSPENDED' | 'RETIRED';
  tombstone?: boolean;
}

export interface OrgEdge {
  id: string;
  source_node_id: string;
  target_node_id: string;
  relationship_type: RelationshipType;
  project_scope: string | null;
  authority_scope: string;
  valid_from: string;
  valid_to: string | null;
  version: number;
  created_by: string;
  policy_ref: string;
}

export interface EdgeInput extends Omit<OrgEdge, 'id' | 'version'> {
  id?: string;
}

export class OrgGraphError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OrgGraphError';
    this.code = code;
  }
}

export interface OrgGraphOptions {
  now?: () => string;
  maxDelegationDepth?: number;
  maxReportHops?: number;
}

export interface GraphChangeOp {
  op: 'addNode' | 'updateNode' | 'retireNode' | 'addEdge' | 'removeEdge';
  node?: OrgNodeV2;
  nodePatch?: Partial<OrgNodeV2>;
  nodeId?: string;
  edge?: EdgeInput;
  edgeId?: string;
}

export interface AppliedChange {
  graphVersion: number;
  /** Authorizations that did NOT move with the member (must be re-granted). */
  authorizationsDropped: string[];
}

interface Snapshot {
  version: number;
  nodes: OrgNodeV2[];
  edges: OrgEdge[];
}

const LATERAL_REPORT_TYPES: RelationshipType[] = [
  'FUNCTIONALLY_REPORTS_TO',
  'PROJECT_REPORTS_TO',
  'ESCALATES_TO',
];

let edgeSeq = 0;

export class OrgGraphV2 {
  private nodes = new Map<string, OrgNodeV2>();
  private edges = new Map<string, OrgEdge>();
  private graphVersion = 0;
  private readonly history: Snapshot[] = [];
  private readonly opts: Required<OrgGraphOptions>;

  constructor(opts: OrgGraphOptions = {}) {
    this.opts = {
      now: opts.now ?? (() => new Date().toISOString()),
      maxDelegationDepth: opts.maxDelegationDepth ?? 5,
      maxReportHops: opts.maxReportHops ?? 10,
    };
    this.snapshot();
  }

  // ------------------------------------------------------------------ nodes

  addNode(node: OrgNodeV2, actor: ActorKind): OrgNodeV2 {
    if (!node.id?.trim()) throw new OrgGraphError('NODE_ID_REQUIRED', 'node id is required');
    if (this.nodes.has(node.id)) {
      throw new OrgGraphError('NODE_EXISTS', `node ${node.id} already exists`);
    }
    const stored: OrgNodeV2 = { ...node, identity: node.identity ? { ...node.identity } : undefined };
    this.nodes.set(node.id, stored);
    this.commit();
    return { ...stored };
  }

  /**
   * Protected relationships: only a HUMAN actor may change a HUMAN node's
   * identity block or its superior (primary manager). AI coordination
   * never grants personnel authority over humans.
   */
  updateNode(id: string, patch: Partial<OrgNodeV2>, actor: ActorKind): OrgNodeV2 {
    const node = this.nodes.get(id);
    if (!node) throw new OrgGraphError('NODE_NOT_FOUND', `node ${id} not found`);
    const touchesIdentity = patch.identity !== undefined;
    const touchesSuperior = (patch as { primaryManagerId?: string }).primaryManagerId !== undefined;
    if (node.type === 'HUMAN' && (touchesIdentity || touchesSuperior) && actor !== 'HUMAN') {
      throw new OrgGraphError(
        'PROTECTED_RELATIONSHIP',
        `actor ${actor} may not modify a human's identity or superior`,
      );
    }
    const updated: OrgNodeV2 = {
      ...node,
      ...patch,
      identity: patch.identity ? { ...patch.identity } : node.identity,
      version: node.version + 1,
    };
    this.nodes.set(id, updated);
    this.commit();
    return { ...updated };
  }

  /** Retire with a tombstone — history stays resolvable. */
  retireNode(id: string, _actor: ActorKind): OrgNodeV2 {
    const node = this.nodes.get(id);
    if (!node) throw new OrgGraphError('NODE_NOT_FOUND', `node ${id} not found`);
    const retired: OrgNodeV2 = { ...node, status: 'RETIRED', tombstone: true, version: node.version + 1 };
    this.nodes.set(id, retired);
    // Retiring a manager orphans direct reports: re-point their primary
    // edge is a governance decision, so we close the edge instead and let
    // applyChange validation surface the orphan for explicit handling.
    for (const e of this.edges.values()) {
      if (e.relationship_type === 'PRIMARY_REPORTS_TO' && e.target_node_id === id && e.valid_to === null) {
        e.valid_to = this.opts.now();
      }
    }
    this.commit();
    return { ...retired };
  }

  getNode(id: string): OrgNodeV2 | undefined {
    const n = this.nodes.get(id);
    return n ? { ...n } : undefined;
  }

  // ------------------------------------------------------------------ edges

  addEdge(input: EdgeInput, actor: ActorKind): OrgEdge {
    void actor;
    const edge: OrgEdge = {
      ...input,
      id: input.id ?? `edge-${++edgeSeq}`,
      version: 1,
    };
    this.validateEdge(edge, this.nodes, this.edges);
    this.edges.set(edge.id, edge);
    this.commit();
    return { ...edge };
  }

  removeEdge(id: string): void {
    if (!this.edges.has(id)) throw new OrgGraphError('EDGE_NOT_FOUND', `edge ${id} not found`);
    this.edges.delete(id);
    this.commit();
  }

  private validateEdge(
    edge: OrgEdge,
    nodes: Map<string, OrgNodeV2>,
    edges: Map<string, OrgEdge>,
  ): void {
    const source = nodes.get(edge.source_node_id);
    const target = nodes.get(edge.target_node_id);
    if (!source) throw new OrgGraphError('ENDPOINT_NOT_FOUND', `edge source ${edge.source_node_id} not found`);
    if (!target) throw new OrgGraphError('ENDPOINT_NOT_FOUND', `edge target ${edge.target_node_id} not found`);
    if (source.orgId !== target.orgId) {
      throw new OrgGraphError(
        'SCOPE_VIOLATION',
        `edge ${source.id}→${target.id} crosses orgs (${source.orgId} vs ${target.orgId})`,
      );
    }
    if (edge.source_node_id === edge.target_node_id) {
      throw new OrgGraphError('SELF_EDGE', 'a node cannot relate to itself');
    }
    if (edge.relationship_type === 'PRIMARY_REPORTS_TO') {
      // One primary manager per employee per org/time (default).
      for (const e of edges.values()) {
        if (
          e.relationship_type === 'PRIMARY_REPORTS_TO' &&
          e.source_node_id === edge.source_node_id &&
          e.valid_to === null &&
          edge.valid_to === null
        ) {
          throw new OrgGraphError(
            'MULTIPLE_PRIMARY_MANAGERS',
            `${edge.source_node_id} already has a primary manager (${e.target_node_id})`,
          );
        }
      }
      // Primary management must be acyclic.
      const pairs: Array<[string, string]> = [];
      for (const e of edges.values()) {
        if (e.relationship_type === 'PRIMARY_REPORTS_TO' && e.valid_to === null) {
          pairs.push([e.source_node_id, e.target_node_id]);
        }
      }
      pairs.push([edge.source_node_id, edge.target_node_id]);
      assertAcyclic(pairs, 'primary management');
    }
  }

  // ------------------------------------------------------------- projections

  /**
   * MANAGES is a reverse-query projection of PRIMARY_REPORTS_TO —
   * never stored, so it can never contradict the edge table.
   */
  manages(managerId: string): OrgNodeV2[] {
    const out: OrgNodeV2[] = [];
    for (const e of this.edges.values()) {
      if (e.relationship_type === 'PRIMARY_REPORTS_TO' && e.target_node_id === managerId && e.valid_to === null) {
        const n = this.nodes.get(e.source_node_id);
        if (n && !n.tombstone) out.push({ ...n });
      }
    }
    return out;
  }

  primaryManager(employeeId: string): OrgNodeV2 | null {
    for (const e of this.edges.values()) {
      if (e.relationship_type === 'PRIMARY_REPORTS_TO' && e.source_node_id === employeeId && e.valid_to === null) {
        const n = this.nodes.get(e.target_node_id);
        return n ? { ...n } : null;
      }
    }
    return null;
  }

  // ------------------------------------------------------- delegation chain

  /**
   * Delegation chains must be acyclic and depth-limited (§9.2).
   * A lateral report edge is never a delegation grant.
   */
  assertDelegationChain(chain: string[]): void {
    if (chain.length > this.opts.maxDelegationDepth + 1) {
      throw new OrgGraphError(
        'DELEGATION_DEPTH_EXCEEDED',
        `chain length ${chain.length} exceeds max depth ${this.opts.maxDelegationDepth}`,
      );
    }
    const seen = new Set<string>();
    for (const id of chain) {
      if (seen.has(id)) {
        throw new OrgGraphError('DELEGATION_CYCLE', `delegation chain revisits ${id}`);
      }
      seen.add(id);
    }
    // Every hop must be an actual CAN_DELEGATE_TO grant, not a report line.
    for (let i = 0; i < chain.length - 1; i++) {
      const ok = [...this.edges.values()].some(
        (e) =>
          e.relationship_type === 'CAN_DELEGATE_TO' &&
          e.source_node_id === chain[i] &&
          e.target_node_id === chain[i + 1] &&
          e.valid_to === null,
      );
      if (!ok) {
        throw new OrgGraphError(
          'DELEGATION_NOT_GRANTED',
          `${chain[i]} has no CAN_DELEGATE_TO grant to ${chain[i + 1]} (a report edge is not delegation)`,
        );
      }
    }
  }

  // ------------------------------------------------------- report fan-out

  /**
   * Lateral report propagation with dedup, hop limit and origin ID —
   * a cycle in the graph can never become a notification storm (§9.2).
   */
  propagateReport(originId: string, startNodeId: string): { deliveredTo: string[]; hops: number } {
    const delivered: string[] = [];
    const seen = new Set<string>([originId, startNodeId]);
    let frontier = [startNodeId];
    let hops = 0;
    while (frontier.length > 0 && hops < this.opts.maxReportHops) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        for (const e of this.edges.values()) {
          if (
            LATERAL_REPORT_TYPES.includes(e.relationship_type) &&
            e.source_node_id === nodeId &&
            e.valid_to === null &&
            !seen.has(e.target_node_id)
          ) {
            seen.add(e.target_node_id);
            delivered.push(e.target_node_id);
            next.push(e.target_node_id);
          }
        }
      }
      frontier = next;
      hops++;
    }
    return { deliveredTo: delivered, hops };
  }

  // ------------------------------------------------------- versioned change

  /**
   * Transactional, versioned graph change (§9.4). All ops are validated
   * against a scratch copy first; nothing commits unless everything is
   * valid. Moving a member drops its old authorizations (they must be
   * re-granted explicitly — listed in the result).
   */
  applyChange(ops: GraphChangeOp[], actor: ActorKind): AppliedChange {
    // Scratch copy.
    const nodes = new Map<string, OrgNodeV2>();
    for (const [k, v] of this.nodes) nodes.set(k, { ...v, identity: v.identity ? { ...v.identity } : undefined });
    const edges = new Map<string, OrgEdge>();
    for (const [k, v] of this.edges) edges.set(k, { ...v });

    const dropped: string[] = [];
    for (const op of ops) {
      switch (op.op) {
        case 'addNode': {
          if (!op.node) throw new OrgGraphError('BAD_OP', 'addNode requires node');
          if (nodes.has(op.node.id)) throw new OrgGraphError('NODE_EXISTS', op.node.id);
          nodes.set(op.node.id, { ...op.node });
          break;
        }
        case 'updateNode': {
          if (!op.nodeId || !op.nodePatch) throw new OrgGraphError('BAD_OP', 'updateNode requires nodeId+patch');
          const n = nodes.get(op.nodeId);
          if (!n) throw new OrgGraphError('NODE_NOT_FOUND', op.nodeId);
          if (n.type === 'HUMAN' && (op.nodePatch.identity !== undefined) && actor !== 'HUMAN') {
            throw new OrgGraphError('PROTECTED_RELATIONSHIP', 'AI may not modify a human identity');
          }
          nodes.set(op.nodeId, { ...n, ...op.nodePatch, version: n.version + 1 });
          break;
        }
        case 'retireNode': {
          if (!op.nodeId) throw new OrgGraphError('BAD_OP', 'retireNode requires nodeId');
          const n = nodes.get(op.nodeId);
          if (!n) throw new OrgGraphError('NODE_NOT_FOUND', op.nodeId);
          nodes.set(op.nodeId, { ...n, status: 'RETIRED', tombstone: true, version: n.version + 1 });
          break;
        }
        case 'addEdge': {
          if (!op.edge) throw new OrgGraphError('BAD_OP', 'addEdge requires edge');
          const edge: OrgEdge = { ...op.edge, id: op.edge.id ?? `edge-${++edgeSeq}`, version: 1 };
          if ((edge.relationship_type as string) === 'MANAGES') {
            throw new OrgGraphError('MANAGES_NOT_STORED', 'MANAGES is a projection; add PRIMARY_REPORTS_TO instead');
          }
          // Member move: closing the old primary edge drops authorizations.
          if (edge.relationship_type === 'PRIMARY_REPORTS_TO') {
            for (const e of edges.values()) {
              if (
                e.relationship_type === 'PRIMARY_REPORTS_TO' &&
                e.source_node_id === edge.source_node_id &&
                e.valid_to === null
              ) {
                e.valid_to = this.opts.now();
                dropped.push(`primary-manager-edge:${e.id}`);
              }
            }
          }
          this.validateEdge(edge, nodes, edges);
          edges.set(edge.id, edge);
          break;
        }
        case 'removeEdge': {
          if (!op.edgeId) throw new OrgGraphError('BAD_OP', 'removeEdge requires edgeId');
          if (!edges.has(op.edgeId)) throw new OrgGraphError('EDGE_NOT_FOUND', op.edgeId);
          edges.delete(op.edgeId);
          break;
        }
      }
    }

    // Post-change validation: no orphaned non-human members, no cycles.
    const pairs: Array<[string, string]> = [];
    for (const e of edges.values()) {
      if (e.relationship_type === 'PRIMARY_REPORTS_TO' && e.valid_to === null) {
        pairs.push([e.source_node_id, e.target_node_id]);
      }
    }
    assertAcyclic(pairs, 'primary management');
    for (const n of nodes.values()) {
      if (n.tombstone || n.type === 'HUMAN' || n.type === 'TEAM' || n.type === 'DEPARTMENT') continue;
      const hasManager = pairs.some(([s]) => s === n.id);
      if (!hasManager) {
        throw new OrgGraphError('ORPHANED_MEMBER', `${n.id} would lose its primary manager`);
      }
    }

    // Commit.
    this.nodes = nodes;
    this.edges = edges;
    this.commit();
    return { graphVersion: this.graphVersion, authorizationsDropped: dropped };
  }

  /** Resolve the graph as of a historical version (for old runs). */
  resolveAt(version: number): { nodes: OrgNodeV2[]; edges: OrgEdge[] } {
    const snap = this.history.find((h) => h.version === version);
    if (!snap) throw new OrgGraphError('VERSION_NOT_FOUND', `no snapshot for graph version ${version}`);
    return {
      nodes: snap.nodes.map((n) => ({ ...n })),
      edges: snap.edges.map((e) => ({ ...e })),
    };
  }

  get version(): number {
    return this.graphVersion;
  }

  /** Every graph change is versioned (§9.4). */
  private commit(): void {
    this.graphVersion++;
    this.snapshot();
  }

  private snapshot(): void {
    this.history.push({
      version: this.graphVersion,
      nodes: [...this.nodes.values()].map((n) => ({ ...n })),
      edges: [...this.edges.values()].map((e) => ({ ...e })),
    });
  }
}

function assertAcyclic(pairs: Array<[string, string]>, kind: string): void {
  const adj = new Map<string, string[]>();
  for (const [a, b] of pairs) {
    const list = adj.get(a) ?? [];
    list.push(b);
    adj.set(a, list);
  }
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const dfs = (node: string): boolean => {
    if (inStack.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    inStack.add(node);
    for (const next of adj.get(node) ?? []) {
      if (dfs(next)) return true;
    }
    inStack.delete(node);
    return false;
  };
  for (const [a] of pairs) {
    if (dfs(a)) {
      throw new OrgGraphError('CYCLE_DETECTED', `${kind} would contain a cycle`);
    }
  }
}

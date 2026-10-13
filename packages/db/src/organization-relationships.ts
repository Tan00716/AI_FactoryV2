/**
 * Durable organization graph — SPEC v2 §48.2 Organization domain
 * (Batch 34).
 *
 * Until Batch 34 the only home for the hybrid Human–AI organization
 * graph was `OrgGraphV2` in @ai-factory/squads — two in-memory Maps
 * (nodes, edges) plus a versioned snapshot history. A restart forgot
 * the entire org chart. This file is the record layer:
 *
 *  - `organization_nodes` — every org node (HUMAN / AI_EMPLOYEE /
 *    TEAM / DEPARTMENT), keyed by node id. Upsert semantics (a node
 *    id is stable identity; re-saving edits it).
 *  - `organization_relationships` — the authoritative edge table
 *    (§9: the edge table is authoritative; `parent_agent`/`children`
 *    are display projections). Upsert semantics; removeEdge deletes.
 *
 * The versioned snapshot history (§9.4 "resolve the graph as of a
 * historical version") stays in memory — it is a run-local query
 * convenience, not §48.2 durable state. The CURRENT graph (all
 * nodes + all edges) is what survives a restart; a fresh process
 * rebuilds its scratch history from the persisted rows.
 *
 * Record semantics (pinned by tests):
 *  - nodes: saveNode upserts by node_id; getNode / listNodes read;
 *  - edges: saveEdge upserts by edge_id (this is how a retired
 *    node's PRIMARY_REPORTS_TO edge gets its valid_to closed);
 *    removeEdge hard-deletes; getEdge / listEdges read;
 *  - there is no in-flight process state here: an edge with
 *    valid_to = NULL is an *ongoing relationship*, not an in-flight
 *    process like a delegation ACTIVE. Rows hydrate as-is — there is
 *    nothing to demote (unlike delegations, Batch 32). Tombstoned
 *    nodes stay tombstoned; nobody is "resurrected" on restart.
 *
 * Copy contract: every read returns a fresh deep copy (structuredClone
 * in memory, fresh objects from columns in SQLite).
 *
 * Corrupt rows fail loudly: identity_json that is not JSON throws
 * rather than guessing.
 */
import { DatabaseSync } from 'node:sqlite';

export interface OrgNodeDbRecord {
  nodeId: string;
  orgId: string;
  type: string;
  displayName: string;
  /** JSON of {name?, email?} or null. */
  identityJson: string | null;
  version: number;
  status: string;
  tombstone: boolean;
}

export interface OrgEdgeDbRecord {
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationshipType: string;
  projectScope: string | null;
  authorityScope: string;
  validFrom: string;
  validTo: string | null;
  version: number;
  createdBy: string;
  policyRef: string;
}

export interface OrgGraphStore {
  saveNode(node: OrgNodeDbRecord): void;
  getNode(nodeId: string): OrgNodeDbRecord | undefined;
  listNodes(orgId?: string): OrgNodeDbRecord[];
  /** Node ids only — never parses identity_json, so it never throws
   *  on corrupt rows. Used by readers that skip bad rows loudly. */
  listNodeIds(): string[];
  saveEdge(edge: OrgEdgeDbRecord): void;
  removeEdge(edgeId: string): boolean;
  getEdge(edgeId: string): OrgEdgeDbRecord | undefined;
  listEdges(): OrgEdgeDbRecord[];
}

const copy = <T>(v: T): T => structuredClone(v);

/** In-memory implementation: the behavior reference. */
export class InMemoryOrgGraphStore implements OrgGraphStore {
  private readonly nodes = new Map<string, OrgNodeDbRecord>();
  private readonly edges = new Map<string, OrgEdgeDbRecord>();

  saveNode(node: OrgNodeDbRecord): void {
    this.nodes.set(node.nodeId, copy(node));
  }

  getNode(nodeId: string): OrgNodeDbRecord | undefined {
    const n = this.nodes.get(nodeId);
    return n === undefined ? undefined : copy(n);
  }

  listNodes(orgId?: string): OrgNodeDbRecord[] {
    return [...this.nodes.values()]
      .filter((n) => orgId === undefined || n.orgId === orgId)
      .map(copy);
  }

  listNodeIds(): string[] {
    return [...this.nodes.keys()].sort();
  }

  saveEdge(edge: OrgEdgeDbRecord): void {
    this.edges.set(edge.edgeId, copy(edge));
  }

  removeEdge(edgeId: string): boolean {
    return this.edges.delete(edgeId);
  }

  getEdge(edgeId: string): OrgEdgeDbRecord | undefined {
    const e = this.edges.get(edgeId);
    return e === undefined ? undefined : copy(e);
  }

  listEdges(): OrgEdgeDbRecord[] {
    return [...this.edges.values()].map(copy);
  }
}

function rowToNode(row: Record<string, unknown>): OrgNodeDbRecord {
  // Corrupt rows fail loudly: JSON.parse throws rather than guessing.
  const identityJson = row['identity_json'] as string | null;
  if (identityJson !== null) JSON.parse(identityJson);
  return {
    nodeId: row['node_id'] as string,
    orgId: row['org_id'] as string,
    type: row['type'] as string,
    displayName: row['display_name'] as string,
    identityJson,
    version: row['version'] as number,
    status: row['status'] as string,
    tombstone: (row['tombstone'] as number) === 1,
  };
}

function rowToEdge(row: Record<string, unknown>): OrgEdgeDbRecord {
  return {
    edgeId: row['edge_id'] as string,
    sourceNodeId: row['source_node_id'] as string,
    targetNodeId: row['target_node_id'] as string,
    relationshipType: row['relationship_type'] as string,
    projectScope: row['project_scope'] as string | null,
    authorityScope: row['authority_scope'] as string,
    validFrom: row['valid_from'] as string,
    validTo: row['valid_to'] as string | null,
    version: row['version'] as number,
    createdBy: row['created_by'] as string,
    policyRef: row['policy_ref'] as string,
  };
}

/** SQLite implementation. Tables are created by SCHEMA (IF NOT EXISTS). */
export class SqliteOrgGraphStore implements OrgGraphStore {
  constructor(private readonly db: DatabaseSync) {}

  saveNode(n: OrgNodeDbRecord): void {
    this.db
      .prepare(
        `INSERT INTO organization_nodes
           (node_id, org_id, type, display_name, identity_json,
            version, status, tombstone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           org_id = excluded.org_id,
           type = excluded.type,
           display_name = excluded.display_name,
           identity_json = excluded.identity_json,
           version = excluded.version,
           status = excluded.status,
           tombstone = excluded.tombstone`,
      )
      .run(
        n.nodeId,
        n.orgId,
        n.type,
        n.displayName,
        n.identityJson,
        n.version,
        n.status,
        n.tombstone ? 1 : 0,
      );
  }

  getNode(nodeId: string): OrgNodeDbRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM organization_nodes WHERE node_id = ?')
      .get(nodeId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToNode(row);
  }

  listNodeIds(): string[] {
    const rows = this.db.prepare('SELECT node_id FROM organization_nodes ORDER BY node_id').all() as Record<
      string,
      unknown
    >[];
    return rows.map((r) => r['node_id'] as string);
  }

  listNodes(orgId?: string): OrgNodeDbRecord[] {
    const rows =
      orgId === undefined
        ? (this.db.prepare('SELECT * FROM organization_nodes ORDER BY node_id').all() as Record<
            string,
            unknown
          >[])
        : (this.db
            .prepare('SELECT * FROM organization_nodes WHERE org_id = ? ORDER BY node_id')
            .all(orgId) as Record<string, unknown>[]);
    return rows.map(rowToNode);
  }

  saveEdge(e: OrgEdgeDbRecord): void {
    this.db
      .prepare(
        `INSERT INTO organization_relationships
           (edge_id, source_node_id, target_node_id, relationship_type,
            project_scope, authority_scope, valid_from, valid_to,
            version, created_by, policy_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(edge_id) DO UPDATE SET
           source_node_id = excluded.source_node_id,
           target_node_id = excluded.target_node_id,
           relationship_type = excluded.relationship_type,
           project_scope = excluded.project_scope,
           authority_scope = excluded.authority_scope,
           valid_from = excluded.valid_from,
           valid_to = excluded.valid_to,
           version = excluded.version,
           created_by = excluded.created_by,
           policy_ref = excluded.policy_ref`,
      )
      .run(
        e.edgeId,
        e.sourceNodeId,
        e.targetNodeId,
        e.relationshipType,
        e.projectScope,
        e.authorityScope,
        e.validFrom,
        e.validTo,
        e.version,
        e.createdBy,
        e.policyRef,
      );
  }

  removeEdge(edgeId: string): boolean {
    const res = this.db.prepare('DELETE FROM organization_relationships WHERE edge_id = ?').run(edgeId);
    return (res.changes as number) > 0;
  }

  getEdge(edgeId: string): OrgEdgeDbRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM organization_relationships WHERE edge_id = ?')
      .get(edgeId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToEdge(row);
  }

  listEdges(): OrgEdgeDbRecord[] {
    const rows = this.db.prepare('SELECT * FROM organization_relationships ORDER BY edge_id').all() as Record<
      string,
      unknown
    >[];
    return rows.map(rowToEdge);
  }
}

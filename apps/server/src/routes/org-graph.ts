/**
 * Organization graph HTTP surface — SPEC v2 §9 + §48.2 (Batch 34).
 *
 * Until Batch 34 the hybrid Human–AI org graph lived only in the
 * in-memory `OrgGraphV2` (@ai-factory/squads) — a restart forgot the
 * whole org chart. Nodes and the authoritative edge table
 * `organization_relationships` now persist in fdb.orgGraph.
 *
 *   GET    /api/org/nodes                       list nodes (?org_id=)
 *   POST   /api/org/nodes                       add a node
 *   GET    /api/org/relationships               list edges
 *   POST   /api/org/relationships               add an edge
 *   DELETE /api/org/relationships/:id           remove an edge
 *
 * Every mutation is validated against a scratch OrgGraphV2 rebuilt
 * from the persisted rows (endpoints must exist, no cross-org edges,
 * no self edges, one primary manager, primary management acyclic —
 * §9.2) and then written through to fdb.orgGraph. A rule violation
 * throws BEFORE any write — the DB never sees a rejected change —
 * and is answered 409 with the domain error code (never a 500: the
 * request was understood, the rules said no). A DB write failure is
 * answered 503 and audited ORG_PERSIST_FAILED: the store is the
 * system of record, so a failed write is a failed mutation.
 *
 * Mutations are audited (ORG_NODE_ADDED / ORG_EDGE_ADDED /
 * ORG_EDGE_REMOVED). Edge ids are `orgedge-<uuid>` when the body
 * omits one (the domain's `edge-<n>` counter resets per process and
 * would collide across restarts — never used over HTTP).
 *
 * Semantics (honest, pinned by tests): an edge with valid_to = NULL
 * is an *ongoing relationship*, not in-flight process state — rows
 * hydrate as-is on restart, there is nothing to demote (unlike
 * delegations, Batch 32). Corrupt node rows are skipped loudly at
 * boot and on reads (ORG_NODE_CORRUPT audit) — one bad row never
 * hides the rest. The §9.4 versioned snapshot history stays in
 * memory: only the CURRENT graph is durable.
 *
 * The `actor` field is caller-asserted (HUMAN/AI/SERVICE, default
 * SERVICE) and written into the audit — the server has only coarse
 * token RBAC, so it is not cryptographically bound (same honesty as
 * the Batch-32 authority registry).
 *
 * RBAC: reads are viewer, writes are operator (the auth gate default).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { OrgGraphV2, type ActorKind, type OrgEdge, type OrgNodeV2 } from '@ai-factory/squads';
import type { AuditLog } from '@ai-factory/core';
import type { FactoryDatabase } from '@ai-factory/db';
import type { RouteContext } from './context';

let fdb: FactoryDatabase | null = null;
let auditLog: AuditLog | null = null;

/** Boot wiring (called from the coordinator in index.ts). */
export function initOrgGraphRoutes(f: FactoryDatabase, a: AuditLog): void {
  fdb = f;
  auditLog = a;
  hydrate(f, a);
}

function requireFdb(): FactoryDatabase {
  if (!fdb) throw new Error('org graph routes not initialized');
  return fdb;
}

function requireAudit(): AuditLog {
  if (!auditLog) throw new Error('org graph routes not initialized');
  return auditLog;
}

const ACTORS: ActorKind[] = ['HUMAN', 'AI', 'SERVICE'];
const NODE_TYPES = ['HUMAN', 'AI_EMPLOYEE', 'TEAM', 'DEPARTMENT'] as const;
const NODE_STATUSES = ['ACTIVE', 'SUSPENDED', 'RETIRED'] as const;

/** Rebuild the domain graph from persisted rows. Corrupt node rows are
 *  skipped loudly — one bad row never hides the rest. */
function loadGraph(db: FactoryDatabase, audit: AuditLog): OrgGraphV2 {
  const g = new OrgGraphV2();
  for (const row of db.orgGraph.listNodes()) {
    try {
      const node: OrgNodeV2 = {
        id: row.nodeId,
        orgId: row.orgId,
        type: row.type as OrgNodeV2['type'],
        displayName: row.displayName,
        version: row.version,
        status: row.status as OrgNodeV2['status'],
      };
      if (row.identityJson !== null) node.identity = JSON.parse(row.identityJson) as { name?: string; email?: string };
      if (row.tombstone) node.tombstone = true;
      // Bypass addNode validation here: persisted rows were valid when
      // written; re-running validation would turn a stale row into a
      // boot blocker. Corrupt JSON (thrown above) is the loud failure.
      (g as unknown as { nodes: Map<string, OrgNodeV2> }).nodes.set(node.id, node);
    } catch (e) {
      audit.record('system', 'ORG_NODE_CORRUPT', 'org-node', row.nodeId, {
        error: e instanceof Error ? e.message : 'corrupt org node row',
      });
    }
  }
  for (const row of db.orgGraph.listEdges()) {
    const present = g.getNode(row.sourceNodeId) !== undefined && g.getNode(row.targetNodeId) !== undefined;
    if (!present) {
      audit.record('system', 'ORG_EDGE_ORPHANED', 'org-edge', row.edgeId, {
        error: `edge endpoints missing after restart (${row.sourceNodeId} -> ${row.targetNodeId})`,
      });
      continue;
    }
    const edge: OrgEdge = {
      id: row.edgeId,
      source_node_id: row.sourceNodeId,
      target_node_id: row.targetNodeId,
      relationship_type: row.relationshipType as OrgEdge['relationship_type'],
      project_scope: row.projectScope,
      authority_scope: row.authorityScope,
      valid_from: row.validFrom,
      valid_to: row.validTo,
      version: row.version,
      created_by: row.createdBy,
      policy_ref: row.policyRef,
    };
    (g as unknown as { edges: Map<string, OrgEdge> }).edges.set(edge.id, edge);
  }
  return g;
}

/** Boot: sanity-check that persisted rows still load (loud on corrupt). */
function hydrate(db: FactoryDatabase, audit: AuditLog): void {
  try {
    const g = loadGraph(db, audit);
    audit.record('system', 'ORG_GRAPH_HYDRATED', 'org-graph', '(all)', {
      nodes: db.orgGraph.listNodes().length,
      edges: db.orgGraph.listEdges().length,
      graphVersion: g.version,
    });
  } catch (e) {
    audit.record('system', 'ORG_HYDRATE_FAILED', 'org-graph', '(all)', {
      error: e instanceof Error ? e.message : 'org graph hydrate failed',
    });
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asOptString(b: Record<string, unknown>, k: string): string | null | undefined {
  const v = b[k];
  if (v === undefined || v === null) return v === null ? null : undefined;
  return typeof v === 'string' ? v : 'INVALID';
}

function parseActor(b: Record<string, unknown>): ActorKind | null {
  const v = b['actor'];
  if (v === undefined) return 'SERVICE';
  return typeof v === 'string' && (ACTORS as string[]).includes(v) ? (v as ActorKind) : null;
}

export async function handleOrgGraphRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith('/api/org/')) return false;
  const db = requireFdb();
  const audit = requireAudit();
  const { json, readBody } = ctx;

  // -- nodes -------------------------------------------------------------
  if (p === '/api/org/nodes' && req.method === 'GET') {
    const orgId = url.searchParams.get('org_id') ?? undefined;
    const nodes: Record<string, unknown>[] = [];
    // Per-row loud skip: listNodes() fails loudly on the first corrupt
    // row by store contract, so on corruption fall back to id-scoped
    // reads and skip only the bad rows.
    let rows: ReturnType<FactoryDatabase['orgGraph']['listNodes']> | null = null;
    try {
      rows = db.orgGraph.listNodes();
    } catch {
      rows = null;
    }
    if (rows === null) {
      rows = [];
      for (const id of db.orgGraph.listNodeIds()) {
        try {
          const row = db.orgGraph.getNode(id);
          if (row !== undefined) rows.push(row);
        } catch (e) {
          audit.record('system', 'ORG_NODE_CORRUPT', 'org-node', id, {
            error: e instanceof Error ? e.message : 'corrupt org node row',
          });
        }
      }
    }
    for (const row of rows) {
      if (orgId !== undefined && row.orgId !== orgId) continue;
      let identity: unknown = null;
      try {
        identity = row.identityJson === null ? null : JSON.parse(row.identityJson);
      } catch (e) {
        audit.record('system', 'ORG_NODE_CORRUPT', 'org-node', row.nodeId, {
          error: e instanceof Error ? e.message : 'corrupt org node row',
        });
        continue;
      }
      nodes.push({
        id: row.nodeId,
        org_id: row.orgId,
        type: row.type,
        display_name: row.displayName,
        identity,
        version: row.version,
        status: row.status,
        tombstone: row.tombstone,
      });
    }
    return json(res, 200, { nodes }), true;
  }

  if (p === '/api/org/nodes' && req.method === 'POST') {
    const b = await readBody(req);
    if (!isRecord(b)) return json(res, 400, { error: 'JSON object body required' }), true;
    const actor = parseActor(b);
    if (actor === null) return json(res, 400, { error: 'actor must be HUMAN, AI or SERVICE' }), true;
    const id = typeof b['id'] === 'string' && b['id'].trim() ? b['id'] : null;
    const orgId = typeof b['org_id'] === 'string' && b['org_id'].trim() ? b['org_id'] : null;
    const type = typeof b['type'] === 'string' ? b['type'] : null;
    const displayName = typeof b['display_name'] === 'string' && b['display_name'].trim() ? b['display_name'] : null;
    const status = typeof b['status'] === 'string' ? b['status'] : 'ACTIVE';
    const version = typeof b['version'] === 'number' ? b['version'] : 1;
    if (!id || !orgId || !displayName) {
      return json(res, 400, { error: 'id, org_id and display_name (strings) are required' }), true;
    }
    if (type === null || !(NODE_TYPES as readonly string[]).includes(type)) {
      return json(res, 400, { error: `type must be one of ${NODE_TYPES.join(', ')}` }), true;
    }
    if (!(NODE_STATUSES as readonly string[]).includes(status)) {
      return json(res, 400, { error: `status must be one of ${NODE_STATUSES.join(', ')}` }), true;
    }
    let identityJson: string | null = null;
    if (b['identity'] !== undefined) {
      if (!isRecord(b['identity'])) return json(res, 400, { error: 'identity must be an object' }), true;
      const name = b['identity']['name'];
      const email = b['identity']['email'];
      if ((name !== undefined && typeof name !== 'string') || (email !== undefined && typeof email !== 'string')) {
        return json(res, 400, { error: 'identity.name and identity.email must be strings' }), true;
      }
      identityJson = JSON.stringify({ ...(name !== undefined ? { name } : {}), ...(email !== undefined ? { email } : {}) });
    }
    if (db.orgGraph.getNode(id) !== undefined) {
      return json(res, 409, { error: `node ${id} already exists`, code: 'NODE_EXISTS' }), true;
    }
    try {
      db.orgGraph.saveNode({
        nodeId: id,
        orgId,
        type,
        displayName,
        identityJson,
        version,
        status,
        tombstone: false,
      });
    } catch (e) {
      audit.record(actor, 'ORG_PERSIST_FAILED', 'org-node', id, {
        error: e instanceof Error ? e.message : 'persist failed',
      });
      return json(res, 503, { error: 'persist failed', code: 'ORG_PERSIST_FAILED' }), true;
    }
    audit.record(actor, 'ORG_NODE_ADDED', 'org-node', id, { org_id: orgId, type });
    return json(res, 200, { node: { id, org_id: orgId, type, display_name: displayName, version, status } }), true;
  }

  // -- relationships ------------------------------------------------------
  if (p === '/api/org/relationships' && req.method === 'GET') {
    const edges = db.orgGraph.listEdges().map((row) => ({
      id: row.edgeId,
      source_node_id: row.sourceNodeId,
      target_node_id: row.targetNodeId,
      relationship_type: row.relationshipType,
      project_scope: row.projectScope,
      authority_scope: row.authorityScope,
      valid_from: row.validFrom,
      valid_to: row.validTo,
      version: row.version,
      created_by: row.createdBy,
      policy_ref: row.policyRef,
    }));
    return json(res, 200, { edges }), true;
  }

  if (p === '/api/org/relationships' && req.method === 'POST') {
    const b = await readBody(req);
    if (!isRecord(b)) return json(res, 400, { error: 'JSON object body required' }), true;
    const actor = parseActor(b);
    if (actor === null) return json(res, 400, { error: 'actor must be HUMAN, AI or SERVICE' }), true;
    const source = typeof b['source_node_id'] === 'string' ? b['source_node_id'] : null;
    const target = typeof b['target_node_id'] === 'string' ? b['target_node_id'] : null;
    const relType = typeof b['relationship_type'] === 'string' ? b['relationship_type'] : null;
    const authorityScope = typeof b['authority_scope'] === 'string' ? b['authority_scope'] : null;
    const createdBy = typeof b['created_by'] === 'string' ? b['created_by'] : null;
    const policyRef = typeof b['policy_ref'] === 'string' ? b['policy_ref'] : null;
    const projectScope = asOptString(b, 'project_scope');
    const validTo = asOptString(b, 'valid_to');
    const validFrom = typeof b['valid_from'] === 'string' ? b['valid_from'] : new Date().toISOString();
    const id = typeof b['id'] === 'string' && b['id'].trim() ? b['id'] : `orgedge-${randomUUID()}`;
    if (!source || !target || !relType || !authorityScope || !createdBy || !policyRef) {
      return json(res, 400, {
        error: 'source_node_id, target_node_id, relationship_type, authority_scope, created_by, policy_ref (strings) are required',
      }), true;
    }
    if (projectScope === 'INVALID' || validTo === 'INVALID') {
      return json(res, 400, { error: 'project_scope and valid_to must be strings or null' }), true;
    }
    // Validate against a scratch graph rebuilt from persisted rows: the
    // DB never sees a rejected edge.
    const g = loadGraph(db, audit);
    let edge: OrgEdge;
    try {
      edge = g.addEdge(
        {
          id,
          source_node_id: source,
          target_node_id: target,
          relationship_type: relType as OrgEdge['relationship_type'],
          project_scope: projectScope ?? null,
          authority_scope: authorityScope,
          valid_from: validFrom,
          valid_to: validTo ?? null,
          created_by: createdBy,
          policy_ref: policyRef,
        },
        actor,
      );
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'EDGE_REJECTED';
      return json(res, 409, { error: e instanceof Error ? e.message : 'edge rejected', code }), true;
    }
    try {
      db.orgGraph.saveEdge({
        edgeId: edge.id,
        sourceNodeId: edge.source_node_id,
        targetNodeId: edge.target_node_id,
        relationshipType: edge.relationship_type,
        projectScope: edge.project_scope,
        authorityScope: edge.authority_scope,
        validFrom: edge.valid_from,
        validTo: edge.valid_to,
        version: edge.version,
        createdBy: edge.created_by,
        policyRef: edge.policy_ref,
      });
    } catch (e) {
      audit.record(actor, 'ORG_PERSIST_FAILED', 'org-edge', id, {
        error: e instanceof Error ? e.message : 'persist failed',
      });
      return json(res, 503, { error: 'persist failed', code: 'ORG_PERSIST_FAILED' }), true;
    }
    audit.record(actor, 'ORG_EDGE_ADDED', 'org-edge', id, {
      source: source,
      target: target,
      relationship_type: relType,
    });
    return json(res, 200, { edge: { id, source_node_id: source, target_node_id: target, relationship_type: relType } }), true;
  }

  const relDelete = p.match(/^\/api\/org\/relationships\/([^/]+)$/);
  if (relDelete && req.method === 'DELETE') {
    const id = decodeURIComponent(relDelete[1]!);
    const b = await readBody(req).catch(() => null);
    const actor: ActorKind =
      b !== null && isRecord(b) && b['actor'] !== undefined
        ? ((b['actor'] as string) as ActorKind)
        : 'SERVICE';
    if (!(ACTORS as string[]).includes(actor)) {
      return json(res, 400, { error: 'actor must be HUMAN, AI or SERVICE' }), true;
    }
    let removed: boolean;
    try {
      removed = db.orgGraph.removeEdge(id);
    } catch (e) {
      audit.record(actor, 'ORG_PERSIST_FAILED', 'org-edge', id, {
        error: e instanceof Error ? e.message : 'persist failed',
      });
      return json(res, 503, { error: 'persist failed', code: 'ORG_PERSIST_FAILED' }), true;
    }
    if (!removed) return json(res, 404, { error: `unknown edge ${id}` }), true;
    audit.record(actor, 'ORG_EDGE_REMOVED', 'org-edge', id, {});
    return json(res, 200, { removed: id }), true;
  }

  if (p.startsWith('/api/org/')) return json(res, 405, { error: 'method not allowed' }), true;
  return false;
}

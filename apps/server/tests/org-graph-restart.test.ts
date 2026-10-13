/**
 * Organization graph survives restarts — SPEC v2 §9 + §48.2 (Batch 34).
 *
 * Until Batch 34 the hybrid Human–AI org graph lived only in the
 * in-memory OrgGraphV2 (@ai-factory/squads) — a restart forgot the
 * whole org chart. Now nodes and the authoritative edge table
 * `organization_relationships` persist in fdb.orgGraph:
 *   - POST /api/org/nodes adds a node (409 NODE_EXISTS on duplicate);
 *   - POST /api/org/relationships adds an edge validated against a
 *     scratch graph rebuilt from persisted rows (§9.2: endpoints must
 *     exist, no cross-org edges, no self edges, one primary manager,
 *     primary management acyclic) — 409 with the domain code;
 *   - DELETE /api/org/relationships/:id removes an edge (404 unknown);
 *   - an edge with valid_to = NULL is an *ongoing relationship*, not
 *     in-flight process state — rows hydrate as-is on restart, nothing
 *     is demoted (unlike delegations, Batch 32).
 *
 * Pinned on the REAL server binary (boot → SIGKILL → reboot on the
 * same DB file):
 *   - boot A: add two nodes + a PRIMARY_REPORTS_TO edge; duplicate
 *     node → 409 NODE_EXISTS; edge to missing endpoint → 409
 *     ENDPOINT_NOT_FOUND; second primary manager → 409
 *     MULTIPLE_PRIMARY_MANAGERS; cyclic primary edge → 409
 *     CYCLE_DETECTED; remove edge → 200; re-add;
 *   - SIGKILL boot A, boot B on the same DB:
 *   - GET /api/org/nodes shows both nodes; GET /api/org/relationships
 *     shows the edge with valid_to = null (ongoing, not demoted);
 *   - the audit log contains ORG_GRAPH_HYDRATED, ORG_NODE_ADDED,
 *     ORG_EDGE_ADDED, ORG_EDGE_REMOVED.
 *   - corrupt identity_json row injected into the DB file: boot C
 *     still comes up, ORG_NODE_CORRUPT is in the audit, the bad row
 *     is skipped and the good rows still list.
 *
 * Boots dist/index.js, so this file runs after the server build.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ADMIN = 'gov-org-restart-admin-xyz';

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

async function bootRealServer(dbFile: string): Promise<{ child: ChildProcess; port: number }> {
  const port = 28_000 + Math.floor(Math.random() * 15_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_API_TOKENS: 'admin:' + ADMIN,
    FACTORY_SECRETS_BACKEND: 'memory',
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS']) {
    delete env[k];
  }
  const child = spawn(process.execPath, [serverMain], { cwd: serverCwd, env, stdio: 'ignore' });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { child, port };
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('server did not become healthy in 20000ms');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

type Rec = Record<string, unknown>;

describe('org graph survives restarts (§9/§48.2, Batch 34)', () => {
  it('SIGKILL restart keeps nodes and the authoritative edge table', { timeout: 180_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-org-restart-'));
    const dbFile = join(dir, 'factory.db');
    let child: ChildProcess | null = null;
    try {
      const call = async (port: number, method: string, path: string, body?: unknown) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: { Authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let parsed: unknown = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          /* non-JSON */
        }
        return { status: res.status, body: parsed as Rec | null };
      };

      // ---- boot A ---------------------------------------------------
      let s = await bootRealServer(dbFile);
      child = s.child;
      const p = s.port;

      const node = (id: string, org: string, type: string, name: string) =>
        call(p, 'POST', '/api/org/nodes', {
          id,
          org_id: org,
          type,
          display_name: name,
          identity: { name },
        });
      assert.equal((await node('mgr-1', 'org-1', 'HUMAN', 'boss')).status, 200);
      assert.equal((await node('wrk-1', 'org-1', 'AI_EMPLOYEE', 'worker')).status, 200);
      // duplicate node
      const dup = await node('mgr-1', 'org-1', 'HUMAN', 'boss');
      assert.equal(dup.status, 409);
      assert.equal(dup.body?.['code'], 'NODE_EXISTS');

      const edge = (body: Rec) => call(p, 'POST', '/api/org/relationships', body);
      const base = {
        relationship_type: 'PRIMARY_REPORTS_TO',
        authority_scope: 'org',
        created_by: 'human',
        policy_ref: 'pol-1',
      };
      const e1 = await edge({ ...base, source_node_id: 'wrk-1', target_node_id: 'mgr-1' });
      assert.equal(e1.status, 200);
      const edgeId = e1.body?.['edge'] as Rec;
      assert.ok(typeof edgeId?.['id'] === 'string');

      // edge to missing endpoint
      const badEnd = await edge({ ...base, source_node_id: 'ghost', target_node_id: 'mgr-1' });
      assert.equal(badEnd.status, 409);
      assert.equal(badEnd.body?.['code'], 'ENDPOINT_NOT_FOUND');

      // second primary manager for the same employee
      await node('mgr-2', 'org-1', 'HUMAN', 'boss2');
      const secondPrimary = await edge({ ...base, source_node_id: 'wrk-1', target_node_id: 'mgr-2' });
      assert.equal(secondPrimary.status, 409);
      assert.equal(secondPrimary.body?.['code'], 'MULTIPLE_PRIMARY_MANAGERS');

      // cyclic primary edge
      const cycle = await edge({ ...base, source_node_id: 'mgr-1', target_node_id: 'wrk-1' });
      assert.equal(cycle.status, 409);
      assert.equal(cycle.body?.['code'], 'CYCLE_DETECTED');

      // remove + re-add
      assert.equal((await call(p, 'DELETE', `/api/org/relationships/${edgeId['id']}`)).status, 200);
      assert.equal((await call(p, 'DELETE', `/api/org/relationships/${edgeId['id']}`)).status, 404);
      const e2 = await edge({ ...base, source_node_id: 'wrk-1', target_node_id: 'mgr-1' });
      assert.equal(e2.status, 200);
      const readdedId = (e2.body?.['edge'] as Rec)['id'];

      child.kill('SIGKILL');
      child = null;

      // ---- boot B (same DB) -----------------------------------------
      s = await bootRealServer(dbFile);
      child = s.child;
      const p2 = s.port;

      const nodes = await call(p2, 'GET', '/api/org/nodes');
      assert.equal(nodes.status, 200);
      const nodeIds = ((nodes.body?.['nodes'] as Rec[]) ?? []).map((n) => n['id']).sort();
      assert.deepEqual(nodeIds, ['mgr-1', 'mgr-2', 'wrk-1']);

      const edges = await call(p2, 'GET', '/api/org/relationships');
      assert.equal(edges.status, 200);
      const edgeRows = (edges.body?.['edges'] as Rec[]) ?? [];
      assert.equal(edgeRows.length, 1);
      assert.equal(edgeRows[0]?.['id'], readdedId);
      assert.equal(edgeRows[0]?.['valid_to'], null); // ongoing — NOT demoted
      assert.equal(edgeRows[0]?.['relationship_type'], 'PRIMARY_REPORTS_TO');

      const audit = await call(p2, 'GET', '/api/audit?limit=200');
      const entries = (Array.isArray(audit.body) ? audit.body : []) as Rec[];
      const actions = entries.map((e) => e['action']);
      for (const want of ['ORG_GRAPH_HYDRATED', 'ORG_NODE_ADDED', 'ORG_EDGE_ADDED', 'ORG_EDGE_REMOVED']) {
        assert.ok(actions.includes(want), `audit should contain ${want}`);
      }

      child.kill('SIGKILL');
      child = null;

      // ---- corrupt row: boot C still comes up ------------------------
      {
        const raw = new DatabaseSync(dbFile);
        raw.prepare("UPDATE organization_nodes SET identity_json = 'not-json{{{' WHERE node_id = 'mgr-2'").run();
        raw.close();
      }
      s = await bootRealServer(dbFile);
      child = s.child;
      const p3 = s.port;
      const nodes3 = await call(p3, 'GET', '/api/org/nodes');
      assert.equal(nodes3.status, 200);
      const nodeIds3 = ((nodes3.body?.['nodes'] as Rec[]) ?? []).map((n) => n['id']).sort();
      assert.deepEqual(nodeIds3, ['mgr-1', 'wrk-1']); // bad row skipped
      const edges3 = await call(p3, 'GET', '/api/org/relationships');
      assert.equal(((edges3.body?.['edges'] as Rec[]) ?? []).length, 1); // good rows survive
      const audit3 = await call(p3, 'GET', '/api/audit?limit=200');
      const entries3 = (Array.isArray(audit3.body) ? audit3.body : []) as Rec[];
      assert.ok(entries3.some((e) => e['action'] === 'ORG_NODE_CORRUPT'), 'audit should contain ORG_NODE_CORRUPT');
      child.kill('SIGKILL');
      child = null;
    } finally {
      if (child) child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

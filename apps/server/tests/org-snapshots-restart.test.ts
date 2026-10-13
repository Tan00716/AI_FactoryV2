/**
 * Versioned org-graph snapshot history survives restarts — SPEC v2 §9.4 (Batch 35).
 *
 * §9.4: "图变更为事务和版本…历史 Run 继续能解析当时的组织版本。"
 * Until Batch 35 the only versioned history was OrgGraphV2's in-memory
 * Snapshot[] — a restart forgot it. Now every persisted mutation
 * appends an org_version_snapshots row carrying the full graph as of
 * that version (per-database monotonic graph_version, first = 1):
 *   - POST /api/org/nodes → NODE_ADDED snapshot;
 *   - POST /api/org/relationships → EDGE_ADDED snapshot;
 *   - DELETE /api/org/relationships/:id → EDGE_REMOVED snapshot;
 *   - GET /api/org/snapshots lists the history (newest first, with
 *     node/edge counts);
 *   - GET /api/org/snapshots/:id resolves the graph exactly as it was
 *     (the durable equivalent of OrgGraphV2.resolveAt) — the §9.4
 *     "historical run resolves the org version" read.
 *
 * Snapshot rows are terminal record state: they hydrate as-is across
 * restarts, nothing is demoted. A pre-Batch-35 database gets one
 * GENESIS snapshot at boot recording the REAL current state — it
 * records what is there, never invents history. Corrupt graph_json
 * rows are skipped loudly (ORG_SNAPSHOT_CORRUPT), one bad row never
 * hides the rest.
 *
 * Pinned on the REAL server binary (boot → SIGKILL → reboot on the
 * same DB file). Boots dist/index.js, so this file runs after the
 * server build.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ADMIN = 'gov-org-snapshots-admin-xyz';

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

describe('org version snapshot history (§9.4 durable, Batch 35)', () => {
  it('every mutation appends a versioned snapshot; history survives SIGKILL restarts', { timeout: 180_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-org-snapshots-'));
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

      // ---- boot A: mutations append snapshots ------------------------
      let s = await bootRealServer(dbFile);
      child = s.child;
      const p = s.port;

      const nodeA = await call(p, 'POST', '/api/org/nodes', {
        id: 'snap-a',
        org_id: 'org-1',
        type: 'AI_EMPLOYEE',
        display_name: 'worker a',
      });
      assert.equal(nodeA.status, 200);
      const nodeB = await call(p, 'POST', '/api/org/nodes', {
        id: 'snap-b',
        org_id: 'org-1',
        type: 'AI_EMPLOYEE',
        display_name: 'worker b',
      });
      assert.equal(nodeB.status, 200);
      const edge = await call(p, 'POST', '/api/org/relationships', {
        source_node_id: 'snap-a',
        target_node_id: 'snap-b',
        relationship_type: 'PRIMARY_REPORTS_TO',
        authority_scope: 'org',
        created_by: 'tester',
        policy_ref: 'policy-v1',
      });
      assert.equal(edge.status, 200);

      const list1 = await call(p, 'GET', '/api/org/snapshots');
      assert.equal(list1.status, 200);
      const snaps1 = (list1.body?.['snapshots'] as Rec[]) ?? [];
      assert.equal(snaps1.length, 3);
      // newest first, versions 3,2,1
      assert.deepEqual(
        snaps1.map((x) => x['graph_version']),
        [3, 2, 1],
      );
      assert.deepEqual(
        snaps1.map((x) => x['change']),
        ['EDGE_ADDED', 'NODE_ADDED', 'NODE_ADDED'],
      );
      assert.equal(snaps1[0]!['edge_count'], 1);
      assert.equal(snaps1[0]!['node_count'], 2);
      assert.equal(snaps1[2]!['node_count'], 1);
      assert.equal(snaps1[2]!['edge_count'], 0);

      // Resolve history: version 1 sees only node a; version 2 sees both; version 3 the edge.
      const byId = (snap: Rec) => snap['snapshot_id'] as string;
      const r1 = await call(p, 'GET', `/api/org/snapshots/${byId(snaps1[2]!)}`);
      assert.equal(r1.status, 200);
      assert.deepEqual((r1.body?.['nodes'] as Rec[]).map((n) => n['id']), ['snap-a']);
      assert.deepEqual(r1.body?.['edges'], []);
      const r3 = await call(p, 'GET', `/api/org/snapshots/${byId(snaps1[0]!)}`);
      assert.equal(r3.status, 200);
      assert.deepEqual((r3.body?.['nodes'] as Rec[]).map((n) => n['id']).sort(), ['snap-a', 'snap-b']);
      assert.equal((r3.body?.['edges'] as Rec[]).length, 1);
      assert.equal(r1.body?.['snapshot']?.['graph_version'], 1);

      // Unknown snapshot -> 404.
      const r404 = await call(p, 'GET', '/api/org/snapshots/orgsnap-does-not-exist');
      assert.equal(r404.status, 404);

      // Remove the edge -> EDGE_REMOVED snapshot, graph without the edge.
      const del = await call(p, 'DELETE', `/api/org/relationships/${edge.body?.['edge']?.['id']}`);
      assert.equal(del.status, 200);
      const list2 = await call(p, 'GET', '/api/org/snapshots');
      const snaps2 = (list2.body?.['snapshots'] as Rec[]) ?? [];
      assert.equal(snaps2.length, 4);
      assert.equal(snaps2[0]!['change'], 'EDGE_REMOVED');
      assert.equal(snaps2[0]!['graph_version'], 4);
      const r4 = await call(p, 'GET', `/api/org/snapshots/${byId(snaps2[0]!)}`);
      assert.deepEqual(r4.body?.['edges'], []);
      assert.equal((r4.body?.['nodes'] as Rec[]).length, 2);

      child.kill('SIGKILL');
      child = null;

      // ---- boot B: history hydrates as-is, nothing demoted ------------
      s = await bootRealServer(dbFile);
      child = s.child;
      const p2 = s.port;
      const listB = await call(p2, 'GET', '/api/org/snapshots');
      assert.equal(listB.status, 200);
      const snapsB = (listB.body?.['snapshots'] as Rec[]) ?? [];
      assert.equal(snapsB.length, 4);
      assert.deepEqual(
        snapsB.map((x) => x['graph_version']),
        [4, 3, 2, 1],
      );
      // The historical edge is still resolvable after the restart.
      const r3b = await call(p2, 'GET', `/api/org/snapshots/${byId(snapsB[1]!)}`);
      assert.equal((r3b.body?.['edges'] as Rec[]).length, 1);
      const audit = await call(p2, 'GET', '/api/audit?limit=200');
      const actions = ((Array.isArray(audit.body) ? audit.body : []) as Rec[]).map((e) => e['action']);
      assert.ok(actions.includes('ORG_SNAPSHOT_HISTORY_HYDRATED'), 'audit should contain ORG_SNAPSHOT_HISTORY_HYDRATED');

      child.kill('SIGKILL');
      child = null;

      // ---- corrupt row: boot C still comes up, bad row skipped loudly --
      {
        const raw = new DatabaseSync(dbFile);
        raw.prepare("UPDATE org_version_snapshots SET graph_json = 'not-json{{{' WHERE graph_version = 2").run();
        raw.close();
      }
      s = await bootRealServer(dbFile);
      child = s.child;
      const p3 = s.port;
      const listC = await call(p3, 'GET', '/api/org/snapshots');
      assert.equal(listC.status, 200);
      const snapsC = (listC.body?.['snapshots'] as Rec[]) ?? [];
      // Bad version-2 row is skipped; good rows still list.
      assert.deepEqual(
        snapsC.map((x) => x['graph_version']),
        [4, 3, 1],
      );
      const corruptDetail = await call(p3, 'GET', `/api/org/snapshots/${byId(snapsB[2]!)}`);
      assert.equal(corruptDetail.status, 500);
      assert.equal((corruptDetail.body as Rec)['code'], 'ORG_SNAPSHOT_CORRUPT');
      const audit3 = await call(p3, 'GET', '/api/audit?limit=200');
      const actions3 = ((Array.isArray(audit3.body) ? audit3.body : []) as Rec[]).map((e) => e['action']);
      assert.ok(actions3.includes('ORG_SNAPSHOT_CORRUPT'), 'audit should contain ORG_SNAPSHOT_CORRUPT');
      child.kill('SIGKILL');
      child = null;
    } finally {
      if (child) child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pre-Batch-35 database gets one GENESIS snapshot at boot, recording real state', { timeout: 180_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-org-snapshots-genesis-'));
    const dbFile = join(dir, 'factory.db');
    let child: ChildProcess | null = null;
    try {
      // Create nodes/edges rows directly, no snapshots (simulates a Batch-34-era DB).
      {
        const raw = new DatabaseSync(dbFile);
        raw.exec(`CREATE TABLE IF NOT EXISTS organization_nodes (
          node_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, type TEXT NOT NULL,
          display_name TEXT NOT NULL, identity_json TEXT, version INTEGER NOT NULL,
          status TEXT NOT NULL, tombstone INTEGER NOT NULL DEFAULT 0)`);
        raw.exec(`CREATE TABLE IF NOT EXISTS organization_relationships (
          edge_id TEXT PRIMARY KEY, source_node_id TEXT NOT NULL, target_node_id TEXT NOT NULL,
          relationship_type TEXT NOT NULL, project_scope TEXT, authority_scope TEXT NOT NULL,
          valid_from TEXT NOT NULL, valid_to TEXT, version INTEGER NOT NULL,
          created_by TEXT NOT NULL, policy_ref TEXT NOT NULL)`);
        raw.prepare(
          `INSERT INTO organization_nodes (node_id, org_id, type, display_name, version, status, tombstone)
           VALUES ('gen-a', 'org-1', 'AI_EMPLOYEE', 'gen worker', 1, 'ACTIVE', 0)`,
        ).run();
        raw.close();
      }
      const s = await bootRealServer(dbFile);
      child = s.child;
      const call = async (method: string, path: string) => {
        const res = await fetch(`http://127.0.0.1:${s.port}${path}`, {
          method,
          headers: { Authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
        });
        return { status: res.status, body: (await res.json().catch(() => null)) as Rec | null };
      };
      const list = await call('GET', '/api/org/snapshots');
      assert.equal(list.status, 200);
      const snaps = (list.body?.['snapshots'] as Rec[]) ?? [];
      assert.equal(snaps.length, 1);
      assert.equal(snaps[0]!['change'], 'GENESIS');
      assert.equal(snaps[0]!['graph_version'], 1);
      assert.equal(snaps[0]!['node_count'], 1);
      // The genesis snapshot resolves the REAL current state.
      const detail = await call('GET', `/api/org/snapshots/${snaps[0]!['snapshot_id']}`);
      assert.deepEqual((detail.body?.['nodes'] as Rec[]).map((n) => n['id']), ['gen-a']);
      child.kill('SIGKILL');
      child = null;
    } finally {
      if (child) child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

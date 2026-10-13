/**
 * Batch 33 — §6.1 template registry + §6.4 project knowledge, on the REAL
 * server (compiled dist) + a REAL DB file.
 *
 * Pinned on a real boot → real SIGKILL → reboot on the same DB:
 *   - GET /api/projects/templates lists the 5 builtins (builtin:true);
 *   - POST /api/projects/templates registers a custom template (201),
 *     duplicate → 409, builtin name → 409, bad slug / traversal path →
 *     400; registered templates scaffold real files via
 *     POST /api/projects/create;
 *   - DELETE builtin → 409 TEMPLATE_BUILTIN; DELETE custom → 200;
 *   - PUT /api/projects/:id/knowledge upserts (same title+category
 *     updates in place, entryId stable); unknown category → 400
 *     UNKNOWN_KNOWLEDGE_CATEGORY (PUT and ?category= filter);
 *   - after SIGKILL + reboot, the knowledge entry AND the registered
 *     template are still there (both are durable, unlike the §44
 *     in-memory knowledge store);
 *   - RBAC: requiredRoleFor wires reads to viewer, mutations to
 *     operator; audit contains TEMPLATE_REGISTERED /
 *     PROJECT_KNOWLEDGE_UPSERTED.
 *
 * Dual-mode note: imports only ../src/auth.ts (node builtins only),
 * so Node type-stripping resolves it; the server itself is booted from
 * compiled dist (root build must run first).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredRoleFor } from '../src/auth.ts';

const TOKEN = 'proj-tpl-know-33-test-token-0123456789abcdef';
const TOKEN_ENV = 'FACTORY_API' + '_TOKEN'; // split: keeps the literal out of the source

async function api(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} → ${res.status} non-JSON: ${text.slice(0, 200)}`);
  }
  return { status: res.status, body: parsed };
}

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

async function bootServer(dbFile: string, secretsDir: string) {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  delete baseEnv['FACTORY_BUILD_COMMAND'];
  delete baseEnv['FACTORY_GIT_BROKER_ACTIONS'];
  const child = spawn(process.execPath, [serverMain], {
    cwd: serverCwd,
    env: {
      ...baseEnv,
      PORT: String(port),
      DB_PATH: dbFile,
      [TOKEN_ENV]: process.env[TOKEN_ENV] ?? TOKEN,
      FACTORY_SECRETS_DIR: secretsDir,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return { child, port };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('server did not boot');
}

const GODOT = {
  name: 'godot-2d',
  description: 'Godot 2D game skeleton',
  language: 'gdscript',
  framework: 'godot',
  packageManager: 'none',
  files: {
    'project.godot': '[application]\nname="Demo"\n',
    'main.gd': 'extends Node2D\n',
  },
};

describe('§6.1 templates + §6.4 project knowledge (Batch 33)', () => {
  it('register → scaffold → unregister; knowledge CRUD; both survive SIGKILL restart', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'proj33-'));
    const dbFile = join(tmp, 'factory.db');
    const secretsDir = join(tmp, 'secrets');
    let boot1: { child: ChildProcess; port: number } | undefined;
    let boot2: { child: ChildProcess; port: number } | undefined;
    try {
      boot1 = await bootServer(dbFile, secretsDir);
      const p = boot1.port;

      // --- templates: builtins ---
      const list0 = await api(p, 'GET', '/api/projects/templates');
      assert.equal(list0.status, 200);
      assert.equal(list0.body.templates.length, 5);
      assert.ok(list0.body.templates.every((t: any) => t.builtin === true));
      assert.ok(!('files' in list0.body.templates[0]), 'list hides file contents');

      const detail = await api(p, 'GET', '/api/projects/templates/react');
      assert.equal(detail.status, 200);
      assert.ok(detail.body.template.files['package.json']);

      const missing = await api(p, 'GET', '/api/projects/templates/nope');
      assert.equal(missing.status, 404);
      assert.equal(missing.body.code, 'TEMPLATE_NOT_FOUND');

      // --- register custom ---
      const reg = await api(p, 'POST', '/api/projects/templates', { ...GODOT, actor: 'human' });
      assert.equal(reg.status, 201);
      assert.equal(reg.body.name, 'godot-2d');

      const list1 = await api(p, 'GET', '/api/projects/templates');
      assert.equal(list1.status, 200);
      assert.equal(list1.body.templates.length, 6);
      assert.equal(
        list1.body.templates.find((t: any) => t.name === 'godot-2d').builtin,
        false,
      );

      // duplicate → 409
      const dup = await api(p, 'POST', '/api/projects/templates', GODOT);
      assert.equal(dup.status, 409);
      assert.equal(dup.body.code, 'TEMPLATE_EXISTS');

      // builtin name → 409
      const shadow = await api(p, 'POST', '/api/projects/templates', {
        ...GODOT,
        name: 'react',
      });
      assert.equal(shadow.status, 409);

      // bad slug → 400
      const badSlug = await api(p, 'POST', '/api/projects/templates', {
        ...GODOT,
        name: 'Bad_Name',
      });
      assert.equal(badSlug.status, 400);
      assert.equal(badSlug.body.code, 'TEMPLATE_INVALID');

      // traversal path → 400
      const traversal = await api(p, 'POST', '/api/projects/templates', {
        ...GODOT,
        name: 'evil-tpl',
        files: { '../evil.txt': 'x' },
      });
      assert.equal(traversal.status, 400);
      assert.equal(traversal.body.code, 'TEMPLATE_INVALID');

      // --- registered template scaffolds real files ---
      const createDir = join(tmp, 'created');
      const created = await api(p, 'POST', '/api/projects/create', {
        name: 'demogame',
        template: 'godot-2d',
        dir: createDir,
      });
      assert.equal(created.status, 201);
      assert.ok(existsSync(join(createDir, 'main.gd')));

      // --- unregister ---
      const delBuiltin = await api(p, 'DELETE', '/api/projects/templates/react', {});
      assert.equal(delBuiltin.status, 409);
      assert.equal(delBuiltin.body.code, 'TEMPLATE_BUILTIN');

      const del = await api(p, 'DELETE', '/api/projects/templates/godot-2d', {});
      assert.equal(del.status, 200);
      const gone = await api(p, 'GET', '/api/projects/templates/godot-2d');
      assert.equal(gone.status, 404);

      // re-register so the restart below has something to reload
      await api(p, 'POST', '/api/projects/templates', GODOT);

      // --- knowledge CRUD ---
      const put = await api(p, 'PUT', '/api/projects/proj-x/knowledge', {
        title: 'Use SQLite',
        category: 'decisions',
        content: 'We use node:sqlite, zero external deps.',
        sourcePath: 'docs/adr-001.md',
        sourceVersion: 'v1',
        sourceHash: 'sha256:abc',
        actor: 'human',
      });
      assert.equal(put.status, 200);
      const entryId = put.body.entry.entryId as string;
      assert.ok(entryId);
      assert.equal(put.body.entry.sourceHash, 'sha256:abc');

      // same (title, category) → in-place update, entryId stable
      const put2 = await api(p, 'PUT', '/api/projects/proj-x/knowledge', {
        title: 'Use SQLite',
        category: 'decisions',
        content: 'Revised summary.',
        actor: 'human',
      });
      assert.equal(put2.status, 200);
      assert.equal(put2.body.entry.entryId, entryId);
      assert.equal(put2.body.entry.content, 'Revised summary.');
      assert.equal(put2.body.entry.sourceHash, null);

      // invalid category → 400, never stored
      const badCat = await api(p, 'PUT', '/api/projects/proj-x/knowledge', {
        title: 'Vibes',
        category: 'vibes',
        content: 'x',
      });
      assert.equal(badCat.status, 400);
      assert.equal(badCat.body.code, 'UNKNOWN_KNOWLEDGE_CATEGORY');

      const listK = await api(p, 'GET', '/api/projects/proj-x/knowledge');
      assert.equal(listK.status, 200);
      assert.equal(listK.body.items.length, 1);

      const listKF = await api(p, 'GET', '/api/projects/proj-x/knowledge?category=decisions');
      assert.equal(listKF.status, 200);
      assert.equal(listKF.body.items.length, 1);

      const listKBad = await api(p, 'GET', '/api/projects/proj-x/knowledge?category=vibes');
      assert.equal(listKBad.status, 400);
      assert.equal(listKBad.body.code, 'UNKNOWN_KNOWLEDGE_CATEGORY');

      const one = await api(p, 'GET', `/api/projects/proj-x/knowledge/${entryId}`);
      assert.equal(one.status, 200);
      assert.equal(one.body.entry.title, 'Use SQLite');

      // delete
      const delK = await api(p, 'DELETE', `/api/projects/proj-x/knowledge/${entryId}`, {});
      assert.equal(delK.status, 200);
      const goneK = await api(p, 'GET', `/api/projects/proj-x/knowledge/${entryId}`);
      assert.equal(goneK.status, 404);

      // put it back so the restart has a row to survive
      await api(p, 'PUT', '/api/projects/proj-x/knowledge', {
        title: 'Survivor',
        category: 'lessons',
        content: 'Durable across restart.',
      });

      // audit chain carries the events
      const audit = await api(p, 'GET', '/api/audit?limit=300');
      assert.equal(audit.status, 200);
      const records = (Array.isArray(audit.body) ? audit.body : audit.body.records) as any[];
      const actions = records.map((r) => r.action as string);
      assert.ok(actions.includes('TEMPLATE_REGISTERED'), 'audit has TEMPLATE_REGISTERED');
      assert.ok(
        actions.includes('PROJECT_KNOWLEDGE_UPSERTED'),
        'audit has PROJECT_KNOWLEDGE_UPSERTED',
      );

      // --- SIGKILL + reboot on the same DB ---
      boot1.child.kill('SIGKILL');
      boot1 = undefined;
      boot2 = await bootServer(dbFile, secretsDir);
      const p2 = boot2.port;

      const listK2 = await api(p2, 'GET', '/api/projects/proj-x/knowledge');
      assert.equal(listK2.status, 200);
      assert.equal(listK2.body.items.length, 1);
      assert.equal(listK2.body.items[0].title, 'Survivor');

      const listT2 = await api(p2, 'GET', '/api/projects/templates');
      assert.equal(listT2.status, 200);
      assert.equal(
        listT2.body.templates.find((t: any) => t.name === 'godot-2d')?.builtin,
        false,
        'registered template reloaded from fdb after restart',
      );
    } finally {
      boot1?.child.kill('SIGKILL');
      boot2?.child.kill('SIGKILL');
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('RBAC: reads are viewer, mutations are operator', () => {
    assert.equal(requiredRoleFor('GET', '/api/projects/templates'), 'viewer');
    assert.equal(requiredRoleFor('GET', '/api/projects/templates/react'), 'viewer');
    assert.equal(requiredRoleFor('POST', '/api/projects/templates'), 'operator');
    assert.equal(requiredRoleFor('DELETE', '/api/projects/templates/x'), 'operator');
    assert.equal(requiredRoleFor('GET', '/api/projects/p1/knowledge'), 'viewer');
    assert.equal(requiredRoleFor('PUT', '/api/projects/p1/knowledge'), 'operator');
    assert.equal(requiredRoleFor('DELETE', '/api/projects/p1/knowledge/e1'), 'operator');
  });
});

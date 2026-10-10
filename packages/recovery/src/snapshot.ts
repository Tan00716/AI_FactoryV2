/**
 * Snapshot store — spec §77.
 *
 * take(workspaceDir, {dbPath, tag}) → immutable SnapshotManifest:
 *   - walks the workspace, records sha256 per file
 *   - copies every file into <root>/<id>/files/ (plus the db file if given)
 *   - seals the snapshot (seal binds the manifest hash; tampering is detected)
 *
 * restore(id, workspaceDir?) → applies the snapshot:
 *   1. requires a sealed, integrity-verified snapshot (else throws)
 *   2. FIRST takes a fresh backup snapshot of the current state, tagged
 *      `pre-restore:<id>` — so the rollback itself is roll-backable
 *   3. replaces the workspace contents with the snapshot contents
 *
 * Snapshots are immutable: after seal() the manifest + files are never
 * rewritten; verify() re-hashes everything on demand.
 */

import { createHash, randomUUID } from 'crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import type { Clock, SnapshotFile, SnapshotManifest } from './types';
import { isoNow } from './types';

export interface TakeOptions {
  dbPath?: string;
  tag?: string;
  clock?: Clock;
  /** Internal/test escape hatch: leave the snapshot unsealed. Default true. */
  seal?: boolean;
}

export interface SnapshotStoreOptions {
  clock?: Clock;
}

export class SnapshotError extends Error {}

function sha256File(path: string): { hash: string; size: number } {
  const data = readFileSync(path);
  return {
    hash: createHash('sha256').update(data).digest('hex'),
    size: data.length,
  };
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

export class SnapshotStore {
  private root: string;
  private clock?: Clock;

  constructor(root: string, opts: SnapshotStoreOptions = {}) {
    this.root = resolve(root);
    this.clock = opts.clock;
    mkdirSync(this.root, { recursive: true });
  }

  private snapDir(id: string): string {
    return join(this.root, id);
  }

  private manifestPath(id: string): string {
    return join(this.snapDir(id), 'manifest.json');
  }

  private sealPath(id: string): string {
    return join(this.snapDir(id), 'sealed.json');
  }

  /** Take an immutable snapshot of a workspace directory (+ optional db file). */
  take(workspaceDir: string, opts: TakeOptions = {}): SnapshotManifest {
    const ws = resolve(workspaceDir);
    if (!existsSync(ws) || !statSync(ws).isDirectory()) {
      throw new SnapshotError(`workspace directory not found: ${ws}`);
    }
    if (ws === this.root || ws.startsWith(this.root + sep)) {
      throw new SnapshotError(
        'workspaceDir must not contain the snapshot store root',
      );
    }
    if (opts.dbPath) {
      const db = resolve(opts.dbPath);
      if (db === this.root || db.startsWith(this.root + sep)) {
        throw new SnapshotError('dbPath must not live inside the snapshot store root');
      }
    }

    const id = randomUUID();
    const dir = this.snapDir(id);
    const filesDir = join(dir, 'files');
    mkdirSync(filesDir, { recursive: true });

    const files: SnapshotFile[] = [];
    for (const full of listFiles(ws)) {
      const rel = toPosix(relative(ws, full));
      const { hash, size } = sha256File(full);
      const dest = join(filesDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(full, dest);
      files.push({ path: rel, hash, size });
    }

    let dbPath: string | null = null;
    let dbHash: string | null = null;
    if (opts.dbPath) {
      const db = resolve(opts.dbPath);
      if (!existsSync(db) || !statSync(db).isFile()) {
        throw new SnapshotError(`db file not found: ${db}`);
      }
      const { hash, size } = sha256File(db);
      cpSync(db, join(dir, 'db.sqlite'));
      void size;
      dbPath = db;
      dbHash = hash;
    }

    const manifest: SnapshotManifest = {
      id,
      createdAt: isoNow(this.clock ?? opts.clock),
      workspaceDir: ws,
      dbPath,
      dbHash,
      files,
      tag: opts.tag,
      sealed: false,
    };
    writeFileSync(this.manifestPath(id), JSON.stringify(manifest, null, 2));

    if (opts.seal !== false) this.seal(id);
    return this.get(id) as SnapshotManifest;
  }

  /** Seal a snapshot: bind the manifest hash; after this it is immutable. */
  seal(id: string): SnapshotManifest {
    const manifest = this.get(id);
    if (!manifest) throw new SnapshotError(`snapshot not found: ${id}`);
    const manifestJson = readFileSync(this.manifestPath(id), 'utf8');
    const seal = {
      sealedAt: isoNow(this.clock),
      manifestHash: createHash('sha256').update(manifestJson).digest('hex'),
    };
    writeFileSync(this.sealPath(id), JSON.stringify(seal, null, 2));
    const sealed: SnapshotManifest = { ...manifest, sealed: true };
    writeFileSync(this.manifestPath(id), JSON.stringify(sealed, null, 2));
    // Re-bind the seal to the final manifest (with sealed:true).
    const finalJson = readFileSync(this.manifestPath(id), 'utf8');
    writeFileSync(
      this.sealPath(id),
      JSON.stringify(
        {
          sealedAt: seal.sealedAt,
          manifestHash: createHash('sha256').update(finalJson).digest('hex'),
        },
        null,
        2,
      ),
    );
    return sealed;
  }

  get(id: string): SnapshotManifest | null {
    const p = this.manifestPath(id);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8')) as SnapshotManifest;
  }

  list(): SnapshotManifest[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => this.get(e.name))
      .filter((m): m is SnapshotManifest => m !== null)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  /** Re-hash everything; detects any tampering of a sealed snapshot. */
  verify(id: string): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    const manifest = this.get(id);
    if (!manifest) return { ok: false, errors: [`snapshot not found: ${id}`] };
    if (!manifest.sealed || !existsSync(this.sealPath(id))) {
      errors.push('snapshot is not sealed');
    } else {
      const seal = JSON.parse(readFileSync(this.sealPath(id), 'utf8')) as {
        manifestHash: string;
      };
      const manifestJson = readFileSync(this.manifestPath(id), 'utf8');
      if (
        createHash('sha256').update(manifestJson).digest('hex') !==
        seal.manifestHash
      ) {
        errors.push('manifest was modified after sealing');
      }
    }
    const filesDir = join(this.snapDir(id), 'files');
    for (const f of manifest.files) {
      const p = join(filesDir, f.path);
      if (!existsSync(p)) {
        errors.push(`missing stored file: ${f.path}`);
        continue;
      }
      const { hash } = sha256File(p);
      if (hash !== f.hash) errors.push(`hash mismatch (tampered): ${f.path}`);
    }
    if (manifest.dbPath && manifest.dbHash) {
      const dbp = join(this.snapDir(id), 'db.sqlite');
      if (!existsSync(dbp)) errors.push('missing stored db file');
      else if (sha256File(dbp).hash !== manifest.dbHash) {
        errors.push('db file hash mismatch (tampered)');
      }
    }
    return { ok: errors.length === 0, errors };
  }

  /**
   * Restore a snapshot into a workspace directory.
   * The current state is backed up FIRST as a new snapshot tagged
   * `pre-restore:<id>` so the rollback itself can be rolled back.
   * Returns the backup manifest.
   */
  restore(id: string, workspaceDir?: string): SnapshotManifest {
    const manifest = this.get(id);
    if (!manifest) throw new SnapshotError(`snapshot not found: ${id}`);
    const v = this.verify(id);
    if (!v.ok) {
      throw new SnapshotError(
        `snapshot ${id} failed integrity check: ${v.errors.join('; ')}`,
      );
    }
    const ws = resolve(workspaceDir ?? manifest.workspaceDir);
    if (!existsSync(ws)) mkdirSync(ws, { recursive: true });

    // 1. Back up the current state before touching anything.
    const backup = this.take(ws, {
      tag: `pre-restore:${id}`,
      clock: this.clock,
    });

    // 2. Replace workspace contents with the snapshot contents.
    const filesDir = join(this.snapDir(id), 'files');
    for (const entry of readdirSync(ws, { withFileTypes: true })) {
      rmSync(join(ws, entry.name), { recursive: true, force: true });
    }
    for (const f of manifest.files) {
      const dest = join(ws, f.path);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(filesDir, f.path), dest);
    }
    if (manifest.dbPath && manifest.dbHash) {
      cpSync(join(this.snapDir(id), 'db.sqlite'), manifest.dbPath);
    }
    return backup;
  }
}

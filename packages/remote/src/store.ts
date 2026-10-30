/**
 * Atomic JSON store for remote connections (R7-#1).
 *
 * File: <AI_FACTORY_DATA_DIR>/remote-connections.json (route layer
 * resolves the directory). Writes go to a temp sibling + rename, so a
 * crashed write never leaves a half-written file. A corrupt file is
 * fail-closed: the store throws STORE_CORRUPT and refuses to overwrite
 * it, instead of silently resetting the user's connections.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  RemoteError,
  newConnection,
  validateConnectionInput,
  type RemoteConnection,
  type RemoteConnectionInput,
  type RemoteStatus,
} from './types';

const FILE_VERSION = 1;

interface StoreFile {
  version: number;
  connections: RemoteConnection[];
}

export class RemoteConnectionStore {
  filePath: string;
  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private readAll(): RemoteConnection[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new RemoteError('STORE_READ_FAILED', `cannot read ${this.filePath}: ${(e as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new RemoteError(
        'STORE_CORRUPT',
        'remote-connections.json is corrupt JSON; refusing to overwrite it (rename it away explicitly)',
      );
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as StoreFile).version !== FILE_VERSION ||
      !Array.isArray((parsed as StoreFile).connections)
    ) {
      throw new RemoteError('STORE_CORRUPT', 'remote-connections.json has an unknown shape; refusing to overwrite it');
    }
    return (parsed as StoreFile).connections;
  }

  private writeAll(connections: RemoteConnection[]): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, connections }, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  list(): RemoteConnection[] {
    return this.readAll();
  }

  get(id: string): RemoteConnection | null {
    return this.readAll().find((c) => c.id === id) ?? null;
  }

  create(body: unknown): RemoteConnection {
    const input: RemoteConnectionInput = validateConnectionInput(body);
    const all = this.readAll();
    if (all.some((c) => c.name === input.name)) {
      throw new RemoteError('DUPLICATE_NAME', `a connection named '${input.name}' already exists`);
    }
    const conn = newConnection(input);
    all.push(conn);
    this.writeAll(all);
    return conn;
  }

  setStatus(
    id: string,
    patch: { status: RemoteStatus; lastProbeAt?: string | null; lastProbeMs?: number | null; lastError?: string | null },
  ): RemoteConnection {
    const all = this.readAll();
    const conn = all.find((c) => c.id === id);
    if (!conn) throw new RemoteError('NOT_FOUND', `no connection ${id}`);
    conn.status = patch.status;
    if (patch.lastProbeAt !== undefined) conn.lastProbeAt = patch.lastProbeAt;
    if (patch.lastProbeMs !== undefined) conn.lastProbeMs = patch.lastProbeMs;
    if (patch.lastError !== undefined) conn.lastError = patch.lastError;
    conn.updatedAt = new Date().toISOString();
    this.writeAll(all);
    return conn;
  }

  remove(id: string): boolean {
    const all = this.readAll();
    const next = all.filter((c) => c.id !== id);
    if (next.length === all.length) return false;
    this.writeAll(next);
    return true;
  }
}

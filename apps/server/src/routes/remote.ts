/**
 * Remote development routes (R7-#1).
 *
 *   GET    /api/remote/connections                    list (viewer)
 *   POST   /api/remote/connections                    create (operator)
 *   GET    /api/remote/connections/:id                get (viewer)
 *   DELETE /api/remote/connections/:id                delete (operator)
 *   POST   /api/remote/connections/:id/probe          probe reachability (operator)
 *   POST   /api/remote/connections/:id/disconnect     stop forwards, mark offline (operator)
 *   POST   /api/remote/connections/:id/exec           { command } (operator)
 *   GET    /api/remote/connections/:id/files?path=    list dir (viewer)
 *   GET    /api/remote/connections/:id/file?path=    read file (viewer)
 *   POST   /api/remote/connections/:id/file           { path, content } (operator)
 *   GET    /api/remote/connections/:id/forwards       list tunnels (viewer)
 *   POST   /api/remote/connections/:id/forwards       { localPort, remoteHost, remotePort } (operator)
 *   DELETE /api/remote/connections/:id/forwards/:port  stop tunnel (operator)
 *
 * Fail-closed rules (no silent local fallback, ever):
 * - exec/file/forward ops on a connection whose stored status is not
 *   'online' are refused with 409 NOT_CONNECTED. A failed probe never
 *   reroutes work to the local machine; `local` is a kind you choose
 *   explicitly when creating the connection.
 * - Remote commands pass the injected exec policy (the same
 *   checkCommandPolicy as /api/exec, wired by the coordinator). If the
 *   policy is unwired, exec answers 503 instead of running anything.
 *
 * Secret hygiene (audited and enforced):
 * - Audit details carry connection id + kind + outcome only. They
 *   never carry keyPath, command text, or file content — a command or
 *   a file could itself contain a secret.
 * - The key file is never opened by this process: ssh receives
 *   `-i <keyPath>` only (see @ai-factory/remote).
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) maps GET ->
 * viewer and POST/DELETE -> operator for this prefix — no auth.ts
 * change. Store: <AI_FACTORY_DATA_DIR|data>/remote-connections.json.
 *
 * Dual-mode: value imports are node builtins + @ai-factory/* packages
 * only, so tests may import this module from src with an explicit `.ts`
 * suffix; the HTTP tests boot the real dist server instead.
 */
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { redactText } from '@ai-factory/diagpack';
import {
  FILE_MAX_BYTES,
  RemoteConnectionStore,
  RemoteError,
  listDir,
  listForwards,
  probe,
  readFile,
  runCommand,
  startForward,
  stopAllForwards,
  stopForward,
  writeFile,
  type RemoteConnection,
} from '@ai-factory/remote';
import type { RouteContext } from './context';

const PREFIX = '/api/remote';

export const REMOTE_CONNECTION_CREATED = 'REMOTE_CONNECTION_CREATED';
export const REMOTE_CONNECTION_DELETED = 'REMOTE_CONNECTION_DELETED';
export const REMOTE_PROBE = 'REMOTE_PROBE';
export const REMOTE_DISCONNECTED = 'REMOTE_DISCONNECTED';
export const REMOTE_EXEC = 'REMOTE_EXEC';
export const REMOTE_FILE_WRITTEN = 'REMOTE_FILE_WRITTEN';
export const REMOTE_FORWARD_STARTED = 'REMOTE_FORWARD_STARTED';
export const REMOTE_FORWARD_STOPPED = 'REMOTE_FORWARD_STOPPED';

/** Exec policy: coordinator-injected (checkCommandPolicy). */
let execPolicy: ((command: string) => string[]) | null = null;

export function setRemoteExecPolicy(fn: ((command: string) => string[]) | null): void {
  execPolicy = fn;
}

function storePath(): string {
  const dir = process.env['AI_FACTORY_DATA_DIR'] ?? 'data';
  return path.resolve(dir, 'remote-connections.json');
}

function store(): RemoteConnectionStore {
  return new RemoteConnectionStore(storePath());
}

/** Audit details carry id + kind + outcome only — never keyPath, command text, or file content. */
function auditDetails(conn: RemoteConnection, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { connectionId: conn.id, kind: conn.kind, ...extra };
}

function errStatus(err: RemoteError): number {
  switch (err.code) {
    case 'INVALID_INPUT':
    case 'INVALID_PATH':
    case 'SECRET_FIELD_REJECTED':
      return 400;
    case 'NOT_FOUND':
      return 404;
    case 'DUPLICATE_NAME':
    case 'DUPLICATE_FORWARD':
    case 'NOT_CONNECTED':
    case 'UNSUPPORTED':
    case 'FORWARD_FAILED':
      return 409;
    case 'TRANSPORT_UNAVAILABLE':
    case 'TIMEOUT':
    case 'COMMAND_FAILED':
    case 'OUTPUT_TOO_LARGE':
      return 502;
    case 'STORE_CORRUPT':
    case 'STORE_READ_FAILED':
      return 500;
    default:
      return 500;
  }
}

function requireOnline(conn: RemoteConnection): RemoteConnection {
  if (conn.status !== 'online') {
    throw new RemoteError('NOT_CONNECTED', `connection '${conn.name}' is ${conn.status}; probe it first (no local fallback)`);
  }
  return conn;
}

export async function handleRemoteRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const p = url.pathname;
  if (p !== PREFIX && !pathMatches(p)) return false;
  const rest = p.slice(PREFIX.length);
  const seg = rest.split('/').filter((s) => s.length > 0);
  try {
    // GET /api/remote/connections
    if (method === 'GET' && seg.length === 1 && seg[0] === 'connections') {
      ctx.json(res, 200, { connections: store().list() });
      return true;
    }
    // POST /api/remote/connections
    if (method === 'POST' && seg.length === 1 && seg[0] === 'connections') {
      const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
      const conn = store().create(body);
      ctx.audit.record('human', REMOTE_CONNECTION_CREATED, 'remote', conn.id, auditDetails(conn));
      ctx.json(res, 201, { connection: conn });
      return true;
    }
    if (seg.length >= 2 && seg[0] === 'connections') {
      const id = decodeURIComponent(seg[1] as string);
      const st = store();
      const conn = st.get(id);
      if (!conn) {
        ctx.json(res, 404, { error: 'NOT_FOUND', detail: `no connection ${id}` });
        return true;
      }
      // GET /api/remote/connections/:id
      if (method === 'GET' && seg.length === 2) {
        ctx.json(res, 200, { connection: conn });
        return true;
      }
      // DELETE /api/remote/connections/:id
      if (method === 'DELETE' && seg.length === 2) {
        stopAllForwards(conn.id);
        st.remove(conn.id);
        ctx.audit.record('human', REMOTE_CONNECTION_DELETED, 'remote', conn.id, auditDetails(conn));
        ctx.json(res, 200, { deleted: true });
        return true;
      }
      // POST /api/remote/connections/:id/probe
      if (method === 'POST' && seg.length === 3 && seg[2] === 'probe') {
        const result = await probe(conn);
        const updated = st.setStatus(conn.id, {
          status: result.online ? 'online' : 'offline',
          lastProbeAt: new Date().toISOString(),
          lastProbeMs: result.latencyMs,
          lastError: result.online ? null : result.detail,
        });
        ctx.audit.record('human', REMOTE_PROBE, 'remote', conn.id, auditDetails(conn, {
          online: result.online,
          reason: result.reason,
          latencyMs: result.latencyMs,
        }));
        ctx.json(res, 200, { connection: updated, probe: result });
        return true;
      }
      // POST /api/remote/connections/:id/disconnect
      if (method === 'POST' && seg.length === 3 && seg[2] === 'disconnect') {
        const stopped = stopAllForwards(conn.id);
        const updated = st.setStatus(conn.id, { status: 'offline' });
        ctx.audit.record('human', REMOTE_DISCONNECTED, 'remote', conn.id, auditDetails(conn, { forwardsStopped: stopped }));
        ctx.json(res, 200, { connection: updated, forwardsStopped: stopped });
        return true;
      }
      // POST /api/remote/connections/:id/exec
      if (method === 'POST' && seg.length === 3 && seg[2] === 'exec') {
        if (!execPolicy) {
          ctx.json(res, 503, { error: 'UNWIRED', detail: 'remote exec policy is not wired' });
          return true;
        }
        requireOnline(conn);
        const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
        const command = body['command'];
        if (typeof command !== 'string' || !command.trim()) {
          ctx.json(res, 400, { error: 'INVALID_INPUT', detail: 'command is required' });
          return true;
        }
        let tokens: string[];
        try {
          tokens = execPolicy(command);
        } catch (e) {
          ctx.json(res, 403, { error: 'POLICY_DENIED', detail: (e as Error).message });
          return true;
        }
        let out;
        try {
          out = await runCommand(conn, tokens);
        } catch (e) {
          if (e instanceof RemoteError && e.code === 'TRANSPORT_UNAVAILABLE') {
            st.setStatus(conn.id, { status: 'offline', lastError: e.message });
          }
          throw e;
        }
        ctx.audit.record('human', REMOTE_EXEC, 'remote', conn.id, auditDetails(conn, {
          exitCode: out.exitCode,
          stdoutChars: out.stdout.length,
        }));
        // R15 #6(f): the exec response is returned verbatim to the API, so
        // secret-shaped values are redacted before returning (runhistory /
        // quality-gate precedent). The primary fix is the scrubbed child
        // env in transport.ts spawnCollect.
        ctx.json(res, 200, { stdout: redactText(out.stdout), stderr: redactText(out.stderr), exitCode: out.exitCode });
        return true;
      }
      // GET /api/remote/connections/:id/files?path=
      if (method === 'GET' && seg.length === 3 && seg[2] === 'files') {
        requireOnline(conn);
        const rel = url.searchParams.get('path') ?? '.';
        const entries = await listDir(conn, rel);
        ctx.json(res, 200, { path: rel, entries });
        return true;
      }
      // GET /api/remote/connections/:id/file?path=  |  POST .../file
      if (seg.length === 3 && seg[2] === 'file') {
        requireOnline(conn);
        if (method === 'GET') {
          const rel = url.searchParams.get('path');
          if (!rel) {
            ctx.json(res, 400, { error: 'INVALID_INPUT', detail: 'path query param is required' });
            return true;
          }
          const content = await readFile(conn, rel);
          ctx.json(res, 200, { path: rel, content });
          return true;
        }
        if (method === 'POST') {
          const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
          const rel = body['path'];
          const content = body['content'];
          if (typeof rel !== 'string' || !rel) {
            ctx.json(res, 400, { error: 'INVALID_INPUT', detail: 'path is required' });
            return true;
          }
          if (typeof content !== 'string') {
            ctx.json(res, 400, { error: 'INVALID_INPUT', detail: 'content must be a string' });
            return true;
          }
          if (Buffer.byteLength(content, 'utf8') > FILE_MAX_BYTES) {
            ctx.json(res, 400, { error: 'INVALID_INPUT', detail: `content exceeds ${FILE_MAX_BYTES} bytes` });
            return true;
          }
          await writeFile(conn, rel, content);
          ctx.audit.record('human', REMOTE_FILE_WRITTEN, 'remote', conn.id, auditDetails(conn, { path: rel }));
          ctx.json(res, 200, { written: true, path: rel });
          return true;
        }
      }
      // GET /api/remote/connections/:id/forwards
      if (method === 'GET' && seg.length === 3 && seg[2] === 'forwards') {
        ctx.json(res, 200, { forwards: listForwards(conn.id) });
        return true;
      }
      // POST /api/remote/connections/:id/forwards
      if (method === 'POST' && seg.length === 3 && seg[2] === 'forwards') {
        requireOnline(conn);
        const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
        const localPort = body['localPort'];
        const remoteHost = body['remoteHost'];
        const remotePort = body['remotePort'];
        if (typeof localPort !== 'number' || typeof remoteHost !== 'string' || typeof remotePort !== 'number') {
          ctx.json(res, 400, { error: 'INVALID_INPUT', detail: 'localPort, remoteHost, remotePort are required' });
          return true;
        }
        const rec = await startForward(conn, localPort, remoteHost, remotePort);
        ctx.audit.record('human', REMOTE_FORWARD_STARTED, 'remote', conn.id, auditDetails(conn, { localPort }));
        ctx.json(res, 201, { forward: rec });
        return true;
      }
      // DELETE /api/remote/connections/:id/forwards/:port
      if (method === 'DELETE' && seg.length === 4 && seg[2] === 'forwards') {
        const port = Number(seg[3]);
        if (!Number.isInteger(port)) {
          ctx.json(res, 400, { error: 'INVALID_INPUT', detail: 'port must be an integer' });
          return true;
        }
        const stopped = stopForward(conn.id, port);
        if (!stopped) {
          ctx.json(res, 404, { error: 'NOT_FOUND', detail: `no forward on local port ${port}` });
          return true;
        }
        ctx.audit.record('human', REMOTE_FORWARD_STOPPED, 'remote', conn.id, auditDetails(conn, { localPort: port }));
        ctx.json(res, 200, { stopped: true });
        return true;
      }
    }
  } catch (e) {
    if (e instanceof RemoteError) {
      ctx.json(res, errStatus(e), { error: e.code, detail: e.message });
      return true;
    }
    ctx.json(res, 500, { error: 'REMOTE_FAILED', detail: e instanceof Error ? e.message : String(e) });
    return true;
  }
  return false;
}

function pathMatches(p: string): boolean {
  return p.startsWith(`${PREFIX}/`);
}

/**
 * Port-forward lifecycle (R7-#1, ssh only).
 *
 * Forwards are process-bound: the tunnel is a child `ssh -N -L` process
 * tracked in memory. A server restart drops them (documented, not
 * silent: listForwards then reports nothing, and the panel shows the
 * forward as gone). Stopping kills the child; a SIGTERM-resistant child
 * gets SIGKILL after 1s. Forwards for non-ssh kinds are refused (409)
 * — there is no local fallback tunnel.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { RemoteError, type RemoteConnection } from './types';
import { sshPrefix } from './transport';

export interface ForwardRecord {
  connectionId: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  startedAt: string;
  alive: boolean;
}

interface LiveForward extends ForwardRecord {
  child: ChildProcess;
}

const live = new Map<string, LiveForward>();

export function forwardKey(connectionId: string, localPort: number): string {
  return `${connectionId}:${localPort}`;
}

function validateForward(localPort: number, remoteHost: string, remotePort: number): void {
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    throw new RemoteError('INVALID_INPUT', 'localPort must be an integer 1-65535');
  }
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw new RemoteError('INVALID_INPUT', 'remotePort must be an integer 1-65535');
  }
  if (!remoteHost || /[\s;|&$`><\\'"!*?~#(){}[\]]/.test(remoteHost) || remoteHost.startsWith('-')) {
    throw new RemoteError('INVALID_INPUT', 'remoteHost must be a plain host name');
  }
}

/**
 * Start a tunnel. Waits 500ms: an ssh that exits immediately (bad host,
 * bad key, refused port) surfaces as a failed start instead of a
 * phantom "running" forward.
 */
export async function startForward(
  conn: RemoteConnection,
  localPort: number,
  remoteHost: string,
  remotePort: number,
): Promise<ForwardRecord> {
  if (conn.kind !== 'ssh') {
    throw new RemoteError('UNSUPPORTED', `port forwards are ssh-only (kind is ${conn.kind})`);
  }
  validateForward(localPort, remoteHost, remotePort);
  const key = forwardKey(conn.id, localPort);
  const existing = live.get(key);
  if (existing && existing.child.exitCode === null && !existing.child.killed) {
    throw new RemoteError('DUPLICATE_FORWARD', `local port ${localPort} is already forwarded for this connection`);
  }
  const spec = `${localPort}:${remoteHost}:${remotePort}`;
  const child = spawn('ssh', ['-N', '-L', spec, ...sshPrefix(conn, 10)], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const rec: LiveForward = {
    connectionId: conn.id,
    localPort,
    remoteHost,
    remotePort,
    startedAt: new Date().toISOString(),
    alive: true,
    child,
  };
  live.set(key, rec);
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 500);
    timer.unref?.();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (exited) {
    live.delete(key);
    throw new RemoteError('FORWARD_FAILED', `ssh tunnel exited immediately (exit ${child.exitCode})`);
  }
  child.once('exit', () => {
    const cur = live.get(key);
    if (cur) cur.alive = false;
  });
  return publicForward(rec);
}

export function stopForward(connectionId: string, localPort: number): boolean {
  const key = forwardKey(connectionId, localPort);
  const rec = live.get(key);
  if (!rec) return false;
  live.delete(key);
  try {
    rec.child.kill('SIGTERM');
  } catch {
    // already gone
  }
  setTimeout(() => {
    try {
      if (rec.child.exitCode === null) rec.child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }, 1000).unref?.();
  return true;
}

export function stopAllForwards(connectionId: string): number {
  let n = 0;
  for (const key of [...live.keys()]) {
    if (key.startsWith(`${connectionId}:`)) {
      const localPort = Number(key.slice(connectionId.length + 1));
      if (stopForward(connectionId, localPort)) n += 1;
    }
  }
  return n;
}

export function listForwards(connectionId: string): ForwardRecord[] {
  const out: ForwardRecord[] = [];
  for (const rec of live.values()) {
    if (rec.connectionId !== connectionId) continue;
    out.push(publicForward(rec));
  }
  return out;
}

function publicForward(rec: LiveForward): ForwardRecord {
  return {
    connectionId: rec.connectionId,
    localPort: rec.localPort,
    remoteHost: rec.remoteHost,
    remotePort: rec.remotePort,
    startedAt: rec.startedAt,
    alive: rec.child.exitCode === null && !rec.child.killed,
  };
}

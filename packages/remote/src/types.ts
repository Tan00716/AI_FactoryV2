/**
 * Remote connection model (R7-#1).
 *
 * A connection is configuration, never credential material:
 * - `keyPath` is a path reference to a private key file on the local
 *   machine. The key file itself is never read, never stored, never
 *   logged, and never appears in audit details — it is passed to the
 *   local `ssh` binary as `-i <path>` only.
 * - There is deliberately NO password / passphrase / privateKey field.
 *   Input carrying one is rejected fail-closed, not silently dropped.
 * - `local` is a loopback transport for development and testing. It is
 *   a distinct kind, never a fallback: a failed probe on an ssh/wsl/
 *   container connection never silently degrades to local execution.
 */
import { randomUUID } from 'node:crypto';

export type RemoteKind = 'ssh' | 'wsl' | 'container' | 'local';
export type RemoteStatus = 'unknown' | 'online' | 'offline' | 'error';

export const REMOTE_KINDS: readonly RemoteKind[] = ['ssh', 'wsl', 'container', 'local'];

export interface RemoteConnectionInput {
  name: string;
  kind: RemoteKind;
  host: string | null;
  port: number | null;
  username: string | null;
  keyPath: string | null;
  containerName: string | null;
  distro: string | null;
  remoteRoot: string;
}

export interface RemoteConnection extends RemoteConnectionInput {
  id: string;
  status: RemoteStatus;
  lastProbeAt: string | null;
  lastProbeMs: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export class RemoteError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RemoteError';
    this.code = code;
  }
}

const HOST_RE = /^[A-Za-z0-9._-]+$/;
const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const SHELL_META = /[\s;|&$`><\\'"!*?~#(){}[\]]/;
const FORBIDDEN_KEYS = ['password', 'passphrase', 'privateKey', 'secret', 'token'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function optString(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new RemoteError('INVALID_INPUT', `${key} must be a string`);
  return v;
}

/**
 * Validate a create/update body. Returns the normalized input, or throws
 * RemoteError('INVALID_INPUT' | 'SECRET_FIELD_REJECTED').
 */
export function validateConnectionInput(body: unknown): RemoteConnectionInput {
  if (!isRecord(body)) throw new RemoteError('INVALID_INPUT', 'body must be an object');
  for (const k of FORBIDDEN_KEYS) {
    if (k in body) {
      throw new RemoteError(
        'SECRET_FIELD_REJECTED',
        `field '${k}' is never accepted: credentials are referenced by path only, never stored`,
      );
    }
  }
  const name = body['name'];
  if (typeof name !== 'string' || !name.trim() || name.length > 100) {
    throw new RemoteError('INVALID_INPUT', 'name is required (max 100 chars)');
  }
  const kind = body['kind'];
  if (typeof kind !== 'string' || !(REMOTE_KINDS as readonly string[]).includes(kind)) {
    throw new RemoteError('INVALID_INPUT', `kind must be one of ${REMOTE_KINDS.join(', ')}`);
  }
  const host = optString(body, 'host');
  const username = optString(body, 'username');
  const keyPath = optString(body, 'keyPath');
  const containerName = optString(body, 'containerName');
  const distro = optString(body, 'distro');
  const remoteRoot = body['remoteRoot'];
  if (typeof remoteRoot !== 'string' || !remoteRoot.startsWith('/')) {
    throw new RemoteError('INVALID_INPUT', 'remoteRoot must be an absolute path starting with /');
  }
  let port: number | null = null;
  const rawPort = body['port'];
  if (rawPort !== undefined && rawPort !== null && rawPort !== '') {
    if (typeof rawPort !== 'number' || !Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
      throw new RemoteError('INVALID_INPUT', 'port must be an integer 1-65535');
    }
    port = rawPort;
  }
  if (kind === 'ssh') {
    if (!host || !HOST_RE.test(host) || host.startsWith('-')) {
      throw new RemoteError('INVALID_INPUT', 'ssh requires a plain host name or IP (no whitespace, no leading -)');
    }
    if (username !== null && (SHELL_META.test(username) || username.startsWith('-'))) {
      throw new RemoteError('INVALID_INPUT', 'username must be a plain login name');
    }
    if (keyPath !== null && !keyPath.startsWith('/')) {
      throw new RemoteError('INVALID_INPUT', 'keyPath must be an absolute path');
    }
    if (port === null) port = 22;
  } else {
    if (host !== null && (SHELL_META.test(host) || host.startsWith('-'))) {
      throw new RemoteError('INVALID_INPUT', 'host must be a plain host name');
    }
  }
  if (kind === 'container' && (containerName === null || !NAME_RE.test(containerName))) {
    throw new RemoteError('INVALID_INPUT', 'container requires containerName (letters, digits, _ . -)');
  }
  if (kind === 'wsl' && distro !== null && (SHELL_META.test(distro) || distro.startsWith('-'))) {
    throw new RemoteError('INVALID_INPUT', 'distro must be a plain distribution name');
  }
  return {
    name: name.trim(),
    kind: kind as RemoteKind,
    host,
    port,
    username,
    keyPath,
    containerName,
    distro,
    remoteRoot,
  };
}

export function newConnection(input: RemoteConnectionInput): RemoteConnection {
  const now = new Date().toISOString();
  return {
    ...input,
    id: randomUUID(),
    status: 'unknown',
    lastProbeAt: null,
    lastProbeMs: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Public view: the stored object as-is. Key material is never stored, so there is nothing to strip. */
export function connectionView(c: RemoteConnection): RemoteConnection {
  return { ...c };
}

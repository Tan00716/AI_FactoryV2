/**
 * Remote transports (R7-#1): ssh / wsl / container / local.
 *
 * All process spawns use argv arrays with NO shell, so a crafted file
 * name or command token can never inject shell syntax locally. For ssh
 * the remote side necessarily runs through the remote user's shell, so
 * every remote argument is single-quote escaped by shellQuote() before
 * it is joined into one remote command string.
 *
 * Key material never flows through here: ssh receives `-i <keyPath>`
 * only; the key file is never opened by this process. stderr/stdout
 * are capped and never include key contents for that reason.
 *
 * `local` is a loopback transport for development and testing. It is a
 * distinct kind selected explicitly — never a fallback for a failed
 * remote probe (the route layer enforces that: exec/file ops on a
 * non-online connection are refused, never rerouted).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as posix from 'node:path/posix';
import { scrubCredentialEnv } from '@ai-factory/runtime';
import { RemoteError, type RemoteConnection } from './types';

export interface TransportRunOptions {
  timeoutMs?: number;
  maxBytes?: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
}

export interface TransportResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface ProbeResult {
  online: boolean;
  latencyMs: number;
  reason: 'ok' | 'transport-unavailable' | 'command-failed' | 'timeout' | 'output-too-large';
  detail: string | null;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BYTES = 1024 * 1024;
export const FILE_MAX_BYTES = 512 * 1024;

/** Single-quote escape for a remote shell word. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolve a user-supplied relative path against a remote root (posix).
 * Absolute user paths are rejected; `..` that escapes the root is
 * rejected; the result is always inside the root (or the root itself).
 */
export function resolveRemotePath(remoteRoot: string, rel: string): string {
  if (rel.startsWith('/')) throw new RemoteError('INVALID_PATH', 'path must be relative to the remote root');
  const cleaned = posix.normalize(rel.replace(/\\/g, '/'));
  if (cleaned === '..' || cleaned.startsWith('../')) {
    throw new RemoteError('INVALID_PATH', 'path escapes the remote root');
  }
  if (cleaned === '.' || cleaned === '') return remoteRoot;
  const root = remoteRoot.endsWith('/') ? remoteRoot.slice(0, -1) : remoteRoot;
  return `${root}/${cleaned}`;
}

function spawnCollect(
  cmd: string,
  args: string[],
  opts: TransportRunOptions,
): Promise<TransportResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        // R15 #6(f): single choke point — when the caller passes no explicit
        // env, the child inherits the ambient env scrubbed of credential
        // material (same scrubCredentialEnv as pty.ts childEnv / R13 #6(d)).
        // An explicit opts.env still passes through as before.
        env: opts.env ?? scrubCredentialEnv(process.env),
      });
    } catch (e) {
      reject(new RemoteError('TRANSPORT_UNAVAILABLE', `${cmd} could not start: ${(e as Error).message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let stdoutLen = 0;
    let stderrLen = 0;
    let tooLarge = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (e) => {
      clearTimeout(timer);
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        reject(new RemoteError('TRANSPORT_UNAVAILABLE', `${cmd} is not installed or not on PATH`));
      } else {
        reject(new RemoteError('TRANSPORT_FAILED', `${cmd} failed to spawn: ${(e as Error).message}`));
      }
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutLen += chunk.length;
      if (stdoutLen > maxBytes) {
        tooLarge = true;
        child.kill('SIGKILL');
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrLen += chunk.length;
      if (stderrLen > maxBytes) {
        tooLarge = true;
        child.kill('SIGKILL');
        return;
      }
      stderr += chunk.toString('utf8');
    });
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    } else {
      child.stdin?.end();
    }
    child.on('close', (code) => {
      clearTimeout(timer);
      if (tooLarge) {
        reject(new RemoteError('OUTPUT_TOO_LARGE', `output exceeded ${maxBytes} bytes`));
        return;
      }
      resolve({ stdout, stderr, exitCode: code ?? 1, timedOut });
    });
  });
}

/** ssh argv prefix for a connection (no remote command appended). */
export function sshPrefix(conn: RemoteConnection, connectTimeoutSec: number): string[] {
  const args: string[] = [
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${connectTimeoutSec}`,
    '-o',
    'StrictHostKeyChecking=accept-new',
  ];
  if (conn.keyPath) args.push('-i', conn.keyPath);
  if (conn.port !== null) args.push('-p', String(conn.port));
  const target = conn.username ? `${conn.username}@${conn.host as string}` : (conn.host as string);
  args.push(target);
  return args;
}

/**
 * Run argv on the remote side. For ssh/wsl/container the argv is carried
 * through the transport; for local it spawns directly. Throws
 * RemoteError on transport failure, non-zero exit, timeout, or oversize
 * output (callers map COMMAND_FAILED to probe-offline, not to local).
 */
export async function runCommand(
  conn: RemoteConnection,
  argv: string[],
  opts: TransportRunOptions = {},
): Promise<TransportResult> {
  if (argv.length === 0) throw new RemoteError('INVALID_INPUT', 'command is required');
  let res: TransportResult;
  if (conn.kind === 'ssh') {
    const remote = argv.map(shellQuote).join(' ');
    res = await spawnCollect('ssh', [...sshPrefix(conn, 10), remote], opts);
  } else if (conn.kind === 'wsl') {
    const args = conn.distro ? ['-d', conn.distro, '--exec', ...argv] : ['--exec', ...argv];
    res = await spawnCollect('wsl', args, opts);
  } else if (conn.kind === 'container') {
    res = await spawnCollect('docker', ['exec', conn.containerName as string, ...argv], opts);
  } else {
    res = await spawnCollect(argv[0] as string, argv.slice(1), opts);
  }
  if (res.timedOut) throw new RemoteError('TIMEOUT', `command timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
  if (res.exitCode !== 0) {
    throw new RemoteError('COMMAND_FAILED', `exit ${res.exitCode}: ${res.stderr.trim().slice(0, 300)}`);
  }
  return res;
}

/** Run a shell string on the remote side (needed for output redirection on write). */
export async function runShell(
  conn: RemoteConnection,
  command: string,
  opts: TransportRunOptions = {},
): Promise<TransportResult> {
  let res: TransportResult;
  if (conn.kind === 'ssh') {
    res = await spawnCollect('ssh', [...sshPrefix(conn, 10), command], opts);
  } else if (conn.kind === 'wsl') {
    const args = conn.distro ? ['-d', conn.distro, '--exec', 'sh', '-c', command] : ['--exec', 'sh', '-c', command];
    res = await spawnCollect('wsl', args, opts);
  } else if (conn.kind === 'container') {
    res = await spawnCollect('docker', ['exec', '-i', conn.containerName as string, 'sh', '-c', command], opts);
  } else {
    res = await spawnCollect('sh', ['-c', command], opts);
  }
  if (res.timedOut) throw new RemoteError('TIMEOUT', `command timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
  if (res.exitCode !== 0) {
    throw new RemoteError('COMMAND_FAILED', `exit ${res.exitCode}: ${res.stderr.trim().slice(0, 300)}`);
  }
  return res;
}

/** Probe reachability. Never throws for a failed probe — it reports offline. */
export async function probe(conn: RemoteConnection, opts: TransportRunOptions = {}): Promise<ProbeResult> {
  const started = Date.now();
  try {
    if (conn.kind === 'local') {
      await runCommand(conn, ['true'], { ...opts, timeoutMs: opts.timeoutMs ?? 10_000 });
    } else {
      await runCommand(conn, ['true'], { ...opts, timeoutMs: opts.timeoutMs ?? 10_000 });
    }
    return { online: true, latencyMs: Date.now() - started, reason: 'ok', detail: null };
  } catch (e) {
    if (e instanceof RemoteError) {
      if (e.code === 'TRANSPORT_UNAVAILABLE') {
        return { online: false, latencyMs: Date.now() - started, reason: 'transport-unavailable', detail: e.message };
      }
      if (e.code === 'TIMEOUT') {
        return { online: false, latencyMs: Date.now() - started, reason: 'timeout', detail: e.message };
      }
      if (e.code === 'OUTPUT_TOO_LARGE') {
        return { online: false, latencyMs: Date.now() - started, reason: 'output-too-large', detail: e.message };
      }
      return { online: false, latencyMs: Date.now() - started, reason: 'command-failed', detail: e.message };
    }
    return { online: false, latencyMs: Date.now() - started, reason: 'command-failed', detail: String(e) };
  }
}

export async function listDir(
  conn: RemoteConnection,
  rel: string,
  opts: TransportRunOptions = {},
): Promise<string[]> {
  const abs = resolveRemotePath(conn.remoteRoot, rel);
  if (conn.kind === 'local') {
    const localAbs = path.resolve(abs);
    const entries = fs.readdirSync(localAbs, { withFileTypes: true });
    return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
  }
  const res = await runCommand(conn, ['ls', '-1', '--', abs], opts);
  return res.stdout.split('\n').filter((l) => l.length > 0);
}

export async function readFile(
  conn: RemoteConnection,
  rel: string,
  opts: TransportRunOptions = {},
): Promise<string> {
  const abs = resolveRemotePath(conn.remoteRoot, rel);
  if (conn.kind === 'local') {
    const buf = fs.readFileSync(path.resolve(abs));
    if (buf.length > FILE_MAX_BYTES) throw new RemoteError('OUTPUT_TOO_LARGE', `file exceeds ${FILE_MAX_BYTES} bytes`);
    return buf.toString('utf8');
  }
  const res = await runCommand(conn, ['cat', '--', abs], { ...opts, maxBytes: FILE_MAX_BYTES });
  return res.stdout;
}

export async function writeFile(
  conn: RemoteConnection,
  rel: string,
  content: string,
  opts: TransportRunOptions = {},
): Promise<void> {
  if (Buffer.byteLength(content, 'utf8') > FILE_MAX_BYTES) {
    throw new RemoteError('OUTPUT_TOO_LARGE', `content exceeds ${FILE_MAX_BYTES} bytes`);
  }
  const abs = resolveRemotePath(conn.remoteRoot, rel);
  if (conn.kind === 'local') {
    const localAbs = path.resolve(abs);
    fs.mkdirSync(path.dirname(localAbs), { recursive: true });
    fs.writeFileSync(localAbs, content, 'utf8');
    return;
  }
  await runShell(conn, `cat > ${shellQuote(abs)}`, { ...opts, input: content });
}

/**
 * OS keychain backend — via the platform's CLI (§46.2: "Windows
 * Credential Manager 或其它 OS-protected store"):
 *
 *   linux  — `secret-tool` (libsecret / GNOME Keyring, KWallet via
 *            secret-service): store / lookup / clear with attributes
 *            service=ai-factory, name=<secret name>. The value travels
 *            on stdin for store, never in argv.
 *   darwin — `security` generic passwords (service=ai-factory,
 *            account=<secret name>). NOTE: add-generic-password takes
 *            the value via -w in argv, which other local processes can
 *            observe in the process list — a known weakness of the
 *            stock tool, recorded here rather than hidden.
 *   win32  — cmdkey can STORE credentials but offers no way to read a
 *            password back, so resolution is unsupported: detection
 *            reports unavailable with that reason (modeled, not faked).
 *
 * Detection is explicit (probe for the tool) and failures are loud:
 * a lookup MISS is a clean undefined; any other tool failure throws
 * SecretBackendUnavailableError. This module never falls back to any
 * other storage.
 *
 * On the development machine none of these tools are installed, so
 * this backend is delivered probed-and-modeled: argument construction
 * and miss/failure handling are pinned by tests through an injected
 * fake runner, but it has NOT been exercised against a live keyring.
 */
import { execFile, execFileSync } from 'node:child_process';
import {
  SecretBackendUnavailableError,
  assertSecretName,
  type SecretStore,
} from './types';

export interface KeychainCommandResult {
  stdout: string;
}

/** (file, args, stdin?) → stdout. Rejects on non-zero exit / ENOENT. */
export type KeychainCommandRunner = (
  file: string,
  args: string[],
  input?: string,
) => Promise<KeychainCommandResult>;

export const defaultKeychainRunner: KeychainCommandRunner = (file, args, input) =>
  new Promise((resolvePromise, reject) => {
    const child = execFile(file, args, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolvePromise({ stdout: stdout.toString() });
    });
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });

export interface KeychainDetection {
  available: boolean;
  platform: string;
  tool: string | null;
  reason: string;
}

const SERVICE = 'ai-factory';

function toolForPlatform(platform: string): string | null {
  if (platform === 'linux') return 'secret-tool';
  if (platform === 'darwin') return 'security';
  return null;
}

/** Synchronous probe (used at startup so a misconfigured keychain
 *  backend fails fast, before the server opens anything). `which` is
 *  injectable via syncRunner for tests. */
export function probeKeychainSync(
  platform: string = process.platform,
  syncRunner: (file: string, args: string[]) => string = (file, args) =>
    execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
): KeychainDetection {
  if (platform === 'win32') {
    return {
      available: false,
      platform,
      tool: 'cmdkey',
      reason:
        'cmdkey can store credentials but cannot read a password back; ' +
        'OS keychain resolution is unsupported on win32 in this build',
    };
  }
  const tool = toolForPlatform(platform);
  if (!tool) {
    return { available: false, platform, tool: null, reason: `no OS keychain CLI is modeled for platform "${platform}"` };
  }
  try {
    syncRunner('which', [tool]);
    return { available: true, platform, tool, reason: `${tool} found` };
  } catch {
    return {
      available: false,
      platform,
      tool,
      reason: `${tool} not found on PATH — the OS keychain backend needs it installed`,
    };
  }
}

export interface KeychainStoreOptions {
  platform?: string;
  runner?: KeychainCommandRunner;
  /** Pre-computed detection (tests); default probes synchronously. */
  detection?: KeychainDetection;
}

export class KeychainStore implements SecretStore {
  readonly id = 'os-keychain';
  /** darwin/win32 caveat aside, set/delete go through the same CLI. */
  readonly writable: boolean;
  private readonly platform: string;
  private readonly runner: KeychainCommandRunner;
  readonly detection: KeychainDetection;

  constructor(opts: KeychainStoreOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.runner = opts.runner ?? defaultKeychainRunner;
    this.detection = opts.detection ?? probeKeychainSync(this.platform);
    // win32 detection says tool=cmdkey but available=false; writable
    // follows availability so the broker refuses writes up front too.
    this.writable = this.detection.available;
  }

  private tool(): string {
    if (!this.detection.available || !this.detection.tool) {
      throw new SecretBackendUnavailableError(
        `OS keychain backend unavailable: ${this.detection.reason}`,
      );
    }
    return this.detection.tool;
  }

  /** Run a lookup-style command: a non-zero exit on lookup means
   *  "no such entry" for both secret-tool and security; a spawn
   *  failure (ENOENT) means the tool vanished — unavailable. */
  private async lookup(file: string, args: string[]): Promise<string | undefined> {
    try {
      const { stdout } = await this.runner(file, args);
      return stdout.replace(/\n$/, '');
    } catch (e) {
      const err = e as { code?: unknown };
      if (err.code === 'ENOENT') {
        throw new SecretBackendUnavailableError(
          `OS keychain tool "${file}" could not be executed (ENOENT)`,
        );
      }
      return undefined; // tool ran and reported no entry
    }
  }

  private async run(file: string, args: string[], input?: string): Promise<void> {
    try {
      await this.runner(file, args, input);
    } catch (e) {
      const err = e as { code?: unknown; message?: string };
      throw new SecretBackendUnavailableError(
        `OS keychain command "${file} ${args[0] ?? ''}" failed (${err.code === 'ENOENT' ? 'tool missing' : 'non-zero exit'})`,
      );
    }
  }

  async get(name: string): Promise<string | undefined> {
    assertSecretName(name);
    const tool = this.tool();
    if (this.platform === 'linux') {
      return this.lookup(tool, ['lookup', 'service', SERVICE, 'name', name]);
    }
    // darwin
    return this.lookup(tool, ['find-generic-password', '-s', SERVICE, '-a', name, '-w']);
  }

  async set(name: string, value: string): Promise<void> {
    assertSecretName(name);
    const tool = this.tool();
    if (this.platform === 'linux') {
      await this.run(
        tool,
        ['store', '--label', `AI Factory secret ${name}`, 'service', SERVICE, 'name', name],
        value,
      );
      return;
    }
    await this.run(tool, ['add-generic-password', '-U', '-s', SERVICE, '-a', name, '-w', value]);
  }

  async delete(name: string): Promise<boolean> {
    assertSecretName(name);
    const tool = this.tool();
    const existed = (await this.get(name)) !== undefined;
    if (!existed) return false;
    if (this.platform === 'linux') {
      await this.run(tool, ['clear', 'service', SERVICE, 'name', name]);
    } else {
      await this.run(tool, ['delete-generic-password', '-s', SERVICE, '-a', name]);
    }
    return true;
  }

  /** Neither CLI offers a portable "list my entries" for one service;
   *  the broker's listing therefore reflects the other backends, and
   *  keychain entries are found by name (describe/has/get all work). */
  async list(): Promise<string[]> {
    return [];
  }
}

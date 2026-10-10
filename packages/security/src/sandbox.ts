/**
 * Sandbox strategy — spec §76.
 *
 * One abstraction (`ExecutionEnvironment`) with two tiers:
 *   local  — OS permissions + project-directory boundary (trusted dev work)
 *   strong — isolated temp workspace, no network by default (untrusted /
 *            high-risk tasks)
 *
 * `resolvePolicy(taskRisk)` picks the tier. Path resolution enforces the
 * workspace boundary and rejects directory escapes (`..` leaving the root).
 */

import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { mkdtempSync } from 'fs';
import { scanManifest, ScanResult } from './scanner';

export type TaskRisk = 'low' | 'medium' | 'high';
export type SandboxTier = 'local' | 'strong';

export interface SandboxPolicy {
  tier: SandboxTier;
  /** Absolute workspace root every path is confined to. */
  workspaceRoot: string;
  networkAllowed: boolean;
  /** Extra human-readable constraints, e.g. read-only areas. */
  constraints: string[];
}

/** Thrown when an operation would violate the sandbox boundary. */
export class SandboxViolationError extends Error {
  readonly code: 'PATH_ESCAPE' | 'NETWORK_DENIED' | 'COMMAND_BLOCKED';
  constructor(code: SandboxViolationError['code'], message: string) {
    super(message);
    this.name = 'SandboxViolationError';
    this.code = code;
  }
}

/**
 * Risk → tier mapping. Medium risk keeps the local tier but cuts network;
 * high risk (untrusted content, unknown skills, prod-adjacent) gets the
 * isolated strong tier.
 */
export function resolvePolicy(
  taskRisk: TaskRisk,
  opts: { workspaceRoot: string; isolatedRoot?: string } = { workspaceRoot: process.cwd() },
): SandboxPolicy {
  const workspaceRoot = resolve(opts.workspaceRoot);
  if (taskRisk === 'high') {
    const strongRoot = opts.isolatedRoot ?? mkdtempSync(join(tmpdir(), 'ai-factory-strong-'));
    return {
      tier: 'strong',
      workspaceRoot: resolve(strongRoot),
      networkAllowed: false,
      constraints: [
        'isolated temporary workspace — nothing outside workspaceRoot is reachable',
        'network denied by default',
        'no credential material mounted',
      ],
    };
  }
  return {
    tier: 'local',
    workspaceRoot,
    networkAllowed: taskRisk === 'low',
    constraints: [
      'confined to project workspace directory',
      taskRisk === 'low' ? 'network allowed' : 'network denied',
      'OS user permissions apply',
    ],
  };
}

/**
 * Resolve a user-supplied path inside the sandbox root. Rejects directory
 * escapes — `..` climbing out of the root, absolute paths outside the root,
 * or null bytes. Returns the absolute, confined path.
 */
export function resolveSafePath(workspaceRoot: string, userPath: string): string {
  if (userPath.includes('\0')) {
    throw new SandboxViolationError('PATH_ESCAPE', 'null byte in path');
  }
  const root = resolve(workspaceRoot);
  const abs = resolve(root, userPath);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new SandboxViolationError(
      'PATH_ESCAPE',
      `path escapes workspace: ${JSON.stringify(userPath)}`,
    );
  }
  return abs;
}

/**
 * Execution environment abstraction (spec §76: never hard-code one sandbox
 * technology). Policy checks only — actual process spawning is left to the
 * runtime, which must consult these gates first.
 */
export interface ExecutionEnvironment {
  readonly tier: SandboxTier;
  readonly policy: SandboxPolicy;
  /** Resolve a path, enforcing the workspace boundary. */
  resolvePath(p: string): string;
  /** Throw when a URL/host is not allowed to be contacted. */
  checkNetwork(url: string): void;
  /** Static scan of a shell command before execution. */
  checkCommand(command: string): ScanResult;
}

abstract class BaseEnvironment implements ExecutionEnvironment {
  readonly policy: SandboxPolicy;
  constructor(policy: SandboxPolicy) {
    this.policy = policy;
  }
  get tier(): SandboxTier {
    return this.policy.tier;
  }
  resolvePath(p: string): string {
    return resolveSafePath(this.policy.workspaceRoot, p);
  }
  checkNetwork(url: string): void {
    if (this.policy.networkAllowed) return;
    throw new SandboxViolationError('NETWORK_DENIED', `network denied in ${this.tier} tier: ${url}`);
  }
  checkCommand(command: string): ScanResult {
    const result = scanManifest({
      name: 'inline-command',
      instructions: '',
      scripts: [command],
      declared: { network: false, fileAccess: 'read', shell: true },
      // Content scan only — the UNKNOWN-origin trust gate applies to
      // installs (scanManifest), not to inline command checks.
      trustLevel: 'VERIFIED',
    });
    if (result.verdict === 'BLOCK') {
      throw new SandboxViolationError('COMMAND_BLOCKED', `command blocked: ${command.slice(0, 120)}`);
    }
    return result;
  }
}

/** Local dev tier: project directory boundary + OS permissions. */
export class LocalExecutionEnvironment extends BaseEnvironment {
  constructor(workspaceRoot: string, networkAllowed = true) {
    super({
      tier: 'local',
      workspaceRoot: resolve(workspaceRoot),
      networkAllowed,
      constraints: ['confined to project workspace directory', 'OS user permissions apply'],
    });
  }
}

/** Strong tier: isolated temp workspace, network denied by default. */
export class StrongExecutionEnvironment extends BaseEnvironment {
  constructor(isolatedRoot?: string) {
    const root = isolatedRoot ?? mkdtempSync(join(tmpdir(), 'ai-factory-strong-'));
    super({
      tier: 'strong',
      workspaceRoot: resolve(root),
      networkAllowed: false,
      constraints: [
        'isolated temporary workspace',
        'network denied by default',
        'no credential material mounted',
      ],
    });
  }
}

/** Factory — pick the environment from task risk. */
export function createEnvironment(
  taskRisk: TaskRisk,
  workspaceRoot: string,
): ExecutionEnvironment {
  const policy = resolvePolicy(taskRisk, { workspaceRoot });
  return policy.tier === 'strong'
    ? new StrongExecutionEnvironment(policy.workspaceRoot)
    : new LocalExecutionEnvironment(policy.workspaceRoot, policy.networkAllowed);
}

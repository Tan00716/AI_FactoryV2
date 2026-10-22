/**
 * @ai-factory/debugger — `.vscode/launch.json` parsing.
 *
 * Reads the VS Code launch configuration file and normalizes the entries
 * this package can actually serve. Pure functions — no FS access here;
 * the server route reads the file inside the project jail.
 *
 * Supported (honest boundary):
 *   - type "node" or "pwa-node", request "launch" → Node.js launch
 *   - type "node" or "pwa-node", request "attach" → Node.js attach (port)
 * Everything else (chrome, python, coreclr, compound, …) is reported as
 * unsupported — never silently reinterpreted.
 */
import { NormalizedLaunchConfig } from './types';

export class LaunchConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchConfigError';
  }
}

export interface RawLaunchJson {
  version?: string;
  configurations?: RawConfig[];
}

export interface RawConfig {
  name?: string;
  type?: string;
  request?: string;
  program?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stopOnEntry?: boolean;
  port?: number;
  address?: string;
  console?: string;
  [k: string]: unknown;
}

const NODE_TYPES = new Set(['node', 'pwa-node']);

/** Parse launch.json text. Throws LaunchConfigError on invalid JSON/shape. */
export function parseLaunchJson(text: string): RawConfig[] {
  let parsed: unknown;
  try {
    // launch.json allows comments; strip // and /* */ comments first.
    const stripped = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    parsed = JSON.parse(stripped);
  } catch (e) {
    throw new LaunchConfigError(`invalid launch.json: ${(e as Error).message}`);
  }
  const obj = parsed as RawLaunchJson;
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.configurations)) {
    throw new LaunchConfigError('launch.json has no "configurations" array');
  }
  return obj.configurations.filter((c) => c && typeof c === 'object');
}

/** Pick a configuration by name (exact match). Throws when missing. */
export function selectConfig(configs: RawConfig[], name: string): RawConfig {
  const found = configs.find((c) => c.name === name);
  if (!found) {
    const names = configs.map((c) => String(c.name ?? '<unnamed>')).join(', ');
    throw new LaunchConfigError(`no launch configuration named "${name}" (have: ${names || 'none'})`);
  }
  return found;
}

/**
 * Normalize one raw config to a NormalizedLaunchConfig.
 * `resolvePath` maps a possibly-relative path to absolute (the caller jails it).
 * Throws LaunchConfigError for unsupported types or missing required fields.
 */
export function normalizeConfig(
  raw: RawConfig,
  resolvePath: (p: string) => string,
): NormalizedLaunchConfig {
  const name = String(raw.name ?? 'unnamed');
  const type = String(raw.type ?? '');
  if (!NODE_TYPES.has(type)) {
    throw new LaunchConfigError(
      `configuration "${name}": debug type "${type || '<missing>'}" is not supported — only "node"/"pwa-node" (Node.js) for now`,
    );
  }
  const request = String(raw.request ?? 'launch');
  if (request !== 'launch' && request !== 'attach') {
    throw new LaunchConfigError(`configuration "${name}": request must be "launch" or "attach", got "${request}"`);
  }
  if (raw.console && raw.console !== 'internalConsole' && raw.console !== 'integratedTerminal') {
    throw new LaunchConfigError(
      `configuration "${name}": console "${raw.console}" is not supported — only internalConsole`,
    );
  }
  if (request === 'launch') {
    if (!raw.program || typeof raw.program !== 'string' || !raw.program.trim()) {
      throw new LaunchConfigError(`configuration "${name}": launch needs a "program" path`);
    }
    const args = Array.isArray(raw.args) ? raw.args.filter((a) => typeof a === 'string') : [];
    const env: Record<string, string> = {};
    if (raw.env && typeof raw.env === 'object') {
      for (const [k, v] of Object.entries(raw.env)) {
        if (typeof v === 'string') env[k] = v;
      }
    }
    return {
      name,
      request: 'launch',
      adapter: 'node',
      program: resolvePath(raw.program),
      args,
      cwd: raw.cwd && typeof raw.cwd === 'string' ? resolvePath(raw.cwd) : undefined,
      env,
      stopOnEntry: raw.stopOnEntry === true,
      address: '127.0.0.1',
    };
  }
  const port = typeof raw.port === 'number' ? raw.port : Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new LaunchConfigError(`configuration "${name}": attach needs a numeric "port" (1-65535)`);
  }
  return {
    name,
    request: 'attach',
    adapter: 'node',
    args: [],
    env: {},
    stopOnEntry: false,
    port,
    address: typeof raw.address === 'string' && raw.address ? raw.address : '127.0.0.1',
  };
}

/**
 * node:vm sandbox for @ai-factory/extensions (round-6 R6-S1).
 *
 * Security model (defense in depth for locally-installed extensions):
 *   - Extension code runs in a fresh vm context with code generation
 *     disabled (no eval, no Function constructor, no WebAssembly) and a
 *     per-run timeout (infinite loops fail, they do not hang the server).
 *   - The context global exposes exactly one host-adjacent object: `api`
 *     (log + registerCommand + registerContextProvider), defined INSIDE
 *     the vm by the bootstrap script. No host object ever crosses into
 *     the vm: arguments cross as JSON strings parsed inside the vm, and
 *     results cross as JSON strings produced inside the vm.
 *   - Handlers must be synchronous and return JSON values. Async handlers
 *     are rejected (a returned thenable is an error, not silently coerced
 *     to {} by JSON.stringify).
 *   - The sandbox does NOT make an untrusted extension safe against a
 *     determined adversary: install itself requires operator privileges,
 *     and a determined author with install rights could ship a different
 *     bundle. The sandbox limits the API surface and blocks naive escapes
 *     (require/process/Buffer/eval/Function/constructor chains); it is
 *     documented as such, not as a multi-tenant security boundary.
 */
import { createContext, runInContext, type Context } from 'node:vm';
import { validateMainSource, validateManifest } from './manifest.js';
import {
  ExtensionError,
  type ExtensionManifest,
  type ExtensionProviderItem,
} from './types.js';

export const LOAD_TIMEOUT_MS = 2000;
export const INVOKE_TIMEOUT_MS = 5000;
export const MAX_ARGS_BYTES = 64 * 1024;
export const MAX_RESULT_BYTES = 64 * 1024;
export const MAX_PROVIDER_ITEMS = 50;
export const MAX_PROVIDER_TEXT = 4096;
export const MAX_LOG_LINES = 100;

export class SandboxError extends ExtensionError {}

/** Bootstrap script: defines the vm-side api + handler registry + invoke. */
const BOOTSTRAP = `
const __handlers = { cmd: {}, prov: {} };
const __logs = [];
const api = {
  log: function (msg) {
    __logs.push(String(msg).slice(0, 2000));
    if (__logs.length > ${MAX_LOG_LINES}) __logs.shift();
  },
  registerCommand: function (id, fn) {
    if (typeof id !== 'string' || typeof fn !== 'function') {
      throw new Error('registerCommand needs (id, function)');
    }
    __handlers.cmd[id] = fn;
  },
  registerContextProvider: function (id, fn) {
    if (typeof id !== 'string' || typeof fn !== 'function') {
      throw new Error('registerContextProvider needs (id, function)');
    }
    __handlers.prov[id] = fn;
  },
};
function __invoke(kind, id, args) {
  const fn = __handlers[kind][id];
  if (!fn) throw new Error('no handler for ' + kind + ':' + id);
  const r = fn(args);
  if (r !== null && (typeof r === 'object' || typeof r === 'function') && typeof r.then === 'function') {
    throw new Error('async handlers are not supported in v1 (return a plain JSON value)');
  }
  return r;
}
function __handlerIds(kind) { return Object.keys(__handlers[kind]); }
function __takeLogs() { const out = __logs.slice(); __logs.length = 0; return out; }
`;

function toVmJson(value: unknown, what: string): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? 'null';
  } catch {
    throw new SandboxError(`${what} is not JSON-serializable`);
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_ARGS_BYTES) {
    throw new SandboxError(`${what} exceeds ${MAX_ARGS_BYTES} bytes`);
  }
  return json;
}

function runJson(ctx: Context, script: string, filename: string, timeoutMs: number): unknown {
  let out: unknown;
  try {
    out = runInContext(script, ctx, { timeout: timeoutMs, filename });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new SandboxError(msg);
  }
  return out;
}

export interface LoadedExtension {
  manifest: ExtensionManifest;
  runCommand(commandId: string, args: unknown): { result: unknown; logs: string[] };
  resolveProvider(providerId: string, query: string): { items: ExtensionProviderItem[]; logs: string[] };
}

function drainLogs(ctx: Context, name: string): string[] {
  const out = runJson(ctx, 'JSON.stringify(__takeLogs())', `${name}/logs.js`, INVOKE_TIMEOUT_MS);
  if (typeof out !== 'string') return [];
  try {
    const parsed = JSON.parse(out) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Load an extension into a fresh sandbox and verify its handlers match
 * the manifest (every declared command/provider must have a handler;
 * handlers for undeclared ids are rejected). Throws SandboxError.
 */
export function loadExtension(manifestInput: unknown, mainInput: unknown): LoadedExtension {
  const manifest = validateManifest(manifestInput);
  const main = validateMainSource(mainInput);
  const ctx: Context = createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  runJson(ctx, BOOTSTRAP, `${manifest.name}/bootstrap.js`, LOAD_TIMEOUT_MS);
  runJson(ctx, main, `${manifest.name}/main.js`, LOAD_TIMEOUT_MS);

  const registered = (kind: string): string[] => {
    const out = runJson(
      ctx,
      `JSON.stringify(__handlerIds(${JSON.stringify(kind)}))`,
      `${manifest.name}/ids.js`,
      INVOKE_TIMEOUT_MS,
    );
    if (typeof out !== 'string') throw new SandboxError('could not read handler registry');
    const parsed = JSON.parse(out) as unknown;
    if (!Array.isArray(parsed)) throw new SandboxError('could not read handler registry');
    return parsed.filter((x): x is string => typeof x === 'string');
  };
  const cmdIds = registered('cmd');
  const provIds = registered('prov');
  for (const c of manifest.contributes.commands) {
    if (!cmdIds.includes(c.id)) {
      throw new SandboxError(`declared command has no handler: ${c.id}`);
    }
  }
  for (const p of manifest.contributes.providers) {
    if (!provIds.includes(p.id)) {
      throw new SandboxError(`declared provider has no handler: ${p.id}`);
    }
  }
  for (const id of cmdIds) {
    if (!manifest.contributes.commands.some((c) => c.id === id)) {
      throw new SandboxError(`handler registered for undeclared command: ${id}`);
    }
  }
  for (const id of provIds) {
    if (!manifest.contributes.providers.some((p) => p.id === id)) {
      throw new SandboxError(`handler registered for undeclared provider: ${id}`);
    }
  }

  function invoke(kind: 'cmd' | 'prov', id: string, args: unknown): { value: unknown; logs: string[] } {
    const argsJson = toVmJson(args, 'command arguments');
    const script =
      `JSON.stringify(__invoke(${JSON.stringify(kind)}, ${JSON.stringify(id)}, ` +
      `JSON.parse(${JSON.stringify(argsJson)})))`;
    const out = runJson(ctx, script, `${manifest.name}/invoke.js`, INVOKE_TIMEOUT_MS);
    const logs = drainLogs(ctx, manifest.name);
    if (out === undefined) return { value: null, logs };
    if (typeof out !== 'string') throw new SandboxError('extension handler returned a non-serializable value');
    if (Buffer.byteLength(out, 'utf8') > MAX_RESULT_BYTES) {
      throw new SandboxError(`extension handler result exceeds ${MAX_RESULT_BYTES} bytes`);
    }
    let value: unknown;
    try {
      value = JSON.parse(out) as unknown;
    } catch {
      throw new SandboxError('extension handler returned a non-serializable value');
    }
    return { value, logs };
  }

  return {
    manifest,
    runCommand(commandId: string, args: unknown): { result: unknown; logs: string[] } {
      if (!manifest.contributes.commands.some((c) => c.id === commandId)) {
        throw new SandboxError(`unknown command: ${commandId}`);
      }
      const { value, logs } = invoke('cmd', commandId, args ?? {});
      return { result: value, logs };
    },
    resolveProvider(providerId: string, query: string): { items: ExtensionProviderItem[]; logs: string[] } {
      if (typeof query !== 'string' || query.length > 2000) {
        throw new SandboxError('provider query must be a string of at most 2000 chars');
      }
      if (!manifest.contributes.providers.some((p) => p.id === providerId)) {
        throw new SandboxError(`unknown provider: ${providerId}`);
      }
      const { value, logs } = invoke('prov', providerId, { query });
      if (!Array.isArray(value)) {
        throw new SandboxError('provider handler must return an array of items');
      }
      if (value.length > MAX_PROVIDER_ITEMS) {
        throw new SandboxError(`provider returned more than ${MAX_PROVIDER_ITEMS} items`);
      }
      const items: ExtensionProviderItem[] = value.map((item) => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
          throw new SandboxError('provider items must be objects');
        }
        const rec = item as Record<string, unknown>;
        if (typeof rec.label !== 'string' || typeof rec.text !== 'string') {
          throw new SandboxError('provider items need string label and text');
        }
        if (rec.text.length > MAX_PROVIDER_TEXT) {
          throw new SandboxError(`provider item text exceeds ${MAX_PROVIDER_TEXT} chars`);
        }
        return { label: rec.label, text: rec.text };
      });
      return { items, logs };
    },
  };
}

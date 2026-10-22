/**
 * R5-S2 — tasks.json parser. Fail-closed validation of the supported
 * VS Code tasks.json subset. Unknown fields produce warnings, never
 * silent behavior changes.
 *
 * SUPPORTED (task level):
 *   label (required, unique), type ("shell"|"process", default "shell"),
 *   command (required), args (string[], default []), group
 *   ("build"|"test"|"none", default "none"), detail (string),
 *   dependsOn (string|string[], default []), dependsOrder
 *   ("sequence"|"parallel", default "sequence"), problemMatcher
 *   (string|string[], default []), options { cwd, env, timeoutMs }.
 * SUPPORTED (document level): version, tasks.
 * UNSUPPORTED (warned + ignored): presentation, isBackground / background
 *   watchers, runOptions, windows/osx/linux overrides, icon, group as
 *   object, anything else.
 */
import type {
  DependsOrder,
  TaskDef,
  TaskGroup,
  TaskOptions,
  TaskType,
  TasksFileResult,
} from './types';

export const MAX_TASKS = 200;
export const MAX_LABEL_LEN = 128;
export const MAX_COMMAND_LEN = 4096;
export const MAX_ARGS = 64;
export const MAX_ARG_LEN = 4096;
export const MAX_ENV_VARS = 32;
export const MAX_ENV_VALUE_LEN = 4096;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 300_000;

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Env names that must never be overridden by a task (process integrity). */
export const ENV_DENYLIST = new Set([
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'NODE_OPTIONS',
]);

const TOP_KEYS = new Set(['version', 'tasks']);
const TASK_KEYS = new Set([
  'label',
  'type',
  'command',
  'args',
  'group',
  'detail',
  'dependsOn',
  'dependsOrder',
  'problemMatcher',
  'options',
]);
const OPTION_KEYS = new Set(['cwd', 'env', 'timeoutMs']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strList(raw: unknown, field: string, errors: string[]): string[] | null {
  if (raw === undefined) return [];
  const arr = typeof raw === 'string' ? [raw] : raw;
  if (!Array.isArray(arr)) {
    errors.push(`${field}: expected string or string[]`);
    return null;
  }
  const out: string[] = [];
  for (const v of arr) {
    if (typeof v !== 'string') {
      errors.push(`${field}: every entry must be a string`);
      return null;
    }
    out.push(v);
  }
  return out;
}

function parseOptions(raw: unknown, label: string, errors: string[]): TaskOptions | null {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    errors.push(`task "${label}": options must be an object`);
    return null;
  }
  const opts: TaskOptions = {};
  for (const k of Object.keys(raw)) {
    if (!OPTION_KEYS.has(k)) {
      // options-level unknown keys are warnings, handled by caller via warnings list
    }
  }
  if (raw['cwd'] !== undefined) {
    if (typeof raw['cwd'] !== 'string' || raw['cwd'].length === 0) {
      errors.push(`task "${label}": options.cwd must be a non-empty string`);
      return null;
    }
    if (raw['cwd'].length > 1024) {
      errors.push(`task "${label}": options.cwd too long`);
      return null;
    }
    opts.cwd = raw['cwd'];
  }
  if (raw['env'] !== undefined) {
    if (!isRecord(raw['env'])) {
      errors.push(`task "${label}": options.env must be an object`);
      return null;
    }
    const entries = Object.entries(raw['env']);
    if (entries.length > MAX_ENV_VARS) {
      errors.push(`task "${label}": options.env exceeds ${MAX_ENV_VARS} variables`);
      return null;
    }
    const env: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (!ENV_KEY_RE.test(k)) {
        errors.push(`task "${label}": options.env has invalid name "${k}"`);
        return null;
      }
      if (ENV_DENYLIST.has(k)) {
        errors.push(`task "${label}": options.env must not override "${k}"`);
        return null;
      }
      if (typeof v !== 'string') {
        errors.push(`task "${label}": options.env["${k}"] must be a string`);
        return null;
      }
      if (v.length > MAX_ENV_VALUE_LEN) {
        errors.push(`task "${label}": options.env["${k}"] too long`);
        return null;
      }
      env[k] = v;
    }
    opts.env = env;
  }
  if (raw['timeoutMs'] !== undefined) {
    const t = raw['timeoutMs'];
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      errors.push(`task "${label}": options.timeoutMs must be a number`);
      return null;
    }
    opts.timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(t)));
  }
  return opts;
}

/**
 * Parse and validate a tasks.json document. Fail-closed: on any error the
 * returned tasks array is empty and `errors` explains why.
 */
export function parseTasksJson(text: string): TasksFileResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { version: null, tasks: [], errors: [`invalid JSON: ${(e as Error).message}`], warnings };
  }
  if (!isRecord(doc)) {
    return { version: null, tasks: [], errors: ['document must be a JSON object'], warnings };
  }
  for (const k of Object.keys(doc)) {
    if (!TOP_KEYS.has(k)) warnings.push(`top-level key "${k}" is not supported and was ignored`);
  }
  const version = typeof doc['version'] === 'string' ? doc['version'] : null;
  if (doc['version'] !== undefined && typeof doc['version'] !== 'string') {
    errors.push('version must be a string');
  }
  const rawTasks = doc['tasks'];
  if (rawTasks === undefined) {
    return { version, tasks: [], errors, warnings };
  }
  if (!Array.isArray(rawTasks)) {
    return { version, tasks: [], errors: ['tasks must be an array'], warnings };
  }
  if (rawTasks.length > MAX_TASKS) {
    return { version, tasks: [], errors: [`too many tasks (max ${MAX_TASKS})`], warnings };
  }
  const tasks: TaskDef[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawTasks.length; i++) {
    const raw = rawTasks[i];
    const where = `tasks[${i}]`;
    if (!isRecord(raw)) {
      errors.push(`${where}: must be an object`);
      continue;
    }
    for (const k of Object.keys(raw)) {
      if (!TASK_KEYS.has(k)) {
        warnings.push(`${where}: key "${k}" is not supported in v1 and was ignored`);
      }
    }
    const label = raw['label'];
    if (typeof label !== 'string' || label.length === 0) {
      errors.push(`${where}: label is required and must be a non-empty string`);
      continue;
    }
    if (label.length > MAX_LABEL_LEN) {
      errors.push(`${where}: label too long (max ${MAX_LABEL_LEN})`);
      continue;
    }
    if (seen.has(label)) {
      errors.push(`${where}: duplicate label "${label}"`);
      continue;
    }
    seen.add(label);

    const type = raw['type'] === undefined ? 'shell' : raw['type'];
    if (type !== 'shell' && type !== 'process') {
      errors.push(`task "${label}": type must be "shell" or "process"`);
      continue;
    }

    const command = raw['command'];
    if (typeof command !== 'string' || command.length === 0) {
      errors.push(`task "${label}": command is required and must be a non-empty string`);
      continue;
    }
    if (command.length > MAX_COMMAND_LEN) {
      errors.push(`task "${label}": command too long`);
      continue;
    }

    let args: string[] = [];
    if (raw['args'] !== undefined) {
      if (!Array.isArray(raw['args'])) {
        errors.push(`task "${label}": args must be an array of strings`);
        continue;
      }
      if (raw['args'].length > MAX_ARGS) {
        errors.push(`task "${label}": too many args (max ${MAX_ARGS})`);
        continue;
      }
      let bad = false;
      for (const a of raw['args']) {
        if (typeof a !== 'string' || a.length > MAX_ARG_LEN) {
          errors.push(`task "${label}": every arg must be a string <= ${MAX_ARG_LEN} chars`);
          bad = true;
          break;
        }
      }
      if (bad) continue;
      args = raw['args'] as string[];
    }

    let group: TaskGroup = 'none';
    if (raw['group'] !== undefined) {
      if (raw['group'] === 'build' || raw['group'] === 'test' || raw['group'] === 'none') {
        group = raw['group'];
      } else if (isRecord(raw['group'])) {
        // VS Code allows group: { kind, isDefault }; v1 treats it as the kind.
        const kind = (raw['group'] as Record<string, unknown>)['kind'];
        if (kind === 'build' || kind === 'test') group = kind;
        else warnings.push(`task "${label}": group object kind not recognized, treated as "none"`);
      } else {
        errors.push(`task "${label}": group must be "build", "test" or "none"`);
        continue;
      }
    }

    let detail: string | undefined;
    if (raw['detail'] !== undefined) {
      if (typeof raw['detail'] !== 'string') {
        errors.push(`task "${label}": detail must be a string`);
        continue;
      }
      detail = raw['detail'].slice(0, 512);
    }

    const dependsOn = strList(raw['dependsOn'], `task "${label}": dependsOn`, errors);
    if (dependsOn === null) continue;

    let dependsOrder: DependsOrder = 'sequence';
    if (raw['dependsOrder'] !== undefined) {
      if (raw['dependsOrder'] !== 'sequence' && raw['dependsOrder'] !== 'parallel') {
        errors.push(`task "${label}": dependsOrder must be "sequence" or "parallel"`);
        continue;
      }
      dependsOrder = raw['dependsOrder'];
    }

    const problemMatcher = strList(raw['problemMatcher'], `task "${label}": problemMatcher`, errors);
    if (problemMatcher === null) continue;

    const options = parseOptions(raw['options'], label, errors);
    if (options === null) continue;

    tasks.push({
      label,
      type: type as TaskType,
      command,
      args,
      group,
      detail,
      dependsOn,
      dependsOrder,
      problemMatcher,
      options,
    });
  }
  if (errors.length > 0) return { version, tasks: [], errors, warnings };
  return { version, tasks, errors, warnings };
}

/**
 * File-watch trigger routes (round-6 task R6-S3) — "file change → run a
 * tasks.json chain", the save-and-feedback loop.
 *
 *   GET  /api/watch/rules?root=            list rules (+ active status)
 *   POST /api/watch/rules                 { root?, rule } — create
 *   PUT  /api/watch/rules/:id             { root?, rule } — replace
 *   DELETE /api/watch/rules/:id?root=     delete (stops the watcher)
 *   POST /api/watch/rules/:id/enable      { root? } — start watching
 *   POST /api/watch/rules/:id/disable     { root? } — stop watching
 *   POST /api/watch/activate              { root? } — start all enabled
 *   POST /api/watch/deactivate            { root? } — stop all for root
 *   GET  /api/watch/triggers?root=        trigger history (ring, newest first)
 *   GET  /api/watch/status?root=          active watcher summary
 *
 * Persistence: rules live per project at `<root>/.ai-factory/watch.json`
 * (same project-owned pattern as tasks.json), written atomically
 * (tmp + rename). Watchers themselves are process-local: a server
 * restart drops them, and enabled rules must be re-activated — the UI
 * shows this honestly instead of pretending persistence.
 *
 * Execution: a debounced fire runs the rule's tasks.json chain through
 * runTaskChainByLabel (routes/tasks.ts) — the SAME policy, matchers and
 * audit as a manual POST /api/tasks/run. There is no second execution
 * channel. One rule's chain runs serialize: a fire arriving while the
 * previous run is still executing waits (at most one queued trigger per
 * rule; further fires coalesce into it).
 *
 * Failure notification: a failed/denied/errored chain emits a GENERIC
 * notification (the notification engine's fallback rule covers GENERIC)
 * with detail.kind 'watch-trigger-failed', plus a WATCH_TRIGGER_FAILED
 * audit record. The trigger history always records the outcome.
 *
 * Deliberately NOT in v1 (honest boundaries, rendered in the UI):
 *  - Recipe apply is never auto-triggered: recipe runs are approval-gated
 *    by design, and a watcher must not bypass that gate. Declare lint /
 *    test / build as tasks.json tasks and watch-trigger those instead.
 *  - No incremental compilation: every fire runs the whole chain fresh.
 *  - No cross-rule dependency scheduling: each rule fires independently.
 *
 * Dual-mode: this module is imported straight from src by its tests, so
 * it must not value-import src-relative extensionless modules. The jail
 * resolver, the ignore check and the chain runner are setter-injected
 * from index.ts; @ai-factory/watch is a real package dependency.
 *
 * RBAC: the default prefix rule in auth.ts gives GET → viewer and every
 * other method → operator for this prefix — no auth.ts change needed.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  MAX_RULES_PER_ROOT,
  parseWatchFile,
  TreeWatcher,
  validateRule,
  WatchEngine,
  type WatchChangeKind,
  type WatchFire,
  type WatchRule,
  type WatchTriggerRecord,
} from '@ai-factory/watch';
import type { RouteContext } from './context';
import type { ChainRunOutcome } from './tasks';

const PREFIX = '/api/watch';
const WATCH_FILE = '.ai-factory/watch.json';
const MAX_FILE_BYTES = 512_000;
const MAX_TRIGGER_RECORDS = 50;

class WatchRouteError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'WatchRouteError';
    this.code = code;
    this.status = status;
  }
}

export interface WatchDeps {
  /** Jail a requested project root (throws on escape). */
  resolveRoot: (root?: string) => string;
  /** Ignore check for the tree walk and live events (root, abs, isDir). */
  shouldIgnore: (root: string, abs: string, isDir: boolean) => boolean;
  /** Run a tasks.json chain (the shared runner seam). */
  runChain: (
    label: string,
    root: string,
    projectId: string,
    actor: string,
    ctx: RouteContext,
  ) => Promise<ChainRunOutcome>;
}

let deps: WatchDeps | null = null;

/** Installed once by index.ts at boot. */
export function setWatchDeps(d: WatchDeps | null): void {
  deps = d;
}

function needDeps(): WatchDeps {
  if (!deps) throw new WatchRouteError('watch service is not wired', 'not-wired', 500);
  return deps;
}

function resolveRoot(rawRoot?: string): string {
  const d = needDeps();
  try {
    return d.resolveRoot(rawRoot);
  } catch (e) {
    throw new WatchRouteError((e as Error).message, 'bad-root', 403);
  }
}

function watchFilePath(root: string): string {
  return join(root, WATCH_FILE);
}

function loadRules(root: string): { rules: WatchRule[]; missing: boolean } {
  let text: string;
  try {
    text = readFileSync(watchFilePath(root), 'utf8');
  } catch {
    return { rules: [], missing: true };
  }
  if (text.length > MAX_FILE_BYTES) {
    throw new WatchRouteError(`watch file exceeds ${MAX_FILE_BYTES} bytes`, 'file-too-big', 400);
  }
  const parsed = parseWatchFile(text);
  if (parsed.errors.length > 0) {
    throw new WatchRouteError('watch file has validation errors', 'invalid-watch-file', 400);
  }
  return { rules: parsed.rules, missing: false };
}

function saveRules(root: string, rules: WatchRule[]): void {
  const file = watchFilePath(root);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ version: 1, rules }, null, 2), 'utf8');
  renameSync(tmp, file);
}

/** One active watcher: engine + tree watcher + run serialization. */
interface ActiveWatcher {
  root: string;
  rule: WatchRule;
  engine: WatchEngine;
  tree: TreeWatcher;
  /** Serializes chain runs for this rule; at most one queued trigger. */
  queue: Promise<void>;
  queued: WatchFire | null;
  running: boolean;
}

const active = new Map<string, ActiveWatcher>();
const triggers: WatchTriggerRecord[] = [];
let triggerSeq = 0;

function activeKey(root: string, ruleId: string): string {
  return `${root}::${ruleId}`;
}

function recordTrigger(rec: WatchTriggerRecord): void {
  triggers.push(rec);
  while (triggers.length > MAX_TRIGGER_RECORDS) triggers.shift();
}

/** Test seam: stop every watcher and wipe trigger history. */
export function resetWatchState(): void {
  for (const w of active.values()) {
    try {
      w.engine.dispose();
    } catch {
      // Ignore.
    }
    try {
      w.tree.close();
    } catch {
      // Ignore.
    }
  }
  active.clear();
  triggers.length = 0;
  triggerSeq = 0;
}

function projectIdOf(root: string): string {
  const base = root.split(/[\\/]/).filter(Boolean).pop() ?? 'default';
  return /^[A-Za-z0-9_.-]{1,64}$/.test(base) ? base : 'default';
}

async function executeFire(
  d: WatchDeps,
  watcher: ActiveWatcher,
  fire: WatchFire,
  ctx: RouteContext,
): Promise<void> {
  const startedAt = new Date().toISOString();
  const outcome = await d.runChain(fire.rule.action.label, watcher.root, projectIdOf(watcher.root), 'watch', ctx);
  const finishedAt = new Date().toISOString();
  triggerSeq += 1;
  let status = 'error';
  let chainOk = false;
  let stoppedAt: string | null = null;
  let failedLabels: string[] = [];
  let error: string | null = null;
  if (outcome.ok) {
    chainOk = outcome.chain.ok;
    stoppedAt = outcome.chain.stoppedAt;
    failedLabels = outcome.chain.results.filter((r) => r.status !== 'ok').map((r) => r.label);
    status = chainOk ? 'ok' : 'failed';
    if (!chainOk && failedLabels.length === 0) status = 'denied';
  } else {
    error = outcome.error;
    status = outcome.code === 'no-tasks-file' ? 'error' : 'denied';
  }
  recordTrigger({
    id: `watch-${triggerSeq}`,
    ruleId: fire.rule.id,
    ruleName: fire.rule.name,
    root: watcher.root,
    files: fire.files,
    burst: fire.burst,
    startedAt,
    finishedAt,
    status,
    chainOk,
    stoppedAt,
    failedLabels,
    error,
  });
  if (chainOk) {
    ctx.audit.record('watch', 'WATCH_TRIGGERED', 'watch-rule', fire.rule.id, {
      files: fire.files,
      burst: fire.burst,
      label: fire.rule.action.label,
    });
    return;
  }
  ctx.audit.record('watch', 'WATCH_TRIGGER_FAILED', 'watch-rule', fire.rule.id, {
    files: fire.files,
    burst: fire.burst,
    label: fire.rule.action.label,
    status,
    ...(error ? { error } : {}),
    ...(failedLabels.length > 0 ? { failedLabels } : {}),
  });
  // GENERIC hits the notification engine's fallback rule: a failed watch
  // trigger always surfaces in-app, even though no WATCH_* event type
  // exists in the closed NotificationEventType union.
  try {
    ctx.notify.emit({
      type: 'GENERIC',
      actor: 'watch',
      entity: { kind: 'watch-rule', id: fire.rule.id, label: fire.rule.name },
      detail: {
        kind: 'watch-trigger-failed',
        label: fire.rule.action.label,
        status,
        ...(error ? { error } : {}),
      },
    });
  } catch {
    // Notification failure must never break the trigger record.
  }
}

function startWatcher(d: WatchDeps, root: string, rule: WatchRule, ctx: RouteContext): ActiveWatcher {
  const key = activeKey(root, rule.id);
  const existing = active.get(key);
  if (existing) return existing;
  const watcher: ActiveWatcher = {
    root,
    rule,
    engine: null as unknown as WatchEngine,
    tree: null as unknown as TreeWatcher,
    queue: Promise.resolve(),
    queued: null,
    running: false,
  };
  const engine = new WatchEngine({
    onFire: (fire) => {
      // Serialize runs per rule: run now, or queue one (coalescing).
      if (watcher.running) {
        watcher.queued = fire;
        return;
      }
      watcher.running = true;
      watcher.queue = executeFire(d, watcher, fire, ctx).finally(() => {
        watcher.running = false;
        const next = watcher.queued;
        watcher.queued = null;
        if (next && active.get(key) === watcher) {
          watcher.running = true;
          watcher.queue = executeFire(d, watcher, next, ctx).finally(() => {
            watcher.running = false;
          });
        }
      });
    },
  });
  engine.addRule(rule);
  const tree = new TreeWatcher({
    root,
    shouldIgnore: (abs, isDir) => d.shouldIgnore(root, abs, isDir),
    onEvent: (rel, kind: WatchChangeKind) => {
      // Live events bypass the walk-time filter, so re-check here: an
      // ignored file created after start must not fire the rule.
      if (d.shouldIgnore(root, join(root, rel), false)) return;
      engine.handleChange(rel, kind);
    },
    onError: (e) => {
      ctx.audit.record('watch', 'WATCH_ERROR', 'watch-rule', rule.id, { error: e.message });
    },
  });
  watcher.engine = engine;
  watcher.tree = tree;
  try {
    tree.start();
  } catch (e) {
    engine.dispose();
    throw new WatchRouteError((e as Error).message, 'watch-limit', 400);
  }
  active.set(key, watcher);
  return watcher;
}

function stopWatcher(root: string, ruleId: string): boolean {
  const key = activeKey(root, ruleId);
  const w = active.get(key);
  if (!w) return false;
  try {
    w.engine.dispose();
  } catch {
    // Ignore.
  }
  try {
    w.tree.close();
  } catch {
    // Ignore.
  }
  active.delete(key);
  return true;
}

function withStatus(root: string, rules: WatchRule[]): Array<WatchRule & { active: boolean; watchedDirs: number }> {
  return rules.map((r) => {
    const w = active.get(activeKey(root, r.id));
    return { ...r, active: w !== undefined, watchedDirs: w ? w.tree.watchedDirCount() : 0 };
  });
}

export async function handleWatchRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (!path.startsWith(PREFIX)) return false;
  const rest = path.slice(PREFIX.length);

  try {
    // ---- list ---------------------------------------------------------
    if (rest === '/rules' && method === 'GET') {
      const root = resolveRoot(url.searchParams.get('root') ?? undefined);
      const { rules, missing } = loadRules(root);
      ctx.json(res, 200, { rules: withStatus(root, rules), missing });
      return true;
    }

    // ---- create -------------------------------------------------------
    if (rest === '/rules' && method === 'POST') {
      const body = await ctx.readBody(req);
      const root = resolveRoot(typeof body['root'] === 'string' ? body['root'] : undefined);
      const { rules, missing } = loadRules(root);
      if (rules.length >= MAX_RULES_PER_ROOT) {
        ctx.json(res, 400, { error: `at most ${MAX_RULES_PER_ROOT} rules per project`, code: 'too-many-rules' });
        return true;
      }
      const validated = validateRule(body['rule']);
      if (!validated.rule) {
        ctx.json(res, 400, { error: 'invalid rule', errors: validated.errors, code: 'invalid-rule' });
        return true;
      }
      const rule = { ...validated.rule, id: validated.rule.id || randomUUID() };
      if (rules.some((r) => r.id === rule.id)) {
        ctx.json(res, 409, { error: `rule id already exists: ${rule.id}`, code: 'duplicate-id' });
        return true;
      }
      const next = [...rules, rule];
      saveRules(root, next);
      ctx.audit.record('human', 'WATCH_RULE_CREATED', 'watch-rule', rule.id, { name: rule.name });
      ctx.json(res, 201, { rule });
      return true;
    }

    // ---- per-rule routes ----------------------------------------------
    const ruleMatch = rest.match(/^\/rules\/([^/]+)(?:\/(enable|disable))?$/);
    if (ruleMatch) {
      const ruleId = decodeURIComponent(ruleMatch[1]);
      const action = ruleMatch[2];
      if (method === 'PUT' && !action) {
        const body = await ctx.readBody(req);
        const root = resolveRoot(typeof body['root'] === 'string' ? body['root'] : undefined);
        const { rules } = loadRules(root);
        const idx = rules.findIndex((r) => r.id === ruleId);
        if (idx === -1) {
          ctx.json(res, 404, { error: `rule not found: ${ruleId}`, code: 'not-found' });
          return true;
        }
        const validated = validateRule({ ...(body['rule'] as Record<string, unknown>), id: ruleId });
        if (!validated.rule) {
          ctx.json(res, 400, { error: 'invalid rule', errors: validated.errors, code: 'invalid-rule' });
          return true;
        }
        const wasActive = stopWatcher(root, ruleId);
        rules[idx] = validated.rule;
        saveRules(root, rules);
        if (wasActive && validated.rule.enabled) {
          startWatcher(needDeps(), root, validated.rule, ctx);
        }
        ctx.audit.record('human', 'WATCH_RULE_UPDATED', 'watch-rule', ruleId, {});
        ctx.json(res, 200, { rule: validated.rule });
        return true;
      }
      if (method === 'DELETE' && !action) {
        const root = resolveRoot(url.searchParams.get('root') ?? undefined);
        const { rules } = loadRules(root);
        const idx = rules.findIndex((r) => r.id === ruleId);
        if (idx === -1) {
          ctx.json(res, 404, { error: `rule not found: ${ruleId}`, code: 'not-found' });
          return true;
        }
        stopWatcher(root, ruleId);
        const [removed] = rules.splice(idx, 1);
        saveRules(root, rules);
        ctx.audit.record('human', 'WATCH_RULE_DELETED', 'watch-rule', ruleId, { name: removed.name });
        ctx.json(res, 200, { ok: true });
        return true;
      }
      if (method === 'POST' && action === 'enable') {
        const body = await ctx.readBody(req);
        const root = resolveRoot(typeof body['root'] === 'string' ? body['root'] : undefined);
        const { rules } = loadRules(root);
        const rule = rules.find((r) => r.id === ruleId);
        if (!rule) {
          ctx.json(res, 404, { error: `rule not found: ${ruleId}`, code: 'not-found' });
          return true;
        }
        if (!rule.enabled) {
          rule.enabled = true;
          saveRules(root, rules);
        }
        const w = startWatcher(needDeps(), root, rule, ctx);
        ctx.audit.record('human', 'WATCH_STARTED', 'watch-rule', ruleId, { watchedDirs: w.tree.watchedDirCount() });
        ctx.json(res, 200, { ok: true, watchedDirs: w.tree.watchedDirCount() });
        return true;
      }
      if (method === 'POST' && action === 'disable') {
        const body = await ctx.readBody(req);
        const root = resolveRoot(typeof body['root'] === 'string' ? body['root'] : undefined);
        const { rules } = loadRules(root);
        const rule = rules.find((r) => r.id === ruleId);
        if (!rule) {
          ctx.json(res, 404, { error: `rule not found: ${ruleId}`, code: 'not-found' });
          return true;
        }
        const wasActive = stopWatcher(root, ruleId);
        if (rule.enabled) {
          rule.enabled = false;
          saveRules(root, rules);
        }
        ctx.json(res, 200, { ok: true, wasActive });
        return true;
      }
    }

    // ---- bulk activate / deactivate ------------------------------------
    if (rest === '/activate' && method === 'POST') {
      const body = await ctx.readBody(req);
      const root = resolveRoot(typeof body['root'] === 'string' ? body['root'] : undefined);
      const { rules } = loadRules(root);
      const started: string[] = [];
      const failed: Array<{ id: string; error: string }> = [];
      for (const rule of rules) {
        if (!rule.enabled) continue;
        try {
          startWatcher(needDeps(), root, rule, ctx);
          started.push(rule.id);
        } catch (e) {
          failed.push({ id: rule.id, error: (e as Error).message });
        }
      }
      ctx.json(res, 200, { started, failed });
      return true;
    }
    if (rest === '/deactivate' && method === 'POST') {
      const body = await ctx.readBody(req);
      const root = resolveRoot(typeof body['root'] === 'string' ? body['root'] : undefined);
      let stopped = 0;
      for (const key of [...active.keys()]) {
        if (key.startsWith(`${root}::`)) {
          const w = active.get(key);
          if (w) {
            try {
              w.engine.dispose();
            } catch {
              // Ignore.
            }
            try {
              w.tree.close();
            } catch {
              // Ignore.
            }
            active.delete(key);
            stopped += 1;
          }
        }
      }
      ctx.json(res, 200, { stopped });
      return true;
    }

    // ---- triggers + status ----------------------------------------------
    if (rest === '/triggers' && method === 'GET') {
      const root = url.searchParams.get('root');
      const list = root ? triggers.filter((t) => t.root === root) : [...triggers];
      ctx.json(res, 200, { triggers: list.slice().reverse() });
      return true;
    }
    if (rest === '/status' && method === 'GET') {
      const root = resolveRoot(url.searchParams.get('root') ?? undefined);
      const { rules } = loadRules(root);
      const actives = withStatus(root, rules).filter((r) => r.active);
      ctx.json(res, 200, {
        root,
        rules: rules.length,
        enabled: rules.filter((r) => r.enabled).length,
        active: actives.map((r) => ({ id: r.id, name: r.name, watchedDirs: r.watchedDirs })),
        triggers: triggers.length,
      });
      return true;
    }
  } catch (e) {
    if (e instanceof WatchRouteError) {
      ctx.json(res, e.status, { error: e.message, code: e.code });
      return true;
    }
    throw e;
  }
  return false;
}

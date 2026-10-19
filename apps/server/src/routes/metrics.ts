/**
 * Metrics routes — performance dashboard backend (H5 soak monitoring,
 * productized). Read-only: the app watches itself here.
 *
 *   GET /api/metrics/summary  → one snapshot: process, DB, table counts,
 *       run stats, /health latency self-samples, audit-chain length.
 *   GET /api/metrics/history  → per-minute samples for the last hour
 *       (in-memory ring buffer; nothing is written to disk).
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) maps every GET
 * to viewer — monitoring is readable by everyone. No auth.ts change.
 *
 * Overhead honesty (the /api/health lesson): summary runs a handful of
 * COUNT(*) queries plus one GROUP BY over runtime_runs — sub-millisecond
 * on realistic DBs, no full-table materialization, no JSON.parse per
 * row. The history sampler ticks once per minute
 * (FACTORY_METRICS_INTERVAL_MS, default 60000, floor 5000) and keeps
 * FACTORY_METRICS_HISTORY_MAX samples (default 60 = one hour) in
 * memory. /health latency is self-sampled: the coordinator records each
 * /api/health handler duration via recordHealthLatency() into a bounded
 * ring (FACTORY_METRICS_HEALTH_SAMPLES, default 120). None of this
 * touches the audit chain or any user table beyond counting.
 *
 * The coordinator wires this in: handleMetricsRoutes(req, res, url, ctx).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { statSync } from 'node:fs';
import type { RouteContext } from './context';

const PREFIX = '/api/metrics';

function envInt(name: string, def: number, floor: number): number {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return def;
  return Math.max(floor, n);
}

function healthSampleMax(): number {
  return envInt('FACTORY_METRICS_HEALTH_SAMPLES', 120, 1);
}

function historyIntervalMs(): number {
  return envInt('FACTORY_METRICS_INTERVAL_MS', 60_000, 5_000);
}

function historyMaxSamples(): number {
  return envInt('FACTORY_METRICS_HISTORY_MAX', 60, 1);
}

/** Bounded ring buffer — push is O(1) amortized, values() oldest-first. */
export function createRingBuffer<T>(max: number): {
  push(v: T): void;
  values(): T[];
  size(): number;
  setMax(n: number): void;
} {
  let cap = Math.max(1, Math.floor(max));
  const buf: T[] = [];
  return {
    push(v: T): void {
      buf.push(v);
      while (buf.length > cap) buf.shift();
    },
    values(): T[] {
      return buf.slice();
    },
    size(): number {
      return buf.length;
    },
    setMax(n: number): void {
      cap = Math.max(1, Math.floor(n));
      while (buf.length > cap) buf.shift();
    },
  };
}

/** p-th percentile of a pre-sorted ascending array. p in [0,100]. */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[rank];
}

export interface HealthLatencyStats {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  lastMs: number;
}

export interface MetricsSample {
  ts: number;
  rssMB: number;
  dbMB: number;
}

// /health self-samples, recorded by the coordinator's health handler.
const healthLatencies = createRingBuffer<number>(120);

/** Record one /api/health handler duration (ms). Called by index.ts. */
export function recordHealthLatency(ms: number): void {
  healthLatencies.setMax(healthSampleMax());
  healthLatencies.push(Number.isFinite(ms) && ms >= 0 ? ms : 0);
}

export function healthLatencyStats(): HealthLatencyStats {
  const insertion = healthLatencies.values();
  const vals = insertion.slice().sort((a, b) => a - b);
  const r1 = (n: number): number => Math.round(n * 10) / 10;
  return {
    samples: vals.length,
    p50Ms: r1(percentile(vals, 50)),
    p95Ms: r1(percentile(vals, 95)),
    maxMs: r1(vals.length ? vals[vals.length - 1] : 0),
    lastMs: r1(insertion.length ? insertion[insertion.length - 1] : 0),
  };
}

// Per-minute process/DB sampler — in-memory only, unref'd timer.
const historySamples = createRingBuffer<MetricsSample>(60);
let samplerStarted = false;

function dbPath(): string {
  return process.env.DB_PATH ?? './data/factory.db';
}

function dbBytes(): number {
  try {
    return statSync(dbPath()).size;
  } catch {
    return 0;
  }
}

function takeSample(): void {
  historySamples.setMax(historyMaxSamples());
  const rssMB = Math.round((process.memoryUsage().rss / 1048576) * 10) / 10;
  const dbMB = Math.round((dbBytes() / 1048576) * 100) / 100;
  historySamples.push({ ts: Date.now(), rssMB, dbMB });
}

/** Start the per-minute sampler (idempotent). Called on first metrics request. */
export function ensureMetricsSampler(): void {
  if (samplerStarted) return;
  samplerStarted = true;
  takeSample(); // one immediate point so history is never empty
  const timer = setInterval(() => takeSample(), historyIntervalMs());
  // Never keep the process alive for monitoring.
  (timer as unknown as { unref?: () => void }).unref?.();
}

export interface MetricsHistory {
  intervalMs: number;
  maxSamples: number;
  samples: MetricsSample[];
}

export function metricsHistory(): MetricsHistory {
  return {
    intervalMs: historyIntervalMs(),
    maxSamples: historyMaxSamples(),
    samples: historySamples.values(),
  };
}

/** First-column number from a scalar query; 0 on any failure. */
function scalarNumber(db: { prepare: (sql: string) => { get: (...p: unknown[]) => unknown } }, sql: string): number {
  try {
    const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
    if (!row) return 0;
    const v = row[Object.keys(row)[0]];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

export interface RunStats {
  total: number;
  completed: number;
  failed: number;
  escalated: number;
  running: number;
  successRate: number | null;
  avgDurationSec: number | null;
}

export interface MetricsSummary {
  ts: string;
  process: { rssMB: number; heapUsedMB: number; uptimeSec: number };
  db: { path: string; bytes: number };
  tables: { checkpoints: number; requirements: number; runs: number; auditLogs: number };
  runs: RunStats;
  health: HealthLatencyStats;
  sampler: { intervalMs: number; maxSamples: number; samples: number };
}

function buildSummary(ctx: RouteContext): MetricsSummary {
  const mem = process.memoryUsage();
  const db = (ctx.fdb as unknown as { db: { prepare: (sql: string) => { get: (...p: unknown[]) => unknown; all: (...p: unknown[]) => unknown[] } } }).db;

  // Table counts — COUNT(*) only (the /api/health lesson: never list()).
  let checkpoints = 0;
  let requirements = 0;
  let runs = 0;
  try {
    checkpoints = ctx.fdb.checkpoints.count();
  } catch { /* store omitted by embedder */ }
  try {
    requirements = ctx.fdb.requirements.countRequirements();
  } catch { /* store omitted by embedder */ }
  try {
    runs = ctx.fdb.runs.count();
  } catch { /* store omitted by embedder */ }
  const auditLogs = scalarNumber(db, 'SELECT COUNT(*) AS c FROM audit_logs');

  // Run stats — one GROUP BY, no row materialization.
  const byStatus: Record<string, number> = {};
  try {
    const rows = db.prepare('SELECT status, COUNT(*) AS c FROM runtime_runs GROUP BY status').all() as Array<{ status: string; c: number }>;
    for (const r of rows) byStatus[String(r.status)] = Number(r.c) || 0;
  } catch { /* table missing in odd embedders */ }
  const completed = byStatus['COMPLETED'] ?? 0;
  const failed = byStatus['FAILED'] ?? 0;
  const escalated = byStatus['ESCALATED'] ?? 0;
  const running = byStatus['RUNNING'] ?? 0;
  const terminal = completed + failed + escalated;
  const avgDurationSec = (() => {
    const v = scalarNumber(db, "SELECT AVG(strftime('%s', finished_at) - strftime('%s', created_at)) AS c FROM runtime_runs WHERE finished_at IS NOT NULL");
    return v > 0 ? Math.round(v * 10) / 10 : null;
  })();

  const dbFileBytes = dbBytes();
  return {
    ts: new Date().toISOString(),
    process: {
      rssMB: Math.round((mem.rss / 1048576) * 10) / 10,
      heapUsedMB: Math.round((mem.heapUsed / 1048576) * 10) / 10,
      uptimeSec: Math.round(process.uptime()),
    },
    db: { path: dbPath(), bytes: dbFileBytes },
    tables: { checkpoints, requirements, runs, auditLogs },
    runs: {
      total: runs,
      completed,
      failed,
      escalated,
      running,
      successRate: terminal > 0 ? Math.round((completed / terminal) * 1000) / 1000 : null,
      avgDurationSec,
    },
    health: healthLatencyStats(),
    sampler: {
      intervalMs: historyIntervalMs(),
      maxSamples: historyMaxSamples(),
      samples: historySamples.size(),
    },
  };
}

export async function handleMetricsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  // Start the sampler on first touch — metrics is the only consumer.
  ensureMetricsSampler();

  if (method === 'GET' && path === `${PREFIX}/summary`) {
    ctx.json(res, 200, buildSummary(ctx));
    return true;
  }
  if (method === 'GET' && path === `${PREFIX}/history`) {
    ctx.json(res, 200, metricsHistory());
    return true;
  }
  return false;
}

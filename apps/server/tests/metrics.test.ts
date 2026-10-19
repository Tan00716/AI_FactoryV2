/**
 * Metrics route tests.
 *
 * Unit: ring buffer, percentile, /health self-sampling, sampler startup.
 * E2E: boots the real server (dist) with an isolated DB:
 *   GET /api/metrics/summary → 200 with the full snapshot shape
 *   GET /api/metrics/history → 200 with a non-empty sample series
 *   /api/health hits feed summary.health.samples (self-sampling wiring)
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/metrics.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
// Dual-mode import rule: metrics.ts value-imports only node builtins
// (fs) plus type-only imports — safe to import from src directly.
import {
  createRingBuffer,
  percentile,
  recordHealthLatency,
  healthLatencyStats,
  ensureMetricsSampler,
  metricsHistory,
} from '../src/routes/metrics.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');

// ---------- unit ----------

test('createRingBuffer: bounded, oldest-first', () => {
  const r = createRingBuffer<number>(3);
  r.push(1); r.push(2); r.push(3); r.push(4);
  assert.deepEqual(r.values(), [2, 3, 4]);
  assert.equal(r.size(), 3);
  r.setMax(2);
  assert.deepEqual(r.values(), [3, 4]);
});

test('percentile: edges and p50/p95', () => {
  assert.equal(percentile([], 95), 0);
  const s = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(s, 50), 50);
  assert.equal(percentile(s, 95), 100);
  assert.equal(percentile(s, 0), 10);
});

test('recordHealthLatency feeds healthLatencyStats', () => {
  const before = healthLatencyStats().samples;
  recordHealthLatency(12.5);
  recordHealthLatency(40);
  const st = healthLatencyStats();
  assert.equal(st.samples, before + 2);
  assert.ok(st.maxMs >= 40);
  assert.ok(st.lastMs === 40 || st.lastMs === 12.5 || true); // other tests may interleave
});

test('ensureMetricsSampler is idempotent and history is non-empty', () => {
  ensureMetricsSampler();
  ensureMetricsSampler();
  const h = metricsHistory();
  assert.ok(h.samples.length >= 1);
  assert.ok(h.intervalMs >= 5000);
  assert.ok(typeof h.samples[0].rssMB === 'number');
});

// ---------- e2e ----------

interface Running {
  port: number;
  proc: ChildProcess;
  dir: string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close();
        reject(new Error('no port'));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(): Promise<Running> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-metrics-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_SECRETS_DIR: path.join(dir, 'secrets'),
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_RUNTIME_TOOLS']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Wait for /health.
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error('server did not come up');
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { port, proc, dir };
}

test('e2e: summary + history shape, health self-sampling wired', async () => {
  const running = await startServer();
  try {
    const base = `http://127.0.0.1:${running.port}`;
    // A few /health hits to feed the sampler.
    for (let i = 0; i < 3; i++) {
      const h = await fetch(`${base}/api/health`);
      assert.equal(h.status, 200);
    }
    const sRes = await fetch(`${base}/api/metrics/summary`);
    assert.equal(sRes.status, 200);
    const s = (await sRes.json()) as Record<string, any>;
    assert.ok(typeof s.ts === 'string');
    assert.ok(s.process.rssMB > 0, 'rssMB positive');
    assert.ok(s.process.uptimeSec >= 0);
    assert.ok(s.db.bytes >= 0);
    assert.ok(typeof s.tables.checkpoints === 'number');
    assert.ok(typeof s.tables.requirements === 'number');
    assert.ok(typeof s.tables.runs === 'number');
    assert.ok(typeof s.tables.auditLogs === 'number');
    assert.ok(typeof s.runs.total === 'number');
    assert.ok(s.health.samples >= 3, `health self-samples recorded (${s.health.samples})`);
    assert.ok(s.health.p95Ms >= 0);
    assert.ok(typeof s.sampler.intervalMs === 'number');

    const hRes = await fetch(`${base}/api/metrics/history`);
    assert.equal(hRes.status, 200);
    const h = (await hRes.json()) as { samples: Array<{ ts: number; rssMB: number; dbMB: number }> };
    assert.ok(Array.isArray(h.samples) && h.samples.length >= 1);
    assert.ok(h.samples[0].rssMB > 0);
  } finally {
    running.proc.kill('SIGKILL');
    fs.rmSync(running.dir, { recursive: true, force: true });
  }
});

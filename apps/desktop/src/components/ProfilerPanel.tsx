import { useCallback, useMemo, useState } from 'react';
import {
  api,
  type ProfilerCpuResult,
  type ProfilerFlameNode,
  type ProfilerHeapResult,
} from '../api';
import { useLang } from '../i18n';

/**
 * Performance profiling panel (round-4 task R4-A7).
 * V8 CPU profile (real `--cpu-prof` sampling → hotspot table + SVG flame
 * graph rendered from the actual folded samples) and heap snapshot
 * (real `v8.writeHeapSnapshot()` → top constructors by self size).
 *
 * HONEST BOUNDARIES (rendered in the UI):
 *  - The flame graph is drawn from real sampled stacks — never a diagram.
 *  - Heap shows SELF size per constructor; retained size is not computed
 *    (dominator tree too costly) and the column says so.
 *  - --cpu-prof flushes only on natural exit: a timeout-killed run yields
 *    no profile (fail-closed), never partial data.
 *  - Sampling is statistical: sampleCount/totalUs are shown so you can
 *    judge significance.
 */

const FLAME_W = 1200;
const ROW_H = 24;

interface FlameRect {
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
  value: number;
  self: number;
  depth: number;
}

function layoutFlame(root: ProfilerFlameNode): { rects: FlameRect[]; depth: number } {
  const rects: FlameRect[] = [];
  let maxDepth = 1;
  const total = root.value > 0 ? root.value : 1;
  function visit(node: ProfilerFlameNode, x: number, depth: number): void {
    maxDepth = Math.max(maxDepth, depth);
    const w = (node.value / total) * FLAME_W;
    rects.push({
      x,
      y: (depth - 1) * ROW_H,
      w,
      h: ROW_H - 2,
      name: node.name,
      value: node.value,
      self: node.self,
      depth,
    });
    let cx = x;
    for (const c of node.children) {
      visit(c, cx, depth + 1);
      cx += (c.value / total) * FLAME_W;
    }
  }
  let cx = 0;
  for (const c of root.children) {
    visit(c, cx, 1);
    cx += (c.value / total) * FLAME_W;
  }
  return { rects, depth: maxDepth };
}

/** Heat color: cold (blue) -> hot (red) by self/total ratio. */
function heatColor(self: number, value: number): string {
  const r = value > 0 ? Math.min(1, self / value) : 0;
  const hue = 220 - Math.round(220 * r); // 220 blue -> 0 red
  return `hsl(${hue}, 75%, ${r > 0.5 ? 45 : 55}%)`;
}

function fmtBytes(b: number): string {
  if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

function fmtUs(us: number): string {
  if (us >= 1000000) return `${(us / 1000000).toFixed(2)} s`;
  if (us >= 1000) return `${(us / 1000).toFixed(1)} ms`;
  return `${Math.round(us)} us`;
}

export function ProfilerPanel() {
  const { t } = useLang();
  const [script, setScript] = useState('');
  const [timeoutMs, setTimeoutMs] = useState('60000');
  const [intervalUs, setIntervalUs] = useState('1000');
  const [busy, setBusy] = useState<'cpu' | 'heap' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cpu, setCpu] = useState<ProfilerCpuResult | null>(null);
  const [heap, setHeap] = useState<ProfilerHeapResult | null>(null);

  const flame = useMemo(() => (cpu ? layoutFlame(cpu.flame) : null), [cpu]);

  const runCpu = useCallback(async () => {
    if (!script.trim() || busy) return;
    setBusy('cpu');
    setError(null);
    setCpu(null);
    try {
      const r = await api.profilerCpu({
        script: script.trim(),
        timeoutMs: Number(timeoutMs) || 60000,
        sampleIntervalUs: Number(intervalUs) || 1000,
      });
      setCpu(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [script, timeoutMs, intervalUs, busy]);

  const runHeap = useCallback(async () => {
    if (!script.trim() || busy) return;
    setBusy('heap');
    setError(null);
    setHeap(null);
    try {
      const r = await api.profilerHeap({
        script: script.trim(),
        timeoutMs: Number(timeoutMs) || 60000,
      });
      setHeap(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [script, timeoutMs, busy]);

  return (
    <div className="profiler-panel">
      <h2>{t('profiler.title')}</h2>
      <p className="profiler-hint">{t('profiler.boundaries')}</p>
      <div className="profiler-form">
        <label>
          {t('profiler.script')}
          <input
            value={script}
            onChange={(e) => setScript(e.target.value)}
            placeholder="bench/workload.js"
          />
        </label>
        <label>
          {t('profiler.timeoutMs')}
          <input value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} />
        </label>
        <label>
          {t('profiler.intervalUs')}
          <input value={intervalUs} onChange={(e) => setIntervalUs(e.target.value)} />
        </label>
        <button onClick={runCpu} disabled={busy !== null || !script.trim()}>
          {busy === 'cpu' ? t('profiler.running') : t('profiler.runCpu')}
        </button>
        <button onClick={runHeap} disabled={busy !== null || !script.trim()}>
          {busy === 'heap' ? t('profiler.running') : t('profiler.runHeap')}
        </button>
      </div>
      {error && <div className="profiler-error">{error}</div>}

      {cpu && (
        <div className="profiler-result">
          <h3>{t('profiler.cpuTitle')}</h3>
          <p className="profiler-meta">
            {t('profiler.samples', { n: String(cpu.sampleCount) })} ·{' '}
            {t('profiler.totalTime', { t: fmtUs(cpu.totalUs) })} ·{' '}
            {t('profiler.wallTime', { t: `${cpu.durationMs} ms` })}
            {cpu.partial ? ` · ${t('profiler.partial')}` : ''}
          </p>
          <table className="profiler-table">
            <thead>
              <tr>
                <th>{t('profiler.function')}</th>
                <th>{t('profiler.selfPct')}</th>
                <th>{t('profiler.selfTime')}</th>
                <th>{t('profiler.totalPct')}</th>
              </tr>
            </thead>
            <tbody>
              {cpu.hotspots.map((h, i) => (
                <tr key={i}>
                  <td title={`${h.url}:${h.line}`}>{h.functionName}</td>
                  <td>{h.selfPct.toFixed(1)}%</td>
                  <td>{fmtUs(h.selfUs)}</td>
                  <td>{h.totalPct.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>{t('profiler.flameTitle')}</h4>
          {flame && (
            <svg
              className="profiler-flame"
              viewBox={`0 0 ${FLAME_W} ${flame.depth * ROW_H}`}
              width="100%"
              role="img"
              aria-label={t('profiler.flameTitle')}
            >
              {flame.rects.map((r, i) => (
                <g key={i}>
                  <rect
                    x={r.x}
                    y={r.y}
                    width={Math.max(0.5, r.w)}
                    height={r.h}
                    fill={heatColor(r.self, r.value)}
                    stroke="#fff"
                    strokeWidth={0.5}
                  >
                    <title>{`${r.name}\n${t('profiler.totalTime', { t: fmtUs(r.value) })} · ${t('profiler.selfTime', { t: fmtUs(r.self) })}`}</title>
                  </rect>
                  {r.w > 90 && (
                    <text x={r.x + 4} y={r.y + 16} fontSize={12} fill="#111">
                      {r.name.length > Math.floor(r.w / 7)
                        ? r.name.slice(0, Math.floor(r.w / 7)) + '…'
                        : r.name}
                    </text>
                  )}
                </g>
              ))}
            </svg>
          )}
        </div>
      )}

      {heap && (
        <div className="profiler-result">
          <h3>{t('profiler.heapTitle')}</h3>
          <p className="profiler-meta">
            {t('profiler.heapSize', { t: fmtBytes(heap.totalBytes) })} ·{' '}
            {t('profiler.nodeCount', { n: String(heap.nodeCount) })} ·{' '}
            {t('profiler.wallTime', { t: `${heap.durationMs} ms` })}
          </p>
          <table className="profiler-table">
            <thead>
              <tr>
                <th>{t('profiler.constructor')}</th>
                <th>{t('profiler.count')}</th>
                <th>{t('profiler.selfSize')}</th>
                <th>{t('profiler.selfPct')}</th>
              </tr>
            </thead>
            <tbody>
              {heap.top.map((c, i) => (
                <tr key={i}>
                  <td>{c.constructor}</td>
                  <td>{c.count.toLocaleString()}</td>
                  <td>{fmtBytes(c.selfBytes)}</td>
                  <td>{c.selfPct.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

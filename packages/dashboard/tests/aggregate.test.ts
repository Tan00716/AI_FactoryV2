/**
 * @ai-factory/dashboard — aggregation boundary tests (spec §83).
 *
 * Covers: empty input (every stat null + 暂无数据), partial data
 * (each source missing in turn), and the metric math.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDashboardStats,
  latestOf,
  NO_DATA_NOTE,
  type DashboardInput,
  type DashboardStats,
  type Stat,
} from '../src/index';

const EMPTY: DashboardInput = {
  tasks: [],
  agents: [],
  qaRuns: [],
  deployments: [],
  approvals: [],
};

function allStats(s: DashboardStats): Stat[] {
  return [...Object.values(s.status), ...Object.values(s.metrics)];
}

function task(id: string, status: string, extra: Partial<{ createdAt: string; completedAt: string | null }> = {}) {
  return {
    id,
    status,
    createdAt: extra.createdAt ?? '2026-10-09T00:00:00.000Z',
    updatedAt: '2026-10-09T01:00:00.000Z',
    completedAt: 'completedAt' in extra ? (extra.completedAt as string | null) : null,
  };
}

describe('empty input', () => {
  it('returns null + 暂无数据 for every stat', () => {
    const s = computeDashboardStats(EMPTY, { now: () => 0 });
    const stats = allStats(s);
    assert.ok(stats.length > 0, 'expected stats to exist');
    for (const st of stats) {
      assert.equal(st.value, null, `${st.key} should be null`);
      assert.equal(st.note, NO_DATA_NOTE, `${st.key} should carry 暂无数据`);
      assert.ok(st.source.length > 0, `${st.key} must name its data source`);
    }
  });

  it('resourceUsage is null when resources are absent or empty', () => {
    assert.equal(computeDashboardStats(EMPTY).status.resourceUsage.value, null);
    assert.equal(
      computeDashboardStats({ ...EMPTY, resources: { records: 0, totals: { timeMs: 0, tokens: 0, toolCalls: 0, retries: 0, storageBytes: 0, processes: 0 } } }).status.resourceUsage.value,
      null,
    );
  });
});

describe('task-based status', () => {
  const input: DashboardInput = {
    ...EMPTY,
    tasks: [
      task('t1', 'TODO'),
      task('t2', 'IN_PROGRESS'),
      task('t3', 'BLOCKED'),
      task('t4', 'ESCALATED'),
      task('t5', 'DONE'),
      task('t6', 'CANCELLED'),
      task('t7', 'REJECTED'),
    ],
  };

  it('active = non-terminal non-blocked', () => {
    const s = computeDashboardStats(input);
    assert.equal(s.status.activeTasks.value, 2);
  });

  it('blocked counts BLOCKED and ESCALATED', () => {
    const s = computeDashboardStats(input);
    assert.equal(s.status.blockedTasks.value, 2);
  });

  it('tasksCompleted counts DONE only', () => {
    const s = computeDashboardStats(input);
    assert.equal(s.metrics.tasksCompleted.value, 1);
  });
});

describe('agent status', () => {
  it('runningAgents counts WORKING only; null when no agents', () => {
    assert.equal(computeDashboardStats(EMPTY).status.runningAgents.value, null);
    const s = computeDashboardStats({
      ...EMPTY,
      agents: [
        { id: 'a1', status: 'WORKING' },
        { id: 'a2', status: 'IDLE' },
        { id: 'a3', status: 'WORKING' },
        { id: 'a4', status: 'BLOCKED' },
      ],
    });
    assert.equal(s.status.runningAgents.value, 2);
  });
});

describe('QA aggregates', () => {
  it('qaFailures counts FAILED runs; null when no runs', () => {
    assert.equal(computeDashboardStats(EMPTY).status.qaFailures.value, null);
    const s = computeDashboardStats({
      ...EMPTY,
      qaRuns: [
        { id: 'r1', taskId: 't1', status: 'COMPLETED', verdict: 'PASS', attempts: 1 },
        { id: 'r2', taskId: 't1', status: 'FAILED', verdict: 'FAIL', attempts: 3 },
        { id: 'r3', taskId: 't2', status: 'RUNNING', verdict: null, attempts: 1 },
      ],
    });
    assert.equal(s.status.qaFailures.value, 1);
  });

  it('avgRepairLoops averages (attempts-1) over COMPLETED runs only', () => {
    const s = computeDashboardStats({
      ...EMPTY,
      qaRuns: [
        { id: 'r1', taskId: 't1', status: 'COMPLETED', verdict: 'PASS', attempts: 1 }, // 0 loops
        { id: 'r2', taskId: 't2', status: 'COMPLETED', verdict: 'PASS', attempts: 4 }, // 3 loops
        { id: 'r3', taskId: 't3', status: 'FAILED', verdict: 'FAIL', attempts: 5 }, // excluded
      ],
    });
    assert.equal(s.metrics.avgRepairLoops.value, 1.5);
    assert.equal(s.metrics.avgRepairLoops.unit, '轮');
  });

  it('avgRepairLoops is null when no run completed', () => {
    const s = computeDashboardStats({
      ...EMPTY,
      qaRuns: [{ id: 'r1', taskId: 't1', status: 'FAILED', verdict: 'FAIL', attempts: 2 }],
    });
    assert.equal(s.metrics.avgRepairLoops.value, null);
    assert.equal(s.metrics.avgRepairLoops.note, NO_DATA_NOTE);
  });

  it('firstPassSuccessRate = completed tasks whose QA passed on first attempt', () => {
    const s = computeDashboardStats({
      ...EMPTY,
      tasks: [task('t1', 'DONE'), task('t2', 'DONE'), task('t3', 'DONE'), task('t4', 'TODO')],
      qaRuns: [
        { id: 'r1', taskId: 't1', status: 'COMPLETED', verdict: 'PASS', attempts: 1 }, // first-pass
        { id: 'r2', taskId: 't2', status: 'COMPLETED', verdict: 'PASS', attempts: 3 }, // repaired
        // t3 completed but has no QA run → excluded from denominator
      ],
    });
    assert.equal(s.metrics.firstPassSuccessRate.value, 50);
    assert.equal(s.metrics.firstPassSuccessRate.unit, '%');
  });

  it('firstPassSuccessRate is null when no completed task has QA runs', () => {
    const s = computeDashboardStats({
      ...EMPTY,
      tasks: [task('t1', 'DONE')],
      qaRuns: [{ id: 'r1', taskId: 't9', status: 'COMPLETED', verdict: 'PASS', attempts: 1 }],
    });
    assert.equal(s.metrics.firstPassSuccessRate.value, null);
  });
});

describe('avgTaskDuration', () => {
  it('averages (completedAt - createdAt) in minutes over completed tasks', () => {
    const s = computeDashboardStats({
      ...EMPTY,
      tasks: [
        task('t1', 'DONE', { createdAt: '2026-10-09T00:00:00.000Z', completedAt: '2026-10-09T01:00:00.000Z' }), // 60
        task('t2', 'DONE', { createdAt: '2026-10-09T00:00:00.000Z', completedAt: '2026-10-09T00:30:00.000Z' }), // 30
        task('t3', 'DONE', { completedAt: null }), // excluded: no completion timestamp
        task('t4', 'IN_PROGRESS'), // excluded: not done
      ],
    });
    assert.equal(s.metrics.avgTaskDuration.value, 45);
    assert.equal(s.metrics.avgTaskDuration.unit, '分钟');
  });

  it('is null when no completed task has a completion timestamp', () => {
    const s = computeDashboardStats({ ...EMPTY, tasks: [task('t1', 'DONE', { completedAt: null })] });
    assert.equal(s.metrics.avgTaskDuration.value, null);
  });
});

describe('deployment aggregates', () => {
  const input: DashboardInput = {
    ...EMPTY,
    deployments: [
      { id: 'd1', environment: 'DEV', status: 'SUCCEEDED', startedAt: '2026-10-09T00:00:00.000Z', endedAt: '2026-10-09T00:05:00.000Z' },
      { id: 'd2', environment: 'PROD', status: 'FAILED', startedAt: '2026-10-09T01:00:00.000Z', endedAt: '2026-10-09T01:10:00.000Z' },
      { id: 'd3', environment: 'PROD', status: 'ROLLED_BACK', startedAt: '2026-10-09T02:00:00.000Z', endedAt: '2026-10-09T02:05:00.000Z' },
    ],
  };

  it('latestDeployment picks the most recent deployment', () => {
    assert.equal(computeDashboardStats(input).status.latestDeployment.value, 'PROD · ROLLED_BACK');
  });

  it('productionStatus reflects the latest PROD deployment', () => {
    assert.equal(computeDashboardStats(input).status.productionStatus.value, 'ROLLED_BACK');
  });

  it('productionStatus is null when there is no PROD deployment', () => {
    const s = computeDashboardStats({
      ...EMPTY,
      deployments: [{ id: 'd1', environment: 'DEV', status: 'SUCCEEDED', startedAt: null, endedAt: null }],
    });
    assert.equal(s.status.productionStatus.value, null);
  });

  it('counts failed deployments and rollbacks', () => {
    const s = computeDashboardStats(input);
    assert.equal(s.metrics.failedDeployments.value, 1);
    assert.equal(s.metrics.rollbackCount.value, 1);
  });

  it('latestOf handles missing timestamps without crashing', () => {
    assert.equal(latestOf([]), null);
    const d = { id: 'x', environment: 'DEV', status: 'PENDING', startedAt: null, endedAt: null };
    assert.equal(latestOf([d]), d);
  });
});

describe('approvals', () => {
  it('humanInterventions counts human-decided approvals only', () => {
    const s = computeDashboardStats({
      ...EMPTY,
      approvals: [
        { id: 'a1', status: 'APPROVED', decidedBy: 'human' },
        { id: 'a2', status: 'REJECTED', decidedBy: 'human' },
        { id: 'a3', status: 'APPROVED', decidedBy: 'agent-1' },
        { id: 'a4', status: 'PENDING', decidedBy: '' },
      ],
    });
    assert.equal(s.metrics.humanInterventions.value, 2);
  });
});

describe('resource usage', () => {
  it('renders a human summary when records exist', () => {
    const s = computeDashboardStats({
      ...EMPTY,
      resources: {
        records: 5,
        totals: { timeMs: 1200, tokens: 2500, toolCalls: 7, retries: 1, storageBytes: 0, processes: 0 },
      },
    });
    const v = s.status.resourceUsage.value;
    assert.ok(typeof v === 'string', `expected a string summary, got: ${JSON.stringify(v)}`);
    assert.ok(v.includes('2.5k'), `expected compact token count, got: ${v}`);
    assert.ok(v.includes('7'), `expected tool-call count, got: ${v}`);
    assert.equal(s.status.resourceUsage.note, undefined);
  });
});

describe('every stat carries a source', () => {
  it('no stat is missing its data-source label', () => {
    const rich: DashboardInput = {
      tasks: [task('t1', 'DONE', { completedAt: '2026-10-09T01:00:00.000Z' })],
      agents: [{ id: 'a1', status: 'WORKING' }],
      qaRuns: [{ id: 'r1', taskId: 't1', status: 'COMPLETED', verdict: 'PASS', attempts: 1 }],
      deployments: [{ id: 'd1', environment: 'PROD', status: 'SUCCEEDED', startedAt: null, endedAt: '2026-10-09T02:00:00.000Z' }],
      approvals: [{ id: 'a1', status: 'APPROVED', decidedBy: 'human' }],
      resources: { records: 1, totals: { timeMs: 1, tokens: 1, toolCalls: 1, retries: 0, storageBytes: 0, processes: 0 } },
    };
    for (const st of allStats(computeDashboardStats(rich))) {
      assert.ok(st.source.length > 0, `${st.key} must name its data source`);
      if (st.value !== null) assert.equal(st.note, undefined);
    }
  });
});

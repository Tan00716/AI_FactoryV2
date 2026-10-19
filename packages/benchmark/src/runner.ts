/**
 * Benchmark runner — task 10.
 *
 * Runs every benchmark case through runAgent (the real agent loop, not a
 * mock), collects deterministic metrics, and returns a machine-readable
 * report. Cases run sequentially so timings are comparable and a hung
 * case cannot starve the others (each case has its own wall-clock race).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent, Task } from '@ai-factory/core';
import { Harness, runAgent } from '@ai-factory/runtime';
import type { BenchmarkAdapterName } from './adapters';
import { createCaseAdapter } from './adapters';
import { BENCHMARK_CASES } from './tasks';
import type {
  BenchmarkCase,
  BenchmarkReport,
  CaseResult,
} from './types';

/** Token estimate method label — always surfaced so nobody mistakes it for metered usage. */
export const TOKEN_ESTIMATE_METHOD = 'heuristic: ceil((measured prompt chars + output chars) / 4)';

export function estimateTokens(promptChars: number, outputChars: number): number {
  return Math.ceil((promptChars + outputChars) / 4);
}

export interface RunBenchmarkOptions {
  adapter?: BenchmarkAdapterName;
  cases?: BenchmarkCase[];
  /** Default per-case wall-clock budget when the case sets none. */
  defaultTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  appVersion?: string;
}

const DEFAULT_CASE_TIMEOUT_MS = 60_000;

function buildAgent(c: BenchmarkCase): Agent {
  return {
    id: `agent-bench-${c.id}`,
    name: c.agent.name,
    displayName: c.agent.name,
    jobTitle: c.agent.jobTitle,
    department: 'benchmark',
    parentAgentId: null,
    mission: c.agent.mission,
    instructions: 'Complete the benchmark task.',
    skills: [],
    rules: [],
    model: 'bench-model',
    reasoningLevel: 'MEDIUM',
    tools: c.agent.tools,
    permissions: c.agent.permissions,
    autonomyLevel: 3,
    status: 'WORKING',
    version: 1,
    createdAt: '2026-10-19T00:00:00Z',
    updatedAt: '2026-10-19T00:00:00Z',
  };
}

function buildTask(c: BenchmarkCase): Task {
  return {
    id: `task-bench-${c.id}`,
    projectId: 'proj-bench',
    parentTaskId: null,
    title: c.task.title,
    goal: c.task.goal,
    description: '',
    priority: 'P2',
    severity: 'MAJOR',
    acceptanceCriteria: c.task.acceptanceCriteria,
    constraints: c.task.constraints ?? [],
    workspace: '/tmp/ai-factory-bench-ws',
    creator: 'benchmark',
    status: 'IN_PROGRESS',
    currentAgentId: `agent-bench-${c.id}`,
    assignedAgentIds: [`agent-bench-${c.id}`],
    subtaskIds: [],
    dependencies: [],
    risk: 'LOW',
    createdAt: '2026-10-19T00:00:00Z',
    updatedAt: '2026-10-19T00:00:00Z',
    completedAt: null,
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number, caseId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`case '${caseId}' exceeded timeout of ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runCase(
  c: BenchmarkCase,
  adapterName: BenchmarkAdapterName,
  opts: { defaultTimeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CaseResult> {
  const timeoutMs = c.timeoutMs ?? opts.defaultTimeoutMs ?? DEFAULT_CASE_TIMEOUT_MS;
  const promptViolations: string[] = [];
  const measured = createCaseAdapter(adapterName, c.stubScript, opts.env, (prompt) => {
    for (const s of c.forbidVerbatim ?? []) {
      if (prompt.includes(s)) promptViolations.push(s);
    }
  });
  const allowedRoot = mkdtempSync(join(tmpdir(), 'ai-factory-bench-'));
  const harness = new Harness({
    allowedRoots: [allowedRoot],
    stepTimeoutMs: 10_000,
    permissions: c.agent.permissions,
    toolPermissions: c.toolPermissions,
    evidence: { collect: () => undefined },
  });
  const failReasons: string[] = [];
  const startedAt = Date.now();
  let outcome = 'unknown';
  let steps = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  let evidenceTypes: string[] = [];
  try {
    const result = await withTimeout(
      runAgent({
        agent: buildAgent(c),
        task: buildTask(c),
        harness,
        adapter: measured.adapter,
        tools: c.makeTools(),
        extendedBudgets: c.extendedBudgets,
      }),
      timeoutMs,
      c.id,
    );
    outcome = result.outcome;
    steps = result.steps;
    modelCalls = result.budgetUsage?.modelCalls ?? 0;
    toolCalls = result.budgetUsage?.toolCalls ?? 0;
    evidenceTypes = result.evidence.map((e) => e.type);
  } catch (err) {
    outcome = 'error';
    failReasons.push(err instanceof Error ? err.message : String(err));
  }
  const latencyMs = Date.now() - startedAt;

  if (outcome !== 'error') {
    if (outcome !== c.expectOutcome) {
      failReasons.push(`expected outcome '${c.expectOutcome}', got '${outcome}'`);
    }
    for (const t of c.expectEvidenceTypes ?? []) {
      if (!evidenceTypes.includes(t)) {
        failReasons.push(`expected evidence type '${t}' not found`);
      }
    }
    for (const s of promptViolations) {
      failReasons.push(`forbidden string reached the model prompt verbatim: ${JSON.stringify(s)}`);
    }
    if (c.expectSteps !== undefined && steps !== c.expectSteps) {
      failReasons.push(`expected ${c.expectSteps} steps, got ${steps}`);
    }
  }

  const tokenEstimate = estimateTokens(measured.promptChars(), measured.outputChars());
  return {
    caseId: c.id,
    name: c.name,
    adapter: adapterName,
    pass: failReasons.length === 0,
    outcome,
    expectedOutcome: c.expectOutcome,
    failReasons,
    latencyMs,
    steps,
    modelCalls,
    toolCalls,
    tokenEstimate,
    tokenEstimateMethod: TOKEN_ESTIMATE_METHOD,
  };
}

export async function runBenchmark(opts: RunBenchmarkOptions = {}): Promise<BenchmarkReport> {
  const adapter = opts.adapter ?? 'stub';
  const cases = opts.cases ?? BENCHMARK_CASES;
  const results: CaseResult[] = [];
  for (const c of cases) {
    // Sequential: comparable timings, one hung case cannot starve others.
    results.push(await runCase(c, adapter, { defaultTimeoutMs: opts.defaultTimeoutMs, env: opts.env }));
  }
  const passed = results.filter((r) => r.pass).length;
  const totalLatencyMs = results.reduce((a, r) => a + r.latencyMs, 0);
  return {
    generatedAt: new Date().toISOString(),
    adapter,
    appVersion: opts.appVersion ?? '0.2.0',
    cases: results,
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      passRate: results.length === 0 ? 0 : passed / results.length,
      totalLatencyMs,
      avgLatencyMs: results.length === 0 ? 0 : Math.round(totalLatencyMs / results.length),
      totalTokenEstimate: results.reduce((a, r) => a + r.tokenEstimate, 0),
    },
  };
}

/**
 * QA routes — spec §36–§38.
 *
 *  GET  /api/qa/org                 QA org chart (lead + specialists)
 *  POST /api/qa/specialists        {kind} → create a QA specialist
 *  POST /api/qa/runs               {taskId, categories?, actor?} → run the QA loop
 *  GET  /api/qa/runs               list runs (in-memory)
 *  GET  /api/qa/runs/:id           one run
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleQaRoutes } from './routes/qa';
 *   if (await handleQaRoutes(req, res, url, ctx)) return;
 *
 * PROTOTYPE NOTE: POST /api/qa/runs executes the compiled qa demo sample
 * (packages/qa/dist/demo/sample) per requested category — only 'unit' has a
 * real suite; other categories report SKIPPED. The onFixNeeded hook
 * auto-applies the demo fix (removes the off-by-one in a temp copy of the
 * sample) on the first PRODUCT_FAILURE. Real projects would map categories
 * to their own suite commands here.
 */
import { randomUUID } from 'crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  ALL_TEST_CATEGORIES,
  FailureRecord,
  QaLoop,
  QaSpecialistKind,
  TestCategory,
  createQaSpecialist,
  ensureQaLead,
  listQaOrg,
  qaEvidencePayload,
  shellRunner,
  skippedRunner,
  SuiteRunner,
} from '@ai-factory/qa';
import type { RouteContext } from './context';

const QA_SPECIALIST_KINDS: readonly QaSpecialistKind[] = [
  'Functional',
  'API',
  'E2E',
  'Regression',
  'Performance',
  'Security',
];

interface QaRunRecord {
  id: string;
  taskId: string;
  categories: TestCategory[];
  actor: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  verdict: string | null;
  attempts: number;
  escalated: boolean;
  evidenceId: string | null;
  createdAt: string;
  finishedAt: string | null;
  summary: unknown;
}

/** In-memory run store — the coordinator may persist this later. */
const runs = new Map<string, QaRunRecord>();

function slimAgent(a: { id: string; name: string; displayName: string; jobTitle: string; status: string; autonomyLevel: number }) {
  return {
    id: a.id,
    name: a.name,
    displayName: a.displayName,
    jobTitle: a.jobTitle,
    status: a.status,
    autonomyLevel: a.autonomyLevel,
  };
}

/** Locate the compiled demo sample suite shipped with @ai-factory/qa. */
function sampleDir(): string | null {
  try {
    const pkgRoot = dirname(require.resolve('@ai-factory/qa/package.json'));
    const dir = join(pkgRoot, 'dist', 'demo', 'sample');
    return existsSync(join(dir, 'calc.test.js')) ? dir : null;
  } catch {
    return null;
  }
}

/**
 * Prototype auto-fix (documented): on the first PRODUCT_FAILURE in the
 * sample unit suite, copy the sample to a temp dir and remove the
 * off-by-one from the temp copy. Later attempts run against the fixed copy.
 */
function autoFixSample(runId: string, dir: string): string {
  const fixed = join(tmpdir(), `qa-run-${runId}`, 'sample');
  mkdirSync(fixed, { recursive: true });
  cpSync(dir, fixed, { recursive: true });
  const calcJs = join(fixed, 'calc.js');
  const src = readFileSync(calcJs, 'utf8');
  writeFileSync(calcJs, src.replace('a + b + 1', 'a + b'));
  return fixed;
}

export async function handleQaRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/qa/')) return false;
  const method = req.method ?? 'GET';
  const seg = path.slice('/api/qa/'.length).split('/').filter(Boolean);

  // GET /api/qa/org
  if (method === 'GET' && seg.length === 1 && seg[0] === 'org') {
    const lead = ensureQaLead(ctx.agents);
    const { specialists } = listQaOrg(ctx.agents);
    ctx.json(res, 200, { lead: slimAgent(lead), specialists: specialists.map(slimAgent) });
    return true;
  }

  // POST /api/qa/specialists  {kind, actor?}
  if (method === 'POST' && seg.length === 1 && seg[0] === 'specialists') {
    const body = await ctx.readBody(req);
    const kind = body['kind'] as string | undefined;
    const actor = (body['actor'] as string | undefined) ?? 'human';
    if (!kind || !(QA_SPECIALIST_KINDS as readonly string[]).includes(kind)) {
      ctx.json(res, 400, {
        error: `kind must be one of: ${QA_SPECIALIST_KINDS.join(', ')}`,
      });
      return true;
    }
    const specialist = createQaSpecialist(ctx.agents, kind as QaSpecialistKind);
    ctx.audit.record(actor, 'QA_SPECIALIST_CREATED', 'agent', specialist.id, { kind });
    ctx.json(res, 201, { specialist: slimAgent(specialist) });
    return true;
  }

  // POST /api/qa/runs  {taskId, categories?, actor?}
  if (method === 'POST' && seg.length === 1 && seg[0] === 'runs') {
    const body = await ctx.readBody(req);
    const taskId = body['taskId'] as string | undefined;
    const actor = (body['actor'] as string | undefined) ?? 'human';
    const rawCats = body['categories'] as string[] | undefined;
    if (!taskId) {
      ctx.json(res, 400, { error: 'taskId is required' });
      return true;
    }
    const task = ctx.tasks.get(taskId);
    if (!task) {
      ctx.json(res, 404, { error: `task ${taskId} not found` });
      return true;
    }
    const categories: TestCategory[] =
      rawCats && rawCats.length > 0
        ? rawCats.filter((c): c is TestCategory =>
            (ALL_TEST_CATEGORIES as readonly string[]).includes(c),
          )
        : ['unit'];
    if (categories.length === 0) {
      ctx.json(res, 400, {
        error: `categories must be a subset of: ${ALL_TEST_CATEGORIES.join(', ')}`,
      });
      return true;
    }

    const dir = sampleDir();
    if (!dir) {
      ctx.json(res, 500, { error: 'qa demo sample not found — build @ai-factory/qa first' });
      return true;
    }

    const runId = randomUUID();
    const record: QaRunRecord = {
      id: runId,
      taskId,
      categories,
      actor,
      status: 'RUNNING',
      verdict: null,
      attempts: 0,
      escalated: false,
      evidenceId: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      summary: null,
    };
    runs.set(runId, record);

    let fixedDir: string | null = null;
    const loop = new QaLoop({
      maxAttempts: 3,
      taskId,
      taskAgent: task.currentAgentId ?? 'coder',
      agents: ctx.agents,
      actor,
      onFixNeeded: (f: FailureRecord) => {
        // Prototype behavior: auto-apply the demo fix on first PRODUCT_FAILURE.
        if (f.classification === 'PRODUCT_FAILURE' && f.category === 'unit' && !fixedDir) {
          fixedDir = autoFixSample(runId, dir);
        }
      },
    });

    const factory = (attempt: number): SuiteRunner[] =>
      categories.map((category) => {
        if (category !== 'unit') {
          return skippedRunner(category, `no ${category} suite in prototype`);
        }
        const active = attempt === 1 || !fixedDir ? dir : (fixedDir as string);
        return shellRunner(
          'unit',
          `qa-sample unit (attempt ${attempt})`,
          process.execPath,
          ['--test', '--test-reporter=tap', join(active, 'calc.test.js')],
          active,
        );
      });

    try {
      const { payload, escalated, attempts } = await loop.execute(factory);
      const evidence = ctx.evidence.create({
        taskId,
        type: 'qa_result',
        title: `QA run ${runId.slice(0, 8)} — ${payload.verdict}`,
        payload: qaEvidencePayload(payload),
        createdBy: actor,
      });
      ctx.audit.record(actor, 'QA_RUN_COMPLETED', 'qa_run', runId, {
        taskId,
        verdict: payload.verdict,
        attempts,
        escalated,
      });
      record.status = payload.verdict === 'PASS' ? 'COMPLETED' : 'FAILED';
      record.verdict = payload.verdict;
      record.attempts = attempts;
      record.escalated = escalated;
      record.evidenceId = evidence.id;
      record.finishedAt = new Date().toISOString();
      record.summary = {
        total: payload.total,
        passed: payload.passed,
        failed: payload.failed,
        skipped: payload.skipped,
        categories: payload.categories.map((c) => ({
          category: c.category,
          verdict: c.verdict,
          total: c.total,
          passed: c.passed,
          failed: c.failed,
          skipped: c.skipped,
          durationMs: c.durationMs,
        })),
        failures: payload.failures,
      };
    } catch (err) {
      record.status = 'FAILED';
      record.finishedAt = new Date().toISOString();
      record.summary = { error: (err as Error).message };
    }
    ctx.json(res, 200, { run: record });
    return true;
  }

  // GET /api/qa/runs
  if (method === 'GET' && seg.length === 1 && seg[0] === 'runs') {
    ctx.json(res, 200, { runs: [...runs.values()].reverse() });
    return true;
  }

  // GET /api/qa/runs/:id
  if (method === 'GET' && seg.length === 2 && seg[0] === 'runs') {
    const record = runs.get(seg[1] as string);
    if (!record) {
      ctx.json(res, 404, { error: `qa run ${seg[1]} not found` });
      return true;
    }
    ctx.json(res, 200, { run: record });
    return true;
  }

  return false;
}

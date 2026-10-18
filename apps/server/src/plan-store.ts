/**
 * Plan mode store (W-B).
 *
 * A "plan" is an agent's proposed sequence of steps for a task, created in
 * read-only exploration and held PENDING until a human approves it — the
 * plan/execute split Codex and Claude Code call "plan mode". Approval
 * itself reuses the §23.3 approval machinery (ApprovalManager over
 * ctx.fdb.approvals): the plan's approve/reject endpoints delegate the
 * decision to the approval ticket, so digests, required_approvers,
 * deadlines and the audit trail all work unchanged. This store holds the
 * plan CONTENT (title/goal/steps); the approval ticket holds the DECISION.
 *
 * Persistence: JSON file under AI_FACTORY_DATA_DIR (same convention as
 * mcp-server-mode.ts). Fail-closed on corrupt files: a corrupt plans file
 * refuses writes and serves an empty list rather than silently dropping
 * pending plans.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type PlanStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXECUTING' | 'DONE' | 'CANCELLED';

export interface PlanStep {
  title: string;
  detail?: string;
}

export interface Plan {
  id: string;
  title: string;
  goal: string;
  steps: PlanStep[];
  status: PlanStatus;
  /** §23.3 approval ticket id bound to this plan ('' until created). */
  approvalId: string;
  /** sha256 of the canonical plan content the approval binds to. */
  contentDigest: string;
  taskId: string | null;
  agentId: string | null;
  createdBy: string;
  createdAt: string;
  decidedAt: string | null;
  decisionReason: string;
}

export function planStorePath(): string {
  const fromEnv = process.env.AI_FACTORY_PLAN_STORE_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'plans.json');
}

/** Canonical JSON for digest binding: sorted keys, no whitespace noise. */
export function canonicalPlanContent(p: { title: string; goal: string; steps: PlanStep[] }): string {
  const steps = p.steps.map((s) => ({ detail: s.detail ?? '', title: s.title }));
  return JSON.stringify({ goal: p.goal, steps, title: p.title });
}

export function planContentDigest(p: { title: string; goal: string; steps: PlanStep[] }): string {
  return createHash('sha256').update(canonicalPlanContent(p), 'utf8').digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

export class PlanStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanStoreError';
  }
}

export class PlanStore {
  private readonly path: string;
  private plans: Map<string, Plan> | null = null;
  private corrupt = false;

  constructor(path: string = planStorePath()) {
    this.path = path;
  }

  private load(): Map<string, Plan> {
    if (this.plans) return this.plans;
    const map = new Map<string, Plan>();
    if (!existsSync(this.path)) {
      this.plans = map;
      return map;
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { plans?: Plan[] };
      for (const p of raw.plans ?? []) {
        if (p && typeof p.id === 'string') map.set(p.id, p);
      }
    } catch {
      // Fail-closed: serve empty, refuse writes — never silently drop plans.
      this.corrupt = true;
      this.plans = new Map();
      return this.plans;
    }
    this.plans = map;
    return map;
  }

  private save(): void {
    if (this.corrupt) {
      throw new PlanStoreError(`plan store is corrupt (${this.path}); refusing write`);
    }
    const map = this.load();
    mkdirSync(resolve(this.path, '..'), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ plans: [...map.values()] }, null, 2), 'utf8');
    // Atomic replace: readers never see a half-written file.
    renameSync(tmp, this.path);
  }

  create(input: {
    title: string;
    goal: string;
    steps: PlanStep[];
    taskId?: string | null;
    agentId?: string | null;
    createdBy: string;
  }): Plan {
    const title = input.title.trim();
    if (!title) throw new PlanStoreError('title is required');
    if (input.steps.length === 0) throw new PlanStoreError('at least one step is required');
    if (input.steps.length > 100) throw new PlanStoreError('too many steps (max 100)');
    for (const s of input.steps) {
      if (!s.title || !s.title.trim()) throw new PlanStoreError('every step needs a title');
    }
    const plan: Plan = {
      id: randomUUID(),
      title,
      goal: input.goal ?? '',
      steps: input.steps.map((s) => ({ title: s.title.trim(), detail: s.detail?.trim() || undefined })),
      status: 'PENDING',
      approvalId: '',
      contentDigest: planContentDigest({ title, goal: input.goal ?? '', steps: input.steps }),
      taskId: input.taskId ?? null,
      agentId: input.agentId ?? null,
      createdBy: input.createdBy,
      createdAt: nowIso(),
      decidedAt: null,
      decisionReason: '',
    };
    this.load().set(plan.id, plan);
    this.save();
    return plan;
  }

  get(id: string): Plan | undefined {
    const p = this.load().get(id);
    return p ? { ...p, steps: p.steps.map((s) => ({ ...s })) } : undefined;
  }

  list(filter: { status?: PlanStatus; taskId?: string } = {}): Plan[] {
    return [...this.load().values()]
      .filter((p) => (filter.status === undefined || p.status === filter.status)
        && (filter.taskId === undefined || p.taskId === filter.taskId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((p) => ({ ...p, steps: p.steps.map((s) => ({ ...s })) }));
  }

  /** Bind the §23.3 approval ticket to the plan (called right after request()). */
  bindApproval(id: string, approvalId: string): Plan {
    const map = this.load();
    const p = map.get(id);
    if (!p) throw new PlanStoreError(`plan not found: ${id}`);
    const updated = { ...p, approvalId };
    map.set(id, updated);
    this.save();
    return updated;
  }

  /** Mirror the approval decision onto the plan. Only PENDING plans move. */
  decide(id: string, approved: boolean, reason: string): Plan {
    const map = this.load();
    const p = map.get(id);
    if (!p) throw new PlanStoreError(`plan not found: ${id}`);
    if (p.status !== 'PENDING') {
      throw new PlanStoreError(`plan ${id} is ${p.status}, not PENDING`);
    }
    const updated: Plan = {
      ...p,
      status: approved ? 'APPROVED' : 'REJECTED',
      decidedAt: nowIso(),
      decisionReason: reason,
    };
    map.set(id, updated);
    this.save();
    return updated;
  }

  /** Mark an APPROVED plan as EXECUTING (agent picked it up). */
  markExecuting(id: string): Plan {
    const map = this.load();
    const p = map.get(id);
    if (!p) throw new PlanStoreError(`plan not found: ${id}`);
    if (p.status !== 'APPROVED') {
      throw new PlanStoreError(`plan ${id} is ${p.status}; only APPROVED plans can execute`);
    }
    const updated: Plan = { ...p, status: 'EXECUTING' };
    map.set(id, updated);
    this.save();
    return updated;
  }

  /** Terminal states from EXECUTING. */
  finish(id: string, done: boolean, reason = ''): Plan {
    const map = this.load();
    const p = map.get(id);
    if (!p) throw new PlanStoreError(`plan not found: ${id}`);
    if (p.status !== 'EXECUTING') {
      throw new PlanStoreError(`plan ${id} is ${p.status}; only EXECUTING plans can finish`);
    }
    const updated: Plan = {
      ...p,
      status: done ? 'DONE' : 'CANCELLED',
      decisionReason: reason || p.decisionReason,
    };
    map.set(id, updated);
    this.save();
    return updated;
  }
}

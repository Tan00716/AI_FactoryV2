/**
 * Model-cost governance objects — V3.0 audit suggestion #8 (policy layer).
 *
 * This is the budget object the audit found missing: the existing quota
 * layer (§27) tracks provider buckets and limit policies, but had no
 * per-task / per-person / per-project cap object, no breaker that pauses
 * new model calls, and no conservative default cap. This module adds
 * exactly that — and nothing that needs a real model:
 *
 *  - Budget objects: three scopes (task / person / project), three units
 *    (usd-estimate / calls / tokens-estimate), four periods (daily /
 *    weekly / monthly / all-time). Limits are fail-closed validated.
 *  - Breaker: usage at or over the limit trips the budget; checkAllowed()
 *    then refuses NEW model calls that would charge the tripped budget.
 *    Already-running deterministic work is unaffected (that is §27.4's
 *    rule, owned by QuotaMonitor, not duplicated here).
 *  - Warn-then-trip: at 80% the budget warns once per window; at 100% it
 *    trips once per window. A trip can be released exactly once per
 *    window with a recorded reason (audit at the route layer) — release
 *    clears the trip, it never raises the limit.
 *  - Defaults: caps are ON by default, auto-renew is OFF by default, and
 *    a new project gets a conservative monthly USD-estimate default
 *    (see DEFAULT_BUDGET_POLICY). apply-defaults never overwrites an
 *    existing budget for the same scope + key + unit + period.
 *  - Conversion table: placeholder coefficients only, every row marked
 *    measured: false with a "pending measurement" note. Unknown units
 *    estimate to null, never to an invented number.
 *
 * HONEST BOUNDARY: every cost/token figure here is an ESTIMATE unless
 * the usage row says source: 'provider-reported'. Simulated usage
 * (source: 'simulated') is what the StubAdapter verification path
 * records; it proves the breaker logic, not a real bill. The ledger
 * keeps only the CURRENT window per budget (older windows are pruned
 * on write) — this is a policy ledger, not a billing history.
 */

export type BudgetScope = 'task' | 'person' | 'project';
export type BudgetUnit = 'usd-estimate' | 'calls' | 'tokens-estimate';
export type BudgetPeriod = 'daily' | 'weekly' | 'monthly' | 'all-time';
export type BudgetStatus = 'ok' | 'warned' | 'tripped' | 'released';
export type UsageSource = 'simulated' | 'provider-reported' | 'manual';

export class BudgetError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A cap object: one scope key, one unit, one period. */
export interface Budget {
  id: string;
  scope: BudgetScope;
  /** task id / person id / project id, depending on scope. */
  scopeKey: string;
  unit: BudgetUnit;
  /** Must be finite and > 0 (fail-closed: no zero/negative/infinite cap). */
  limit: number;
  period: BudgetPeriod;
  /** Default false: an expired window never auto-refills without review. */
  autoRenew: boolean;
  /** Default true: a created budget constrains immediately. */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetInput {
  scope: BudgetScope;
  scopeKey: string;
  unit: BudgetUnit;
  limit: number;
  period?: BudgetPeriod;
  autoRenew?: boolean;
  enabled?: boolean;
}

/** One recorded chunk of usage, attributed to all matching scopes. */
export interface UsageRecord {
  taskId?: string;
  personId?: string;
  projectId?: string;
  calls?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** USD estimate, unless source is 'provider-reported'. */
  costUsd?: number;
  source: UsageSource;
  note?: string;
}

export interface UsageTally {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Per-budget view for the current window. */
export interface BudgetUsage {
  budget: Budget;
  windowId: string;
  used: number;
  limit: number;
  /** Null when the unit has no recorded usage shape (never happens for the three units). */
  pct: number;
  status: BudgetStatus;
}

export interface TripEvent {
  budgetId: string;
  scope: BudgetScope;
  scopeKey: string;
  windowId: string;
  used: number;
  limit: number;
  trippedAt: string;
}

export interface WarnEvent {
  budgetId: string;
  scope: BudgetScope;
  scopeKey: string;
  windowId: string;
  used: number;
  limit: number;
  warnedAt: string;
}

export interface ReleaseRecord {
  budgetId: string;
  windowId: string;
  reason: string;
  releasedAt: string;
}

/**
 * Conservative default policy (V3-#8 §5: "默认开上限、默认关自动续费").
 * The numbers are AI Factory's own policy defaults, not any provider's
 * price: a $10/month project estimate cap and a $2 all-time task
 * estimate cap. They are deliberately low so a fresh project can never
 * run unbounded by accident; the operator raises them explicitly.
 */
export const DEFAULT_BUDGET_POLICY = {
  capEnabledByDefault: true,
  autoRenewDefault: false,
  warnAtPct: 80,
  defaultProjectBudget: {
    unit: 'usd-estimate' as BudgetUnit,
    limit: 10,
    period: 'monthly' as BudgetPeriod,
  },
  defaultTaskBudget: {
    unit: 'usd-estimate' as BudgetUnit,
    limit: 2,
    period: 'all-time' as BudgetPeriod,
  },
} as const;

/** The default budget(s) a new project starts with. */
export function defaultBudgetInputsForProject(projectId: string): BudgetInput[] {
  return [
    {
      scope: 'project',
      scopeKey: projectId,
      unit: DEFAULT_BUDGET_POLICY.defaultProjectBudget.unit,
      limit: DEFAULT_BUDGET_POLICY.defaultProjectBudget.limit,
      period: DEFAULT_BUDGET_POLICY.defaultProjectBudget.period,
      autoRenew: DEFAULT_BUDGET_POLICY.autoRenewDefault,
      enabled: DEFAULT_BUDGET_POLICY.capEnabledByDefault,
    },
  ];
}

/**
 * Cost conversion table — PLACEHOLDER coefficients, every row marked
 * measured: false. These exist so the policy layer has a unit table to
 * estimate against before any model is connected; they must be replaced
 * with measured numbers once a real model reports usage. The UI renders
 * the pending-measurement watermark next to every row.
 */
export interface ConversionRow {
  unit: string;
  description: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  /** Always false until a real model run measures the row. */
  measured: false;
  note: string;
}

const PENDING_NOTE = '占位系数：待模型接通后实测填数，不得当作真实价格 / placeholder: replace with measured values once a real model reports usage';

export const COST_CONVERSION_TABLE: readonly ConversionRow[] = [
  {
    unit: 'chat-generation',
    description: '一次 Chat 式生成（问答/解释）',
    estimatedInputTokens: 1000,
    estimatedOutputTokens: 500,
    estimatedCostUsd: 0.01,
    measured: false,
    note: PENDING_NOTE,
  },
  {
    unit: 'code-edit',
    description: '一次代码编辑（读上下文 + 改写）',
    estimatedInputTokens: 2000,
    estimatedOutputTokens: 800,
    estimatedCostUsd: 0.02,
    measured: false,
    note: PENDING_NOTE,
  },
  {
    unit: 'agent-run-step',
    description: '一次 Agent 运行步骤（含工具调用往返）',
    estimatedInputTokens: 4000,
    estimatedOutputTokens: 1500,
    estimatedCostUsd: 0.05,
    measured: false,
    note: PENDING_NOTE,
  },
];

/**
 * Estimate a usage chunk from the placeholder table. Unknown units return
 * null — the caller must surface "unknown", never an invented number.
 */
export function estimateFromConversionTable(
  unit: string,
  count: number,
): { inputTokens: number; outputTokens: number; costUsd: number } | null {
  if (!Number.isFinite(count) || count < 0) return null;
  const row = COST_CONVERSION_TABLE.find((r) => r.unit === unit);
  if (!row) return null;
  return {
    inputTokens: row.estimatedInputTokens * count,
    outputTokens: row.estimatedOutputTokens * count,
    costUsd: row.estimatedCostUsd * count,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function windowIdFor(period: BudgetPeriod, nowMs: number): string {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  if (period === 'daily') return `${y}-${m}-${day}`;
  if (period === 'monthly') return `${y}-${m}`;
  if (period === 'all-time') return 'all';
  // Weekly: ISO week (Monday start, week 1 = week with the first Thursday).
  const thursday = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate()));
  const dow = (thursday.getUTCDay() + 6) % 7; // Monday = 0
  thursday.setUTCDate(thursday.getUTCDate() - dow + 3);
  const weekYear = thursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil(((thursday.getTime() - jan1.getTime()) / 86400000 + 1) / 7);
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
}

function unitUsed(tally: UsageTally, unit: BudgetUnit): number {
  if (unit === 'calls') return tally.calls;
  if (unit === 'tokens-estimate') return tally.inputTokens + tally.outputTokens;
  return tally.costUsd;
}

function emptyTally(): UsageTally {
  return { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

export interface CostGovernorState {
  version: 1;
  budgets: Budget[];
  /** budgetId -> windowId -> tally (current window only; pruned on write). */
  usage: Record<string, Record<string, UsageTally>>;
  warned: string[];
  tripped: string[];
  released: string[];
  overrides: ReleaseRecord[];
}

export class CostGovernor {
  private budgets: Budget[] = [];
  private usage: Map<string, Map<string, UsageTally>> = new Map();
  private warned = new Set<string>();
  private tripped = new Set<string>();
  private released = new Set<string>();
  private overrides: ReleaseRecord[] = [];
  private seq = 0;
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  private windowFor(b: Budget): string {
    return windowIdFor(b.period, this.now());
  }

  private marker(budgetId: string, windowId: string): string {
    return `${budgetId}|${windowId}`;
  }

  private tallyFor(budgetId: string, windowId: string): UsageTally {
    let byWindow = this.usage.get(budgetId);
    if (!byWindow) {
      byWindow = new Map();
      this.usage.set(budgetId, byWindow);
    }
    let t = byWindow.get(windowId);
    if (!t) {
      t = emptyTally();
      byWindow.set(windowId, t);
    }
    return t;
  }

  /** Prune non-current windows so the ledger stays a current-window ledger. */
  private prune(): void {
    for (const b of this.budgets) {
      const current = this.windowFor(b);
      const byWindow = this.usage.get(b.id);
      if (byWindow) {
        for (const w of [...byWindow.keys()]) {
          if (w !== current) byWindow.delete(w);
        }
      }
      for (const set of [this.warned, this.tripped, this.released]) {
        for (const mk of [...set]) {
          if (mk.startsWith(`${b.id}|`) && !mk.endsWith(`|${current}`)) set.delete(mk);
        }
      }
    }
  }

  createBudget(input: BudgetInput): Budget {
    const scope = input.scope;
    if (scope !== 'task' && scope !== 'person' && scope !== 'project') {
      throw new BudgetError('INVALID_BUDGET_SCOPE', `unknown budget scope: ${String(scope)}`);
    }
    const scopeKey = typeof input.scopeKey === 'string' ? input.scopeKey.trim() : '';
    if (!scopeKey || scopeKey.length > 128) {
      throw new BudgetError('INVALID_BUDGET_KEY', 'scopeKey must be a non-empty string (max 128 chars)');
    }
    if (input.unit !== 'usd-estimate' && input.unit !== 'calls' && input.unit !== 'tokens-estimate') {
      throw new BudgetError('INVALID_BUDGET_UNIT', `unknown budget unit: ${String(input.unit)}`);
    }
    if (!Number.isFinite(input.limit) || input.limit <= 0) {
      throw new BudgetError('INVALID_BUDGET_LIMIT', 'limit must be finite and > 0');
    }
    const period = input.period ?? 'monthly';
    if (period !== 'daily' && period !== 'weekly' && period !== 'monthly' && period !== 'all-time') {
      throw new BudgetError('INVALID_BUDGET_PERIOD', `unknown budget period: ${String(period)}`);
    }
    const dup = this.budgets.find(
      (b) => b.scope === scope && b.scopeKey === scopeKey && b.unit === input.unit && b.period === period,
    );
    if (dup) {
      throw new BudgetError(
        'DUPLICATE_BUDGET',
        `a budget already exists for ${scope}:${scopeKey} ${input.unit}/${period} (id ${dup.id}); delete it first, never silently overwrite`,
      );
    }
    const nowIso = new Date(this.now()).toISOString();
    this.seq += 1;
    const budget: Budget = {
      id: `budget-${this.seq}`,
      scope,
      scopeKey,
      unit: input.unit,
      limit: input.limit,
      period,
      autoRenew: input.autoRenew ?? DEFAULT_BUDGET_POLICY.autoRenewDefault,
      enabled: input.enabled ?? DEFAULT_BUDGET_POLICY.capEnabledByDefault,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.budgets.push(budget);
    return { ...budget };
  }

  deleteBudget(id: string): boolean {
    const idx = this.budgets.findIndex((b) => b.id === id);
    if (idx === -1) return false;
    this.budgets.splice(idx, 1);
    this.usage.delete(id);
    for (const set of [this.warned, this.tripped, this.released]) {
      for (const mk of [...set]) if (mk.startsWith(`${id}|`)) set.delete(mk);
    }
    return true;
  }

  getBudget(id: string): Budget | undefined {
    const b = this.budgets.find((x) => x.id === id);
    return b ? { ...b } : undefined;
  }

  listBudgets(): Budget[] {
    return this.budgets.map((b) => ({ ...b }));
  }

  private statusFor(b: Budget): BudgetUsage {
    const windowId = this.windowFor(b);
    const tally = this.tallyFor(b.id, windowId);
    const used = unitUsed(tally, b.unit);
    const pct = b.limit > 0 ? (used / b.limit) * 100 : 0;
    let status: BudgetStatus = 'ok';
    if (!b.enabled) status = 'ok';
    else if (this.released.has(this.marker(b.id, windowId))) status = 'released';
    else if (this.tripped.has(this.marker(b.id, windowId))) status = 'tripped';
    else if (this.warned.has(this.marker(b.id, windowId))) status = 'warned';
    return { budget: { ...b }, windowId, used, limit: b.limit, pct, status };
  }

  /** Current-window usage view for every budget. */
  usageSummary(): BudgetUsage[] {
    this.prune();
    return this.budgets.map((b) => this.statusFor(b));
  }

  /**
   * Record usage. A record is attributed to every ENABLED budget whose
   * scope matches one of its ids. Returns the budgets touched plus any
   * warn/trip events fired by this record (at most one each per budget
   * per window).
   */
  recordUsage(rec: UsageRecord): {
    touched: BudgetUsage[];
    warned: WarnEvent[];
    tripped: TripEvent[];
  } {
    const num = (v: number | undefined): number => {
      if (v === undefined) return 0;
      if (!Number.isFinite(v) || v < 0) {
        throw new BudgetError('INVALID_USAGE', 'usage numbers must be finite and >= 0');
      }
      return v;
    };
    const calls = num(rec.calls);
    const inputTokens = num(rec.inputTokens);
    const outputTokens = num(rec.outputTokens);
    const costUsd = num(rec.costUsd);
    if (rec.source !== 'simulated' && rec.source !== 'provider-reported' && rec.source !== 'manual') {
      throw new BudgetError('INVALID_USAGE_SOURCE', `unknown usage source: ${String(rec.source)}`);
    }
    const warned: WarnEvent[] = [];
    const tripped: TripEvent[] = [];
    const touched: BudgetUsage[] = [];
    const nowIso = new Date(this.now()).toISOString();
    for (const b of this.budgets) {
      if (!b.enabled) continue;
      const key = b.scope === 'task' ? rec.taskId : b.scope === 'person' ? rec.personId : rec.projectId;
      if (key === undefined || key !== b.scopeKey) continue;
      const windowId = this.windowFor(b);
      const tally = this.tallyFor(b.id, windowId);
      tally.calls += calls;
      tally.inputTokens += inputTokens;
      tally.outputTokens += outputTokens;
      tally.costUsd += costUsd;
      const used = unitUsed(tally, b.unit);
      const pct = (used / b.limit) * 100;
      const mk = this.marker(b.id, windowId);
      if (pct >= 100 && !this.tripped.has(mk) && !this.released.has(mk)) {
        this.tripped.add(mk);
        tripped.push({ budgetId: b.id, scope: b.scope, scopeKey: b.scopeKey, windowId, used, limit: b.limit, trippedAt: nowIso });
      } else if (pct >= DEFAULT_BUDGET_POLICY.warnAtPct && pct < 100 && !this.warned.has(mk) && !this.tripped.has(mk)) {
        this.warned.add(mk);
        warned.push({ budgetId: b.id, scope: b.scope, scopeKey: b.scopeKey, windowId, used, limit: b.limit, warnedAt: nowIso });
      }
      touched.push(this.statusFor(b));
    }
    this.prune();
    return { touched, warned, tripped };
  }

  /**
   * May a NEW model call start? Blocked when any applicable ENABLED
   * budget is tripped in its current window. A released budget does not
   * block (release is the operator's explicit one-window override).
   */
  checkAllowed(refs: { taskId?: string; personId?: string; projectId?: string }): {
    allowed: boolean;
    blocking: BudgetUsage[];
  } {
    this.prune();
    const blocking: BudgetUsage[] = [];
    for (const b of this.budgets) {
      if (!b.enabled) continue;
      const key = b.scope === 'task' ? refs.taskId : b.scope === 'person' ? refs.personId : refs.projectId;
      if (key === undefined || key !== b.scopeKey) continue;
      const view = this.statusFor(b);
      if (view.status === 'tripped') blocking.push(view);
    }
    return { allowed: blocking.length === 0, blocking };
  }

  /**
   * One-click release: clears this window's trip for one budget. The
   * reason is mandatory (fail-closed: no silent override) and recorded
   * for the audit layer. The limit is never raised by a release.
   */
  releaseBudget(id: string, reason: string): ReleaseRecord {
    const b = this.budgets.find((x) => x.id === id);
    if (!b) throw new BudgetError('BUDGET_NOT_FOUND', `no budget with id ${id}`);
    const r = typeof reason === 'string' ? reason.trim() : '';
    if (!r) throw new BudgetError('RELEASE_REASON_REQUIRED', 'release requires a non-empty reason');
    const windowId = this.windowFor(b);
    this.tripped.delete(this.marker(id, windowId));
    this.released.add(this.marker(id, windowId));
    const rec: ReleaseRecord = { budgetId: id, windowId, reason: r, releasedAt: new Date(this.now()).toISOString() };
    this.overrides.push(rec);
    return { ...rec };
  }

  listOverrides(): ReleaseRecord[] {
    return this.overrides.map((o) => ({ ...o }));
  }

  /**
   * Idempotent defaults: create the default budgets for a project, but
   * never overwrite an existing budget for the same scope + key + unit
   * + period. Returns what was created and what already existed.
   */
  applyDefaults(projectId: string): { created: Budget[]; existing: Budget[] } {
    const created: Budget[] = [];
    const existing: Budget[] = [];
    for (const input of defaultBudgetInputsForProject(projectId)) {
      const dup = this.budgets.find(
        (b) => b.scope === input.scope && b.scopeKey === input.scopeKey && b.unit === input.unit && b.period === input.period,
      );
      if (dup) existing.push({ ...dup });
      else created.push(this.createBudget(input));
    }
    return { created, existing };
  }

  /** Serialize for the file-backed route store (version-stamped). */
  toJSON(): CostGovernorState {
    this.prune();
    const usage: CostGovernorState['usage'] = {};
    for (const [id, byWindow] of this.usage) {
      const obj: Record<string, UsageTally> = {};
      for (const [w, t] of byWindow) obj[w] = { ...t };
      if (Object.keys(obj).length > 0) usage[id] = obj;
    }
    return {
      version: 1,
      budgets: this.listBudgets(),
      usage,
      warned: [...this.warned],
      tripped: [...this.tripped],
      released: [...this.released],
      overrides: this.listOverrides(),
    };
  }

  /** Restore from a file-backed snapshot. Unknown shapes fail closed. */
  static fromJSON(raw: unknown): CostGovernor {
    if (!isRecord(raw) || raw['version'] !== 1 || !Array.isArray(raw['budgets'])) {
      throw new BudgetError('BAD_BUDGET_STATE', 'budget state must be a version-1 snapshot');
    }
    const g = new CostGovernor();
    for (const b of raw['budgets'] as Budget[]) {
      if (!isRecord(b) || typeof b['id'] !== 'string') {
        throw new BudgetError('BAD_BUDGET_STATE', 'budget entry has unknown shape');
      }
      g.budgets.push({ ...(b as Budget) });
      const n = Number(String(b['id']).replace('budget-', ''));
      if (Number.isFinite(n) && n > g.seq) g.seq = n;
    }
    if (isRecord(raw['usage'])) {
      for (const [id, byWindow] of Object.entries(raw['usage'])) {
        if (!isRecord(byWindow)) continue;
        const m = new Map<string, UsageTally>();
        for (const [w, t] of Object.entries(byWindow)) {
          if (isRecord(t)) m.set(w, { ...emptyTally(), ...(t as Partial<UsageTally>) });
        }
        if (m.size > 0) g.usage.set(id, m);
      }
    }
    for (const [key, set] of [['warned', g.warned], ['tripped', g.tripped], ['released', g.released]] as const) {
      const arr = raw[key];
      if (Array.isArray(arr)) for (const mk of arr) if (typeof mk === 'string') set.add(mk);
    }
    if (Array.isArray(raw['overrides'])) {
      for (const o of raw['overrides']) if (isRecord(o)) g.overrides.push(o as unknown as ReleaseRecord);
    }
    return g;
  }
}

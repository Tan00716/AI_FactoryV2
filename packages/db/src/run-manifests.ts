/**
 * Durable run manifests — the accountability record of one HTTP run
 * (apps/server §24–§27 routes, Batch 15).
 *
 * A run scatters its accountability facts across half a dozen
 * surfaces: the POST body (agent/task/driver script), the operator
 * allowlist grant (audited as RUNTIME_RUN_STARTED), the model-routing
 * decision (recorded as run evidence), the budget tracker (limits +
 * usage), the step-intent store (§28.1), the run's evidence list, and
 * the checkpoint log (§28.3). Any one surface can be read, but no
 * single record answered "what exactly was this run authorized to
 * do, what did it actually do, and where is the proof?" The manifest
 * is that record: assembled by the runtime route from those same
 * surfaces at the two moments they are knowable —
 *
 *  - at creation: identity (run/agent/task/project), the driver
 *    (caller-supplied script vs the route's default script; the
 *    adapter that will drive it; whether a model routeRequest was
 *    supplied), the granted tools, a snapshot of the budget limits
 *    the run will execute under, and the context-manifest hash —
 *    assembled by the EXACT code the §28.3 checkpoint capture uses
 *    (assembleRunCheckpoint in the route), so a manifest and the
 *    run's checkpoints can be cross-checked hash-for-hash instead of
 *    trusting a second, divergent hash;
 *  - at finalization (the run's terminal or error write): the
 *    outcome, the effective model read back from the run's own
 *    recorded facts (the routing decision's primary when a
 *    routeRequest drove one, else the adapter name the OBSERVE
 *    evidence recorded), budget usage, the run's step intents
 *    bucketed by status (DENIED is its own bucket — the tool never
 *    ran), the run's evidence accounted by count/type, and the
 *    checkpoint step range.
 *
 * Honesty rules, same as everywhere in this codebase:
 *  - every field comes from a real record; anything the run path
 *    does not produce stays null/absent, never invented. In
 *    particular the run path's evidence entries are harness records
 *    ({type, title, payload, t}) — nothing assigns them ids, so the
 *    manifest accounts evidence by count and type; it does not mint
 *    "evidence ids" that exist nowhere else.
 *  - a manifest exists only for runs created through the route since
 *    this wiring. A run record WITHOUT a manifest row (created
 *    before it) reads back as NO manifest — the route answers 404 —
 *    rather than a backfilled reconstruction pretending to be a
 *    creation-time snapshot.
 *  - a process that dies mid-run leaves its manifest at the creation
 *    snapshot with status RUNNING and null completion fields — the
 *    honest state of an interrupted run, same report-only philosophy
 *    as the run record itself. Nothing finalizes it retroactively.
 *
 * Why the seam lives in THIS package: the same reasoning as
 * runs.ts — the manifest is the server route's accountability
 * projection, not a runtime domain type (runtime owns its §25
 * RunRecord; db owns the persisted record shapes and every SQLite
 * store). Composite fields are JSON text (lossless for these plain
 * shapes) and every read is a fresh parse, so both implementations
 * honour the copy contract structurally.
 */

import { DatabaseSync } from 'node:sqlite';

/** The run's terminal accounting state — mirrors the run record's status. */
export type RunManifestStatus = 'RUNNING' | 'COMPLETED' | 'ESCALATED' | 'FAILED';

/** What drove the run, snapshotted at creation. */
export interface RunManifestDriver {
  /**
   * 'script' — the caller supplied the adapter outputs in the POST
   * body; 'default-script' — the route's built-in DEFAULT_SCRIPT ran.
   */
  kind: 'script' | 'default-script';
  /**
   * The adapter implementation's own name (adapter.name), read off
   * the instance that drove the run. On the HTTP route today this is
   * the StubAdapter ('stub') — recorded verbatim, never prettied up
   * into a claim about a real model.
   */
  adapter: string;
  /** Whether the POST carried a model routeRequest. */
  routeRequestProvided: boolean;
}

/** The budget limits the run executed under, snapshotted at creation. */
export interface RunManifestBudgetLimits {
  /** The AgentLoop budgets the route builds (maxSteps/timeMs/maxRetries). */
  loop: { maxSteps: number; timeMs: number; maxRetries: number };
  /**
   * The extended budgets (§25) the run's BudgetTracker was built
   * from — all eight fields, as a plain record.
   */
  extended: Record<string, number>;
}

/** The run's extended-budget consumption at finalization (§25). */
export interface RunManifestBudgetUsage {
  modelCalls: number;
  toolCalls: number;
  repairLoops: number;
  noProgressSteps: number;
  elapsedMs: number;
}

/**
 * The run's step intents at finalization, read back from the shared
 * intent store (§28.1) — total, ids (the cross-reference into the
 * store / step_intents table), and counts bucketed by status.
 * DENIED is a decided terminal state of its own: the gate refused
 * the call before execution, so it is neither EXECUTED nor FAILED.
 */
export interface RunManifestIntents {
  total: number;
  ids: string[];
  byStatus: { PENDING: number; EXECUTED: number; FAILED: number; DENIED: number };
}

/**
 * The run's evidence at finalization, accounted by count and type.
 * The run path's evidence entries carry no ids (see header), so
 * there is deliberately no id list here.
 */
export interface RunManifestEvidence {
  count: number;
  byType: Record<string, number>;
}

/**
 * The run's checkpoint reference at finalization (§28.3): how many
 * captures the checkpoint log holds for the run and the step range
 * they span — enough to pull the full captures from the checkpoint
 * read surface without duplicating them here.
 */
export interface RunManifestCheckpoints {
  count: number;
  firstStep: number | null;
  lastStep: number | null;
}

/**
 * One run's manifest. The creation block (identity, driver, grant,
 * budget limits, context hash) is written when the run is created;
 * the completion block stays null until the run's terminal/error
 * write fills it. `status` starts RUNNING and ends mirroring the
 * run record's terminal status.
 */
export interface RunManifest {
  runId: string;
  agentId: string;
  taskId: string;
  projectId: string;
  /** ISO timestamp — the run record's createdAt. */
  createdAt: string;
  driver: RunManifestDriver;
  /** Operator-granted tools for this run (FACTORY_RUNTIME_TOOLS). */
  grantedTools: string[];
  budgetLimits: RunManifestBudgetLimits;
  /**
   * sha256 over the run's assembled context — assembled exactly as
   * the §28.3 checkpoint capture assembles it, so it equals the
   * contextManifestHash on every checkpoint this run captures.
   */
  contextManifestHash: string;
  status: RunManifestStatus;
  outcome: string | null;
  finishedAt: string | null;
  error: string | null;
  steps: number | null;
  /**
   * The effective model, read back at finalization from the run's
   * own recorded facts: the routing decision's primary model when a
   * routeRequest drove one (modelSource 'model-router'), else the
   * model the OBSERVE evidence recorded — on this path the adapter's
   * own name (modelSource 'adapter'). Null when the run recorded
   * neither (e.g. routing refused before any evidence was taken).
   */
  model: string | null;
  modelSource: 'model-router' | 'adapter' | null;
  budgetUsage: RunManifestBudgetUsage | null;
  intents: RunManifestIntents | null;
  evidence: RunManifestEvidence | null;
  checkpoints: RunManifestCheckpoints | null;
}

/**
 * The manifest registry's storage contract — the same minimal set
 * as the run registry's: read one, upsert (create or full replace),
 * list all. No delete: nothing in the run lifecycle removes a run.
 */
export interface RunManifestStore {
  /** The manifest for one run id, or undefined when none exists. */
  get(runId: string): RunManifest | undefined;
  /**
   * Insert a manifest, or replace the stored manifest with the same
   * run id. Replacement keeps the manifest's original list position
   * (first-put order), matching Map.set semantics on an existing key.
   */
  put(manifest: RunManifest): void;
  /** Every stored manifest, in first-put (creation) order. */
  list(): RunManifest[];
}

/**
 * Default RunManifestStore: an in-process Map with copy-in / copy-out
 * semantics. Nothing survives a restart — it exists so embedders and
 * tests without a database keep working; durable deployments install
 * the SQLite implementation (FactoryDatabase.runManifests) at startup.
 */
export class InMemoryRunManifestStore implements RunManifestStore {
  private readonly manifests = new Map<string, RunManifest>();

  get(runId: string): RunManifest | undefined {
    const m = this.manifests.get(runId);
    return m ? structuredClone(m) : undefined;
  }

  put(manifest: RunManifest): void {
    this.manifests.set(manifest.runId, structuredClone(manifest));
  }

  list(): RunManifest[] {
    return [...this.manifests.values()].map((m) => structuredClone(m));
  }
}

function rowToManifest(r: Record<string, unknown>): RunManifest {
  const jsonOrNull = <T>(v: unknown): T | null =>
    v === null || v === undefined ? null : (JSON.parse(v as string) as T);
  return {
    runId: r['run_id'] as string,
    agentId: r['agent_id'] as string,
    taskId: r['task_id'] as string,
    projectId: r['project_id'] as string,
    createdAt: r['created_at'] as string,
    driver: JSON.parse(r['driver'] as string) as RunManifestDriver,
    grantedTools: JSON.parse(r['granted_tools'] as string) as string[],
    budgetLimits: JSON.parse(r['budget_limits'] as string) as RunManifestBudgetLimits,
    contextManifestHash: r['context_manifest_hash'] as string,
    status: r['status'] as RunManifestStatus,
    outcome: (r['outcome'] as string | null) ?? null,
    finishedAt: (r['finished_at'] as string | null) ?? null,
    error: (r['error'] as string | null) ?? null,
    steps: r['steps'] === null || r['steps'] === undefined ? null : Number(r['steps']),
    model: (r['model'] as string | null) ?? null,
    modelSource: (r['model_source'] as RunManifest['modelSource']) ?? null,
    budgetUsage: jsonOrNull<RunManifestBudgetUsage>(r['budget_usage']),
    intents: jsonOrNull<RunManifestIntents>(r['intents']),
    evidence: jsonOrNull<RunManifestEvidence>(r['evidence']),
    checkpoints: jsonOrNull<RunManifestCheckpoints>(r['checkpoints']),
  };
}

/**
 * SQLite-backed RunManifestStore — same record shape, same identity
 * (the run id) and replace semantics as the in-memory default; only
 * the backing changes. One row per run on the run_manifests table.
 */
export class SqliteRunManifestStore implements RunManifestStore {
  constructor(private readonly db: DatabaseSync) {}

  get(runId: string): RunManifest | undefined {
    const r = this.db
      .prepare('SELECT * FROM run_manifests WHERE run_id = ?')
      .get(runId) as Record<string, unknown> | undefined;
    return r ? rowToManifest(r) : undefined;
  }

  put(manifest: RunManifest): void {
    const jsonOrNull = (v: unknown): string | null =>
      v === null || v === undefined ? null : JSON.stringify(v);
    this.db
      .prepare(
        `INSERT INTO run_manifests
           (run_id, agent_id, task_id, project_id, created_at, driver,
            granted_tools, budget_limits, context_manifest_hash, status,
            outcome, finished_at, error, steps, model, model_source,
            budget_usage, intents, evidence, checkpoints)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(run_id) DO UPDATE SET
           agent_id=excluded.agent_id, task_id=excluded.task_id,
           project_id=excluded.project_id, created_at=excluded.created_at,
           driver=excluded.driver, granted_tools=excluded.granted_tools,
           budget_limits=excluded.budget_limits,
           context_manifest_hash=excluded.context_manifest_hash,
           status=excluded.status, outcome=excluded.outcome,
           finished_at=excluded.finished_at, error=excluded.error,
           steps=excluded.steps, model=excluded.model,
           model_source=excluded.model_source,
           budget_usage=excluded.budget_usage, intents=excluded.intents,
           evidence=excluded.evidence, checkpoints=excluded.checkpoints`,
      )
      .run(
        manifest.runId, manifest.agentId, manifest.taskId, manifest.projectId,
        manifest.createdAt, JSON.stringify(manifest.driver),
        JSON.stringify(manifest.grantedTools),
        JSON.stringify(manifest.budgetLimits), manifest.contextManifestHash,
        manifest.status, manifest.outcome, manifest.finishedAt, manifest.error,
        manifest.steps, manifest.model, manifest.modelSource,
        jsonOrNull(manifest.budgetUsage), jsonOrNull(manifest.intents),
        jsonOrNull(manifest.evidence), jsonOrNull(manifest.checkpoints),
      );
  }

  list(): RunManifest[] {
    // rowid order = first-put order: ON CONFLICT DO UPDATE keeps the
    // original rowid, so a replaced manifest keeps its position —
    // matching the in-memory store's Map semantics.
    const rows = this.db
      .prepare('SELECT * FROM run_manifests ORDER BY rowid')
      .all() as unknown as Record<string, unknown>[];
    return rows.map(rowToManifest);
  }
}

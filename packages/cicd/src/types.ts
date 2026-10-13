/**
 * CI/CD domain types — spec §39 (CI/CD ENGINE), §40 (ENVIRONMENT MANAGEMENT),
 * §41 (PRODUCTION POLICY), §77 (SNAPSHOT / RECOVERY).
 */

/**
 * spec §40 — the 12 pipeline stages, always executed in this order:
 * Build → Test → Lint → Typecheck → Security → Package → Artifact
 * → Review/QA Gate → UAT → Release → Smoke/Observe/Outcome → Recovery.
 *
 * NOTE: v1 had 8 stages ending in deploy/smoke; v2 follows the §40 list.
 * Deployment itself is governed by §41 (risk-based deployment/canary);
 * the deploy.ts audit phases ('deploy', 'smoke') are unchanged plain
 * strings, not StageName values.
 */
export type StageName =
  | 'build'
  | 'test'
  | 'lint'
  | 'typecheck'
  | 'security'
  | 'package'
  | 'artifact'
  | 'review_gate'
  | 'uat'
  | 'release'
  | 'smoke'
  | 'recovery';

/** The canonical stage order (spec §40: build → test → lint → typecheck → security → package → artifact → review_gate → uat → release → smoke → recovery). */
export const PIPELINE_STAGE_ORDER: StageName[] = [
  'build',
  'test',
  'lint',
  'typecheck',
  'security',
  'package',
  'artifact',
  'review_gate',
  'uat',
  'release',
  'smoke',
  'recovery',
];

/** Per-stage lifecycle. SKIPPED = handler reported nothing to do; the pipeline continues. */
export type StageStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'INTERRUPTED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'SKIPPED';

/** Evidence produced by a stage. Immutable once the stage completes (spec §42). */
export interface Artifact {
  name: string;
  /** e.g. 'build-output', 'test-report', 'bundle', 'scan-report' */
  kind: string;
  summary?: string;
}

/** spec §39 — one stage run within a pipeline. */
export interface PipelineStage {
  name: StageName;
  status: StageStatus;
  /** Captured log lines for this stage. */
  logs: string[];
  /** Evidence artifacts produced by the stage. */
  artifacts: Artifact[];
  startedAt: string | null;
  endedAt: string | null;
  /** Set when status === 'FAILED'. */
  error?: string;
}

/**
 * Pipeline-level lifecycle.
 *
 * INTERRUPTED is a hydration-time state (Batch 31): the process died
 * mid-run, so a pipeline or stage left RUNNING in the durable store is
 * demoted to INTERRUPTED on rebuild — it is never presented as still
 * running, and it can never be resumed (stage handlers are host
 * closures; /run on a hydrated record keeps 409ing). The runner
 * itself never produces INTERRUPTED.
 */
export type PipelineStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'INTERRUPTED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'ROLLED_BACK'
  | 'CANCELLED';

/** spec §39 — a pipeline run. */
export interface Pipeline {
  id: string;
  commitSha: string;
  environment: EnvironmentName;
  stages: PipelineStage[];
  status: PipelineStatus;
  createdAt: string;
  updatedAt: string;
  /** Set when status === 'FAILED': the first failing stage and its message. */
  failure?: { stage: StageName; message: string };
}

/** spec §40 — the four default environments. */
export type EnvironmentName = 'LOCAL' | 'DEV' | 'UAT' | 'PROD';

/**
 * spec §41 — production policy modes:
 *   HUMAN_APPROVAL — Mode A: a human must approve before deploy.
 *   AI_REVIEW      — Mode B: AI review + policy gate.
 *   AUTO           — no approval gate (still runs the §41 checklist).
 */
export type ApprovalPolicy = 'HUMAN_APPROVAL' | 'AI_REVIEW' | 'AUTO';

/** spec §40 — one environment definition. */
export interface Environment {
  name: EnvironmentName;
  runtime: string;
  variables: Record<string, string>;
  /**
   * Reference to the secret store (name/ref only). Agents never receive raw
   * production secrets (spec §40: "Agents should never automatically receive
   * raw production secrets").
   */
  secretsRef: string;
  url: string;
  deploymentMethod: string;
  permissions: string[];
  healthCheck: string;
  /**
   * How to roll this environment back. An empty value means NO rollback
   * capability — deploys are refused by the §77 pre-deploy gate.
   */
  rollbackMethod: string;
  approvalPolicy: ApprovalPolicy;
}

/** spec §77 — snapshot taken before a major operation (deploy, migration, ...). */
export interface Snapshot {
  id: string;
  label: string;
  /** Opaque pre-op state captured by the caller; restored by rollback(). */
  data: unknown;
  environment: EnvironmentName;
  createdAt: string;
}

/** Deployment lifecycle. */
export type DeploymentStatus =
  | 'PENDING'
  | 'AWAITING_APPROVAL'
  | 'DEPLOYING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'ROLLED_BACK';

/** spec §77 — one deployment of a pipeline artifact to an environment. */
export interface Deployment {
  id: string;
  pipelineId: string;
  environment: EnvironmentName;
  status: DeploymentStatus;
  /** Snapshot taken before the deploy; restored if the deploy fails (§77). */
  snapshotId: string | null;
  /** Approval id (from @ai-factory/approvals) that authorized this deploy. */
  approvalId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Set when the deploy failed or was rolled back. */
  error?: string;
}

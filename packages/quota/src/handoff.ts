/**
 * Cross-model handoff packages — SPEC v2 §27.3.
 *
 * A handoff carries references and the minimal content needed to continue —
 * never raw credentials, private internal reasoning, or unbounded chat
 * history. Every package is hash-verified on receipt. The old run is ended
 * or paused BEFORE the new one activates: old and new never dual-write.
 */
import { createHash, randomUUID } from 'node:crypto';
import { QuotaError } from './types';

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** SPEC v2 §27.3 — required handoff fields. */
export interface HandoffPackage {
  schemaVersion: '2.0';
  handoffId: string;
  taskId: string;
  runId: string;
  delegationId?: string;
  rootAuthorizationId: string;
  requirementVersion: string;
  acceptanceCriteriaVersions: string[];
  goal: string;
  scope: string;
  plan: string[];
  completed: string[];
  notCompleted: string[];
  decisions: { decision: string; rationale: string; at: string }[];
  gitBaseSha?: string;
  gitCandidateSha?: string;
  diffRefs: string[];
  fileRefs: string[];
  commands: string[];
  tests: { name: string; outcome: 'pass' | 'fail' | 'skipped'; ref?: string }[];
  failures: string[];
  artifactRefs: string[];
  evidenceRefs: string[];
  risks: { severity: 'LOW' | 'MEDIUM' | 'HIGH'; description: string }[];
  workerHost: string;
  environment: string;
  pendingSideEffects: string[];
  checkpointRef: string;
  policyVersion: string;
  capabilityCeilingRef: string;
  budgetUsed: number;
  budgetRemaining: number;
  contextSourceManifest: { source: string; version: string; hash: string }[];
  /** Hash of the canonical package bytes, computed at seal time. */
  packageHash: string;
  createdAt: string;
}

export type HandoffInput = Omit<HandoffPackage, 'schemaVersion' | 'handoffId' | 'packageHash' | 'createdAt'>;

const REQUIRED_FIELDS: (keyof HandoffInput)[] = [
  'taskId',
  'runId',
  'rootAuthorizationId',
  'requirementVersion',
  'acceptanceCriteriaVersions',
  'goal',
  'scope',
  'plan',
  'completed',
  'notCompleted',
  'workerHost',
  'environment',
  'pendingSideEffects',
  'checkpointRef',
  'policyVersion',
  'capabilityCeilingRef',
  'contextSourceManifest',
];

export class IncompleteHandoff extends QuotaError {
  constructor(missing: string[]) {
    super('INCOMPLETE_HANDOFF', `Handoff package missing required fields: ${missing.join(', ')}`);
  }
}

export class HandoffHashMismatch extends QuotaError {
  constructor() {
    super('HANDOFF_HASH_MISMATCH', 'Handoff package hash does not match its content — refusing to activate');
  }
}

export class SecretInHandoff extends QuotaError {
  constructor(where: string) {
    super('SECRET_IN_HANDOFF', `Handoff package must not carry raw secrets (${where})`);
  }
}

/** Refuse obvious secret material before it ever leaves the boundary. */
function assertNoSecrets(input: HandoffInput): void {
  const haystack = JSON.stringify(input);
  const hits: Array<[RegExp, string]> = [
    [/sk-[A-Za-z0-9]{10,}/, 'api-key-like value'],
    [/"(?:password|passwd|secret|private_key)"\s*:\s*"[^"]{4,}"/i, 'password/secret field with a value'],
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key block'],
  ];
  for (const [re, label] of hits) {
    if (re.test(haystack)) throw new SecretInHandoff(label);
  }
}

/** Build + seal a handoff package. Throws on missing fields or secrets. */
export function createHandoffPackage(
  input: HandoffInput,
  now: () => number = Date.now,
): HandoffPackage {
  assertNoSecrets(input);
  const missing = REQUIRED_FIELDS.filter((f) => {
    const v = input[f];
    return v === undefined || v === null || (Array.isArray(v) && v.length === 0 && f !== 'pendingSideEffects');
  });
  if (missing.length > 0) throw new IncompleteHandoff(missing);
  const pkg = {
    ...input,
    schemaVersion: '2.0',
    handoffId: randomUUID(),
    createdAt: new Date(now()).toISOString(),
  } as Omit<HandoffPackage, 'packageHash'>;
  const packageHash = sha256Hex(JSON.stringify(pkg));
  return { ...pkg, packageHash };
}

/** Verify a received package before activating the new run. */
export function verifyHandoffPackage(pkg: HandoffPackage): void {
  const { packageHash, ...rest } = pkg;
  if (sha256Hex(JSON.stringify(rest)) !== packageHash) {
    throw new HandoffHashMismatch();
  }
  assertNoSecrets(rest as HandoffInput);
}

/**
 * No-dual-write guard: the replacement run may only activate after the old
 * run is ended or paused. Tracked here so both halves live in one place.
 */
export class HandoffActivationGuard {
  private readonly oldRunStates = new Map<string, 'ACTIVE' | 'ENDED' | 'PAUSED'>();

  registerOldRun(runId: string): void {
    this.oldRunStates.set(runId, 'ACTIVE');
  }

  markOldRunSettled(runId: string, to: 'ENDED' | 'PAUSED'): void {
    if (!this.oldRunStates.has(runId)) {
      throw new QuotaError('UNKNOWN_HANDOFF_RUN', `No handoff registered for old run ${runId}`);
    }
    this.oldRunStates.set(runId, to);
  }

  /** Throws unless the old run is ended/paused — prevents dual writes. */
  assertOldRunSettled(runId: string): void {
    const s = this.oldRunStates.get(runId);
    if (s !== 'ENDED' && s !== 'PAUSED') {
      throw new QuotaError(
        'DUAL_WRITE_RISK',
        `Old run ${runId} is still ${s ?? 'unknown'} — end or pause it before activating the replacement`,
      );
    }
  }
}

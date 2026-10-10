/**
 * SPEC v2 §49.3 runtime validators — hand-written, zero dependencies.
 *
 * Enforce: field presence, enum values, field lengths, Ref shape, and the
 * schemaVersion literal. Validators return a result object (never throw for
 * bad input) so callers can surface every issue at once.
 *
 * SECURITY NOTE (§49.3): never trust a client-submitted `actor`. Validators
 * check the actor *shape*, but the authoritative identity always comes from
 * the server's authenticated session — use applyServerActor() to overwrite
 * whatever the client sent before acting on an envelope.
 */
import type {
  Actor,
  CommandEnvelope,
  DelegationRequest,
  EvidenceRecord,
  Ref,
  TransitionRequest,
} from './types';

/** One validation failure. */
export interface ValidationIssue {
  path: string;
  message: string;
}

/** Validator outcome. */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

type Validator<T> = (input: unknown, path: string) => ValidationResult<T>;

function fail<T>(path: string, message: string): ValidationResult<T> {
  return { ok: false, issues: [{ path, message }] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(
  v: unknown,
  path: string,
  opts: { max: number; allowEmpty?: boolean } = { max: 256 },
): ValidationResult<string> {
  if (typeof v !== 'string') return fail(path, 'must be a string');
  if (!opts.allowEmpty && v.length === 0) return fail(path, 'must not be empty');
  if (v.length > opts.max) return fail(path, `exceeds max length ${opts.max}`);
  return { ok: true, value: v };
}

function int(v: unknown, path: string, opts: { min?: number } = {}): ValidationResult<number> {
  if (typeof v !== 'number' || !Number.isInteger(v)) return fail(path, 'must be an integer');
  if (opts.min !== undefined && v < opts.min) return fail(path, `must be >= ${opts.min}`);
  return { ok: true, value: v };
}

function enumOf<T extends string>(
  v: unknown,
  path: string,
  allowed: readonly T[],
): ValidationResult<T> {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    return fail(path, `must be one of: ${allowed.join(' | ')}`);
  }
  return { ok: true, value: v as T };
}

function literal<T extends string>(v: unknown, path: string, expected: T): ValidationResult<T> {
  if (v !== expected) return fail(path, `must be exactly ${JSON.stringify(expected)}`);
  return { ok: true, value: expected };
}

/** Run field validators against a record, collecting all issues. */
function object<T>(
  v: unknown,
  path: string,
  build: (get: <F>(name: string, fn: Validator<F>) => F) => T,
): ValidationResult<T> {
  if (!isRecord(v)) return fail(path, 'must be an object');
  const issues: ValidationIssue[] = [];
  const values: Record<string, unknown> = {};
  const get = <F>(name: string, fn: Validator<F>): F => {
    const r = fn(v[name], path ? `${path}.${name}` : name);
    if (!r.ok) {
      issues.push(...r.issues);
      return undefined as F;
    }
    values[name] = r.value;
    return r.value;
  };
  const built = build(get);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { ...(built as object), ...values } as T };
}

function optional<T>(fn: Validator<T>): Validator<T | undefined> {
  return (v, path) => {
    if (v === undefined) return { ok: true, value: undefined };
    return fn(v, path);
  };
}

function arrayOf<T>(item: Validator<T>, path: string, v: unknown, max: number): ValidationResult<T[]> {
  if (!Array.isArray(v)) return fail(path, 'must be an array');
  if (v.length > max) return fail(path, `exceeds max items ${max}`);
  const issues: ValidationIssue[] = [];
  const out: T[] = [];
  v.forEach((el, i) => {
    const r = item(el, `${path}[${i}]`);
    if (!r.ok) issues.push(...r.issues);
    else out.push(r.value);
  });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: out };
}

function strArray(v: unknown, path: string, max: number, itemMax: number): ValidationResult<string[]> {
  return arrayOf<string>((el, p) => str(el, p, { max: itemMax }), path, v, max);
}

/** §49.3 Ref: { id, version, hash? }. */
export function validateRef(v: unknown, path = 'ref'): ValidationResult<Ref> {
  return object<Ref>(v, path, (get) => ({
    id: get('id', (x, p) => str(x, p, { max: 128 })),
    version: get('version', (x, p) => int(x, p, { min: 0 })),
    hash: get('hash', optional((x, p) => str(x, p, { max: 256 }))),
  }));
}

/**
 * §49.3 Actor shape check. Shape only — the authoritative actor is derived
 * server-side; see applyServerActor().
 */
export function validateActor(v: unknown, path = 'actor'): ValidationResult<Actor> {
  return object<Actor>(v, path, (get) => ({
    id: get('id', (x, p) => str(x, p, { max: 128 })),
    type: get('type', (x, p) => enumOf(x, p, ['HUMAN', 'AI', 'SERVICE'] as const)),
  }));
}

/**
 * Overwrite the envelope's actor with the server-derived identity.
 * Call this on every inbound envelope before acting on it — a client that
 * submits `actor.type: "HUMAN"` gains nothing.
 */
export function applyServerActor<T>(
  envelope: CommandEnvelope<T>,
  serverActor: Actor,
): CommandEnvelope<T> {
  return { ...envelope, actor: { ...serverActor } };
}

/** §49.3 CommandEnvelope<T> with a caller-supplied payload validator. */
export function validateCommandEnvelope<T>(
  v: unknown,
  validatePayload: Validator<T>,
  path = 'envelope',
): ValidationResult<CommandEnvelope<T>> {
  return object<CommandEnvelope<T>>(v, path, (get) => ({
    schemaVersion: get('schemaVersion', (x, p) => literal(x, p, '2.0')),
    requestId: get('requestId', (x, p) => str(x, p, { max: 128 })),
    idempotencyKey: get('idempotencyKey', (x, p) => str(x, p, { max: 128 })),
    organizationId: get('organizationId', (x, p) => str(x, p, { max: 128 })),
    projectId: get('projectId', optional((x, p) => str(x, p, { max: 128 }))),
    actor: get('actor', validateActor),
    expectedVersion: get('expectedVersion', optional((x, p) => int(x, p, { min: 0 }))),
    payload: get('payload', validatePayload),
  }));
}

/** §49.3 TransitionRequest payload. */
export function validateTransitionRequest(v: unknown, path = 'payload'): ValidationResult<TransitionRequest> {
  return object<TransitionRequest>(v, path, (get) => ({
    task: get('task', validateRef),
    requirement: get('requirement', validateRef),
    from: get('from', (x, p) => str(x, p, { max: 64 })),
    to: get('to', (x, p) => str(x, p, { max: 64 })),
    candidateDigest: get('candidateDigest', (x, p) => str(x, p, { max: 256 })),
    evidenceManifestRef: get('evidenceManifestRef', validateRef),
    approvalRefs: get('approvalRefs', (x, p) =>
      arrayOf<Ref>(validateRef, p, x, 64),
    ),
  }));
}

/** §49.3 DelegationRequest payload. */
export function validateDelegationRequest(
  v: unknown,
  path = 'payload',
): ValidationResult<DelegationRequest> {
  return object<DelegationRequest>(v, path, (get) => ({
    parentDelegationRef: get('parentDelegationRef', optional(validateRef)),
    rootAuthorizationRef: get('rootAuthorizationRef', validateRef),
    task: get('task', validateRef),
    delegatorId: get('delegatorId', (x, p) => str(x, p, { max: 128 })),
    delegateeId: get('delegateeId', (x, p) => str(x, p, { max: 128 })),
    scopeRef: get('scopeRef', validateRef),
    acceptanceCriteriaRefs: get('acceptanceCriteriaRefs', (x, p) =>
      arrayOf<Ref>(validateRef, p, x, 128),
    ),
    capabilityCeilingRef: get('capabilityCeilingRef', validateRef),
    budgetReservationId: get('budgetReservationId', (x, p) => str(x, p, { max: 128 })),
    reportTo: get('reportTo', (x, p) => strArray(x, p, 32, 128)),
    deadline: get('deadline', optional((x, p) => str(x, p, { max: 64 }))),
  }));
}

/** §49.3 EvidenceRecord. */
export function validateEvidenceRecord(v: unknown, path = 'evidence'): ValidationResult<EvidenceRecord> {
  return object<EvidenceRecord>(v, path, (get) => ({
    id: get('id', (x, p) => str(x, p, { max: 128 })),
    schemaVersion: get('schemaVersion', (x, p) => literal(x, p, '2.0')),
    taskId: get('taskId', (x, p) => str(x, p, { max: 128 })),
    runId: get('runId', (x, p) => str(x, p, { max: 128 })),
    requirement: get('requirement', validateRef),
    candidateDigest: get('candidateDigest', (x, p) => str(x, p, { max: 256 })),
    environmentFingerprint: get('environmentFingerprint', (x, p) => str(x, p, { max: 256 })),
    testDefinitionHash: get('testDefinitionHash', optional((x, p) => str(x, p, { max: 256 }))),
    collectorIdentity: get('collectorIdentity', (x, p) => str(x, p, { max: 128 })),
    artifactHashes: get('artifactHashes', (x, p) => strArray(x, p, 1024, 256)),
    exitCode: get('exitCode', optional((x, p) => int(x, p))),
    result: get('result', (x, p) =>
      isRecord(x) ? { ok: true, value: x } : fail<Record<string, unknown>>(p, 'must be an object'),
    ),
    validity: get('validity', (x, p) =>
      enumOf(x, p, ['ACTIVE', 'STALE', 'REVOKED'] as const),
    ),
    trust: get('trust', (x, p) =>
      enumOf(x, p, ['UNVERIFIED', 'TRUSTED_COLLECTOR', 'EXTERNALLY_ATTESTED'] as const),
    ),
  }));
}

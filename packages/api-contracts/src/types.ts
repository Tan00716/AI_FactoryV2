/**
 * SPEC v2 §49.3 core TypeScript contracts.
 *
 * These are the authoritative field shapes for cross-surface calls
 * (UI/IPC/HTTP/Webhook/MCP). They are a summary of the core fields; the
 * runtime validators in validators.ts enforce the full schema, enums, field
 * lengths, scope references — and never trust a client-submitted actor.
 */

/** §49.3 — versioned reference to another object. */
export interface Ref {
  id: string;
  version: number;
  hash?: string;
}

/** §49.3 — who is acting. The server ALWAYS derives this from the
 * authenticated identity; a client-submitted actor is untrusted input. */
export interface Actor {
  id: string;
  type: 'HUMAN' | 'AI' | 'SERVICE';
}

/**
 * §49.3 — uniform envelope for every command.
 * `actor` is filled/overwritten by the server (see applyServerActor).
 */
export interface CommandEnvelope<T> {
  schemaVersion: '2.0';
  requestId: string;
  idempotencyKey: string;
  organizationId: string;
  projectId?: string;
  actor: Actor;
  expectedVersion?: number;
  payload: T;
}

/** §49.3 — task transition command payload. */
export interface TransitionRequest {
  task: Ref;
  requirement: Ref;
  from: string;
  to: string;
  candidateDigest: string;
  evidenceManifestRef: Ref;
  approvalRefs: Ref[];
}

/** §49.3 — delegation command payload. */
export interface DelegationRequest {
  parentDelegationRef?: Ref;
  rootAuthorizationRef: Ref;
  task: Ref;
  delegatorId: string;
  delegateeId: string;
  scopeRef: Ref;
  acceptanceCriteriaRefs: Ref[];
  capabilityCeilingRef: Ref;
  budgetReservationId: string;
  reportTo: string[];
  deadline?: string;
}

/** §49.3 — evidence record. */
export interface EvidenceRecord {
  id: string;
  schemaVersion: '2.0';
  taskId: string;
  runId: string;
  requirement: Ref;
  candidateDigest: string;
  environmentFingerprint: string;
  testDefinitionHash?: string;
  collectorIdentity: string;
  artifactHashes: string[];
  exitCode?: number;
  result: Record<string, unknown>;
  validity: 'ACTIVE' | 'STALE' | 'REVOKED';
  trust: 'UNVERIFIED' | 'TRUSTED_COLLECTOR' | 'EXTERNALLY_ATTESTED';
}

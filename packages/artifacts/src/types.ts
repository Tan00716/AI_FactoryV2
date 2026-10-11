/**
 * Artifact domain types — spec §23 (Artifact System).
 *
 * §39.1: "Artifacts are first-class objects" and "every important workflow
 * action should generate or reference an Artifact". The spec lists 27
 * supported artifact types (19 v1 + 8 v2); each type carries a schema here (required +
 * optional field specs), and `ArtifactStore.create` validates the field
 * payload against the schema, refusing creation while naming the missing
 * or mistyped fields.
 */

/** §39.1 — the 27 supported artifact types (19 v1 + 8 v2). */
export type ArtifactType =
  | 'PLAN'
  | 'TASK_BREAKDOWN'
  | 'DESIGN'
  | 'ARCHITECTURE'
  | 'CODE_CHANGE'
  | 'COMMIT'
  | 'PULL_REQUEST'
  | 'CODE_REVIEW'
  | 'TEST_PLAN'
  | 'TEST_RESULT'
  | 'SECURITY_REPORT'
  | 'BUILD_ARTIFACT'
  | 'DEPLOYMENT'
  | 'SMOKE_TEST'
  | 'UAT_RESULT'
  | 'RELEASE'
  | 'INCIDENT'
  | 'ROLLBACK'
  | 'FINAL_REPORT'
  // §39.1 v2 additions
  | 'REQUIREMENT_VERSION'
  | 'DELEGATION'
  | 'MANAGEMENT_REPORT'
  | 'RISK_ASSESSMENT'
  | 'OUTCOME_RESULT'
  | 'HANDOFF'
  | 'CHECKPOINT'
  | 'IMPROVEMENT_PROPOSAL';

/** All 27 types, in spec order. Useful for iteration / registration. */
export const ARTIFACT_TYPES: readonly ArtifactType[] = [
  'PLAN',
  'TASK_BREAKDOWN',
  'DESIGN',
  'ARCHITECTURE',
  'CODE_CHANGE',
  'COMMIT',
  'PULL_REQUEST',
  'CODE_REVIEW',
  'TEST_PLAN',
  'TEST_RESULT',
  'SECURITY_REPORT',
  'BUILD_ARTIFACT',
  'DEPLOYMENT',
  'SMOKE_TEST',
  'UAT_RESULT',
  'RELEASE',
  'INCIDENT',
  'ROLLBACK',
  'FINAL_REPORT',
  // §39.1 v2 additions
  'REQUIREMENT_VERSION',
  'DELEGATION',
  'MANAGEMENT_REPORT',
  'RISK_ASSESSMENT',
  'OUTCOME_RESULT',
  'HANDOFF',
  'CHECKPOINT',
  'IMPROVEMENT_PROPOSAL',
];

/**
 * Primitive field types the schema validator understands.
 *  - string / number / boolean: JS primitives (strings must be non-blank)
 *  - string[]: array whose items are all strings
 *  - record: a plain (non-array) object
 *  - isoDate: a string `Date.parse` can parse (ISO-8601 timestamps)
 */
export type FieldType = 'string' | 'number' | 'boolean' | 'string[]' | 'record' | 'isoDate';

/** One field spec: name, expected type, human description. */
export interface FieldSpec {
  name: string;
  type: FieldType;
  description: string;
}

/** Schema for one artifact type: its required + optional field specs. */
export interface ArtifactSchema {
  type: ArtifactType;
  description: string;
  required: FieldSpec[];
  optional: FieldSpec[];
}

/** §23 artifact lifecycle, mirroring the evidence engine (packages/core): DRAFT → SEALED. */
export type ArtifactStatus = 'DRAFT' | 'SEALED';

/**
 * A first-class artifact record. `fields` is the schema-validated payload.
 * `relatedIds` are bidirectional links to other artifacts (evidence chain).
 * All timestamps are ISO-8601 strings; `sealedAt === null` while DRAFT.
 */
export interface Artifact {
  id: string;
  taskId: string;
  type: ArtifactType;
  title: string;
  status: ArtifactStatus;
  fields: Record<string, unknown>;
  relatedIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  sealedAt: string | null;
}

/** Input for `ArtifactStore.create` — identity, status and bookkeeping are assigned. */
export interface NewArtifact {
  taskId: string;
  type: ArtifactType;
  title: string;
  fields: Record<string, unknown>;
  createdBy: string;
  /** Ids to link bidirectionally at creation time; all must exist and be DRAFT. */
  relatedIds?: string[];
}

/** Query filter for `ArtifactStore.query`. */
export interface ArtifactQuery {
  taskId?: string;
  type?: ArtifactType;
  status?: ArtifactStatus;
}

/** Field-level update input for `ArtifactStore.update` (DRAFT only). */
export interface ArtifactUpdate {
  title?: string;
  fields?: Record<string, unknown>;
}

/** Thrown when an artifact id is unknown to the store. */
export class ArtifactNotFoundError extends Error {
  constructor(id: string) {
    super(`Artifact ${id} not found`);
    this.name = 'ArtifactNotFoundError';
  }
}

/**
 * Thrown when a mutating operation targets a SEALED artifact.
 * Same semantics as the evidence engine: sealed means immutable.
 */
export class ArtifactSealedError extends Error {
  constructor(id: string, op: string) {
    super(`Artifact ${id} is SEALED and immutable (refused ${op})`);
    this.name = 'ArtifactSealedError';
  }
}

/** One mistyped field: what was expected vs what was provided. */
export interface FieldTypeError {
  field: string;
  expected: FieldType;
  actual: string;
}

/**
 * Thrown by `create`/`update` when the field payload fails schema
 * validation. The message names every missing required field and every
 * type mismatch so callers know exactly what to fix.
 */
export class ArtifactValidationError extends Error {
  readonly type: ArtifactType;
  readonly missing: string[];
  readonly typeErrors: FieldTypeError[];
  constructor(type: ArtifactType, missing: string[], typeErrors: FieldTypeError[]) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing required fields: ${missing.join(', ')}`);
    for (const e of typeErrors) {
      parts.push(`field "${e.field}" must be ${e.expected}, got ${e.actual}`);
    }
    super(`Artifact ${type} invalid: ${parts.join('; ')}`);
    this.name = 'ArtifactValidationError';
    this.type = type;
    this.missing = missing;
    this.typeErrors = typeErrors;
  }
}

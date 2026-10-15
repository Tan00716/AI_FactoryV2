/**
 * Durable authority-conflict registry rows — spec §8.1, Batch 75 (F12).
 *
 * Until Batch 75 the authority-conflict registry
 * (@ai-factory/policy AuthorityConflictRegistry) was process-local
 * memory: an OPEN conflict that survived a SIGKILL was lost (F12).
 * This file is the record layer for the registry's shapes: directives
 * and conflicts are upserted on every registry mutation by the server
 * (write-through, never roll back the response on persist failure) and
 * reloaded at boot into a fresh registry (silent hydrate — no audit
 * events, no onConflictOpened re-emission, so the §81 needsHuman
 * 'ai-disagreement' upgrade is raised exactly once, when the conflict
 * is opened, never again on restart).
 *
 * Record semantics (pinned by tests):
 *  - saveDirective / saveConflict are upserts keyed by id (register,
 *    supersede, override, attach and resolve all write through the
 *    same path — there is no separate "update" call);
 *  - OPEN conflicts hydrate as-is: an open conflict is a paused target
 *    awaiting a strictly higher-ranked human, not process state;
 *    RESOLVED conflicts hydrate as history (read-only in the live
 *    registry — resolveConflict still requires OPEN);
 *  - corrupt rows fail loudly (invalid enum value or unparseable JSON
 *    throws), never normalized or guessed.
 *
 * Copy contract: every read returns a fresh deep copy.
 */
import type {
  AuthorityConflict,
  AuthorityLevel,
  AuthorityTargetKind,
  ConflictStatus,
  Directive,
  DirectiveEffect,
  DirectiveStatus,
} from '@ai-factory/policy';
import { DatabaseSync } from 'node:sqlite';

export interface AuthorityConflictStore {
  /** Upsert a directive row (insert or full-row replace by id). */
  saveDirective(d: Directive): void;
  /** Upsert a conflict row (insert or full-row replace by id). */
  saveConflict(c: AuthorityConflict): void;
  /** All directives, insertion order. */
  listDirectives(): Directive[];
  /** All conflicts, insertion order. */
  listConflicts(): AuthorityConflict[];
}

const copy = <T>(v: T): T => structuredClone(v);

const LEVELS: ReadonlyArray<string> = [
  'owner',
  'security_authority',
  'manager',
  'operator',
  'viewer',
];
const EFFECTS: ReadonlyArray<string> = ['ALLOW', 'BLOCK', 'PAUSE', 'RESUME', 'CANCEL'];
const DIRECTIVE_STATUSES: ReadonlyArray<string> = ['ACTIVE', 'SUPERSEDED', 'OVERRIDDEN'];
const CONFLICT_STATUSES: ReadonlyArray<string> = ['OPEN', 'RESOLVED'];

function corrupt(what: string, value: unknown): Error {
  return new Error(`corrupted authority_directives row: invalid ${what} ${JSON.stringify(value)}`);
}

function assertEnum(value: unknown, allowed: ReadonlyArray<string>, what: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) throw corrupt(what, value);
  return value;
}

function assertDirectiveShape(d: Directive): void {
  if (typeof d.directiveId !== 'string' || d.directiveId === '') throw corrupt('directiveId', d.directiveId);
  if (typeof d.principalId !== 'string' || d.principalId === '') throw corrupt('principalId', d.principalId);
  assertEnum(d.authorityLevel, LEVELS, 'authorityLevel');
  assertEnum(d.targetKind, ['run', 'task'], 'targetKind');
  if (typeof d.targetId !== 'string' || d.targetId === '') throw corrupt('targetId', d.targetId);
  assertEnum(d.effect, EFFECTS, 'effect');
  if (typeof d.instruction !== 'string') throw corrupt('instruction', d.instruction);
  if (typeof d.createdAt !== 'string') throw corrupt('createdAt', d.createdAt);
  assertEnum(d.status, DIRECTIVE_STATUSES, 'status');
}

function assertConflictShape(c: AuthorityConflict): void {
  if (typeof c.conflictId !== 'string' || c.conflictId === '') {
    throw new Error(`corrupted authority_conflicts row: invalid conflictId ${JSON.stringify(c.conflictId)}`);
  }
  assertEnum(c.targetKind, ['run', 'task'], 'targetKind');
  if (typeof c.targetId !== 'string' || c.targetId === '') {
    throw new Error(`corrupted authority_conflicts row: invalid targetId ${JSON.stringify(c.targetId)}`);
  }
  assertEnum(c.status, CONFLICT_STATUSES, 'status');
  if (!Array.isArray(c.directiveIds) || c.directiveIds.some((id) => typeof id !== 'string')) {
    throw new Error(
      `corrupted authority_conflicts row: invalid directiveIds ${JSON.stringify(c.directiveIds)}`,
    );
  }
  if (typeof c.detectedAt !== 'string') {
    throw new Error(`corrupted authority_conflicts row: invalid detectedAt ${JSON.stringify(c.detectedAt)}`);
  }
  if (c.resolution !== undefined && (typeof c.resolution !== 'object' || c.resolution === null)) {
    throw new Error(`corrupted authority_conflicts row: invalid resolution ${JSON.stringify(c.resolution)}`);
  }
}

/** In-memory implementation: the behavior reference. */
export class InMemoryAuthorityConflictStore implements AuthorityConflictStore {
  private readonly directives = new Map<string, Directive>();
  private readonly conflicts = new Map<string, AuthorityConflict>();

  saveDirective(d: Directive): void {
    assertDirectiveShape(d);
    this.directives.set(d.directiveId, copy(d));
  }

  saveConflict(c: AuthorityConflict): void {
    assertConflictShape(c);
    this.conflicts.set(c.conflictId, copy(c));
  }

  listDirectives(): Directive[] {
    return [...this.directives.values()].map(copy);
  }

  listConflicts(): AuthorityConflict[] {
    return [...this.conflicts.values()].map(copy);
  }
}

function rowToDirective(row: Record<string, unknown>): Directive {
  const d: Directive = {
    directiveId: row['directive_id'] as string,
    principalId: row['principal_id'] as string,
    authorityLevel: row['authority_level'] as AuthorityLevel,
    targetKind: row['target_kind'] as AuthorityTargetKind,
    targetId: row['target_id'] as string,
    effect: row['effect'] as DirectiveEffect,
    instruction: row['instruction'] as string,
    createdAt: row['created_at'] as string,
    status: row['status'] as DirectiveStatus,
  };
  // Corrupt rows fail loudly: nothing is normalized or guessed.
  assertDirectiveShape(d);
  return d;
}

function rowToConflict(row: Record<string, unknown>): AuthorityConflict {
  // Corrupt JSON fails loudly: JSON.parse throws rather than guessing.
  const directiveIdsJson = row['directive_ids_json'] as string;
  const directiveIds = JSON.parse(directiveIdsJson) as unknown;
  const resolutionJson = row['resolution_json'] as string | null;
  const c: AuthorityConflict = {
    conflictId: row['conflict_id'] as string,
    targetKind: row['target_kind'] as string,
    targetId: row['target_id'] as string,
    status: row['status'] as string,
    directiveIds: directiveIds as string[],
    detectedAt: row['detected_at'] as string,
  } as AuthorityConflict;
  // No resolution key at all when the column is NULL: the shape must
  // round-trip exactly (an explicit `resolution: undefined` key is
  // not deep-equal to a missing key under assert/strict).
  if (resolutionJson !== null) {
    c.resolution = JSON.parse(resolutionJson) as AuthorityConflict['resolution'];
  }
  assertConflictShape(c);
  return c;
}

/** SQLite implementation. Tables are created by SCHEMA (IF NOT EXISTS). */
export class SqliteAuthorityConflictStore implements AuthorityConflictStore {
  constructor(private readonly db: DatabaseSync) {}

  saveDirective(d: Directive): void {
    assertDirectiveShape(d);
    this.db
      .prepare(
        `INSERT INTO authority_directives
           (directive_id, principal_id, authority_level, target_kind, target_id,
            effect, instruction, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(directive_id) DO UPDATE SET
           principal_id = excluded.principal_id,
           authority_level = excluded.authority_level,
           target_kind = excluded.target_kind,
           target_id = excluded.target_id,
           effect = excluded.effect,
           instruction = excluded.instruction,
           created_at = excluded.created_at,
           status = excluded.status`,
      )
      .run(
        d.directiveId,
        d.principalId,
        d.authorityLevel,
        d.targetKind,
        d.targetId,
        d.effect,
        d.instruction,
        d.createdAt,
        d.status,
      );
  }

  saveConflict(c: AuthorityConflict): void {
    assertConflictShape(c);
    this.db
      .prepare(
        `INSERT INTO authority_conflicts
           (conflict_id, target_kind, target_id, status, directive_ids_json,
            detected_at, resolution_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conflict_id) DO UPDATE SET
           target_kind = excluded.target_kind,
           target_id = excluded.target_id,
           status = excluded.status,
           directive_ids_json = excluded.directive_ids_json,
           detected_at = excluded.detected_at,
           resolution_json = excluded.resolution_json`,
      )
      .run(
        c.conflictId,
        c.targetKind,
        c.targetId,
        c.status,
        JSON.stringify(c.directiveIds),
        c.detectedAt,
        c.resolution === undefined ? null : JSON.stringify(c.resolution),
      );
  }

  listDirectives(): Directive[] {
    const rows = this.db
      .prepare('SELECT * FROM authority_directives ORDER BY rowid')
      .all() as Record<string, unknown>[];
    return rows.map(rowToDirective);
  }

  listConflicts(): AuthorityConflict[] {
    const rows = this.db
      .prepare('SELECT * FROM authority_conflicts ORDER BY rowid')
      .all() as Record<string, unknown>[];
    return rows.map(rowToConflict);
  }
}

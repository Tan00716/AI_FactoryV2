/**
 * Durable gate definitions + gate evaluations — SPEC v2 §39.3, §48.2 (Batch 32).
 *
 * Until Batch 32 a §39.3 GateDefinitionV2 had nowhere to live at all:
 * evaluateGateV2 is a pure function and no registry, store, or HTTP
 * surface ever held a definition or an evaluation. This file is the
 * record layer only: one row per gate_id holding the full definition
 * JSON (lossless), plus an append-only evaluation log. The verdict
 * computation itself stays in @ai-factory/core (the deterministic
 * evaluator); this store never invents a verdict.
 *
 * Record semantics (pinned by tests):
 *  - saveDefinition is an upsert keyed by gate_id; updating a
 *    definition does NOT rewrite past evaluations (they are history).
 *  - recordEvaluation appends; evaluations are never updated or
 *    deleted through this store (sealed verdicts, §39).
 *  - listEvaluations returns newest-first so the latest verdict is
 *    the first row.
 *  - Gate evaluations are synchronous and terminal in the domain
 *    layer — there is no in-flight evaluation state to demote on
 *    restart (unlike delegations). Definitions have no lifecycle at
 *    all; they hydrate as-is.
 *
 * Copy contract: every read returns a fresh deep copy (structuredClone
 * in memory, fresh objects from JSON in SQLite).
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export interface GateDefinitionDbRecord {
  gateId: string;
  /** Full GateDefinitionV2 JSON (lossless). */
  definitionJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface GateEvaluationDbRecord {
  evaluationId: string;
  gateId: string;
  verdict: string;
  reasonCode: string | null;
  /** JSON array of AC ids with no ACTIVE passing evidence. */
  missingJson: string;
  /** JSON array of evidence ids the verdict was computed over. */
  evidenceRefsJson: string;
  /**
   * Where the evaluated evidence came from, e.g.
   * 'caller-supplied' (HTTP body) vs a future server-side evidence
   * store. Never left blank — provenance is part of the record.
   */
  evidenceSource: string;
  evaluatorId: string;
  evaluatedAt: string;
}

export interface GateStore {
  saveDefinition(record: GateDefinitionDbRecord): void;
  getDefinition(gateId: string): GateDefinitionDbRecord | undefined;
  listDefinitions(): GateDefinitionDbRecord[];
  recordEvaluation(record: GateEvaluationDbRecord): void;
  getEvaluation(evaluationId: string): GateEvaluationDbRecord | undefined;
  listEvaluations(gateId?: string): GateEvaluationDbRecord[];
}

const copy = <T>(v: T): T => structuredClone(v);

export function newGateEvaluationId(): string {
  return randomUUID();
}

/** In-memory implementation: the behavior reference. */
export class InMemoryGateStore implements GateStore {
  private readonly defs = new Map<string, GateDefinitionDbRecord>();
  private readonly evals: GateEvaluationDbRecord[] = [];

  saveDefinition(record: GateDefinitionDbRecord): void {
    this.defs.set(record.gateId, copy(record));
  }

  getDefinition(gateId: string): GateDefinitionDbRecord | undefined {
    const r = this.defs.get(gateId);
    return r === undefined ? undefined : copy(r);
  }

  listDefinitions(): GateDefinitionDbRecord[] {
    return [...this.defs.values()].map(copy).sort((a, b) => a.gateId.localeCompare(b.gateId));
  }

  recordEvaluation(record: GateEvaluationDbRecord): void {
    this.evals.push(copy(record));
  }

  getEvaluation(evaluationId: string): GateEvaluationDbRecord | undefined {
    const r = this.evals.find((e) => e.evaluationId === evaluationId);
    return r === undefined ? undefined : copy(r);
  }

  listEvaluations(gateId?: string): GateEvaluationDbRecord[] {
    return this.evals
      .filter((e) => gateId === undefined || e.gateId === gateId)
      .map(copy)
      .sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt));
  }
}

function rowToDefinition(row: Record<string, unknown>): GateDefinitionDbRecord {
  return {
    gateId: row['gate_id'] as string,
    definitionJson: row['definition_json'] as string,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

function rowToEvaluation(row: Record<string, unknown>): GateEvaluationDbRecord {
  return {
    evaluationId: row['evaluation_id'] as string,
    gateId: row['gate_id'] as string,
    verdict: row['verdict'] as string,
    reasonCode: (row['reason_code'] as string | null) ?? null,
    missingJson: row['missing_json'] as string,
    evidenceRefsJson: row['evidence_refs_json'] as string,
    evidenceSource: row['evidence_source'] as string,
    evaluatorId: row['evaluator_id'] as string,
    evaluatedAt: row['evaluated_at'] as string,
  };
}

/** SQLite implementation. Tables are created by SCHEMA (IF NOT EXISTS). */
export class SqliteGateStore implements GateStore {
  constructor(private readonly db: DatabaseSync) {}

  saveDefinition(r: GateDefinitionDbRecord): void {
    this.db
      .prepare(
        `INSERT INTO gate_definitions (gate_id, definition_json, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(gate_id) DO UPDATE SET
           definition_json=excluded.definition_json,
           updated_at=excluded.updated_at`,
      )
      .run(r.gateId, r.definitionJson, r.createdAt, r.updatedAt);
  }

  getDefinition(gateId: string): GateDefinitionDbRecord | undefined {
    const row = this.db.prepare('SELECT * FROM gate_definitions WHERE gate_id = ?').get(gateId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : rowToDefinition(row);
  }

  listDefinitions(): GateDefinitionDbRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM gate_definitions ORDER BY gate_id ASC')
      .all() as Record<string, unknown>[];
    return rows.map(rowToDefinition);
  }

  recordEvaluation(r: GateEvaluationDbRecord): void {
    this.db
      .prepare(
        `INSERT INTO gate_evaluations
           (evaluation_id, gate_id, verdict, reason_code, missing_json,
            evidence_refs_json, evidence_source, evaluator_id, evaluated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.evaluationId,
        r.gateId,
        r.verdict,
        r.reasonCode,
        r.missingJson,
        r.evidenceRefsJson,
        r.evidenceSource,
        r.evaluatorId,
        r.evaluatedAt,
      );
  }

  getEvaluation(evaluationId: string): GateEvaluationDbRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM gate_evaluations WHERE evaluation_id = ?')
      .get(evaluationId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToEvaluation(row);
  }

  listEvaluations(gateId?: string): GateEvaluationDbRecord[] {
    const rows =
      gateId === undefined
        ? (this.db
            .prepare('SELECT * FROM gate_evaluations ORDER BY evaluated_at DESC, rowid DESC')
            .all() as Record<string, unknown>[])
        : (this.db
            .prepare(
              'SELECT * FROM gate_evaluations WHERE gate_id = ? ORDER BY evaluated_at DESC, rowid DESC',
            )
            .all(gateId) as Record<string, unknown>[]);
    return rows.map(rowToEvaluation);
  }
}

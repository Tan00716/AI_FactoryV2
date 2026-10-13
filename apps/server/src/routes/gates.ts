/**
 * Gate definition + evaluation HTTP surface — SPEC v2 §39.3 (Batch 32).
 *
 *   PUT  /api/gates/definitions/:gateId          upsert a gate definition
 *   GET  /api/gates/definitions                  list definitions
 *   GET  /api/gates/definitions/:gateId          one definition
 *   POST /api/gates/definitions/:gateId/evaluate run the deterministic
 *                                                evaluator over caller-
 *                                                supplied evidence
 *   GET  /api/gates/evaluations                  evaluation log (newest first)
 *   GET  /api/gates/evaluations/:evaluationId    one evaluation
 *
 * The verdict is ALWAYS computed by evaluateGateV2 in @ai-factory/core
 * with the SYSTEM evaluator identity — callers contribute evidence
 * (§39.3: "AI employees/managers, humans and services cannot write
 * verdicts directly; they contribute evidence and findings, the code
 * decides", INV-04). The request body carries evidence records, never
 * a verdict; a body-supplied verdict is rejected outright (400).
 * Every persisted evaluation records its evidence provenance
 * (evidence_source: 'caller-supplied') so a reader never mistakes
 * caller-contributed evidence for server-verified evidence.
 *
 * Mutations are audited (GATE_DEFINITION_SAVED, GATE_EVALUATED).
 * Definitions have no lifecycle and evaluations are terminal — there
 * is no in-flight state to demote on restart (unlike delegations).
 *
 * RBAC: reads are viewer, writes are operator (the auth gate default).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  evaluateGateV2,
  type EvidenceRecordV2,
  type GateDefinitionV2,
} from '@ai-factory/core';
import { newGateEvaluationId } from '@ai-factory/db';
import type { RouteContext } from './context';

const SEVERITIES = ['NONE', 'LOW', 'MEDIUM', 'HIGH'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseDefinition(gateId: string, b: Record<string, unknown>): GateDefinitionV2 | null {
  if (!isRecord(b)) return null;
  const mandatory = b['mandatory_ac_ids'];
  const maxFailed = b['max_failed'];
  const maxSkipped = b['max_skipped'];
  const indep = b['require_independent_review'];
  const sev = b['max_finding_severity'];
  const fresh = b['freshness_ms'];
  const env = b['required_environment'];
  if (
    !Array.isArray(mandatory) ||
    !mandatory.every((x) => typeof x === 'string') ||
    typeof maxFailed !== 'number' ||
    maxFailed < 0 ||
    typeof maxSkipped !== 'number' ||
    maxSkipped < 0 ||
    typeof indep !== 'boolean' ||
    typeof sev !== 'string' ||
    !(SEVERITIES as readonly string[]).includes(sev) ||
    (fresh !== null && typeof fresh !== 'number') ||
    (env !== undefined && typeof env !== 'string')
  ) {
    return null;
  }
  const def: GateDefinitionV2 = {
    gate_id: gateId,
    mandatory_ac_ids: mandatory as string[],
    max_failed: maxFailed,
    max_skipped: maxSkipped,
    require_independent_review: indep,
    max_finding_severity: sev as (typeof SEVERITIES)[number],
    freshness_ms: fresh as number | null,
  };
  if (typeof env === 'string') def.required_environment = env;
  return def;
}

/**
 * Minimal shape guard for caller-supplied v2 evidence: enough for
 * evaluateGateV2 to run without throwing on malformed input.
 * Malformed records are 400, never 500.
 */
function parseEvidence(v: unknown): EvidenceRecordV2[] | null {
  if (!Array.isArray(v)) return null;
  for (const e of v) {
    if (!isRecord(e)) return null;
    if (typeof e['evidence_id'] !== 'string' || e['evidence_id'].length === 0) return null;
    if (!Array.isArray(e['ac_refs'])) return null;
    if (!isRecord(e['result_summary'])) return null;
    if (typeof e['validity_state'] !== 'string') return null;
    if (typeof e['ended_at'] !== 'string') return null;
    if (typeof e['environment_fingerprint'] !== 'string') return null;
  }
  return v as EvidenceRecordV2[];
}

export async function handleGateRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const p = url.pathname;
  if (p !== '/api/gates' && !p.startsWith('/api/gates/')) return false;
  const { json, readBody, audit, fdb } = ctx;
  const method = req.method ?? 'GET';
  const store = fdb.gates;

  // PUT /api/gates/definitions/:gateId
  let m = p.match(/^\/api\/gates\/definitions\/([^/]+)$/);
  if (m) {
    const gateId = decodeURIComponent(m[1]);
    if (method === 'PUT') {
      const b = await readBody(req);
      const def = parseDefinition(gateId, b);
      if (!def) {
        return json(res, 400, {
          error:
            'body must be a §39.3 gate definition: mandatory_ac_ids (string[]), max_failed/max_skipped (non-negative numbers), require_independent_review (boolean), max_finding_severity (NONE|LOW|MEDIUM|HIGH), freshness_ms (number|null), required_environment? (string)',
        }), true;
      }
      const now = new Date().toISOString();
      const existing = store.getDefinition(gateId);
      store.saveDefinition({
        gateId,
        definitionJson: JSON.stringify(def),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      audit.record('gate-service', 'GATE_DEFINITION_SAVED', 'gate_definition', gateId, {
        updated: existing !== undefined,
      });
      return json(res, 200, { definition: def }), true;
    }
    if (method === 'GET') {
      const row = store.getDefinition(gateId);
      if (!row) return json(res, 404, { error: `unknown gate definition ${gateId}` }), true;
      return json(res, 200, {
        definition: JSON.parse(row.definitionJson) as GateDefinitionV2,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      }), true;
    }
    return json(res, 405, { error: 'method not allowed' }), true;
  }

  // GET /api/gates/definitions
  if (p === '/api/gates/definitions' && method === 'GET') {
    return json(res, 200, {
      definitions: store.listDefinitions().map((r) => ({
        ...(JSON.parse(r.definitionJson) as GateDefinitionV2),
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      })),
    }), true;
  }

  // POST /api/gates/definitions/:gateId/evaluate
  m = p.match(/^\/api\/gates\/definitions\/([^/]+)\/evaluate$/);
  if (m && method === 'POST') {
    const gateId = decodeURIComponent(m[1]);
    const row = store.getDefinition(gateId);
    if (!row) return json(res, 404, { error: `unknown gate definition ${gateId}` }), true;
    const b = await readBody(req);
    if (b['verdict'] !== undefined) {
      // INV-04: callers contribute evidence, never verdicts.
      return json(res, 400, {
        error: 'verdicts are computed by the deterministic evaluator; the request body must carry evidence[], not a verdict',
      }), true;
    }
    const evidence = parseEvidence(b['evidence']);
    if (!evidence) {
      return json(res, 400, {
        error:
          'evidence[] is required: each record needs evidence_id (string), ac_refs (array), result_summary (object), validity_state (string), ended_at (string), environment_fingerprint (string)',
      }), true;
    }
    const def = JSON.parse(row.definitionJson) as GateDefinitionV2;
    const evaluation = evaluateGateV2(
      def,
      evidence,
      new Map(),
      { kind: 'SYSTEM', id: 'gate-evaluator' },
      Date.now(),
    );
    const evaluationId = newGateEvaluationId();
    store.recordEvaluation({
      evaluationId,
      gateId,
      verdict: evaluation.verdict,
      reasonCode: evaluation.reason_code,
      missingJson: JSON.stringify(evaluation.missing),
      evidenceRefsJson: JSON.stringify(evaluation.evidence_refs),
      evidenceSource: 'caller-supplied',
      evaluatorId: evaluation.evaluator_id,
      evaluatedAt: evaluation.evaluated_at,
    });
    audit.record('gate-service', 'GATE_EVALUATED', 'gate_evaluation', evaluationId, {
      gate_id: gateId,
      verdict: evaluation.verdict,
      reason_code: evaluation.reason_code,
      evidence_source: 'caller-supplied',
      evidence_count: evidence.length,
    });
    return json(res, 200, {
      evaluation_id: evaluationId,
      evaluation,
      evidence_source: 'caller-supplied',
      note: 'verdict computed by the deterministic evaluator (§39.3, INV-04); the evidence above was caller-supplied, not server-verified',
    }), true;
  }

  // GET /api/gates/evaluations/:evaluationId
  m = p.match(/^\/api\/gates\/evaluations\/([^/]+)$/);
  if (m && method === 'GET') {
    const evaluationId = decodeURIComponent(m[1]);
    const row = store.getEvaluation(evaluationId);
    if (!row) return json(res, 404, { error: `unknown gate evaluation ${evaluationId}` }), true;
    return json(res, 200, {
      evaluation_id: row.evaluationId,
      gate_id: row.gateId,
      verdict: row.verdict,
      reason_code: row.reasonCode,
      missing: JSON.parse(row.missingJson) as string[],
      evidence_refs: JSON.parse(row.evidenceRefsJson) as string[],
      evidence_source: row.evidenceSource,
      evaluator_id: row.evaluatorId,
      evaluated_at: row.evaluatedAt,
    }), true;
  }

  // GET /api/gates/evaluations[?gate_id=...]
  if (p === '/api/gates/evaluations' && method === 'GET') {
    const gateId = url.searchParams.get('gate_id') ?? undefined;
    return json(res, 200, {
      evaluations: store.listEvaluations(gateId).map((r) => ({
        evaluation_id: r.evaluationId,
        gate_id: r.gateId,
        verdict: r.verdict,
        reason_code: r.reasonCode,
        missing: JSON.parse(r.missingJson) as string[],
        evidence_refs: JSON.parse(r.evidenceRefsJson) as string[],
        evidence_source: r.evidenceSource,
        evaluator_id: r.evaluatorId,
        evaluated_at: r.evaluatedAt,
      })),
    }), true;
  }

  return false;
}

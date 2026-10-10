/**
 * AI disagreement independent adjudication — spec §96 (AI Disagreement)
 * and §97 (Multi-Agent Consensus).
 *
 * §96 flow when two agents disagree (e.g. Coder says PASS, Reviewer says
 * FAIL):
 *
 *   Collect evidence → Independent evaluator → Resolve
 *        (unresolved → ESCALATED to a human)
 *
 * §97 guard: independent verification is only wired up where it is useful
 * (security / architecture / high-risk deployment / complex bug). Routine
 * tasks skip it with a recorded reason so no tokens are wasted on
 * meaningless "5 agents repeating the same answer" consensus.
 *
 * Dispute state machine: OPEN → EVIDENCE_COLLECTED → ADJUDICATED | ESCALATED.
 * Every transition is pushed into the dispute history and emitted through
 * an injected audit hook.
 *
 * Zero external dependencies; all time flows through an injected clock
 * (`{ now: () => number }`, ms epoch), same convention as types.ts.
 */

import { randomUUID } from 'crypto';
import type { Clock } from './types';

/* ------------------------------------------------------------------ */
/* Verdicts and dispute shape                                          */
/* ------------------------------------------------------------------ */

/** One agent's verdict in a disagreement (§96: PASS / FAIL / WARN). */
export type DisputeVerdict = 'PASS' | 'FAIL' | 'WARN';

export interface AgentDisputeVerdict {
  /** Agent/employee id that issued the verdict. */
  agent: string;
  verdict: DisputeVerdict;
  /** Evidence ids backing this verdict (test runs, reviews, logs, …). */
  evidenceIds: string[];
  /** One-line human-readable justification. */
  reason: string;
}

/** Dispute lifecycle (§96): OPEN → EVIDENCE_COLLECTED → ADJUDICATED | ESCALATED. */
export type DisputeStatus =
  | 'OPEN'
  | 'EVIDENCE_COLLECTED'
  | 'ADJUDICATED'
  | 'ESCALATED';

export interface DisputeHistoryEntry {
  ts: number;
  from: DisputeStatus | 'NONE';
  to: DisputeStatus;
  note: string;
}

export interface Dispute {
  disputeId: string;
  verdictA: AgentDisputeVerdict;
  verdictB: AgentDisputeVerdict;
  status: DisputeStatus;
  openedAt: number;
  /** True only when both sides cite at least one evidence item. */
  evidenceReady: boolean;
  history: DisputeHistoryEntry[];
}

export class DisputeTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DisputeTransitionError';
  }
}

/* ------------------------------------------------------------------ */
/* Audit hook                                                         */
/* ------------------------------------------------------------------ */

export type DisputeAuditEventType =
  | 'dispute_opened'
  | 'evidence_collected'
  | 'adjudicated'
  | 'escalated';

export interface DisputeAuditEvent {
  type: DisputeAuditEventType;
  disputeId: string;
  ts: number;
  details: Record<string, unknown>;
}

/** Injected audit hook — called on every dispute lifecycle transition. */
export type DisputeAuditHook = (event: DisputeAuditEvent) => void;

/* ------------------------------------------------------------------ */
/* 1. Disagreement detection                                          */
/* ------------------------------------------------------------------ */

/**
 * Do two verdicts actually conflict?
 *
 * PASS vs WARN is *partial agreement* (both approve, one with caveats) and
 * does not count as a disagreement. Everything else that differs does:
 * PASS vs FAIL, WARN vs FAIL.
 */
export function verdictsConflict(
  a: DisputeVerdict,
  b: DisputeVerdict,
): boolean {
  if (a === b) return false;
  const partialAgreement =
    (a === 'PASS' && b === 'WARN') || (a === 'WARN' && b === 'PASS');
  return !partialAgreement;
}

/**
 * Detect a disagreement between two agent verdicts (§96).
 *
 * A disagreement is *established* when the conclusions conflict (§96
 * example: Coder PASS vs Reviewer FAIL). The dispute is opened even when
 * one side cites no evidence — the evidence gap is recorded on the dispute
 * (`evidenceReady === false`) and the evidence-less side is marked weak
 * first during evidence collection (§96 "Collect evidence").
 *
 * Returns null when there is no hard disagreement (same verdict, or
 * PASS vs WARN partial agreement).
 */
export function detectDisagreement(
  verdictA: AgentDisputeVerdict,
  verdictB: AgentDisputeVerdict,
  clock: Clock = { now: () => Date.now() },
): Dispute | null {
  if (!verdictsConflict(verdictA.verdict, verdictB.verdict)) return null;
  const now = clock.now();
  return {
    disputeId: `dsp_${randomUUID()}`,
    verdictA,
    verdictB,
    status: 'OPEN',
    openedAt: now,
    evidenceReady:
      verdictA.evidenceIds.length > 0 && verdictB.evidenceIds.length > 0,
    history: [
      {
        ts: now,
        from: 'NONE',
        to: 'OPEN',
        note: `${verdictA.agent} ${verdictA.verdict} vs ${verdictB.agent} ${verdictB.verdict}`,
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Evidence collection                                                */
/* ------------------------------------------------------------------ */

export type EvidenceKind =
  | 'test-report'
  | 'review-note'
  | 'log'
  | 'metric'
  | 'screenshot'
  | 'other';

export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  /** 0..1 fraction of the disputed change covered by tests, if known. */
  testCoverage?: number;
  summary?: string;
}

/** Lookup of evidence details by id; unknown ids degrade to kind 'other'. */
export type EvidenceIndex = Record<string, EvidenceItem>;

export interface SideEvidence {
  side: 'A' | 'B';
  agent: string;
  items: EvidenceItem[];
  /**
   * Weakness flags, e.g. 'no-evidence-cited', 'fewer-evidence-items',
   * 'low-test-coverage'.
   */
  weaknesses: string[];
}

export interface EvidenceCollection {
  sideA: SideEvidence;
  sideB: SideEvidence;
  /**
   * The side marked weak first — the one with no evidence, or with fewer
   * evidence items when both have some (§96: the evidence-less side is
   * recorded as the weak side before adjudication). Null when even.
   */
  weakSide: 'A' | 'B' | null;
  collectedAt: number;
}

function resolveItems(
  ids: string[],
  index: EvidenceIndex | undefined,
): EvidenceItem[] {
  return ids.map((id) => index?.[id] ?? { id, kind: 'other' as const });
}

/**
 * Collect both sides' evidence and compare the lists (§96 "Collect
 * evidence"). The side with no evidence — or fewer evidence items — is
 * flagged weak first so the independent evaluator starts from an honest
 * asymmetry instead of a coin flip.
 */
export function collectEvidence(
  dispute: Dispute,
  index?: EvidenceIndex,
  clock: Clock = { now: () => Date.now() },
): EvidenceCollection {
  const build = (
    side: 'A' | 'B',
    v: AgentDisputeVerdict,
  ): SideEvidence => {
    const items = resolveItems(v.evidenceIds, index);
    const weaknesses: string[] = [];
    if (items.length === 0) weaknesses.push('no-evidence-cited');
    const coverages = items
      .map((i) => i.testCoverage)
      .filter((c): c is number => typeof c === 'number');
    if (coverages.length > 0) {
      const mean = coverages.reduce((s, c) => s + c, 0) / coverages.length;
      if (mean < 0.5) weaknesses.push('low-test-coverage');
    }
    return { side, agent: v.agent, items, weaknesses };
  };

  const sideA = build('A', dispute.verdictA);
  const sideB = build('B', dispute.verdictB);

  let weakSide: 'A' | 'B' | null = null;
  if (sideA.items.length === 0 && sideB.items.length > 0) weakSide = 'A';
  else if (sideB.items.length === 0 && sideA.items.length > 0) weakSide = 'B';
  else if (
    sideA.items.length > 0 &&
    sideB.items.length > 0 &&
    sideA.items.length !== sideB.items.length
  ) {
    const weaker = sideA.items.length < sideB.items.length ? sideA : sideB;
    weakSide = weaker.side;
    weaker.weaknesses.push('fewer-evidence-items');
  }

  return { sideA, sideB, weakSide, collectedAt: clock.now() };
}

/* ------------------------------------------------------------------ */
/* Independent evaluator                                              */
/* ------------------------------------------------------------------ */

export interface AdjudicationRuling {
  /** Which side's verdict stands. */
  winner: 'A' | 'B';
  rationale: string;
  /** 0..1 — how decisive the evidence was. */
  confidence: number;
}

export interface EvaluatorInput {
  dispute: Dispute;
  evidence: EvidenceCollection;
}

/**
 * Independent evaluator seam (§96 "Independent evaluator"). Implementations
 * may call an LLM judge, a rules engine, or anything else. Returning null
 * means "cannot decide" — the dispute is then escalated to a human.
 */
export type IndependentEvaluator = (
  input: EvaluatorInput,
) => AdjudicationRuling | null;

function sideScore(side: SideEvidence): number {
  if (side.items.length === 0) return 0;
  // Evidence completeness: 3+ cited items count as complete.
  const completeness = Math.min(1, side.items.length / 3);
  const coverages = side.items.map((i) => i.testCoverage ?? 0);
  const meanCoverage =
    coverages.reduce((s, c) => s + c, 0) / Math.max(1, coverages.length);
  return 0.5 * completeness + 0.5 * meanCoverage;
}

/**
 * Default heuristic evaluator: evidence completeness + test coverage.
 * The side with the stronger evidence record wins; confidence is the score
 * margin. Abstains (null) when neither side has evidence or the margin is
 * a near tie — abstention escalates to a human rather than flipping a coin.
 */
export function defaultHeuristicEvaluator(
  input: EvaluatorInput,
): AdjudicationRuling | null {
  const { sideA, sideB } = input.evidence;
  const scoreA = sideScore(sideA);
  const scoreB = sideScore(sideB);
  const margin = Math.abs(scoreA - scoreB);
  if ((scoreA === 0 && scoreB === 0) || margin < 0.05) return null;
  const winner: 'A' | 'B' = scoreA > scoreB ? 'A' : 'B';
  const winningSide = winner === 'A' ? sideA : sideB;
  return {
    winner,
    rationale:
      `${winningSide.agent} prevails on evidence: ` +
      `${winningSide.items.length} cited item(s), ` +
      `evidence completeness and test coverage outweigh ` +
      `${winner === 'A' ? sideB.agent : sideA.agent}'s case ` +
      `(score ${Math.max(scoreA, scoreB).toFixed(2)} vs ` +
      `${Math.min(scoreA, scoreB).toFixed(2)}).`,
    confidence: margin,
  };
}

/* ------------------------------------------------------------------ */
/* Escalation                                                         */
/* ------------------------------------------------------------------ */

export interface EscalationRecord {
  escalationId: string;
  disputeId: string;
  /** Why the independent evaluator could not resolve the dispute. */
  reasons: string[];
  /** Concrete items awaiting a human decision. */
  pendingHumanActions: string[];
  evidenceBySide: {
    side: 'A' | 'B';
    agent: string;
    verdict: DisputeVerdict;
    evidenceIds: string[];
    weaknesses: string[];
  }[];
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* 2. Independent adjudication flow                                   */
/* ------------------------------------------------------------------ */

export type AdjudicationOutcome =
  | {
      status: 'ADJUDICATED';
      dispute: Dispute;
      ruling: AdjudicationRuling;
    }
  | {
      status: 'ESCALATED';
      dispute: Dispute;
      escalation: EscalationRecord;
    };

export interface AdjudicateOptions {
  /** Injected independent evaluator; defaults to the evidence heuristic. */
  evaluator?: IndependentEvaluator;
  /** Evidence details by id for the default evaluator. */
  evidenceIndex?: EvidenceIndex;
  /**
   * Minimum ruling confidence to accept (0..1). Below it the dispute is
   * escalated instead of resolved. Defaults to 0.6.
   */
  confidenceThreshold?: number;
  now?: () => number;
  audit?: DisputeAuditHook;
}

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

function transition(
  dispute: Dispute,
  to: DisputeStatus,
  note: string,
  now: number,
): void {
  dispute.history.push({ ts: now, from: dispute.status, to, note });
  dispute.status = to;
}

/**
 * Run the §96 independent adjudication flow:
 *
 *   OPEN → EVIDENCE_COLLECTED → ADJUDICATED | ESCALATED
 *
 * 1. Collect both sides' evidence (weak side flagged first).
 * 2. Ask the independent evaluator for a ruling.
 * 3. Accept the ruling only when confidence >= threshold; otherwise —
 *    or when the evaluator abstains — mark ESCALATED and produce an
 *    escalation record with both sides' evidence and human TODO items.
 *
 * Every transition is recorded in the dispute history and emitted via the
 * audit hook. Throws DisputeTransitionError if the dispute is not OPEN.
 */
export function adjudicate(
  dispute: Dispute,
  options: AdjudicateOptions = {},
): AdjudicationOutcome {
  const {
    evaluator = defaultHeuristicEvaluator,
    evidenceIndex,
    confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD,
    audit,
  } = options;
  const now = (options.now ?? Date.now)();

  if (dispute.status !== 'OPEN') {
    throw new DisputeTransitionError(
      `Cannot adjudicate dispute ${dispute.disputeId}: status is ${dispute.status}, expected OPEN.`,
    );
  }

  const evidence = collectEvidence(dispute, evidenceIndex, { now: () => now });
  transition(
    dispute,
    'EVIDENCE_COLLECTED',
    `evidence collected (weak side: ${evidence.weakSide ?? 'none'})`,
    now,
  );
  audit?.({
    type: 'evidence_collected',
    disputeId: dispute.disputeId,
    ts: now,
    details: {
      weakSide: evidence.weakSide,
      sideA: {
        agent: evidence.sideA.agent,
        evidenceCount: evidence.sideA.items.length,
        weaknesses: evidence.sideA.weaknesses,
      },
      sideB: {
        agent: evidence.sideB.agent,
        evidenceCount: evidence.sideB.items.length,
        weaknesses: evidence.sideB.weaknesses,
      },
    },
  });

  const ruling = evaluator({ dispute, evidence });

  const reasons: string[] = [];
  if (evidence.sideA.items.length === 0 && evidence.sideB.items.length === 0) {
    reasons.push('neither side cited evidence — nothing for the evaluator to weigh');
  }
  if (ruling === null) {
    reasons.push(
      'independent evaluator abstained: the evidence does not discriminate a winner',
    );
  } else if (ruling.confidence < confidenceThreshold) {
    reasons.push(
      `evaluator confidence ${ruling.confidence.toFixed(2)} below threshold ${confidenceThreshold.toFixed(2)}`,
    );
  }

  if (reasons.length === 0 && ruling !== null) {
    transition(dispute, 'ADJUDICATED', `winner: side ${ruling.winner}`, now);
    audit?.({
      type: 'adjudicated',
      disputeId: dispute.disputeId,
      ts: now,
      details: {
        winner: ruling.winner,
        winnerAgent:
          ruling.winner === 'A'
            ? dispute.verdictA.agent
            : dispute.verdictB.agent,
        confidence: ruling.confidence,
        rationale: ruling.rationale,
      },
    });
    return { status: 'ADJUDICATED', dispute, ruling };
  }

  const escalation: EscalationRecord = {
    escalationId: `esc_${randomUUID()}`,
    disputeId: dispute.disputeId,
    reasons,
    pendingHumanActions: [
      `Human review required: ${dispute.verdictA.agent} (${dispute.verdictA.verdict}) vs ${dispute.verdictB.agent} (${dispute.verdictB.verdict}).`,
      'Inspect the cited evidence from both sides listed below.',
      'Re-run the disputed checks and attach fresh evidence.',
      'Cast the deciding verdict and record the rationale.',
    ],
    evidenceBySide: [evidence.sideA, evidence.sideB].map((s) => ({
      side: s.side,
      agent: s.agent,
      verdict: s.side === 'A' ? dispute.verdictA.verdict : dispute.verdictB.verdict,
      evidenceIds: s.items.map((i) => i.id),
      weaknesses: s.weaknesses,
    })),
    createdAt: now,
  };
  transition(dispute, 'ESCALATED', `escalated: ${reasons.join('; ')}`, now);
  audit?.({
    type: 'escalated',
    disputeId: dispute.disputeId,
    ts: now,
    details: {
      escalationId: escalation.escalationId,
      reasons,
      pendingHumanActions: escalation.pendingHumanActions,
    },
  });
  return { status: 'ESCALATED', dispute, escalation };
}

/* ------------------------------------------------------------------ */
/* 3. §97 — independent verification only where useful                */
/* ------------------------------------------------------------------ */

/** The four §97 scenarios where independent verification is worthwhile. */
export type IndependentVerificationScenario =
  | 'security'
  | 'architecture'
  | 'high-risk-deployment'
  | 'complex-bug';

const VERIFICATION_SCENARIOS: IndependentVerificationScenario[] = [
  'security',
  'architecture',
  'high-risk-deployment',
  'complex-bug',
];

export interface TaskDescriptor {
  taskId: string;
  /** Free-form task category, e.g. 'security', 'docs', 'refactor'. */
  category: string;
}

export interface VerificationDecision {
  use: boolean;
  reason: string;
  scenario?: IndependentVerificationScenario;
}

/**
 * Decide whether a task warrants independent verification (§97).
 *
 * Only the four high-stakes scenarios return true. Ordinary tasks return
 * false with a recorded skip reason — running a second agent (or five)
 * there would burn tokens for a meaningless rubber-stamp consensus.
 */
export function shouldUseIndependentVerification(
  task: TaskDescriptor,
): VerificationDecision {
  const normalized = task.category
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-') as IndependentVerificationScenario;
  if ((VERIFICATION_SCENARIOS as string[]).includes(normalized)) {
    return {
      use: true,
      scenario: normalized,
      reason: `independent verification enabled: high-stakes scenario '${normalized}' (§97)`,
    };
  }
  return {
    use: false,
    reason:
      `skipped: '${task.category}' is a routine task — independent ` +
      `verification would spend tokens for no value (§97)`,
  };
}

/* ------------------------------------------------------------------ */
/* Coordinator — stateful wrapper over the pure functions              */
/* ------------------------------------------------------------------ */

export interface DisputeCoordinatorOptions {
  now?: () => number;
  evaluator?: IndependentEvaluator;
  evidenceIndex?: EvidenceIndex;
  confidenceThreshold?: number;
  audit?: DisputeAuditHook;
}

/**
 * Stateful dispute coordinator: opens disputes, runs adjudication, and
 * keeps the dispute/escalation registries. The pure functions above do
 * the work; this class wires clock, evaluator, threshold, and audit
 * together for a long-lived process.
 */
export class DisputeCoordinator {
  private disputes = new Map<string, Dispute>();
  private escalationRecords: EscalationRecord[] = [];

  constructor(private readonly options: DisputeCoordinatorOptions = {}) {}

  private clock(): Clock {
    return { now: this.options.now ?? Date.now };
  }

  /** Detect and register a disagreement; null when there is none. */
  open(
    verdictA: AgentDisputeVerdict,
    verdictB: AgentDisputeVerdict,
  ): Dispute | null {
    const dispute = detectDisagreement(verdictA, verdictB, this.clock());
    if (!dispute) return null;
    this.disputes.set(dispute.disputeId, dispute);
    this.options.audit?.({
      type: 'dispute_opened',
      disputeId: dispute.disputeId,
      ts: dispute.openedAt,
      details: {
        agentA: dispute.verdictA.agent,
        verdictA: dispute.verdictA.verdict,
        agentB: dispute.verdictB.agent,
        verdictB: dispute.verdictB.verdict,
        evidenceReady: dispute.evidenceReady,
      },
    });
    return dispute;
  }

  /** Run the full adjudication flow for a registered dispute. */
  adjudicate(disputeId: string): AdjudicationOutcome {
    const dispute = this.disputes.get(disputeId);
    if (!dispute) {
      throw new DisputeTransitionError(`Unknown dispute: ${disputeId}`);
    }
    const outcome = adjudicate(dispute, {
      evaluator: this.options.evaluator,
      evidenceIndex: this.options.evidenceIndex,
      confidenceThreshold: this.options.confidenceThreshold,
      now: this.options.now,
      audit: this.options.audit,
    });
    if (outcome.status === 'ESCALATED') {
      this.escalationRecords.push(outcome.escalation);
    }
    return outcome;
  }

  get(disputeId: string): Dispute | undefined {
    return this.disputes.get(disputeId);
  }

  list(status?: DisputeStatus): Dispute[] {
    const all = [...this.disputes.values()];
    return status ? all.filter((d) => d.status === status) : all;
  }

  escalations(): EscalationRecord[] {
    return [...this.escalationRecords];
  }
}

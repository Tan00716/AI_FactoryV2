/**
 * UAT — SPEC v2 §38.4.
 *
 * UAT is acceptance against business scenarios in an acceptance environment,
 * not "deployed to a server named UAT". A project may configure automatic
 * UAT, human UAT, or both. Acceptance criteria that need real human business
 * judgment are never faked as AI-proven: they stay WAITING.
 */
import { randomUUID } from 'node:crypto';

export type UatMode = 'auto' | 'human' | 'both';

/** How one acceptance criterion was evaluated. */
export type AcEvaluationMethod = 'auto' | 'human' | 'telemetry';

export interface UatAcResult {
  acId: string;
  method: AcEvaluationMethod;
  /** 'human' evaluation by anyone other than a verified human stays WAITING. */
  result: 'PASS' | 'FAIL' | 'WAITING';
  evaluatedBy?: string;
  evidenceRef?: string;
  at: string;
}

export interface UatSession {
  id: string;
  taskId: string;
  candidateDigest: string;
  mode: UatMode;
  /** ACs that require genuine human business judgment (never auto-passed). */
  humanJudgmentAcIds: string[];
  acResults: UatAcResult[];
  /** UAT-vs-PROD config/data drift check outcome. */
  driftCheck?: { checked: boolean; driftFound: boolean; details?: string };
  /** Test data was redacted before UAT. */
  testDataRedacted: boolean;
  status: 'RUNNING' | 'PASSED' | 'FAILED' | 'WAITING_HUMAN';
  createdAt: string;
  updatedAt: string;
}

export interface StartUatInput {
  taskId: string;
  candidateDigest: string;
  mode: UatMode;
  /** AC ids that need real human business judgment. */
  humanJudgmentAcIds?: string[];
  testDataRedacted?: boolean;
  now?: () => number;
}

export class UatManager {
  private readonly sessions = new Map<string, UatSession>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  start(input: StartUatInput): UatSession {
    if (!input.taskId) throw new Error('taskId is required');
    if (!input.candidateDigest) throw new Error('candidateDigest is required');
    const at = new Date(this.now()).toISOString();
    const session: UatSession = {
      id: randomUUID(),
      taskId: input.taskId,
      candidateDigest: input.candidateDigest,
      mode: input.mode,
      humanJudgmentAcIds: [...(input.humanJudgmentAcIds ?? [])],
      acResults: [],
      testDataRedacted: input.testDataRedacted ?? false,
      status: 'RUNNING',
      createdAt: at,
      updatedAt: at,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): UatSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`UAT session ${id} not found`);
    return s;
  }

  /**
   * Record one AC evaluation. Human-judgment ACs evaluated by anything other
   * than a verified human are forced to WAITING — an AI may not fake them.
   */
  recordAc(
    sessionId: string,
    input: { acId: string; method: AcEvaluationMethod; result: 'PASS' | 'FAIL'; evaluatedBy?: string; evidenceRef?: string },
  ): UatAcResult {
    const s = this.get(sessionId);
    const needsHuman = s.humanJudgmentAcIds.includes(input.acId);
    const isVerifiedHuman = input.method === 'human' && (input.evaluatedBy ?? '').startsWith('human:');
    const result: UatAcResult = {
      acId: input.acId,
      method: input.method,
      result: needsHuman && !isVerifiedHuman ? 'WAITING' : input.result,
      evaluatedBy: input.evaluatedBy,
      evidenceRef: input.evidenceRef,
      at: new Date(this.now()).toISOString(),
    };
    s.acResults.push(result);
    s.updatedAt = result.at;
    this.recompute(s);
    return result;
  }

  /** Record the UAT-vs-PROD config/data drift check (§38.4). */
  recordDriftCheck(sessionId: string, driftFound: boolean, details?: string): void {
    const s = this.get(sessionId);
    s.driftCheck = { checked: true, driftFound, details };
    s.updatedAt = new Date(this.now()).toISOString();
    this.recompute(s);
  }

  private recompute(s: UatSession): void {
    if (s.acResults.some((r) => r.result === 'FAIL')) {
      s.status = 'FAILED';
      return;
    }
    if (s.driftCheck?.driftFound) {
      s.status = 'FAILED';
      return;
    }
    const waiting = s.acResults.filter((r) => r.result === 'WAITING');
    const uncoveredHuman = s.humanJudgmentAcIds.filter(
      (id) => !s.acResults.some((r) => r.acId === id && r.result === 'PASS'),
    );
    s.status = waiting.length > 0 || uncoveredHuman.length > 0 ? 'WAITING_HUMAN' : s.acResults.length > 0 ? 'PASSED' : 'RUNNING';
  }
}

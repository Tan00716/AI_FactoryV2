/**
 * §22 Agent Communication — structured message primitives.
 *
 * Agents never rely on free-form chat. Every exchange is one of the
 * eight typed payload primitives carried inside a uniform envelope.
 */

/** Discriminant for every message payload. No free-text/chat kind exists. */
export type MessageKind =
  | 'assignment'
  | 'artifact_ref'
  | 'decision'
  | 'report'
  | 'evidence'
  | 'approval_ref'
  | 'handoff'
  | 'event';

export const MESSAGE_KINDS: readonly MessageKind[] = [
  'assignment',
  'artifact_ref',
  'decision',
  'report',
  'evidence',
  'approval_ref',
  'handoff',
  'event',
];

/** Task 指派: assign a unit of work to an agent. */
export interface AssignmentPayload {
  kind: 'assignment';
  /** Short human-readable title of the task. */
  title: string;
  /** What needs to be done. */
  description: string;
  requirements?: string[];
  /** Epoch-ms deadline, optional. */
  deadline?: number;
}

/** Artifact 产物引用: point at a first-class artifact (PR, build, report...). */
export interface ArtifactRefPayload {
  kind: 'artifact_ref';
  artifactId: string;
  artifactType: string;
  uri?: string;
  summary: string;
}

/** Decision 决策: record a decision made by an agent. */
export interface DecisionPayload {
  kind: 'decision';
  subject: string;
  outcome: string;
  rationale?: string;
}

/** Report 报告: structured result of an agent's work (e.g. QA report). */
export interface ReportPayload {
  kind: 'report';
  title: string;
  verdict: 'pass' | 'fail' | 'blocked' | 'needs_review';
  summary: string;
  details?: Record<string, unknown>;
}

/** Evidence 证据引用: cite evidence backing a claim or report. */
export interface EvidencePayload {
  kind: 'evidence';
  uri: string;
  description: string;
  artifactId?: string;
}

/** ApprovalRef 审批引用: reference an approval outcome. */
export interface ApprovalRefPayload {
  kind: 'approval_ref';
  approvalId: string;
  decision: 'approved' | 'rejected';
  note?: string;
}

/** Handoff 交接: hand work from one agent/role to the next. */
export interface HandoffPayload {
  kind: 'handoff';
  fromRole: string;
  toRole: string;
  summary: string;
  context?: Record<string, unknown>;
}

/** Event 事件: a notable occurrence (status change, failure, milestone). */
export interface EventPayload {
  kind: 'event';
  name: string;
  severity?: 'info' | 'warn' | 'error';
  details?: Record<string, unknown>;
}

/** The eight structured communication primitives (§22). */
export type CommsPayload =
  | AssignmentPayload
  | ArtifactRefPayload
  | DecisionPayload
  | ReportPayload
  | EvidencePayload
  | ApprovalRefPayload
  | HandoffPayload
  | EventPayload;

/**
 * Uniform envelope for every message.
 * correlationId links messages that belong to one handoff chain
 * (e.g. assignment → handoff → report).
 */
export interface CommsMessage {
  id: string;
  taskId: string;
  from: string;
  to: string;
  timestamp: number;
  correlationId: string;
  payload: CommsPayload;
}

/** Full communication trace of one task, for run/trace auditing. */
export interface TaskTrace {
  taskId: string;
  exportedAt: number;
  messageCount: number;
  /** Participants seen in this trace (senders + receivers). */
  participants: string[];
  /** Count of messages per payload kind. */
  kindCounts: Record<MessageKind, number>;
  /** Messages in chronological order. */
  messages: CommsMessage[];
}

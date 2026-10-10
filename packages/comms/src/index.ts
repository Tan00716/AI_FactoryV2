/**
 * @ai-factory/comms — §22 Agent Communication.
 *
 * Agents do not rely on free-form chat. All communication flows as
 * structured objects: one of eight typed primitives inside a uniform
 * envelope, delivered through task-isolated channels.
 */

export {
  MESSAGE_KINDS,
} from './types.ts';
export type {
  MessageKind,
  AssignmentPayload,
  ArtifactRefPayload,
  DecisionPayload,
  ReportPayload,
  EvidencePayload,
  ApprovalRefPayload,
  HandoffPayload,
  EventPayload,
  CommsPayload,
  CommsMessage,
  TaskTrace,
} from './types.ts';

export {
  Channel,
  CommsError,
  DEFAULT_MAX_PAYLOAD_BYTES,
} from './channel.ts';
export type {
  Clock,
  ChannelOptions,
  PostInput,
  CommsErrorCode,
} from './channel.ts';

export {
  REPORT_SCHEMA_VERSION,
  ReportError,
  ReportLog,
} from './report.ts';
export type {
  ManagementReport,
  ManagementReportStatus,
  NewManagementReport,
  RefExistenceChecker,
  ReportErrorCode,
  ReportRisk,
  ReportSubmitContext,
  RiskSeverity,
  SystemReportFields,
} from './report.ts';

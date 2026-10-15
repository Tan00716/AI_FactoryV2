/**
 * F58 follow-up — DATA_EXPORT → approvals authorization ticket (record-mode).
 *
 * G11/INV-30 honest boundary (F58): DATA_EXPORT was an evidence-level audit
 * record only, not an approvals-package authorization ticket. Before a prompt
 * is sent to a NON-LOCAL provider, this module creates a PENDING approval
 * ticket in @ai-factory/approvals and links it bidirectionally with the
 * DATA_EXPORT evidence event:
 *   - evidence → ticket: evidence.payload.approval_id
 *   - ticket → evidence: the ticket's APPROVAL_REQUESTED audit details
 *     carry evidence_id (RequestApprovalInput.evidence_id — NOT a §23.3
 *     field, so the Approval object itself stays §23.3-verbatim)
 * plus an explicit DATA_EXPORT_AUTHORIZATION_RECORDED audit event.
 *
 * RECORD-MODE ONLY (Batch 80): the ticket is recorded (PENDING) and
 * audited; the adapter is NOT blocked and no UX changes. Blocking-mode
 * gating is a product decision reserved for Tan (F58).
 */
import { randomUUID } from 'node:crypto';
import type { Approval, ApprovalManager } from '@ai-factory/approvals';
import type { DataClass } from '@ai-factory/model-router';
import type { EvidenceInput } from './types';

export interface ExportAuthorizationInput {
  /** The DATA_EXPORT evidence event built by dataExportEventFor (non-null). */
  exportEvent: EvidenceInput;
  /** Resolved provider ('unknown' fail-safe; never 'local' — local is exempt). */
  provider: string;
  model: string;
  privacy: DataClass | 'unknown';
  agentId: string;
  taskId: string;
  approvals: ApprovalManager;
  audit: (action: string, detail: string) => void;
}

export interface ExportAuthorization {
  /** Id anchoring the DATA_EXPORT evidence event (also in its payload). */
  evidenceId: string;
  /** The recorded approvals-package ticket (PENDING). */
  approval: Approval;
}

/**
 * Record the pre-send export authorization ticket for a non-local model
 * call and link it bidirectionally with the DATA_EXPORT evidence event.
 * Never blocks: record-mode only.
 */
export function attachExportAuthorization(
  input: ExportAuthorizationInput,
): ExportAuthorization {
  const evidenceId = randomUUID();
  const approval = input.approvals.request({
    action: 'data_export',
    requester: `agent:${input.agentId}`,
    task_id: input.taskId,
    risk_level: 'MEDIUM',
    // Ticket → evidence half of the bidirectional link (carried in the
    // APPROVAL_REQUESTED audit details; the Approval object stays §23.3).
    evidence_id: evidenceId,
  });
  // Evidence → ticket half.
  input.exportEvent.payload['evidence_id'] = evidenceId;
  input.exportEvent.payload['approval_id'] = approval.approval_id;
  input.exportEvent.payload['authorization_mode'] = 'record';
  input.audit(
    'DATA_EXPORT_AUTHORIZATION_RECORDED',
    `record-mode: approval ${approval.approval_id} <-> data_export evidence ${evidenceId} ` +
      `(provider=${input.provider} model=${input.model} privacy=${input.privacy}); ` +
      `ticket is PENDING and the call is NOT blocked — blocking-mode gating ` +
      `is reserved for Tan's product decision (F58)`,
  );
  return { evidenceId, approval };
}

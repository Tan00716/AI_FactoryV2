/**
 * Diagnostics bundle types (V3-#10).
 *
 * Privacy shape, fixed by design:
 * - No secret or token VALUE ever enters a bundle: free text is redacted
 *   (see redact.ts), audit `details` are dropped, task titles and file
 *   contents are never collected — only counts.
 * - Config is a snapshot of names and modes, not values: auth mode,
 *   egress summary, counts. Environment variable names and values are
 *   never included (even masked key names hint at what exists).
 */
export interface DiagnosticsMeta {
  bundleVersion: 1;
  bundleId: string;
  exportedAt: string;
  appVersion: string;
  serverVersion: string;
  platform: string;
  arch: string;
  nodeVersion: string;
}

export interface PrivacyNotice {
  includes: string[];
  excludes: string[];
  noticeZh: string;
  noticeEn: string;
}

/** One audit record, stripped to fields that cannot carry payloads. */
export interface AuditSummaryRecord {
  id: string;
  ts: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  result: string | null;
}

export interface AuditSummary {
  totalRecords: number;
  fromTs: string | null;
  toTs: string | null;
  byAction: Array<{ action: string; count: number }>;
  /** Newest first, capped by the caller. `details` are never included. */
  recent: AuditSummaryRecord[];
}

export interface TaskEvidence {
  projectCount: number;
  taskCount: number;
  byStatus: Array<{ status: string; count: number }>;
}

export interface EgressSummary {
  enabled: boolean;
  defaultPolicy: string;
  ruleCount: number;
}

export interface ConfigSnapshot {
  /** 'open' | 'token' | 'unknown' — never a token value. */
  authMode: string;
  egress: EgressSummary | null;
  /** Why egress is null when it is (e.g. provider unwired). */
  egressUnavailableReason: string | null;
}

export interface PerfBaselineSummary {
  available: boolean;
  reason: string | null;
  /** Per-task milliseconds, summary only — never the raw baseline file. */
  tasks: Array<{ name: string; ms: number | null }>;
  taskCount: number;
}

export interface DiagnosticsBundle {
  meta: DiagnosticsMeta;
  privacy: PrivacyNotice;
  auditSummary: AuditSummary;
  taskEvidence: TaskEvidence;
  configSnapshot: ConfigSnapshot;
  /** Heuristic error excerpt, sourced from audit records (see bundle.ts). */
  errorExcerpt: AuditSummaryRecord[];
  perfBaseline: PerfBaselineSummary;
  /** HTML rendering of the same sections (portable report). */
  reportHtml: string;
}

/** Inputs the server route gathers; the builder only assembles. */
export interface BundleInputs {
  meta: Omit<DiagnosticsMeta, 'bundleVersion'>;
  auditRecords: AuditSummaryRecord[];
  auditTotal: number;
  taskEvidence: TaskEvidence;
  configSnapshot: ConfigSnapshot;
  perfBaseline: PerfBaselineSummary;
  recentLimit: number;
  errorLimit: number;
}

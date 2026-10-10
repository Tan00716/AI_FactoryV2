/**
 * Takeover types — SPEC v2 §31.
 *
 * Request Takeover → Quiesce AI → Revoke writer lease / fence old worker →
 * Verify no uncontrolled writes → Snapshot/checkpoint → Human ownership →
 * Human edits → Return Control → Diff/Reconcile → Revalidate affected
 * evidence → New AI lease → Resume.
 *
 * The UI may show "Control Acquired" ONLY when writers are stopped/isolated
 * AND external writes are confirmed safe; otherwise it shows
 * TAKEOVER_PENDING — never a fake "acquired".
 */

/** The takeover state machine. */
export type TakeoverState =
  | 'REQUESTED'
  | 'QUIESCING'
  | 'QUIET_VERIFIED'
  | 'SNAPSHOTTED'
  | 'HUMAN_OWNED'
  | 'RETURN_REQUESTED'
  | 'RECONCILING'
  | 'REVALIDATING'
  | 'RESUMED'
  | 'FAILED'
  | 'CANCELLED';

/** What the UI is allowed to display. */
export type TakeoverDisplay = 'TAKEOVER_PENDING' | 'CONTROL_ACQUIRED' | 'RETURNED' | 'FAILED';

export const TAKEOVER_FLOW: readonly TakeoverState[] = [
  'REQUESTED',
  'QUIESCING',
  'QUIET_VERIFIED',
  'SNAPSHOTTED',
  'HUMAN_OWNED',
  'RETURN_REQUESTED',
  'RECONCILING',
  'REVALIDATING',
  'RESUMED',
];

/** §31 — human modifications are first-class, attributed records. */
export interface HumanEdit {
  authorType: 'HUMAN';
  authorId: string;
  baseRevision: string;
  /** file path → sha256 of the post-edit content */
  fileHashes: Record<string, string>;
  diff: string;
  timestamp: string;
}

export interface TakeoverRecord {
  id: string;
  runId: string;
  resourceId: string;
  requestedBy: string;
  requestedAt: string;
  state: TakeoverState;
  /** Fencing generation that fenced the old worker out. */
  fencedGeneration: number | null;
  snapshotRef: string | null;
  humanEdits: HumanEdit[];
  /** Evidence ids invalidated by the human edits. */
  revalidatedEvidence: string[];
  /** Files where AI and human changes overlapped → merged, never reset. */
  mergedFiles: string[];
  completedAt: string | null;
  failureReason?: string;
}

export class TakeoverError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WriterNotQuiet extends TakeoverError {
  constructor(detail: string) {
    super('WRITER_NOT_QUIET', `Takeover cannot proceed — writer not quiesced: ${detail}`);
  }
}

export class SilentOverwriteRefused extends TakeoverError {
  constructor(file: string) {
    super(
      'SILENT_OVERWRITE_REFUSED',
      `AI must not silently overwrite human-modified file '${file}': reconcile first`,
    );
  }
}

export class IllegalTakeoverTransition extends TakeoverError {
  constructor(from: TakeoverState, to: TakeoverState) {
    super('ILLEGAL_TAKEOVER_TRANSITION', `Takeover cannot move ${from} → ${to}`);
  }
}

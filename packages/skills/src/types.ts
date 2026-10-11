/**
 * Skill registry domain types — spec §47 (SKILLS REGISTRY), §48 (SKILL DISCOVERY),
 * §49 (SKILL VERSIONING), §74 (SKILL SECURITY).
 *
 * A skill is a modular directory unit:
 *
 *   skill/
 *   ├── SKILL.md       ← instructions (loaded into agent context only when selected)
 *   ├── references/    ← supporting reference documents
 *   ├── scripts/       ← executable helper scripts
 *   └── assets/        ← static assets (templates, fixtures…)
 *
 * Every skill carries the §49 metadata tuple: ID, version, description,
 * compatibility, author, source, trust level, created/updated timestamps and
 * an evaluation score. Multiple versions of one skill coexist; a task records
 * exactly which version it used (see SkillUsage in registry.ts).
 *
 * Security (§74): every install runs the install-time security checklist —
 * scan instructions, scripts, network behavior and file access — before the
 * skill becomes available. Any HIGH finding blocks installation and returns
 * an InstallApprovalRequired descriptor instead; a human must approve before
 * the skill can be installed (HUMAN_APPROVAL).
 */

/** §49 — where a skill comes from and how much it has been vetted. */
export type SkillTrustLevel = 'OFFICIAL' | 'VERIFIED' | 'COMMUNITY' | 'UNREVIEWED';

/** Skill lifecycle states (§35). Retired versions are never loaded into context. */
export type SkillStatus =
  | 'DRAFT'
  | 'QUARANTINED'
  | 'VALIDATED'
  | 'EVALUATED'
  | 'APPROVED'
  | 'ACTIVE'
  | 'DEPRECATED'
  | 'RETIRED';

/**
 * §35 — legal lifecycle transitions for one skill version.
 *
 * Agent self-built skills default to the Proposal flow:
 *   DRAFT (生成) → VALIDATED (安全检查通过) → EVALUATED (独立评测)
 *   → APPROVED (政策批准) → ACTIVE (激活)
 * QUARANTINED is entered when a security check / evaluation flags the
 * version; from there it goes back to DRAFT for rework or straight to
 * RETIRED. ACTIVE → RETIRED directly is allowed for defective versions
 * (block new launches per §35).
 */
export const SKILL_STATUS_TRANSITIONS: Readonly<
  Record<SkillStatus, readonly SkillStatus[]>
> = {
  DRAFT: ['QUARANTINED', 'VALIDATED'],
  QUARANTINED: ['DRAFT', 'RETIRED'],
  VALIDATED: ['EVALUATED', 'QUARANTINED'],
  EVALUATED: ['APPROVED', 'QUARANTINED'],
  APPROVED: ['ACTIVE', 'QUARANTINED'],
  ACTIVE: ['DEPRECATED', 'RETIRED'],
  DEPRECATED: ['RETIRED', 'ACTIVE'],
  RETIRED: [],
};

/** True when `to` is a legal lifecycle move from `from` (§35). */
export function canTransitionSkillStatus(from: SkillStatus, to: SkillStatus): boolean {
  return SKILL_STATUS_TRANSITIONS[from].includes(to);
}

/** Thrown when a lifecycle transition is not in SKILL_STATUS_TRANSITIONS. */
export class SkillStatusTransitionError extends Error {
  constructor(
    public readonly skillId: string,
    public readonly version: string,
    public readonly from: SkillStatus,
    public readonly to: SkillStatus,
  ) {
    super(
      `skill ${skillId}@${version}: illegal status transition ${from} → ${to} ` +
        `(legal: ${SKILL_STATUS_TRANSITIONS[from].join(', ') || 'none'})`,
    );
    this.name = 'SkillStatusTransitionError';
  }
}

/**
 * §47 — the on-disk skill unit. `instructions` is the SKILL.md markdown text;
 * the other three lists name files in references/, scripts/ and assets/.
 */
export interface SkillContent {
  /** SKILL.md markdown — the only part ever loaded into agent context (§48). */
  instructions: string;
  /** Paths/names of files under references/. */
  references: string[];
  /** Paths/names of executable files under scripts/. */
  scripts: string[];
  /** Paths/names of static files under assets/. */
  assets: string[];
}

/**
 * §49 — one immutable version of a skill. Versions coexist; the exact
 * version used by a task is recorded via {@link SkillUsage}.
 */
export interface SkillVersion {
  version: string;
  description: string;
  compatibility: string;
  author: string;
  source: string;
  trustLevel: SkillTrustLevel;
  createdAt: string;
  updatedAt: string;
  /** 0–1 quality/eval score, see spec §49. */
  evaluationScore: number;
  content: SkillContent;
  status: SkillStatus;
  /** Keywords used for discovery matching (§48). */
  keywords: string[];
}

/** §49 — a skill with all its coexisting versions. */
export interface Skill {
  id: string;
  versions: SkillVersion[];
}

/**
 * §74 — capabilities declared at install time. These are checked by the
 * security scan; undeclared dangerous behavior found in the scan escalates
 * findings.
 */
export interface SkillDeclaration {
  /** Declares outbound network access (HTTP, API calls, downloads…). */
  network: boolean;
  /** Declared file-system access scope. */
  fileAccess: 'NONE' | 'READ' | 'WRITE';
  /** Declares shell/process execution capability. */
  shell: boolean;
}

/** §47 — full install payload: skill metadata + content + declared capabilities. */
export interface InstallSkillDef {
  id: string;
  version: string;
  description: string;
  compatibility: string;
  author: string;
  source: string;
  trustLevel: SkillTrustLevel;
  evaluationScore: number;
  content: SkillContent;
  declared: SkillDeclaration;
  keywords: string[];
}

/** §74 — an install request. `approvedByHuman` unblocks HIGH-severity installs. */
export interface InstallRequest {
  skill: InstallSkillDef;
  requestedBy: string;
  /** True only when a human has explicitly approved this install (HUMAN_APPROVAL). */
  approvedByHuman?: boolean;
}

/** §74 — severity of one checklist finding. HIGH → needs HUMAN_APPROVAL. */
export type SecuritySeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH';

/** §74 — the aspect of the skill one finding belongs to. */
export type SecurityCheck =
  | 'INSTRUCTIONS'
  | 'SCRIPTS'
  | 'NETWORK'
  | 'FILE_ACCESS'
  | 'SHELL'
  | 'TRUST';

/** §74 — one install-time security finding. */
export interface SecurityFinding {
  check: SecurityCheck;
  severity: SecuritySeverity;
  message: string;
}

/**
 * §74 — result of the install-time security checklist. The checklist runs
 * Scan → Inspect instructions → Inspect scripts → Inspect network behavior →
 * Inspect file access → Evaluate → Approve.
 */
export interface SecurityChecklist {
  skillId: string;
  version: string;
  checks: SecurityFinding[];
  /** Highest severity across findings. */
  overall: SecuritySeverity;
  /** True when any HIGH finding exists — install needs HUMAN_APPROVAL. */
  requiresHumanApproval: boolean;
  checkedAt: string;
}

/**
 * §74 — returned by install() when a HIGH-severity finding blocks the
 * install. The skill is NOT installed; a human approves by re-issuing the
 * install with `approvedByHuman: true`. The coordinator can turn this into
 * an approval ticket (e.g. via @ai-factory/approvals).
 */
export interface InstallApprovalRequired {
  kind: 'INSTALL_APPROVAL_REQUIRED';
  /** Correlation id for the approval ticket / audit trail. */
  requestId: string;
  skillId: string;
  version: string;
  checklist: SecurityChecklist;
  reason: string;
  requestedBy: string;
  createdAt: string;
}

/**
 * Outcome of registry.install(): either the installed version, or the
 * approval gate descriptor when a HIGH finding blocks installation.
 */
export type InstallResult =
  | { ok: true; skill: Skill; version: SkillVersion }
  | { ok: false; approval: InstallApprovalRequired };

/**
 * §49 — the exact skill version a task used. Recorded at execution time so
 * runs are reproducible even after newer versions land.
 */
export interface SkillUsage {
  taskId: string;
  skillId: string;
  version: string;
  recordedAt: string;
}

/** §48 — what the task needs, used to rank candidate skills. */
export interface TaskProfile {
  title: string;
  goal: string;
  keywords: string[];
  taskType: string;
}

/** §48 — one ranked discovery candidate. */
export interface SkillCandidate {
  skillId: string;
  version: string;
  score: number;
  reasons: string[];
}

/**
 * §48 — the auditable record of one discovery run:
 * Task → Skill Discovery → Candidate Skills → Select → Load instructions.
 * Only skills named in `selectedIds` may have their instructions loaded.
 */
export interface DiscoveryRecord {
  id: string;
  taskProfile: TaskProfile;
  candidates: SkillCandidate[];
  selectedIds: string[];
  reason: string;
  timestamp: string;
}

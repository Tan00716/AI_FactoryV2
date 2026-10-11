/**
 * Per-type schemas for the 27 §39.1 artifact types (19 v1 + 8 v2).
 *
 * Each schema declares a `required` list (enforced at create/update time)
 * and an `optional` list (documented but not enforced). Extra fields beyond
 * the schema are allowed — schemas are a contract floor, not a ceiling.
 */
import { ArtifactSchema, ArtifactType, FieldSpec } from './types';

function f(name: string, type: FieldSpec['type'], description: string): FieldSpec {
  return { name, type, description };
}

/** Schema registry in spec order; see `getSchema` for lookup. */
const SCHEMAS: ArtifactSchema[] = [
  {
    type: 'PLAN',
    description: 'A plan produced for a task: objective and ordered steps.',
    required: [
      f('objective', 'string', 'What the plan aims to achieve.'),
      f('steps', 'string[]', 'Ordered steps of the plan.'),
    ],
    optional: [f('risks', 'string[]', 'Known risks.'), f('estimate', 'string', 'Rough effort estimate.')],
  },
  {
    type: 'TASK_BREAKDOWN',
    description: 'Decomposition of a task into subtasks and owners.',
    required: [f('subtasks', 'string[]', 'Ordered subtask descriptions.')],
    optional: [f('owners', 'record', 'Subtask → owner mapping.'), f('parallelizable', 'boolean', 'Whether subtasks can run in parallel.')],
  },
  {
    type: 'DESIGN',
    description: 'A design document: what will be built and why.',
    required: [
      f('title', 'string', 'Design title.'),
      f('summary', 'string', 'Design summary.'),
    ],
    optional: [f('diagrams', 'string[]', 'Diagram references/urls.'), f('alternatives', 'string[]', 'Considered alternatives.')],
  },
  {
    type: 'ARCHITECTURE',
    description: 'Architecture description: components and key decisions.',
    required: [f('components', 'string[]', 'System components.')],
    optional: [f('decisions', 'string[]', 'Architecture decision records.'), f('diagram', 'string', 'Architecture diagram reference.')],
  },
  {
    type: 'CODE_CHANGE',
    description: 'A code change: which files changed and what the change does.',
    required: [
      f('filesChanged', 'string[]', 'Paths of changed files.'),
      f('diffSummary', 'string', 'Human-readable summary of the diff.'),
      f('changeType', 'string', 'e.g. feature, fix, refactor, chore.'),
    ],
    optional: [f('linesAdded', 'number', 'Lines added.'), f('linesRemoved', 'number', 'Lines removed.')],
  },
  {
    type: 'COMMIT',
    description: 'A version-control commit.',
    required: [
      f('sha', 'string', 'Commit SHA.'),
      f('message', 'string', 'Commit message.'),
      f('author', 'string', 'Commit author.'),
    ],
    optional: [f('branch', 'string', 'Branch the commit landed on.')],
  },
  {
    type: 'PULL_REQUEST',
    description: 'A pull request awaiting/undertaking review.',
    required: [
      f('prNumber', 'number', 'Pull request number.'),
      f('title', 'string', 'Pull request title.'),
      f('sourceBranch', 'string', 'Source branch.'),
      f('targetBranch', 'string', 'Target branch.'),
    ],
    optional: [f('url', 'string', 'Pull request URL.'), f('reviewers', 'string[]', 'Requested reviewers.')],
  },
  {
    type: 'CODE_REVIEW',
    description: 'A code review: verdict plus findings.',
    required: [
      f('reviewer', 'string', 'Who reviewed.'),
      f('verdict', 'string', 'e.g. approve, request-changes, comment.'),
      f('findings', 'string[]', 'Review findings/comments.'),
    ],
    optional: [f('prNumber', 'number', 'Reviewed pull request number.')],
  },
  {
    type: 'TEST_PLAN',
    description: 'A test plan: cases and the environment they run in.',
    required: [
      f('testCases', 'string[]', 'Test case descriptions.'),
      f('environment', 'string', 'Environment the tests run in.'),
    ],
    optional: [f('framework', 'string', 'Test framework used.')],
  },
  {
    type: 'TEST_RESULT',
    description: 'Outcome of a test run.',
    required: [
      f('suite', 'string', 'Test suite name.'),
      f('passed', 'number', 'Number of passing tests.'),
      f('failed', 'number', 'Number of failing tests.'),
      f('summary', 'string', 'Human-readable summary.'),
    ],
    optional: [f('durationMs', 'number', 'Run duration in ms.'), f('failures', 'string[]', 'Failing test names.')],
  },
  {
    type: 'SECURITY_REPORT',
    description: 'Security scan/audit report.',
    required: [
      f('scanner', 'string', 'Scanner or audit that produced the report.'),
      f('severity', 'string', 'Overall severity, e.g. low/medium/high/critical.'),
      f('findings', 'string[]', 'Security findings.'),
    ],
    optional: [f('cves', 'string[]', 'CVE identifiers.'), f('remediations', 'string[]', 'Remediation suggestions.')],
  },
  {
    type: 'BUILD_ARTIFACT',
    description: 'A build output (binary, bundle, image).',
    required: [
      f('artifactName', 'string', 'Build artifact name.'),
      f('version', 'string', 'Built version.'),
      f('location', 'string', 'Where the artifact is stored.'),
    ],
    optional: [f('checksum', 'string', 'Artifact checksum.'), f('sizeBytes', 'number', 'Artifact size in bytes.')],
  },
  {
    type: 'DEPLOYMENT',
    description: 'A deployment of a version to an environment.',
    required: [
      f('environment', 'string', 'Target environment.'),
      f('version', 'string', 'Deployed version.'),
      f('status', 'string', 'e.g. success, failed, rolled-back.'),
    ],
    optional: [f('deployedBy', 'string', 'Who deployed.'), f('deployedAt', 'isoDate', 'Deployment time.')],
  },
  {
    type: 'SMOKE_TEST',
    description: 'Post-deploy smoke test outcome.',
    required: [
      f('environment', 'string', 'Environment tested.'),
      f('checksPassed', 'number', 'Passing smoke checks.'),
      f('checksFailed', 'number', 'Failing smoke checks.'),
    ],
    optional: [f('summary', 'string', 'Human-readable summary.'), f('durationMs', 'number', 'Duration in ms.')],
  },
  {
    type: 'UAT_RESULT',
    description: 'User acceptance test outcome.',
    required: [
      f('tester', 'string', 'Who performed UAT.'),
      f('verdict', 'string', 'e.g. accept, reject, conditional.'),
      f('signOff', 'boolean', 'Whether the tester signed off.'),
    ],
    optional: [f('notes', 'string', 'Tester notes.')],
  },
  {
    type: 'RELEASE',
    description: 'A release cut from a deployed version.',
    required: [
      f('version', 'string', 'Released version.'),
      f('releaseNotes', 'string', 'Release notes.'),
    ],
    optional: [f('releasedAt', 'isoDate', 'Release time.'), f('changelog', 'string[]', 'Changelog entries.')],
  },
  {
    type: 'INCIDENT',
    description: 'A production incident record.',
    required: [
      f('severity', 'string', 'e.g. sev1/sev2/sev3.'),
      f('title', 'string', 'Incident title.'),
      f('description', 'string', 'Incident description.'),
      f('status', 'string', 'e.g. open, mitigating, resolved.'),
    ],
    optional: [f('detectedAt', 'isoDate', 'Detection time.'), f('owner', 'string', 'Incident owner.')],
  },
  {
    type: 'ROLLBACK',
    description: 'A rollback to a previous version.',
    required: [
      f('rollbackToVersion', 'string', 'Version rolled back to.'),
      f('reason', 'string', 'Why the rollback happened.'),
      f('status', 'string', 'e.g. success, failed, in-progress.'),
    ],
    optional: [f('fromVersion', 'string', 'Version rolled back from.')],
  },
  {
    type: 'FINAL_REPORT',
    description: 'End-of-task final report: summary and outcomes.',
    required: [
      f('title', 'string', 'Report title.'),
      f('summary', 'string', 'Task summary.'),
      f('outcomes', 'string[]', 'Task outcomes/deliverables.'),
    ],
    optional: [f('metrics', 'record', 'Outcome metrics.'), f('followUps', 'string[]', 'Follow-up items.')],
  },
  // §39.1 v2 additions
  {
    type: 'REQUIREMENT_VERSION',
    description: 'A pinned requirement version (§16): requirement id + version, AC list.',
    required: [
      f('requirementId', 'string', 'Requirement identifier, e.g. REQ-001.'),
      f('version', 'string', 'Pinned version, e.g. "2".'),
      f('acceptanceCriteria', 'string[]', 'AC list for this version.'),
    ],
    optional: [f('changelog', 'string', 'What changed vs the previous version.')],
  },
  {
    type: 'DELEGATION',
    description: 'A structured delegation record (§12.2): delegator, delegatee, scope, expected outcome.',
    required: [
      f('from', 'string', 'Delegating employee/role.'),
      f('to', 'string', 'Delegatee employee/role.'),
      f('scope', 'string', 'Delegated scope of work.'),
    ],
    optional: [f('dueAt', 'isoDate', 'Expected completion time.'), f('reportId', 'string', 'Linked management report id.')],
  },
  {
    type: 'MANAGEMENT_REPORT',
    description: 'A structured management report snapshot (§14).',
    required: [
      f('reportId', 'string', 'Management report id.'),
      f('taskId', 'string', 'Task the report covers.'),
      f('summary', 'string', 'Report summary.'),
    ],
    optional: [f('risks', 'string[]', 'Reported risks.'), f('blockers', 'string[]', 'Reported blockers.')],
  },
  {
    type: 'RISK_ASSESSMENT',
    description: 'A risk assessment record (§41.1): risk level, factors, authorization basis.',
    required: [
      f('level', 'string', 'LOW | MEDIUM | HIGH | CRITICAL.'),
      f('factors', 'string[]', 'Assessed risk factors.'),
    ],
    optional: [f('authorization', 'string', 'Who/what authorized the residual risk.'), f('mitigations', 'string[]', 'Mitigation actions.')],
  },
  {
    type: 'OUTCOME_RESULT',
    description: 'An outcome evaluation result (§45): whether the intended outcome was met.',
    required: [
      f('outcomeId', 'string', 'Outcome identifier.'),
      f('verdict', 'string', 'MET | NOT_MET | PARTIAL.'),
    ],
    optional: [f('evidenceRefs', 'string[]', 'Evidence backing the verdict.'), f('measuredAt', 'isoDate', 'Measurement time.')],
  },
  {
    type: 'HANDOFF',
    description: 'A handoff record (§31/§14): context transferred between employees or runs.',
    required: [
      f('from', 'string', 'Handoff source.'),
      f('to', 'string', 'Handoff target.'),
      f('summary', 'string', 'Handoff summary.'),
    ],
    optional: [f('artifactRefs', 'string[]', 'Artifacts handed over.'), f('acceptedAt', 'isoDate', 'Acceptance time.')],
  },
  {
    type: 'CHECKPOINT',
    description: 'An execution checkpoint (§28): resumable state snapshot reference.',
    required: [
      f('runId', 'string', 'Run this checkpoint belongs to.'),
      f('snapshotRef', 'string', 'Reference to the state snapshot.'),
    ],
    optional: [f('generation', 'number', 'Fencing generation at checkpoint time.'), f('note', 'string', 'Checkpoint note.')],
  },
  {
    type: 'IMPROVEMENT_PROPOSAL',
    description: 'An improvement proposal (§43/§45): suggested change with rationale.',
    required: [
      f('title', 'string', 'Proposal title.'),
      f('rationale', 'string', 'Why this improvement is proposed.'),
    ],
    optional: [f('targetArea', 'string', 'Area targeted: process, skill, knowledge, tooling…'), f('expectedBenefit', 'string', 'Expected benefit.')],
  },
];

const BY_TYPE = new Map<ArtifactType, ArtifactSchema>(SCHEMAS.map((s) => [s.type, s]));

/** Look up the schema for an artifact type. */
export function getSchema(type: ArtifactType): ArtifactSchema {
  const s = BY_TYPE.get(type);
  if (!s) throw new Error(`Unknown artifact type: ${type}`);
  return s;
}

/** All 27 schemas, in spec order. */
export function listSchemas(): ArtifactSchema[] {
  return SCHEMAS.map((s) => ({ ...s, required: [...s.required], optional: [...s.optional] }));
}

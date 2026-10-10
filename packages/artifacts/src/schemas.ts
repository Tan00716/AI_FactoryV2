/**
 * Per-type schemas for the 19 §23 artifact types.
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
];

const BY_TYPE = new Map<ArtifactType, ArtifactSchema>(SCHEMAS.map((s) => [s.type, s]));

/** Look up the schema for an artifact type. */
export function getSchema(type: ArtifactType): ArtifactSchema {
  const s = BY_TYPE.get(type);
  if (!s) throw new Error(`Unknown artifact type: ${type}`);
  return s;
}

/** All 19 schemas, in spec order. */
export function listSchemas(): ArtifactSchema[] {
  return SCHEMAS.map((s) => ({ ...s, required: [...s.required], optional: [...s.optional] }));
}

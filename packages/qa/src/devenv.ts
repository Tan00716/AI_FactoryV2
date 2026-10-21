/**
 * R3-T7+8 — Reproducible dev environment (devcontainer.json + Copilot Setup Steps).
 *
 * Single source of truth: `DevEnvSpec`. Two renderings derived from the SAME
 * spec object so the two formats cannot drift:
 *   - `renderDevcontainer()`      → `.devcontainer/devcontainer.json` (primary)
 *   - `renderSetupStepsYaml()`    → `.devcontainer/copilot-setup-steps.yml`
 *     (compatible export view; move to `.github/workflows/copilot-setup-steps.yml`
 *     to enable — see docs/dev-environment.md)
 *
 * Plus deterministic validators:
 *   - `validateDevcontainer()` — schema shape + referenced-path existence +
 *     `npm run <script>` reference check against package.json scripts.
 *   - `checkSetupStepsYaml()`  — structural checks on the YAML text
 *     (single `copilot-setup-steps` job, pinned actions, timeout ≤ 59).
 *
 * Deterministic kernel: node builtins only, no network, no real models.
 * Setup steps are DECLARED, never executed — execution stays behind the
 * existing sandbox/exec approval semantics (apps/server/src/exec-sandbox.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** One declarative setup step (Copilot Setup Steps view). */
export interface DevEnvSetupStep {
  /** Human-readable step name. */
  name: string;
  /** Shell command (mutually exclusive with `uses`). */
  run?: string;
  /** GitHub Action (mutually exclusive with `run`), e.g. "actions/checkout@v6". */
  uses?: string;
  /** Action inputs. */
  with?: Record<string, string>;
}

/**
 * The single source of truth for the reproducible dev environment.
 * Both output formats are rendered from this one object.
 */
export interface DevEnvSpec {
  /** Environment display name. */
  name: string;
  /** Node major version, e.g. "22" (aligned with root package.json engines >=22). */
  nodeVersion: string;
  /** Install command, e.g. "npm ci" (package-lock.json is committed). */
  installCommand: string;
  /** Build command, e.g. "npm run build" (root script, must exist). */
  buildCommand: string;
  /** VS Code extension IDs (publisher.name). */
  extensions: string[];
  /** Declarative environment variables (devcontainer remoteEnv / job env). */
  env: Record<string, string>;
  /** Preflight command run before install (node version gate), optional. */
  preflightCommand?: string;
  /** Copilot job timeout in minutes (GitHub caps at 59). */
  setupTimeoutMinutes: number;
}

/** The spec this repository actually ships (checked-in files are rendered from it). */
export function defaultDevEnvSpec(): DevEnvSpec {
  return {
    name: 'AI Factory',
    nodeVersion: '22',
    installCommand: 'npm ci',
    buildCommand: 'npm run build',
    extensions: ['ms-vscode-remote.remote-containers'],
    env: {},
    preflightCommand:
      'node -e "const m=Number(process.versions.node.split(\'.\')[0]);' +
      ' if(m<22){console.error(\'node >=22 required, got \'+process.versions.node);process.exit(1)}"',
    setupTimeoutMinutes: 30,
  };
}

/** Dev container image for the given spec (devcontainers major-version tag convention). */
export function devcontainerImage(spec: DevEnvSpec): string {
  return `mcr.microsoft.com/devcontainers/typescript-node:${spec.nodeVersion}`;
}

/** Render `.devcontainer/devcontainer.json` content from the spec. */
export function renderDevcontainer(spec: DevEnvSpec): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    name: spec.name,
    image: devcontainerImage(spec),
    remoteUser: 'node',
    customizations: {
      vscode: {
        extensions: [...spec.extensions],
      },
    },
    // Lifecycle: install deps, then build everything so the container is ready.
    postCreateCommand: `${spec.installCommand} && ${spec.buildCommand}`,
  };
  if (Object.keys(spec.env).length > 0) {
    doc['remoteEnv'] = { ...spec.env };
  }
  return doc;
}

/** Quote a scalar for the YAML emitter (single-quote style). */
function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Render the Copilot Setup Steps compatible export view from the SAME spec.
 * Per GitHub docs this must live at `.github/workflows/copilot-setup-steps.yml`
 * with a single job named `copilot-setup-steps`; we ship it as a template under
 * `.devcontainer/` because `.github/` is not committed from this workspace.
 */
export function renderSetupStepsYaml(spec: DevEnvSpec): string {
  const steps: DevEnvSetupStep[] = [
    { name: 'Checkout code', uses: 'actions/checkout@v6' },
    {
      name: 'Set up Node.js',
      uses: 'actions/setup-node@v7',
      with: { 'node-version': spec.nodeVersion, cache: 'npm' },
    },
  ];
  if (spec.preflightCommand) {
    steps.push({ name: 'Preflight checks', run: spec.preflightCommand });
  }
  steps.push({ name: 'Install dependencies', run: spec.installCommand });
  steps.push({ name: 'Build', run: spec.buildCommand });

  const lines: string[] = [
    '# Copilot Setup Steps — generated from the same DevEnvSpec as .devcontainer/devcontainer.json.',
    '# Generated by @ai-factory/qa renderSetupStepsYaml(); do not hand-edit — edit the spec instead.',
    '# To enable: move this file to .github/workflows/copilot-setup-steps.yml',
    '',
    'name: "Copilot Setup Steps"',
    '',
    '# Automatically run when changed, so the setup stays validated.',
    'on:',
    '  workflow_dispatch:',
    '  push:',
    '    paths:',
    '      - .github/workflows/copilot-setup-steps.yml',
    '  pull_request:',
    '    paths:',
    '      - .github/workflows/copilot-setup-steps.yml',
    '',
    'jobs:',
    '',
    '  # The job MUST be called `copilot-setup-steps` or it will not be picked up by Copilot.',
    '  copilot-setup-steps:',
    '    runs-on: ubuntu-latest',
    '    permissions:',
    '      contents: read',
    `    timeout-minutes: ${spec.setupTimeoutMinutes}`,
  ];
  if (Object.keys(spec.env).length > 0) {
    lines.push('    env:');
    for (const [k, v] of Object.entries(spec.env)) {
      lines.push(`      ${k}: ${yamlQuote(v)}`);
    }
  }
  lines.push('    steps:');
  for (const step of steps) {
    lines.push(`      - name: ${step.name}`);
    if (step.uses) lines.push(`        uses: ${step.uses}`);
    if (step.with) {
      lines.push('        with:');
      for (const [k, v] of Object.entries(step.with)) {
        lines.push(`          ${k}: ${yamlQuote(v)}`);
      }
    }
    if (step.run) lines.push(`        run: ${step.run}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** One validation finding. */
export interface DevEnvIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

/** True when any finding is an error. */
export function hasErrors(issues: DevEnvIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

const EXTENSION_ID_RE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-_.]*$/i;

/** Common devcontainer.json top-level keys (unknown keys → warning, not error). */
const KNOWN_TOP_LEVEL_KEYS = new Set([
  'name', 'image', 'build', 'dockerCompose', 'dockerFile', 'composeFile', 'service',
  'runServices', 'workspaceFolder', 'workspaceMount', 'shutdownAction', 'init',
  'privileged', 'capAdd', 'securityOpt', 'remoteUser', 'remoteEnv', 'containerEnv',
  'containerUser', 'updateRemoteUserUID', 'mounts', 'customizations', 'features',
  'overrideFeatureInstallOrder', 'portsAttributes', 'otherPortsAttributes',
  'forwardPorts', 'appPort', 'postCreateCommand', 'postStartCommand',
  'postAttachCommand', 'onCreateCommand', 'updateContentCommand', 'waitFor',
  'devcontainerMetadata', 'hostRequirements', 'initializeCommand',
]);

const LIFECYCLE_COMMAND_KEYS = [
  'onCreateCommand',
  'updateContentCommand',
  'postCreateCommand',
  'postStartCommand',
  'postAttachCommand',
];

/** Extract `npm run <script>` script names from lifecycle command strings. */
function extractNpmRunScripts(commands: string[]): string[] {
  const out: string[] = [];
  const re = /npm\s+run\s+([A-Za-z0-9:_-]+)/g;
  for (const cmd of commands) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(cmd)) !== null) out.push(m[1]);
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface ValidateDevcontainerOptions {
  /** Repository root (devcontainer.json is expected at `<root>/.devcontainer/`). */
  repoRoot: string;
  /** Root package.json `scripts` map — enables the `npm run <script>` existence check. */
  packageScripts?: Record<string, string>;
}

/**
 * Validate a parsed devcontainer.json document.
 * Checks: required shape, referenced-file existence (dockerfile), extension ID
 * format, `npm run <script>` references against packageScripts, workspaceFolder
 * sanity. Pure/deterministic: no network, no container launch.
 */
export function validateDevcontainer(
  doc: unknown,
  opts: ValidateDevcontainerOptions,
): DevEnvIssue[] {
  const issues: DevEnvIssue[] = [];
  const err = (code: string, message: string) =>
    issues.push({ severity: 'error', code, message });
  const warn = (code: string, message: string) =>
    issues.push({ severity: 'warning', code, message });

  if (!isPlainObject(doc)) {
    err('INVALID_TYPE', 'devcontainer.json must be a JSON object.');
    return issues;
  }

  if (typeof doc['name'] !== 'string' || doc['name'].trim() === '') {
    err('MISSING_NAME', '"name" must be a non-empty string.');
  }

  const image = doc['image'];
  const build = doc['build'];
  if ((typeof image !== 'string' || image.trim() === '') && !isPlainObject(build)) {
    err('MISSING_IMAGE', 'Either "image" or a "build" section is required.');
  }

  // Referenced dockerfile must exist (resolved relative to the .devcontainer dir,
  // per the devcontainers spec).
  const dockerfileRef =
    (isPlainObject(build) && typeof build['dockerfile'] === 'string'
      ? (build['dockerfile'] as string)
      : typeof doc['dockerFile'] === 'string'
        ? (doc['dockerFile'] as string)
        : null);
  if (dockerfileRef) {
    const abs = path.resolve(opts.repoRoot, '.devcontainer', dockerfileRef);
    if (!fs.existsSync(abs)) {
      err(
        'DOCKERFILE_MISSING',
        `Referenced dockerfile does not exist: ${dockerfileRef} (resolved ${abs}).`,
      );
    }
  }

  const customizations = doc['customizations'];
  if (isPlainObject(customizations) && isPlainObject(customizations['vscode'])) {
    const exts = (customizations['vscode'] as Record<string, unknown>)['extensions'];
    if (exts !== undefined) {
      if (!Array.isArray(exts) || exts.length === 0) {
        err('EMPTY_EXTENSIONS', '"customizations.vscode.extensions" must be a non-empty array.');
      } else {
        for (const e of exts) {
          if (typeof e !== 'string' || !EXTENSION_ID_RE.test(e)) {
            err('BAD_EXTENSION', `Invalid VS Code extension ID: ${JSON.stringify(e)}.`);
          }
        }
      }
    }
  } else if (customizations === undefined) {
    warn('MISSING_CUSTOMIZATIONS', 'No "customizations" section; IDE extensions will not be installed.');
  }

  const lifecycleCommands = LIFECYCLE_COMMAND_KEYS.filter(
    (k) => typeof doc[k] === 'string' && (doc[k] as string).trim() !== '',
  ).map((k) => doc[k] as string);
  if (lifecycleCommands.length === 0) {
    warn('NO_LIFECYCLE_COMMAND', 'No lifecycle command (e.g. postCreateCommand) — container will not self-provision.');
  }

  // `npm run <script>` references must exist in package.json scripts.
  if (opts.packageScripts) {
    for (const script of extractNpmRunScripts(lifecycleCommands)) {
      if (!(script in opts.packageScripts)) {
        err('UNKNOWN_NPM_SCRIPT', `Lifecycle command references unknown npm script: "npm run ${script}".`);
      }
    }
  }

  const workspaceFolder = doc['workspaceFolder'];
  if (workspaceFolder !== undefined) {
    if (
      typeof workspaceFolder !== 'string' ||
      (!path.isAbsolute(workspaceFolder) && !workspaceFolder.includes('${'))
    ) {
      err(
        'BAD_WORKSPACE_FOLDER',
        '"workspaceFolder" must be an absolute path or a devcontainer variable reference (e.g. ${localWorkspaceFolder}).',
      );
    }
  }

  const remoteUser = doc['remoteUser'];
  if (remoteUser !== undefined && (typeof remoteUser !== 'string' || remoteUser.trim() === '')) {
    err('BAD_REMOTE_USER', '"remoteUser" must be a non-empty string when present.');
  }

  for (const key of Object.keys(doc)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      warn('UNKNOWN_KEY', `Unknown top-level key (may be a newer schema field): "${key}".`);
    }
  }

  return issues;
}

export interface CheckSetupStepsOptions {
  /** Expected node major version, e.g. "22" — enables the node-version drift check. */
  nodeVersion?: string;
}

/**
 * Structural checks on a copilot-setup-steps.yml TEXT (no YAML parser needed):
 * single `copilot-setup-steps` job, pinned actions, timeout-minutes ≤ 59,
 * presence of checkout + setup-node steps, optional node-version drift check.
 */
export function checkSetupStepsYaml(text: string, opts: CheckSetupStepsOptions = {}): DevEnvIssue[] {
  const issues: DevEnvIssue[] = [];
  const err = (code: string, message: string) =>
    issues.push({ severity: 'error', code, message });
  const warn = (code: string, message: string) =>
    issues.push({ severity: 'warning', code, message });

  const lines = text.split('\n');
  const inJobs = lines.findIndex((l) => l === 'jobs:');
  if (inJobs < 0) {
    err('NO_JOBS', 'No "jobs:" section found.');
    return issues;
  }
  // Job names are the 2-space-indented `name:` lines directly under `jobs:`.
  const jobNames = lines
    .slice(inJobs + 1)
    .filter((l) => /^  [A-Za-z0-9_-]+:$/.test(l))
    .map((l) => l.trim().slice(0, -1));
  if (!jobNames.includes('copilot-setup-steps')) {
    err('WRONG_JOB_NAME', 'The job MUST be called `copilot-setup-steps` or Copilot will ignore it.');
  }
  if (jobNames.length > 1) {
    err('MULTIPLE_JOBS', `Only one job is honored; found: ${jobNames.join(', ')}.`);
  }

  if (!text.includes('actions/checkout@')) {
    warn('MISSING_CHECKOUT', 'No actions/checkout step — Copilot will clone the repo itself, but explicit checkout is recommended.');
  }
  if (!text.includes('actions/setup-node@')) {
    warn('MISSING_SETUP_NODE', 'No actions/setup-node step — Node.js toolchain is not pinned.');
  }

  const timeoutMatch = text.match(/timeout-minutes:\s*(\d+)/);
  if (timeoutMatch && Number(timeoutMatch[1]) > 59) {
    err('TIMEOUT_TOO_HIGH', `timeout-minutes must be ≤ 59 (GitHub cap); got ${timeoutMatch[1]}.`);
  }

  const nodeVersionMatch = text.match(/node-version:\s*["']?(\d+)["']?/);
  if (opts.nodeVersion && nodeVersionMatch && nodeVersionMatch[1] !== opts.nodeVersion) {
    err(
      'NODE_VERSION_DRIFT',
      `setup-steps node-version (${nodeVersionMatch[1]}) drifts from spec (${opts.nodeVersion}).`,
    );
  }

  for (const m of text.matchAll(/uses:\s*(\S+)/g)) {
    if (!m[1].includes('@')) {
      warn('UNPINNED_ACTION', `Action without version pin: ${m[1]}.`);
    }
  }

  return issues;
}

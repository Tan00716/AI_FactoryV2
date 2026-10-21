/**
 * Tests for R3-T7+8 reproducible dev environment (devenv.ts).
 * Run: node --test dist/tests/devenv.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  defaultDevEnvSpec,
  renderDevcontainer,
  renderSetupStepsYaml,
  validateDevcontainer,
  checkSetupStepsYaml,
  hasErrors,
  type DevEnvSpec,
} from '../src/index';

/** Repository root: dist/tests → dist → qa → packages → repo root. */
function repoRoot(): string {
  const root = path.resolve(__dirname, '..', '..', '..', '..');
  assert.ok(
    fs.existsSync(path.join(root, '.devcontainer', 'devcontainer.json')),
    `expected checked-in .devcontainer/devcontainer.json under ${root}`,
  );
  return root;
}

describe('defaultDevEnvSpec', () => {
  it('aligns with root package.json engines (>=22) and scripts', () => {
    const root = repoRoot();
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const spec = defaultDevEnvSpec();
    assert.equal(spec.nodeVersion, '22');
    assert.match(pkg.engines.node, />=22/);
    // install/build commands must reference real scripts / lockfile facts
    assert.equal(spec.installCommand, 'npm ci');
    assert.ok(fs.existsSync(path.join(root, 'package.json')));
    assert.ok(fs.existsSync(path.join(root, 'package-lock.json')), 'npm ci needs package-lock.json');
    const buildScript = spec.buildCommand.replace(/^npm run /, '');
    assert.ok(buildScript in pkg.scripts, 'buildCommand must reference a real root script');
    assert.ok(spec.setupTimeoutMinutes <= 59, 'GitHub timeout cap');
    assert.ok(spec.extensions.length > 0);
  });
});

describe('renderDevcontainer', () => {
  it('renders the required devcontainer shape from the spec', () => {
    const spec = defaultDevEnvSpec();
    const doc = renderDevcontainer(spec);
    assert.equal(doc['name'], spec.name);
    assert.equal(doc['image'], `mcr.microsoft.com/devcontainers/typescript-node:${spec.nodeVersion}`);
    const vscode = (doc['customizations'] as Record<string, unknown>)['vscode'] as Record<string, unknown>;
    assert.deepEqual(vscode['extensions'], spec.extensions);
    assert.ok(String(doc['postCreateCommand']).includes(spec.installCommand));
    assert.ok(String(doc['postCreateCommand']).includes(spec.buildCommand));
    assert.equal(doc['remoteUser'], 'node');
  });

  it('omits remoteEnv when env is empty, includes it when set', () => {
    assert.ok(!('remoteEnv' in renderDevcontainer(defaultDevEnvSpec())));
    const withEnv: DevEnvSpec = { ...defaultDevEnvSpec(), env: { FOO: 'bar' } };
    assert.deepEqual(renderDevcontainer(withEnv)['remoteEnv'], { FOO: 'bar' });
  });
});

describe('renderSetupStepsYaml', () => {
  it('renders a Copilot-compatible workflow from the same spec', () => {
    const spec = defaultDevEnvSpec();
    const yml = renderSetupStepsYaml(spec);
    assert.ok(yml.includes('copilot-setup-steps:'), 'job must be named copilot-setup-steps');
    assert.ok(yml.includes('actions/checkout@v6'));
    assert.ok(yml.includes('actions/setup-node@v7'));
    assert.ok(/node-version:\s*['"]22['"]/.test(yml), 'node-version must pin spec major');
    assert.ok(yml.includes(spec.installCommand));
    assert.ok(yml.includes(spec.buildCommand));
    assert.ok(yml.includes('contents: read'));
  });

  it('passes the structural checker with the spec node version', () => {
    const spec = defaultDevEnvSpec();
    const issues = checkSetupStepsYaml(renderSetupStepsYaml(spec), { nodeVersion: spec.nodeVersion });
    assert.ok(!hasErrors(issues), `expected no errors, got: ${JSON.stringify(issues)}`);
  });
});

describe('validateDevcontainer', () => {
  const scripts = { build: 'tsc', test: 'node --test' };

  it('accepts the rendered spec document', () => {
    const issues = validateDevcontainer(renderDevcontainer(defaultDevEnvSpec()), {
      repoRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-ok-')),
      packageScripts: scripts,
    });
    assert.ok(!hasErrors(issues), `expected no errors, got: ${JSON.stringify(issues)}`);
  });

  it('rejects non-object input fail-closed', () => {
    const issues = validateDevcontainer(null, { repoRoot: os.tmpdir() });
    assert.ok(issues.some((i) => i.code === 'INVALID_TYPE' && i.severity === 'error'));
  });

  it('flags missing name and missing image', () => {
    const missingName = validateDevcontainer({ image: 'img:x' }, { repoRoot: os.tmpdir() });
    assert.ok(missingName.some((i) => i.code === 'MISSING_NAME'));
    const missingImage = validateDevcontainer({ name: 'n' }, { repoRoot: os.tmpdir() });
    assert.ok(missingImage.some((i) => i.code === 'MISSING_IMAGE'));
  });

  it('flags bad extension IDs', () => {
    const doc = {
      name: 'n',
      image: 'img:x',
      customizations: { vscode: { extensions: ['no-dot-here', 'ok.name'] } },
    };
    const issues = validateDevcontainer(doc, { repoRoot: os.tmpdir() });
    assert.ok(issues.some((i) => i.code === 'BAD_EXTENSION'));
  });

  it('flags lifecycle commands referencing unknown npm scripts', () => {
    const doc = { name: 'n', image: 'img:x', postCreateCommand: 'npm ci && npm run no-such-script' };
    const issues = validateDevcontainer(doc, { repoRoot: os.tmpdir(), packageScripts: scripts });
    assert.ok(
      issues.some((i) => i.code === 'UNKNOWN_NPM_SCRIPT' && i.message.includes('no-such-script')),
    );
  });

  it('skips the npm-script check when packageScripts is not provided', () => {
    const doc = { name: 'n', image: 'img:x', postCreateCommand: 'npm run anything' };
    const issues = validateDevcontainer(doc, { repoRoot: os.tmpdir() });
    assert.ok(!issues.some((i) => i.code === 'UNKNOWN_NPM_SCRIPT'));
  });

  it('flags a referenced dockerfile that does not exist (fixture repo root)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-df-'));
    fs.mkdirSync(path.join(root, '.devcontainer'), { recursive: true });
    const doc = { name: 'n', build: { dockerfile: 'Dockerfile' } };
    const issues = validateDevcontainer(doc, { repoRoot: root });
    assert.ok(issues.some((i) => i.code === 'DOCKERFILE_MISSING'));
    // and passes once the file exists
    fs.writeFileSync(path.join(root, '.devcontainer', 'Dockerfile'), 'FROM node:22\n');
    const ok = validateDevcontainer(doc, { repoRoot: root });
    assert.ok(!ok.some((i) => i.code === 'DOCKERFILE_MISSING'));
  });

  it('validates the real checked-in devcontainer.json against the real repo', () => {
    const root = repoRoot();
    const doc = JSON.parse(
      fs.readFileSync(path.join(root, '.devcontainer', 'devcontainer.json'), 'utf8'),
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const issues = validateDevcontainer(doc, { repoRoot: root, packageScripts: pkg.scripts });
    assert.ok(!hasErrors(issues), `checked-in devcontainer.json must validate: ${JSON.stringify(issues)}`);
  });
});

describe('checkSetupStepsYaml', () => {
  it('rejects a wrong job name', () => {
    const issues = checkSetupStepsYaml('jobs:\n  wrong-name:\n    runs-on: ubuntu-latest\n');
    assert.ok(issues.some((i) => i.code === 'WRONG_JOB_NAME' && i.severity === 'error'));
  });

  it('rejects timeout-minutes above the GitHub cap', () => {
    const yml = 'jobs:\n  copilot-setup-steps:\n    runs-on: ubuntu-latest\n    timeout-minutes: 120\n';
    const issues = checkSetupStepsYaml(yml);
    assert.ok(issues.some((i) => i.code === 'TIMEOUT_TOO_HIGH'));
  });

  it('detects node-version drift against the spec', () => {
    const yml = renderSetupStepsYaml(defaultDevEnvSpec()).replace(
      /node-version:\s*['"]22['"]/,
      `node-version: '20'`,
    );
    const issues = checkSetupStepsYaml(yml, { nodeVersion: '22' });
    assert.ok(issues.some((i) => i.code === 'NODE_VERSION_DRIFT'));
  });

  it('validates the real checked-in setup-steps template', () => {
    const root = repoRoot();
    const yml = fs.readFileSync(path.join(root, '.devcontainer', 'copilot-setup-steps.yml'), 'utf8');
    const issues = checkSetupStepsYaml(yml, { nodeVersion: defaultDevEnvSpec().nodeVersion });
    assert.ok(!hasErrors(issues), `checked-in setup-steps must validate: ${JSON.stringify(issues)}`);
  });
});

describe('single-source consistency (no drift between the two formats)', () => {
  it('checked-in devcontainer.json equals renderDevcontainer(defaultDevEnvSpec())', () => {
    const root = repoRoot();
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(root, '.devcontainer', 'devcontainer.json'), 'utf8'),
    );
    assert.deepEqual(onDisk, renderDevcontainer(defaultDevEnvSpec()));
  });

  it('checked-in copilot-setup-steps.yml equals renderSetupStepsYaml(defaultDevEnvSpec())', () => {
    const root = repoRoot();
    const onDisk = fs.readFileSync(path.join(root, '.devcontainer', 'copilot-setup-steps.yml'), 'utf8');
    assert.equal(onDisk, renderSetupStepsYaml(defaultDevEnvSpec()));
  });
});

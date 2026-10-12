/**
 * New project creation (spec §33): create the directory, init git,
 * materialize a template skeleton, write README/docs, and drop the
 * AI configuration (.ai/project.yaml + .ai/policy.yaml, §103).
 *
 * The final state is a real working repository.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getTemplate } from './templates';
import type {
  CreateProjectOptions,
  CreatedProject,
  ProjectTemplateName,
} from './types';

/**
 * Thrown when createProject targets a directory that already exists and
 * is non-empty (spec §6.3: a non-empty directory must not be
 * overwritten). Pass `force: true` in CreateProjectOptions to opt in.
 */
export class DirectoryNotEmptyError extends Error {
  /** Absolute path of the non-empty target directory. */
  readonly dir: string;

  constructor(dir: string) {
    super(
      `refusing to create project in non-empty directory: ${dir} ` +
        '(spec §6.3 — pass force: true to write into it anyway)',
    );
    this.name = 'DirectoryNotEmptyError';
    this.dir = dir;
  }
}

function isNonEmptyDir(dir: string): boolean {
  try {
    return existsSync(dir) && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function validateName(name: string): void {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('project name is required');
  }
  if (/[\\/]/.test(name)) {
    throw new Error(`project name must not contain path separators: ${name}`);
  }
  if (name === '.' || name === '..' || name.startsWith('-')) {
    throw new Error(`invalid project name: ${name}`);
  }
}

function projectYaml(opts: {
  name: string;
  template: ProjectTemplateName | null;
  language: string | null;
  framework: string | null;
}): string {
  return [
    '# AI Factory project configuration (spec §103)',
    `name: ${opts.name}`,
    `template: ${opts.template ?? 'none'}`,
    `language: ${opts.language ?? 'unknown'}`,
    `framework: ${opts.framework ?? 'unknown'}`,
    `createdAt: ${new Date().toISOString()}`,
    'version: 0.1.0',
    '',
  ].join('\n');
}

function policyYaml(name: string): string {
  // §6 workspace permissions — safe defaults for a fresh project.
  return [
    '# AI Factory workspace policy (spec §6)',
    `# project: ${name}`,
    'permissions:',
    '  READ: true',
    '  WRITE: true',
    '  CREATE: true',
    '  DELETE: limited      # delete own outputs only, never the project root',
    '  EXECUTE: true',
    '  NETWORK: project-defined',
    '  GIT: true',
    '  PROCESS: false',
    '  PORT: false',
    'commandWhitelist: default   # see WorkspaceExecutor DEFAULT_ALLOWED_COMMANDS',
    '',
  ].join('\n');
}

function readmeFor(name: string, template: ProjectTemplateName | null): string {
  return [
    `# ${name}`,
    '',
    template
      ? `Scaffolded from the \`${template}\` template by AI Factory.`
      : 'Created by AI Factory.',
    '',
    '## Layout',
    '',
    '```text',
    '.ai/            AI configuration (project.yaml, policy.yaml)',
    'docs/           documentation',
    '```',
    '',
  ].join('\n');
}

function docsOverview(name: string): string {
  return [
    `# ${name} — Overview`,
    '',
    'Placeholder. Describe the product goal, users and acceptance criteria here.',
    '',
    '## Architecture',
    '',
    'Placeholder. Record the architecture decisions here.',
    '',
  ].join('\n');
}

/**
 * Create a new project on disk and return a summary. Steps (§33):
 * create directory → git init → template skeleton → README → docs →
 * .ai/project.yaml + .ai/policy.yaml.
 *
 * Throws DirectoryNotEmptyError when the resolved target directory
 * already exists and is non-empty, unless `opts.force` is true (§6.3).
 */
export function createProject(opts: CreateProjectOptions): CreatedProject {
  validateName(opts.name);
  const base = opts.dir ? resolve(opts.dir) : resolve(process.cwd(), opts.name);
  // If dir points at an existing directory and the name differs from its
  // basename, create the project inside it (convenient for tests/demos).
  const dir =
    existsSync(base) && base.split(/[\\/]/).pop() !== opts.name
      ? join(base, opts.name)
      : base;

  // §6.3: never overwrite a non-empty directory unless explicitly forced.
  if (!opts.force && isNonEmptyDir(dir)) {
    throw new DirectoryNotEmptyError(dir);
  }

  mkdirSync(dir, { recursive: true });

  let template: ProjectTemplateName | null = null;
  let language: string | null = null;
  let framework: string | null = null;
  const files: string[] = [];

  if (opts.template) {
    const t = getTemplate(opts.template);
    template = t.name;
    language = t.language;
    framework = t.framework;
    for (const [rel, content] of Object.entries(t.files)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
      files.push(rel);
    }
  }

  const ensure = (rel: string, content: string): void => {
    const full = join(dir, rel);
    if (existsSync(full)) return;
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
    files.push(rel);
  };

  ensure('README.md', readmeFor(opts.name, template));
  ensure('.ai/project.yaml', projectYaml({ name: opts.name, template, language, framework }));
  ensure('.ai/policy.yaml', policyYaml(opts.name));
  ensure('docs/overview.md', docsOverview(opts.name));

  let gitInitialized = false;
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' });
    gitInitialized = true;
  } catch {
    gitInitialized = false;
  }

  files.sort();
  return { dir, name: opts.name, template, files, gitInitialized };
}

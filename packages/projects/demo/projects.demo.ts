/**
 * Demo for @ai-factory/projects (spec §31–§33):
 *   1. build a small fixture project and run discoverProject on it;
 *   2. createProject a fresh project from the `react` template;
 *   3. run a whitelisted command in the new project via WorkspaceExecutor.
 *
 * Run: node packages/projects/dist/demo/projects.demo.js
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkspaceExecutor,
  createProject,
  discoverProject,
  listTemplates,
} from '../src/index';

function log(title: string, value: unknown): void {
  console.log(`\n=== ${title} ===`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function main(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'projects-demo-'));

  // 1. Fixture project → discover.
  const fixture = join(scratch, 'fixture-api');
  mkdirSync(fixture, { recursive: true });
  writeFileSync(
    join(fixture, 'package.json'),
    JSON.stringify({
      name: 'fixture-api',
      dependencies: { fastify: '^5.0.0' },
      devDependencies: { vitest: '^2.0.0' },
    }),
  );
  writeFileSync(join(fixture, 'package-lock.json'), '{}');
  mkdirSync(join(fixture, '.git'), { recursive: true });
  writeFileSync(join(fixture, 'AGENTS.md'), '# fixture agents\n');
  const profile = discoverProject(fixture);
  log('1. discoverProject(fixture-api)', profile);

  // 2. Create a new project from a template.
  log('available templates', listTemplates().map((t) => t.name));
  const created = createProject({ name: 'demo-shop', template: 'react', dir: scratch });
  log('2. createProject(demo-shop, template=react)', {
    dir: created.dir,
    template: created.template,
    gitInitialized: created.gitInitialized,
    fileCount: created.files.length,
    sampleFiles: created.files.slice(0, 6),
  });

  // 3. Run a whitelisted command inside the new project.
  const exec = new WorkspaceExecutor({
    root: created.dir,
    permissions: ['READ', 'EXECUTE'],
    agentId: 'demo-agent',
    onAudit: (e) =>
      console.log(`[audit] ${e.kind} agent=${e.agentId} exit=${e.exitCode} cmd=${e.command}`),
  });
  const res = await exec.exec('ls');
  log('3. WorkspaceExecutor.exec("ls")', {
    cwd: res.cwd,
    exitCode: res.exitCode,
    timedOut: res.timedOut,
    truncated: res.truncated,
    durationMs: res.durationMs,
    stdout: res.stdout.trim().split('\n'),
  });

  console.log(`\nDemo scratch dir: ${scratch}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

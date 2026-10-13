/**
 * Built-in tool definitions — SPEC v2 §33.
 *
 * The factory ships DEFINITIONS for every §33 category. Whether a
 * definition is backed by a real implementation is stated per tool via
 * `implementationStatus` — never implied by its presence here:
 *
 *  - 'implemented'     a real implementation of the tool's actions
 *                      exists in the factory codebase today (named in
 *                      BUILTIN_TOOL_NOTES and in the definition's
 *                      `source`). "Exists" means the capability surface
 *                      is real code — git operations in @ai-factory/git,
 *                      test spawning in @ai-factory/qa, pipelines and
 *                      deployments in @ai-factory/cicd, the pure
 *                      echo/add functions on the server's runtime route.
 *                      It does NOT mean this registry's executor is
 *                      wired to that surface: the tools package and the
 *                      runtime harness keep separate execution paths
 *                      (see docs/KNOWN_LIMITATIONS.md), and aligning the
 *                      definitions here is deliberately not an
 *                      execution-plane refactor.
 *  - 'definition-only' the §33 metadata shape and category are fixed,
 *                      but no implementation ships anywhere in the
 *                      factory. Registering or listing such a tool
 *                      must never be read as "the factory can do this".
 *
 * The two execution surfaces this catalog aligns with:
 *  - @ai-factory/runtime's harness names its tool vocabulary in
 *    DEFAULT_TOOL_PERMISSIONS (read/write/delete/shell/commit/push/
 *    pull_request → filesystem.*, shell.execute, git.*, github.*).
 *    fs.* / shell.execute below carry exactly those actions; their
 *    implementations are host-injected ToolImpls. No concrete
 *    filesystem ToolImpl ships in this repo, and while the runtime
 *    does ship a concrete shell ToolImpl (createShellTool, Batch 18),
 *    it is not wired as these definitions' executor — hence
 *    'definition-only' despite the action surface being real.
 *  - The server's HTTP run route registers two pure in-process tools
 *    (echo, add) — catalogued under Custom as runtime.echo/runtime.add.
 */
import { ToolRegistry } from './registry';
import { TOOL_CATEGORIES, type ToolCategory, type ToolMetadata } from './types';

const V = '1.0.0';

export const BUILTIN_TOOLS: readonly ToolMetadata[] = [
  {
    id: 'fs.read',
    version: V,
    source: 'builtin',
    category: 'Filesystem',
    implementationStatus: 'definition-only',
    inputSchema: { path: { type: 'string', required: true } },
    outputSchema: { content: { type: 'string' } },
    capabilities: ['filesystem.read'],
    sideEffect: 'read',
    networkRequirements: [],
    filesystemRequirements: ['workspace'],
    timeoutMs: 10_000,
    idempotency: true,
    cancelable: true,
    reconcilable: false,
    health: 'unknown',
    approvalPolicy: 'AUTO',
  },
  {
    id: 'fs.write',
    version: V,
    source: 'builtin',
    category: 'Filesystem',
    implementationStatus: 'definition-only',
    inputSchema: {
      path: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
    outputSchema: { bytesWritten: { type: 'number' } },
    capabilities: ['filesystem.write'],
    sideEffect: 'write',
    networkRequirements: [],
    filesystemRequirements: ['workspace'],
    timeoutMs: 10_000,
    idempotency: false,
    cancelable: true,
    reconcilable: true,
    health: 'unknown',
    approvalPolicy: 'AUTO',
  },
  {
    id: 'fs.delete',
    version: V,
    source: 'builtin',
    category: 'Filesystem',
    implementationStatus: 'definition-only',
    inputSchema: { path: { type: 'string', required: true } },
    outputSchema: {},
    capabilities: ['filesystem.delete'],
    sideEffect: 'write',
    networkRequirements: [],
    filesystemRequirements: ['workspace'],
    timeoutMs: 10_000,
    idempotency: true,
    cancelable: false,
    reconcilable: false,
    health: 'unknown',
    approvalPolicy: 'HUMAN_APPROVAL',
  },
  {
    id: 'shell.execute',
    version: V,
    source: 'builtin',
    category: 'Shell',
    implementationStatus: 'definition-only',
    inputSchema: {
      command: { type: 'string', required: true },
      cwd: { type: 'string' },
      // Run the command on a real pseudo-terminal instead of pipes
      // (@ai-factory/runtime createShellTool, Batch 18): stdout/stderr
      // arrive merged and the command sees a terminal (isatty, window
      // size). Absent/false keeps the pipe behavior.
      pty: { type: 'boolean' },
    },
    outputSchema: {
      exitCode: { type: 'number' },
      stdout: { type: 'string' },
      stderr: { type: 'string' },
    },
    capabilities: ['shell.execute'],
    sideEffect: 'external',
    networkRequirements: [],
    filesystemRequirements: ['workspace'],
    timeoutMs: 120_000,
    idempotency: false,
    cancelable: true,
    reconcilable: false,
    health: 'unknown',
    approvalPolicy: 'AI_REVIEW_PLUS_POLICY',
  },
  {
    id: 'git.commit',
    version: V,
    source: 'builtin:@ai-factory/git',
    category: 'Git',
    implementationStatus: 'implemented',
    inputSchema: { message: { type: 'string', required: true } },
    outputSchema: { sha: { type: 'string' } },
    capabilities: ['git.commit'],
    sideEffect: 'write',
    networkRequirements: [],
    filesystemRequirements: ['repository'],
    timeoutMs: 60_000,
    idempotency: false,
    cancelable: false,
    reconcilable: true,
    health: 'unknown',
    approvalPolicy: 'AUTO',
  },
  {
    id: 'git.push',
    version: V,
    source: 'builtin:@ai-factory/git',
    category: 'Git',
    implementationStatus: 'implemented',
    inputSchema: { remote: { type: 'string' }, branch: { type: 'string' } },
    outputSchema: {},
    capabilities: ['git.push'],
    sideEffect: 'network',
    networkRequirements: ['git remote'],
    filesystemRequirements: ['repository'],
    timeoutMs: 120_000,
    idempotency: true,
    cancelable: false,
    reconcilable: true,
    health: 'unknown',
    approvalPolicy: 'HUMAN_APPROVAL',
  },
  {
    id: 'git.pull_request',
    version: V,
    source: 'builtin:@ai-factory/git',
    category: 'Git',
    implementationStatus: 'implemented',
    inputSchema: {
      title: { type: 'string', required: true },
      head: { type: 'string', required: true },
      base: { type: 'string' },
    },
    outputSchema: { prId: { type: 'string' } },
    capabilities: ['github.pull_request'],
    sideEffect: 'network',
    networkRequirements: ['git hosting'],
    filesystemRequirements: ['repository'],
    timeoutMs: 60_000,
    idempotency: false,
    cancelable: false,
    reconcilable: true,
    health: 'unknown',
    approvalPolicy: 'AUTO',
  },
  {
    id: 'pkg.install',
    version: V,
    source: 'builtin',
    category: 'Package Manager',
    implementationStatus: 'definition-only',
    inputSchema: {
      package: { type: 'string', required: true },
      version: { type: 'string' },
    },
    outputSchema: {},
    capabilities: ['package.install'],
    sideEffect: 'network',
    networkRequirements: ['package registry'],
    filesystemRequirements: ['workspace'],
    timeoutMs: 300_000,
    idempotency: true,
    cancelable: true,
    reconcilable: false,
    health: 'unknown',
    approvalPolicy: 'AI_REVIEW_PLUS_POLICY',
  },
  {
    id: 'test.run',
    version: V,
    source: 'builtin:@ai-factory/qa',
    category: 'Test/Build Runner',
    implementationStatus: 'implemented',
    inputSchema: {
      command: { type: 'string', required: true },
      args: { type: 'array', items: { type: 'string' } },
    },
    outputSchema: { exitCode: { type: 'number' } },
    capabilities: ['test.execute'],
    sideEffect: 'external',
    networkRequirements: [],
    filesystemRequirements: ['workspace'],
    timeoutMs: 600_000,
    idempotency: true,
    cancelable: true,
    reconcilable: false,
    health: 'unknown',
    approvalPolicy: 'AUTO',
  },
  {
    id: 'browser.open',
    version: V,
    source: 'builtin',
    category: 'Browser',
    implementationStatus: 'definition-only',
    inputSchema: { url: { type: 'string', required: true } },
    outputSchema: { text: { type: 'string' } },
    capabilities: ['browser.open'],
    sideEffect: 'network',
    networkRequirements: ['http/https'],
    filesystemRequirements: [],
    timeoutMs: 60_000,
    idempotency: true,
    cancelable: true,
    reconcilable: false,
    health: 'unknown',
    approvalPolicy: 'AUTO',
  },
  {
    id: 'db.query',
    version: V,
    source: 'builtin',
    category: 'Database',
    implementationStatus: 'definition-only',
    inputSchema: { sql: { type: 'string', required: true } },
    outputSchema: { rows: { type: 'array' } },
    capabilities: ['database.query'],
    sideEffect: 'read',
    networkRequirements: ['database'],
    filesystemRequirements: [],
    timeoutMs: 30_000,
    idempotency: true,
    cancelable: true,
    reconcilable: false,
    health: 'unknown',
    approvalPolicy: 'AUTO',
  },
  {
    id: 'ci.pipeline',
    version: V,
    source: 'builtin:@ai-factory/cicd',
    category: 'CI',
    implementationStatus: 'implemented',
    inputSchema: { pipelineId: { type: 'string', required: true } },
    outputSchema: { status: { type: 'string' } },
    capabilities: ['ci.run'],
    sideEffect: 'external',
    networkRequirements: [],
    filesystemRequirements: ['workspace'],
    timeoutMs: 900_000,
    idempotency: false,
    cancelable: true,
    reconcilable: true,
    health: 'unknown',
    approvalPolicy: 'AUTO',
  },
  {
    id: 'deploy.run',
    version: V,
    source: 'builtin:@ai-factory/cicd',
    category: 'Deploy',
    implementationStatus: 'implemented',
    inputSchema: {
      pipelineId: { type: 'string', required: true },
      environment: { type: 'string', required: true },
    },
    outputSchema: { status: { type: 'string' } },
    capabilities: ['deploy.execute'],
    sideEffect: 'external',
    networkRequirements: [],
    filesystemRequirements: ['workspace'],
    timeoutMs: 900_000,
    idempotency: false,
    cancelable: true,
    reconcilable: true,
    health: 'unknown',
    approvalPolicy: 'HUMAN_APPROVAL',
  },
  {
    id: 'mcp.call',
    version: V,
    source: 'builtin',
    category: 'MCP',
    implementationStatus: 'definition-only',
    inputSchema: {
      serverId: { type: 'string', required: true },
      tool: { type: 'string', required: true },
      args: { type: 'object' },
    },
    outputSchema: {},
    capabilities: ['mcp.call'],
    sideEffect: 'external',
    networkRequirements: [],
    filesystemRequirements: [],
    timeoutMs: 60_000,
    idempotency: false,
    cancelable: true,
    reconcilable: false,
    health: 'unknown',
    approvalPolicy: 'AUTO',
  },
  {
    id: 'runtime.echo',
    version: V,
    source: 'builtin:apps/server runtime route',
    category: 'Custom',
    implementationStatus: 'implemented',
    inputSchema: { msg: { type: 'string' } },
    outputSchema: { echo: { type: 'string' } },
    capabilities: ['runtime.echo'],
    sideEffect: 'none',
    networkRequirements: [],
    filesystemRequirements: [],
    timeoutMs: 5_000,
    idempotency: true,
    cancelable: true,
    reconcilable: false,
    health: 'unknown',
    approvalPolicy: 'AUTO',
  },
  {
    id: 'runtime.add',
    version: V,
    source: 'builtin:apps/server runtime route',
    category: 'Custom',
    implementationStatus: 'implemented',
    inputSchema: { a: { type: 'number' }, b: { type: 'number' } },
    outputSchema: { sum: { type: 'number' } },
    capabilities: ['runtime.add'],
    sideEffect: 'none',
    networkRequirements: [],
    filesystemRequirements: [],
    timeoutMs: 5_000,
    idempotency: true,
    cancelable: true,
    reconcilable: false,
    health: 'unknown',
    approvalPolicy: 'AUTO',
  },
];

/** Why each builtin carries the status it does — one honest line per tool. */
export const BUILTIN_TOOL_NOTES: Readonly<Record<string, string>> = {
  'fs.read':
    'Harness action filesystem.read is real (DEFAULT_TOOL_PERMISSIONS + permission-gated runTool), but implementations are host-injected ToolImpls and no concrete filesystem ToolImpl ships in this repo.',
  'fs.write': 'Same as fs.read: the action and gate exist, no shipped implementation.',
  'fs.delete': 'Same as fs.read: the action and gate exist, no shipped implementation.',
  'shell.execute':
    'Harness action shell.execute exists, and @ai-factory/runtime ships a concrete shell ToolImpl (createShellTool: pipe mode + real-PTY mode via a python3 supervisor, Batch 18) honoring this definition\u2019s pty option; command-spawning machinery also lives in @ai-factory/projects (policy-checked executor) and @ai-factory/qa. Status stays definition-only: the runtime ToolImpl is not registered as this definition\u2019s executor in the server tools registry.',
  'git.commit':
    'Real execFile git implementation in @ai-factory/git, gated by the Git Broker (Batch 16) on the server git routes.',
  'git.push': 'Real execFile git implementation in @ai-factory/git, broker-gated like git.commit.',
  'git.pull_request':
    'PR records and merge flow are real in @ai-factory/git (PrStore + merge queue, Batch 16); the harness vocabulary names the action github.pull_request.',
  'pkg.install':
    'No package-manager tool surface ships. Release tooling shells out to npm for versioning (@ai-factory/cicd), which is not an agent tool.',
  'test.run':
    'Real SuiteRunner in @ai-factory/qa spawns test commands and parses TAP output into machine-readable results.',
  'browser.open':
    'No browser tool ships; §33 additionally requires an isolated profile/host and a bounded download directory, neither of which exists yet.',
  'db.query':
    'No database tool ships; §33 additionally requires separate DEV/UAT/PROD identities and brokered production writes, which do not exist yet.',
  'ci.pipeline': 'Real pipeline execution in @ai-factory/cicd (stages, gates, snapshots) behind the server cicd routes.',
  'deploy.run':
    'Real DeploymentService in @ai-factory/cicd (park/approve/resume across requests since Batch 16).',
  'mcp.call':
    'MCP tools arrive via registered MCP servers (§34), not as factory builtins; this definition only fixes the category in the taxonomy.',
  'runtime.echo':
    'Pure in-process function registered on the server HTTP run route (RUNTIME_TOOLS); executes only when the operator allowlists it (FACTORY_RUNTIME_TOOLS).',
  'runtime.add': 'Same surface as runtime.echo.',
};

/** Register every builtin definition into a registry. Returns the registry. */
export function registerBuiltinTools(registry: ToolRegistry): ToolRegistry {
  for (const meta of BUILTIN_TOOLS) registry.register(meta);
  return registry;
}

/** A fresh registry pre-loaded with the builtin catalog. */
export function createBuiltinToolRegistry(): ToolRegistry {
  return registerBuiltinTools(new ToolRegistry());
}

/** Per-category coverage of the builtin catalog, split by honest status. */
export function summarizeBuiltinTools(): Record<
  ToolCategory,
  { implemented: string[]; definitionOnly: string[] }
> {
  const out = {} as Record<ToolCategory, { implemented: string[]; definitionOnly: string[] }>;
  for (const category of TOOL_CATEGORIES) out[category] = { implemented: [], definitionOnly: [] };
  for (const meta of BUILTIN_TOOLS) {
    const bucket = out[meta.category!];
    if (meta.implementationStatus === 'implemented') bucket.implemented.push(meta.id);
    else bucket.definitionOnly.push(meta.id);
  }
  return out;
}

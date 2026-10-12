/**
 * Tool Registry — SPEC v2 §33.
 *
 * Versioned tool metadata. Lookup pins an exact version; unpinned lookup
 * resolves the latest registered version and records which one was used.
 */
import { isToolCategory, type ToolCategory, type ToolMetadata } from './types';

/**
 * Category inference for definitions registered WITHOUT an explicit
 * category (everything written before the §33 taxonomy landed). The
 * rule is mechanical and documented: the FIRST capability's logical
 * action prefix decides ('filesystem.*' → Filesystem, 'git.*' and
 * 'github.*' → Git, …); anything unrecognized is 'Custom'. Inference
 * only ever fills a gap at register() time — an explicit category is
 * never overridden.
 */
const CAPABILITY_PREFIX_CATEGORIES: ReadonlyArray<readonly [string, ToolCategory]> = [
  ['filesystem.', 'Filesystem'],
  ['shell.', 'Shell'],
  ['git.', 'Git'],
  ['github.', 'Git'],
  ['package.', 'Package Manager'],
  ['pkg.', 'Package Manager'],
  ['test.', 'Test/Build Runner'],
  ['build.', 'Test/Build Runner'],
  ['browser.', 'Browser'],
  ['database.', 'Database'],
  ['db.', 'Database'],
  ['ci.', 'CI'],
  ['deploy.', 'Deploy'],
  ['mcp.', 'MCP'],
];

export function inferToolCategory(meta: Pick<ToolMetadata, 'capabilities'>): ToolCategory {
  const first = meta.capabilities?.[0];
  if (typeof first === 'string') {
    for (const [prefix, category] of CAPABILITY_PREFIX_CATEGORIES) {
      if (first.startsWith(prefix)) return category;
    }
  }
  return 'Custom';
}

export class ToolNotFoundError extends Error {
  readonly code = 'TOOL_NOT_FOUND';
  constructor(id: string, version?: string) {
    super(`tool not found: ${id}${version ? `@${version}` : ''}`);
    this.name = 'ToolNotFoundError';
  }
}

export class DuplicateToolVersionError extends Error {
  readonly code = 'DUPLICATE_TOOL_VERSION';
  constructor(id: string, version: string) {
    super(`tool ${id}@${version} already registered`);
    this.name = 'DuplicateToolVersionError';
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, Map<string, ToolMetadata>>();

  register(meta: ToolMetadata): void {
    if (!meta.id || !meta.version) throw new Error('tool id and version are required');
    if (meta.category !== undefined && !isToolCategory(meta.category)) {
      throw new Error(
        `tool ${meta.id}@${meta.version}: invalid category ${JSON.stringify(meta.category)}`,
      );
    }
    let versions = this.tools.get(meta.id);
    if (!versions) {
      versions = new Map();
      this.tools.set(meta.id, versions);
    }
    if (versions.has(meta.version)) throw new DuplicateToolVersionError(meta.id, meta.version);
    // Normalization: every stored definition carries a category
    // (explicit, else inferred from its capabilities) and an honest
    // implementation status (undeclared ⇒ 'definition-only').
    versions.set(meta.version, {
      ...meta,
      category: meta.category ?? inferToolCategory(meta),
      implementationStatus: meta.implementationStatus ?? 'definition-only',
    });
  }

  /** Exact-version lookup; throws ToolNotFoundError. */
  get(id: string, version?: string): ToolMetadata {
    const versions = this.tools.get(id);
    if (!versions || versions.size === 0) throw new ToolNotFoundError(id, version);
    if (version) {
      const meta = versions.get(version);
      if (!meta) throw new ToolNotFoundError(id, version);
      return { ...meta };
    }
    // Latest = last registered (insertion order). Callers record the version used.
    const latest = [...versions.values()].pop()!;
    return { ...latest };
  }

  listVersions(id: string): string[] {
    const versions = this.tools.get(id);
    if (!versions) throw new ToolNotFoundError(id);
    return [...versions.keys()];
  }

  list(): ToolMetadata[] {
    const out: ToolMetadata[] = [];
    for (const versions of this.tools.values()) {
      const latest = [...versions.values()].pop()!;
      out.push({ ...latest });
    }
    return out;
  }

  /** Latest version of every registered tool in one §33 category. */
  listByCategory(category: ToolCategory): ToolMetadata[] {
    return this.list().filter((meta) => meta.category === category);
  }

  setHealth(id: string, version: string, health: ToolMetadata['health']): void {
    const meta = this.get(id, version);
    meta.health = health;
    this.tools.get(id)!.set(version, meta);
  }
}

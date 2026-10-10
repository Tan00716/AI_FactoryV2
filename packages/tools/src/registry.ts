/**
 * Tool Registry — SPEC v2 §33.
 *
 * Versioned tool metadata. Lookup pins an exact version; unpinned lookup
 * resolves the latest registered version and records which one was used.
 */
import type { ToolMetadata } from './types';

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
    let versions = this.tools.get(meta.id);
    if (!versions) {
      versions = new Map();
      this.tools.set(meta.id, versions);
    }
    if (versions.has(meta.version)) throw new DuplicateToolVersionError(meta.id, meta.version);
    versions.set(meta.version, { ...meta });
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

  setHealth(id: string, version: string, health: ToolMetadata['health']): void {
    const meta = this.get(id, version);
    meta.health = health;
    this.tools.get(id)!.set(version, meta);
  }
}

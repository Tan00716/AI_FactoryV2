/**
 * Plugin install records (W-F) — what is installed, what it registered,
 * whether it is enabled.
 *
 * The plugin *files* live under AI_FACTORY_DATA_DIR/plugins/<name>/;
 * this store is the registry of record: capabilities installed with
 * provenance so enable/disable/uninstall are exact inverse operations.
 *
 * Persistence: JSON file (same convention as review-store.ts). Atomic
 * temp+rename writes; corrupt file → fail-closed.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { PluginPermission } from '@ai-factory/plugins';

export interface InstalledSkillRef {
  id: string;
  version: string;
}

export interface InstalledHookRef {
  /** Hook id in hooks.json. */
  id: string;
  event: 'PreToolUse' | 'PostToolUse' | 'Stop';
  tool?: string;
  command: string;
  timeoutMs?: number;
  description?: string;
}

export interface InstalledMcpRef {
  name: string;
  version: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  description?: string;
}

export interface InstalledSlashCommandRef {
  name: string;
  description: string;
  template: string;
}

export interface InstalledCapabilities {
  skills: InstalledSkillRef[];
  slashCommands: InstalledSlashCommandRef[];
  hooks: InstalledHookRef[];
  mcpServers: InstalledMcpRef[];
}

export interface PluginRecord {
  name: string;
  version: string;
  description: string;
  permissions: PluginPermission[];
  enabled: boolean;
  installedAt: string;
  installedBy: string;
  capabilities: InstalledCapabilities;
}

export class PluginStoreError extends Error {}

export function pluginStorePath(): string {
  const fromEnv = process.env.AI_FACTORY_PLUGIN_STORE_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'plugins.json');
}

function atomicWrite(path: string, plugins: PluginRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ plugins }, null, 2), 'utf8');
  renameSync(tmp, path);
}

export class PluginStore {
  private corrupt = false;
  private plugins: PluginRecord[] = [];
  private readonly path: string;

  constructor(path: string = pluginStorePath()) {
    this.path = path;
    this.load();
  }

  isCorrupt(): boolean {
    return this.corrupt;
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw) as { plugins?: unknown };
      if (!Array.isArray(parsed.plugins)) throw new Error('unexpected shape');
      this.plugins = parsed.plugins as PluginRecord[];
    } catch {
      this.corrupt = true;
      this.plugins = [];
    }
  }

  private save(): void {
    if (this.corrupt) throw new PluginStoreError('plugin store is corrupt; refusing writes');
    atomicWrite(this.path, this.plugins);
  }

  list(): PluginRecord[] {
    return this.plugins.map((p) => structuredClone(p));
  }

  get(name: string): PluginRecord {
    const p = this.plugins.find((x) => x.name === name);
    if (!p) throw new PluginStoreError(`plugin not found: ${name}`);
    return structuredClone(p);
  }

  has(name: string): boolean {
    return this.plugins.some((x) => x.name === name);
  }

  add(record: Omit<PluginRecord, 'installedAt'> & { installedAt?: string }): PluginRecord {
    if (this.has(record.name)) {
      throw new PluginStoreError(`plugin already installed: ${record.name}`);
    }
    const full: PluginRecord = {
      ...structuredClone(record),
      installedAt: record.installedAt ?? new Date().toISOString(),
    };
    this.plugins.push(full);
    this.save();
    return structuredClone(full);
  }

  update(name: string, patch: Partial<Pick<PluginRecord, 'enabled' | 'capabilities'>>): PluginRecord {
    const i = this.plugins.findIndex((x) => x.name === name);
    if (i < 0) throw new PluginStoreError(`plugin not found: ${name}`);
    this.plugins[i] = { ...this.plugins[i], ...structuredClone(patch) };
    this.save();
    return structuredClone(this.plugins[i]);
  }

  remove(name: string): PluginRecord {
    const i = this.plugins.findIndex((x) => x.name === name);
    if (i < 0) throw new PluginStoreError(`plugin not found: ${name}`);
    const [removed] = this.plugins.splice(i, 1);
    this.save();
    return structuredClone(removed);
  }
}

export function newInstallId(): string {
  return randomUUID();
}

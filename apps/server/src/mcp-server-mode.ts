/**
 * MCP Server-mode kill switch (W-A).
 *
 * The AI Factory can expose its own tools as a standard MCP server over
 * stdio (see mcp-serve.ts) so external agents (Claude Code, Codex, …)
 * can call into it. This module is the single place that records
 * whether that mode is enabled:
 *
 *   - `readServerModeFlag()` — what mcp-serve.ts consults on every
 *     initialize/tools/call (fail-closed: missing/corrupt file = disabled).
 *   - `writeServerModeFlag()` — what POST /api/mcp/server-mode uses.
 *
 * The flag file lives next to the server database (`./data/` by
 * default, overridable with AI_FACTORY_MCP_SERVER_MODE_FILE). It is a
 * tiny JSON document: { "enabled": bool, "updatedAt": ms, "updatedBy"?: string }.
 * No secrets ever live here.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface McpServerModeFlag {
  enabled: boolean;
  updatedAt: number;
  updatedBy?: string;
}

export function serverModeFlagPath(): string {
  const fromEnv = process.env.AI_FACTORY_MCP_SERVER_MODE_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  // AI_FACTORY_DATA_DIR lets the stdio bridge (spawned by an external
  // agent with an arbitrary cwd) find the same file the server wrote.
  // Default './data' matches the server's DB_PATH convention.
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'mcp-server-mode.json');
}

/** Fail-closed: any read problem (missing/corrupt/wrong shape) = disabled. */
export function readServerModeFlag(now: () => number = Date.now): McpServerModeFlag {
  const path = serverModeFlagPath();
  try {
    const raw = readFileSync(path, 'utf8');
    const doc = JSON.parse(raw) as Partial<McpServerModeFlag>;
    if (doc && doc.enabled === true) {
      return {
        enabled: true,
        updatedAt: typeof doc.updatedAt === 'number' ? doc.updatedAt : 0,
        ...(typeof doc.updatedBy === 'string' ? { updatedBy: doc.updatedBy } : {}),
      };
    }
  } catch {
    /* missing or corrupt → disabled */
  }
  return { enabled: false, updatedAt: now() };
}

export function writeServerModeFlag(enabled: boolean, updatedBy?: string, now: () => number = Date.now): McpServerModeFlag {
  const path = serverModeFlagPath();
  mkdirSync(dirname(path), { recursive: true });
  const flag: McpServerModeFlag = {
    enabled,
    updatedAt: now(),
    ...(updatedBy ? { updatedBy } : {}),
  };
  writeFileSync(path, JSON.stringify(flag, null, 2) + '\n', 'utf8');
  return flag;
}

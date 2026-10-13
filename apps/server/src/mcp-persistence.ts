/**
 * MCP registry durability wiring — §46, §34.1 (Batch 21).
 *
 * The McpRegistry / McpManager are storage-agnostic by design; this
 * module is the ONLY place that knows both @ai-factory/mcp shapes and
 * the @ai-factory/db rows. It owns three jobs:
 *
 *  1. mapping  — McpServer/InstallRecord/TrustAssessment <-> db rows;
 *  2. secret stripping — runtimePolicy.stdioEnvFixed VALUES never
 *     reach disk (keys are kept so the shape stays visible; the values
 *     are resolved from credentialRefs at launch time, which is the
 *     designed flow anyway);
 *  3. hydration — replay persisted rows into a fresh registry/manager
 *     WITHOUT generating new history/audit events (this process is
 *     learning what happened, not re-doing it).
 *
 * Health is point-in-time data: a persisted health report is marked
 * stale on hydrate and NOT loaded into the live registry. A restart
 * must not pretend a fresh health check happened (health: null means
 * "never checked by this process", per the existing summarize()).
 * Launches are and stay process-local (Batch 19) — only registrations,
 * trust, assessments and install records survive.
 */
import type {
  FactoryDatabase,
  McpServerDbRecord,
  McpInstallDbRecord,
  McpServerStore,
} from '@ai-factory/db';
import {
  McpRegistry,
  McpManager,
  type McpServer,
  type McpServerDefinition,
  type TrustAssessment,
  type InstallRecord,
} from '@ai-factory/mcp';

/**
 * Deep-clone a server record with any smuggled secret VALUES removed.
 * credentialRefs are names by construction; the one other channel a
 * value could ride in on is runtimePolicy.stdioEnvFixed. Keys are
 * preserved (the configuration shape stays visible), values are nulled.
 */
export function stripSecretValues(server: McpServer): McpServer {
  const clone = JSON.parse(JSON.stringify(server)) as McpServer;
  const fixed = clone.runtimePolicy?.stdioEnvFixed;
  if (fixed && typeof fixed === 'object') {
    for (const k of Object.keys(fixed)) {
      (fixed as Record<string, string | null>)[k] = null;
    }
  }
  return clone;
}

export function serverToRow(
  server: McpServer,
  assessment: TrustAssessment | undefined,
): McpServerDbRecord {
  return {
    name: server.name,
    version: server.version,
    trustLevel: server.trustLevel,
    approvalPolicy: server.approvalPolicy,
    // A write from THIS process is fresh by definition; hydrate()
    // is the only writer of healthStale=true.
    healthStale: false,
    recordJson: JSON.stringify(stripSecretValues(server)),
    assessmentJson: assessment ? JSON.stringify(assessment) : null,
    updatedAt: new Date().toISOString(),
  };
}

export function installToRow(install: InstallRecord): McpInstallDbRecord {
  return {
    name: install.name,
    version: install.version,
    status: install.status,
    installedAt: install.installedAt
      ? new Date(install.installedAt).toISOString()
      : null,
    scopeEnabledJson: JSON.stringify(install.scopeEnabled ?? {}),
    lastUsedVersion: install.lastUsedVersion ?? null,
  };
}

export interface HydrateResult {
  restoredServers: number;
  restoredInstalls: number;
  staleHealthMarked: number;
}

/**
 * Replay persisted rows into a fresh registry/manager. Order is the
 * persisted registration order (rowid). No history or audit events are
 * generated: hydrateInstall/hydrateAssessment set state directly, and
 * the registry's recorded history/registeredAt are restored verbatim
 * over the fresh register() defaults.
 */
export function hydrateMcpRegistry(deps: {
  registry: McpRegistry;
  manager: McpManager;
  store: McpServerStore;
}): HydrateResult {
  const { registry, manager, store } = deps;
  let restoredServers = 0;
  let restoredInstalls = 0;
  let staleHealthMarked = 0;
  for (const row of store.listServers()) {
    let stored: McpServer;
    try {
      stored = JSON.parse(row.recordJson) as McpServer;
    } catch {
      // A corrupt row must not take down server startup; it is left
      // in place for inspection and skipped loudly below.
      console.error(
        `[ai-factory] mcp hydrate: skipping corrupt row ${row.name}@${row.version}`,
      );
      continue;
    }
    const def: McpServerDefinition = {
      name: stored.name,
      version: stored.version,
      provider: stored.provider,
      transport: stored.transport,
      tools: stored.tools,
      resources: stored.resources,
      prompts: stored.prompts,
      scopes: stored.scopes,
      permissions: stored.permissions,
      networkRequirements: stored.networkRequirements,
      source: stored.source,
      packageHash: stored.packageHash,
      protocolVersions: stored.protocolVersions,
      networkTargets: stored.networkTargets,
      credentialRefs: stored.credentialRefs,
      runtimePolicy: stored.runtimePolicy,
    };
    const server = registry.register(def, {
      trust: stored.trustLevel,
      policy: stored.approvalPolicy,
      negotiatedVersion: stored.negotiatedVersion,
      extensionSet: stored.extensionSet,
    });
    // register() stamps hydrate-time registeredAt + a fresh REGISTERED
    // event; the persisted values are the truth.
    server.registeredAt = stored.registeredAt;
    server.history = stored.history ? [...stored.history] : [];
    // Health is point-in-time: never inherited by the live registry.
    if (stored.health) {
      store.markHealthStale(row.name, row.version);
      staleHealthMarked++;
    }
    if (row.assessmentJson) {
      try {
        manager.hydrateAssessment(
          JSON.parse(row.assessmentJson) as TrustAssessment,
          row.name,
          row.version,
        );
      } catch {
        console.error(
          `[ai-factory] mcp hydrate: skipping corrupt assessment ${row.name}@${row.version}`,
        );
      }
    }
    restoredServers++;
  }
  for (const irow of store.listInstalls()) {
    let scopeEnabled: Record<string, boolean> = {};
    try {
      scopeEnabled = JSON.parse(irow.scopeEnabledJson) as Record<string, boolean>;
    } catch {
      console.error(
        `[ai-factory] mcp hydrate: bad scope flags for ${irow.name}@${irow.version}, using {}`,
      );
    }
    manager.hydrateInstall({
      name: irow.name,
      version: irow.version,
      status: irow.status as InstallRecord['status'],
      installedAt: irow.installedAt ? Date.parse(irow.installedAt) : undefined,
      scopeEnabled,
      lastUsedVersion: irow.lastUsedVersion ?? undefined,
    });
    restoredInstalls++;
  }
  return { restoredServers, restoredInstalls, staleHealthMarked };
}

/**
 * Attach the write-through observers AFTER hydration (so the replay
 * itself doesn't rewrite rows mid-flight). From here on, every
 * registry mutation, assessment and install change lands in the DB.
 */
export function attachMcpPersistence(deps: {
  registry: McpRegistry;
  manager: McpManager;
  store: McpServerStore;
}): void {
  const { registry, manager, store } = deps;
  registry.setSink({
    onServerChanged: (server) => {
      store.saveServer(
        serverToRow(server, manager.getAssessment(server.name, server.version)),
      );
    },
  });
  manager.setDurabilityObservers({
    onInstallChanged: (install, name, version) => {
      if (install) {
        store.saveInstall(installToRow(install));
      } else {
        store.removeInstall(name, version);
      }
    },
    onAssessmentChanged: (assessment, name, version) => {
      const server = registry.get(name, version);
      if (server) store.saveServer(serverToRow(server, assessment));
    },
  });
}

/** Remove a registration entirely (the /remove route). */
export function removeMcpServerRecord(
  store: McpServerStore,
  name: string,
  version: string,
): boolean {
  return store.removeServer(name, version);
}

export type { McpServerStore };
export type FactoryDatabaseRef = FactoryDatabase;

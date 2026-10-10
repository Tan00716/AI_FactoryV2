/**
 * v1 → v2 data migration — SPEC v2 §52.4.
 *
 * Rules (all conservative — migration must never UPGRADE a claim):
 *  - v1 `parent_agent` / `children` become PRIMARY_REPORTS_TO edges
 *    (MANAGES stays a projection, never stored).
 *  - Old permissions map to Capability CEILINGS, not real grants: a
 *    migrated agent gets no more than the ceiling allows, and nothing
 *    is auto-authorized.
 *  - Old DONE tasks become `legacy_completion_unverified`. A collective
 *    "all old DONEs are Outcome Verified" is FORBIDDEN — only history
 *    with complete evidence and provable requirement scope may convert
 *    to a real milestone, one task at a time.
 *  - Old free-text memory becomes UNVERIFIED.
 *  - Old `production_approval=auto` does NOT auto-activate: it must pass
 *    Risk / Reversibility / Observe checks first.
 */

export interface V1Agent {
  id: string;
  name?: string;
  parent_agent_id?: string | null;
  children?: string[];
  permissions?: string[];
}

export interface PrimaryManagerEdge {
  source_node_id: string;
  target_node_id: string;
  relationship_type: 'PRIMARY_REPORTS_TO';
  migrated_from: 'v1.parent_agent' | 'v1.children';
}

export interface MigrationWarning {
  entity: string;
  message: string;
}

/**
 * parent_agent/children → PRIMARY_REPORTS_TO edges.
 * Conflicts (both fields disagree) are reported, never silently merged.
 */
export function migrateOrgEdges(
  agents: V1Agent[],
): { edges: PrimaryManagerEdge[]; warnings: MigrationWarning[] } {
  const edges: PrimaryManagerEdge[] = [];
  const warnings: MigrationWarning[] = [];
  const byId = new Map(agents.map((a) => [a.id, a]));

  for (const a of agents) {
    if (a.parent_agent_id) {
      if (!byId.has(a.parent_agent_id)) {
        warnings.push({ entity: a.id, message: `parent_agent ${a.parent_agent_id} not found — edge skipped` });
      } else {
        edges.push({
          source_node_id: a.id,
          target_node_id: a.parent_agent_id,
          relationship_type: 'PRIMARY_REPORTS_TO',
          migrated_from: 'v1.parent_agent',
        });
      }
    }
    for (const childId of a.children ?? []) {
      const child = byId.get(childId);
      if (!child) {
        warnings.push({ entity: a.id, message: `child ${childId} not found — edge skipped` });
        continue;
      }
      if (child.parent_agent_id && child.parent_agent_id !== a.id) {
        warnings.push({
          entity: childId,
          message: `parent_agent (${child.parent_agent_id}) disagrees with children[] (${a.id}) — parent_agent wins`,
        });
        continue;
      }
      if (!child.parent_agent_id) {
        edges.push({
          source_node_id: childId,
          target_node_id: a.id,
          relationship_type: 'PRIMARY_REPORTS_TO',
          migrated_from: 'v1.children',
        });
      }
    }
  }
  return { edges, warnings };
}

export interface CapabilityCeiling {
  agentId: string;
  /** Upper bound only — grants NOTHING by itself. */
  ceiling: string[];
  migratedFrom: string[];
}

/**
 * Old permissions → capability ceilings. A ceiling is a maximum, never
 * an authorization: nothing the agent could do in v1 is auto-allowed.
 */
export function migratePermissionsToCeilings(agents: V1Agent[]): CapabilityCeiling[] {
  return agents.map((a) => ({
    agentId: a.id,
    ceiling: [...(a.permissions ?? [])],
    migratedFrom: [...(a.permissions ?? [])],
  }));
}

export type MigratedCompletion =
  | { status: 'legacy_completion_unverified'; reason: string }
  | { status: 'VERIFIED'; milestone: string; evidenceRef: string };

export interface V1Task {
  id: string;
  status: string;
  /** Complete, auditable evidence history, when it exists. */
  evidenceComplete?: boolean;
  requirementScopeProvable?: boolean;
}

/**
 * Old DONE → legacy_completion_unverified. Conversion to a real
 * milestone requires BOTH complete evidence history AND provable
 * requirement scope, per task — never in bulk.
 */
export function migrateTaskCompletion(task: V1Task): MigratedCompletion {
  if (task.status !== 'DONE') {
    return { status: 'legacy_completion_unverified', reason: `v1 status was ${task.status}, not DONE` };
  }
  if (task.evidenceComplete === true && task.requirementScopeProvable === true) {
    return { status: 'VERIFIED', milestone: 'IMPLEMENTED', evidenceRef: task.id };
  }
  return {
    status: 'legacy_completion_unverified',
    reason: 'v1 DONE without complete evidence history and provable requirement scope',
  };
}

export interface MigratedMemory {
  content: string;
  status: 'UNVERIFIED';
  migratedFrom: 'v1.free_text';
}

/** Old free-text memory is never trusted on arrival. */
export function migrateMemoryText(text: string): MigratedMemory {
  return { content: text, status: 'UNVERIFIED', migratedFrom: 'v1.free_text' };
}

export type ProductionApprovalMigration =
  | { mode: 'human'; note: string }
  | { mode: 'auto_pending_checks'; requiredChecks: string[]; note: string };

/**
 * Old production_approval=auto must pass Risk / Reversibility / Observe
 * checks before it may activate — it is staged, not enabled.
 */
export function migrateProductionApproval(
  v1policy: { production_approval?: 'human' | 'auto' },
): ProductionApprovalMigration {
  if (v1policy.production_approval === 'auto') {
    return {
      mode: 'auto_pending_checks',
      requiredChecks: ['risk_assessment', 'reversibility_classification', 'observe_definition'],
      note: 'v1 auto-approval staged only — blocked until Risk/Reversibility/Observe checks pass',
    };
  }
  return { mode: 'human', note: 'v1 human approval preserved' };
}

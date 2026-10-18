/**
 * Durable permission-tier storage — W-C.
 *
 * Two tables (see schema.ts):
 *   permission_tiers(tier PK, policy_json, updated_at) — one row per
 *     tier with the full {auto,ask,deny} policy JSON;
 *   agent_tiers(agent_id PK, tier, updated_at) — agent→tier assignment.
 *
 * Record-layer only: JSON (de)serialization of the tier policy lives
 * here; policy *evaluation* lives in @ai-factory/permissions. Rows
 * are upserts; nothing is implicitly deleted.
 */
import { DatabaseSync } from 'node:sqlite';

export interface TierPolicyRow {
  tier: string;
  policyJson: string;
  updatedAt: string;
}

export interface AgentTierRow {
  agentId: string;
  tier: string;
  updatedAt: string;
}

function tierRowToRecord(row: Record<string, unknown>): TierPolicyRow {
  return {
    tier: String(row['tier']),
    policyJson: String(row['policyJson']),
    updatedAt: String(row['updatedAt']),
  };
}

function agentTierRowToRecord(row: Record<string, unknown>): AgentTierRow {
  return {
    agentId: String(row['agentId']),
    tier: String(row['tier']),
    updatedAt: String(row['updatedAt']),
  };
}

export class SqlitePermissionTierStore {
  constructor(private readonly db: DatabaseSync) {}

  listTierPolicies(): TierPolicyRow[] {
    const rows = this.db
      .prepare('SELECT tier, policy_json AS policyJson, updated_at AS updatedAt FROM permission_tiers ORDER BY tier')
      .all() as Record<string, unknown>[];
    return rows.map(tierRowToRecord);
  }

  getTierPolicy(tier: string): TierPolicyRow | null {
    const row = this.db
      .prepare('SELECT tier, policy_json AS policyJson, updated_at AS updatedAt FROM permission_tiers WHERE tier = ?')
      .get(tier) as Record<string, unknown> | undefined;
    return row ? tierRowToRecord(row) : null;
  }

  saveTierPolicy(tier: string, policyJson: string, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO permission_tiers (tier, policy_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(tier) DO UPDATE SET policy_json = excluded.policy_json, updated_at = excluded.updated_at`,
      )
      .run(tier, policyJson, updatedAt);
  }

  getAgentTier(agentId: string): AgentTierRow | null {
    const row = this.db
      .prepare('SELECT agent_id AS agentId, tier, updated_at AS updatedAt FROM agent_tiers WHERE agent_id = ?')
      .get(agentId) as Record<string, unknown> | undefined;
    return row ? agentTierRowToRecord(row) : null;
  }

  setAgentTier(agentId: string, tier: string, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO agent_tiers (agent_id, tier, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET tier = excluded.tier, updated_at = excluded.updated_at`,
      )
      .run(agentId, tier, updatedAt);
  }

  listAgentTiers(): AgentTierRow[] {
    const rows = this.db
      .prepare('SELECT agent_id AS agentId, tier, updated_at AS updatedAt FROM agent_tiers ORDER BY agent_id')
      .all() as Record<string, unknown>[];
    return rows.map(agentTierRowToRecord);
  }
}

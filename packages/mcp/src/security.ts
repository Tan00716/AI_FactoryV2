/**
 * @ai-factory/mcp — install flow with trust assessment + approval gating (spec §46, §73).
 *
 * Flow:
 *   register → (unknown defaults to BLOCK) → assessTrust → requestInstall
 *   → AUTO: installed immediately
 *   → AI_REVIEW / HUMAN_APPROVAL: PENDING_REVIEW until decideReview
 *   → BLOCKED: denied
 *
 * Supports per agent/task/project enable-disable, uninstall, and multi-version
 * installs. Usage of a specific version is recorded via recordUsage().
 */
import { McpRegistry } from './registry';
import {
  Clock,
  InstallOutcome,
  InstallRecord,
  InstallStatus,
  McpServer,
  ReviewDecision,
  ScopeRef,
  ToolUsage,
  TrustAssessment,
} from './types';

export interface ManagerOptions {
  clock?: Clock;
}

function scopeKey(ref: ScopeRef): string {
  return `${ref.kind}:${ref.id}`;
}

export class McpManager {
  private installs = new Map<string, InstallRecord>();
  private assessments = new Map<string, TrustAssessment>();
  private usage: ToolUsage[] = [];
  private clock: Clock;

  constructor(private registry: McpRegistry, options: ManagerOptions = {}) {
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  private static key(name: string, version: string): string {
    return `${name}@${version}`;
  }

  /** Trust evaluation for a server; records the assessment and updates the registration. */
  assessTrust(name: string, version: string, assessment: Omit<TrustAssessment, 'assessedAt'>): TrustAssessment {
    const server = this.registry.get(name, version);
    if (!server) throw new Error(`mcp: cannot assess trust — ${name}@${version} is not registered`);
    const record: TrustAssessment = { ...assessment, assessedAt: this.clock.now() };
    this.assessments.set(McpManager.key(name, version), record);
    server.trustLevel = assessment.trustLevel;
    server.approvalPolicy = assessment.approvalPolicy;
    this.registry.appendHistory(name, version, {
      kind: 'TRUST_ASSESSED',
      actor: assessment.assessedBy,
      detail: `${assessment.trustLevel}/${assessment.approvalPolicy}`,
      at: record.assessedAt,
    });
    return record;
  }

  getAssessment(name: string, version: string): TrustAssessment | undefined {
    return this.assessments.get(McpManager.key(name, version));
  }

  /**
   * Request an install. Honours the server's approval policy:
   * unknown/trust-UNKNOWN servers carry the BLOCKED default (§73).
   */
  requestInstall(name: string, version: string): InstallOutcome {
    const server = this.registry.get(name, version);
    if (!server) {
      return { ok: false, status: 'BLOCKED', reason: `install denied: ${name}@${version} is not registered (unknown MCP = BLOCK)` };
    }
    // One clock read per request: the request event, the outcome event
    // and (on AUTO) installedAt all share it.
    const now = this.clock.now();
    this.registry.appendHistory(name, version, { kind: 'INSTALL_REQUESTED', at: now });
    switch (server.approvalPolicy) {
      case 'BLOCKED':
        this.registry.appendHistory(name, version, { kind: 'INSTALL_BLOCKED', detail: `policy BLOCKED (trust ${server.trustLevel})`, at: now });
        return {
          ok: false,
          status: 'BLOCKED',
          reason: `install denied: ${name}@${version} has approval policy BLOCKED (trust ${server.trustLevel})`,
        };
      case 'AUTO':
        this.markInstalled(name, version, undefined, now);
        return { ok: true, status: 'INSTALLED' };
      case 'AI_REVIEW':
      case 'HUMAN_APPROVAL':
        this.installs.set(McpManager.key(name, version), this.record(name, version, 'PENDING_REVIEW'));
        this.registry.appendHistory(name, version, { kind: 'INSTALL_PENDING', detail: server.approvalPolicy, at: now });
        return {
          ok: false,
          status: 'PENDING_REVIEW',
          reason: `install pending: ${name}@${version} requires ${server.approvalPolicy} before install`,
        };
    }
  }

  /** Resolve a PENDING_REVIEW install request. */
  decideReview(name: string, version: string, decision: ReviewDecision): InstallOutcome {
    const rec = this.installs.get(McpManager.key(name, version));
    if (!rec || rec.status !== 'PENDING_REVIEW') {
      return { ok: false, status: rec?.status ?? 'BLOCKED', reason: `no pending review for ${name}@${version}` };
    }
    if (!decision.approved) {
      rec.status = 'BLOCKED';
      this.registry.appendHistory(name, version, {
        kind: 'INSTALL_BLOCKED',
        actor: decision.reviewer,
        detail: decision.reason ?? 'denied by review',
      });
      return { ok: false, status: 'BLOCKED', reason: `install denied by review${decision.reason ? `: ${decision.reason}` : ''}` };
    }
    this.markInstalled(name, version, decision.reviewer);
    return { ok: true, status: 'INSTALLED' };
  }

  uninstall(name: string, version: string): boolean {
    const existed = this.installs.delete(McpManager.key(name, version));
    // History lives on the registration record, so it survives the
    // uninstall — the UNINSTALLED entry is appended, never substituted.
    if (existed) this.registry.appendHistory(name, version, { kind: 'UNINSTALLED' });
    return existed;
  }

  getInstall(name: string, version: string): InstallRecord | undefined {
    return this.installs.get(McpManager.key(name, version));
  }

  installedVersions(name: string): InstallRecord[] {
    return [...this.installs.values()].filter((r) => r.name === name && r.status === 'INSTALLED');
  }

  listInstalls(): InstallRecord[] {
    return [...this.installs.values()];
  }

  /** Enable/disable an installed server globally or for one agent/task/project scope. */
  setEnabled(name: string, version: string, enabled: boolean, scope?: ScopeRef): void {
    const rec = this.installs.get(McpManager.key(name, version));
    if (!rec || rec.status !== 'INSTALLED') {
      throw new Error(`mcp: cannot ${enabled ? 'enable' : 'disable'} — ${name}@${version} is not installed`);
    }
    rec.scopeEnabled[scope ? scopeKey(scope) : '*'] = enabled;
    this.registry.appendHistory(name, version, {
      kind: enabled ? 'ENABLED' : 'DISABLED',
      detail: scope ? scopeKey(scope) : '*',
    });
  }

  isEnabled(name: string, version: string, scopes: ScopeRef[] = []): boolean {
    const rec = this.installs.get(McpManager.key(name, version));
    if (!rec || rec.status !== 'INSTALLED') return false;
    if (rec.scopeEnabled['*'] === false) return false;
    for (const s of scopes) {
      const flag = rec.scopeEnabled[scopeKey(s)];
      if (flag === false) return false;
    }
    return true;
  }

  /** Record an authorized tool invocation (which version was actually used). */
  recordUsage(entry: Omit<ToolUsage, 'at'>): void {
    const k = McpManager.key(entry.server, entry.version);
    const rec = this.installs.get(k);
    if (rec && rec.status === 'INSTALLED') rec.lastUsedVersion = entry.version;
    this.usage.push({ ...entry, at: this.clock.now() });
  }

  usageLog(server?: string): ToolUsage[] {
    return server ? this.usage.filter((u) => u.server === server) : [...this.usage];
  }

  private record(name: string, version: string, status: InstallStatus): InstallRecord {
    return { name, version, status, scopeEnabled: {} };
  }

  private markInstalled(name: string, version: string, actor?: string, at?: number): void {
    const k = McpManager.key(name, version);
    const prev = this.installs.get(k);
    const ts = at ?? this.clock.now();
    this.installs.set(k, {
      ...this.record(name, version, 'INSTALLED'),
      scopeEnabled: prev?.scopeEnabled ?? {},
      installedAt: ts,
    });
    this.registry.appendHistory(name, version, { kind: 'INSTALLED', actor, at: ts });
  }
}

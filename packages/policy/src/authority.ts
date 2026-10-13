/**
 * Authority conflict arbitration — spec §8.1, INV-31.
 *
 * §8.1: "Authority Engine 先检查指令者是否有权，Policy Engine 执行明确
 * deny / scope / hard limit，Scheduler 才解决多个合法工作请求的次序。
 * Security Authority 的有效 BLOCK 不能被普通 Manager ALLOW 抵消。
 * 两个同等有效且不兼容的指令，进入 AUTHORITY_CONFLICT，暂停相关动作并升级；
 * 不会采用'最后一条命令'。"
 *
 * INV-31: "多人指令冲突由 Authority / Policy / Scheduler 解析，不按最后发言获胜。"
 *
 * Minimal honest implementation of the Authority layer only:
 *  - directives are registered per principal against a run/task target;
 *  - when two directives from DIFFERENT principals on the SAME target are
 *    both legitimate (equal authority rank) and incompatible, an
 *    AUTHORITY_CONFLICT is opened: the target is paused and the conflict is
 *    escalated — a strictly higher-ranked human must resolve it;
 *  - the one established deterministic rule is applied automatically:
 *    a higher-ranked principal's directive wins (this covers the spec's
 *    explicit case: Security Authority BLOCK is never neutralized by an
 *    ordinary Manager ALLOW);
 *  - without a real conflict nothing ever triggers.
 *
 * This registry is the Authority check. Policy (deny/scope/hard limit) and
 * Scheduler (ordering of legitimate requests) remain their own engines —
 * this module does not pretend to be them.
 */

export type AuthorityLevel =
  | 'owner'
  | 'security_authority'
  | 'manager'
  | 'operator'
  | 'viewer';

/** Rank order of the §8 role template. Higher number = higher authority. */
export const AUTHORITY_RANK: Record<AuthorityLevel, number> = {
  owner: 4,
  security_authority: 3,
  manager: 2,
  operator: 1,
  viewer: 0,
};

export type DirectiveEffect = 'ALLOW' | 'BLOCK' | 'PAUSE' | 'RESUME' | 'CANCEL';

export type AuthorityTargetKind = 'run' | 'task';

export type DirectiveStatus = 'ACTIVE' | 'SUPERSEDED' | 'OVERRIDDEN';

export interface Directive {
  directiveId: string;
  principalId: string;
  authorityLevel: AuthorityLevel;
  targetKind: AuthorityTargetKind;
  targetId: string;
  /** What the principal orders for the target. */
  effect: DirectiveEffect;
  /** Human-readable instruction text, recorded verbatim. */
  instruction: string;
  createdAt: string;
  status: DirectiveStatus;
}

export type ConflictStatus = 'OPEN' | 'RESOLVED';

export interface ConflictResolution {
  /** 'auto_rule' = the established rank rule decided; 'human' = escalated human decided. */
  mode: 'auto_rule' | 'human';
  /** Which deterministic rule fired (auto_rule only). */
  rule?: 'higher-authority-wins';
  decidedByPrincipalId?: string;
  winningDirectiveId: string;
  rationale: string;
  resolvedAt: string;
}

export interface AuthorityConflict {
  conflictId: string;
  targetKind: AuthorityTargetKind;
  targetId: string;
  status: ConflictStatus;
  /** The two (or more, if attached later) directives in conflict. */
  directiveIds: string[];
  detectedAt: string;
  resolution?: ConflictResolution;
}

export interface RegisterDirectiveInput {
  principalId: string;
  authorityLevel: AuthorityLevel;
  targetKind: AuthorityTargetKind;
  targetId: string;
  effect: DirectiveEffect;
  instruction: string;
}

export interface ResolveConflictInput {
  decidedByPrincipalId: string;
  decidedByLevel: AuthorityLevel;
  winningDirectiveId: string;
  rationale: string;
}

export interface AuthorityAuditEvent {
  event: string;
  details: Record<string, unknown>;
}

export interface AuthorityRegistryHooks {
  audit?: (e: AuthorityAuditEvent) => void;
  now?: () => number;
  newId?: () => string;
}

/**
 * Pairs of effects that cannot both govern the same target.
 * Everything else is compatible (no conflict is ever manufactured).
 */
const INCOMPATIBLE: ReadonlySet<string> = new Set([
  'ALLOW|BLOCK',
  'BLOCK|RESUME',
  'ALLOW|CANCEL',
  'RESUME|CANCEL',
  'PAUSE|CANCEL',
  'PAUSE|RESUME',
  'ALLOW|PAUSE',
]);

function incompatible(a: DirectiveEffect, b: DirectiveEffect): boolean {
  if (a === b) return false;
  const key = [a, b].sort().join('|');
  return INCOMPATIBLE.has(key);
}

const LEVELS: ReadonlyArray<AuthorityLevel> = [
  'owner',
  'security_authority',
  'manager',
  'operator',
  'viewer',
];
const EFFECTS: ReadonlyArray<DirectiveEffect> = ['ALLOW', 'BLOCK', 'PAUSE', 'RESUME', 'CANCEL'];

export class AuthorityConflictRegistry {
  private directives = new Map<string, Directive>();
  private conflicts = new Map<string, AuthorityConflict>();
  private seq = 0;
  private readonly hooks: AuthorityRegistryHooks;

  constructor(hooks: AuthorityRegistryHooks = {}) {
    this.hooks = hooks;
  }

  private audit(event: string, details: Record<string, unknown>): void {
    this.hooks.audit?.({ event, details });
  }

  private ts(): string {
    return new Date(this.hooks.now?.() ?? Date.now()).toISOString();
  }

  private id(prefix: string): string {
    const gen = this.hooks.newId?.() ?? `id-${++this.seq}`;
    return `${prefix}-${gen}`;
  }

  private activeOnTarget(targetKind: AuthorityTargetKind, targetId: string): Directive[] {
    const out: Directive[] = [];
    for (const d of this.directives.values()) {
      if (d.status === 'ACTIVE' && d.targetKind === targetKind && d.targetId === targetId) out.push(d);
    }
    return out;
  }

  private openConflictOn(targetKind: AuthorityTargetKind, targetId: string): AuthorityConflict | null {
    for (const c of this.conflicts.values()) {
      if (c.status === 'OPEN' && c.targetKind === targetKind && c.targetId === targetId) return c;
    }
    return null;
  }

  /**
   * Register a principal's directive. Returns the directive plus the conflict
   * it created or joined (null when there is no real conflict).
   */
  registerDirective(input: RegisterDirectiveInput): {
    directive: Directive;
    conflict: AuthorityConflict | null;
    superseded: Directive | null;
  } {
    if (!input.principalId || typeof input.principalId !== 'string') {
      throw new Error('principalId is required');
    }
    if (!LEVELS.includes(input.authorityLevel)) {
      throw new Error(`unknown authorityLevel "${String(input.authorityLevel)}"`);
    }
    if (input.targetKind !== 'run' && input.targetKind !== 'task') {
      throw new Error(`unknown targetKind "${String(input.targetKind)}"`);
    }
    if (!input.targetId || typeof input.targetId !== 'string') {
      throw new Error('targetId is required');
    }
    if (!EFFECTS.includes(input.effect)) {
      throw new Error(`unknown effect "${String(input.effect)}"`);
    }

    const directive: Directive = {
      directiveId: this.id('dir'),
      principalId: input.principalId,
      authorityLevel: input.authorityLevel,
      targetKind: input.targetKind,
      targetId: input.targetId,
      effect: input.effect,
      instruction: input.instruction ?? '',
      createdAt: this.ts(),
      status: 'ACTIVE',
    };

    // A principal updating its own directive is not a conflict (§8.1 covers
    // *different* principals). The older directive is superseded, audited.
    let superseded: Directive | null = null;
    for (const d of this.activeOnTarget(input.targetKind, input.targetId)) {
      if (d.principalId === input.principalId) {
        d.status = 'SUPERSEDED';
        superseded = d;
        this.audit('AUTHORITY_DIRECTIVE_SUPERSEDED', {
          directiveId: d.directiveId,
          supersededBy: directive.directiveId,
          principalId: input.principalId,
          target: `${input.targetKind}:${input.targetId}`,
        });
      }
    }

    this.directives.set(directive.directiveId, directive);
    this.audit('AUTHORITY_DIRECTIVE_REGISTERED', {
      directiveId: directive.directiveId,
      principalId: input.principalId,
      authorityLevel: input.authorityLevel,
      target: `${input.targetKind}:${input.targetId}`,
      effect: input.effect,
    });

    // If the target is already paused under an open conflict, the new
    // directive joins the record but changes nothing about the pause.
    const open = this.openConflictOn(input.targetKind, input.targetId);
    if (open) {
      if (!open.directiveIds.includes(directive.directiveId)) {
        open.directiveIds.push(directive.directiveId);
        this.audit('AUTHORITY_CONFLICT_DIRECTIVE_ATTACHED', {
          conflictId: open.conflictId,
          directiveId: directive.directiveId,
          target: `${input.targetKind}:${input.targetId}`,
        });
      }
      return { directive, conflict: open, superseded };
    }

    // Look for a genuinely incompatible directive from a different principal.
    for (const other of this.activeOnTarget(input.targetKind, input.targetId)) {
      if (other.principalId === directive.principalId) continue;
      if (!incompatible(directive.effect, other.effect)) continue;

      const rankNew = AUTHORITY_RANK[directive.authorityLevel];
      const rankOld = AUTHORITY_RANK[other.authorityLevel];

      if (rankNew !== rankOld) {
        // Deterministic rule: the higher authority wins. This covers the
        // spec's explicit case — Security Authority BLOCK is never
        // neutralized by an ordinary Manager ALLOW — as the rank-3-vs-2
        // instance of the general rule.
        const winner = rankNew > rankOld ? directive : other;
        const loser = rankNew > rankOld ? other : directive;
        loser.status = 'OVERRIDDEN';
        const conflict: AuthorityConflict = {
          conflictId: this.id('ac'),
          targetKind: input.targetKind,
          targetId: input.targetId,
          status: 'RESOLVED',
          directiveIds: [directive.directiveId, other.directiveId],
          detectedAt: this.ts(),
          resolution: {
            mode: 'auto_rule',
            rule: 'higher-authority-wins',
            winningDirectiveId: winner.directiveId,
            rationale:
              `§8.1: ${winner.authorityLevel} (rank ${AUTHORITY_RANK[winner.authorityLevel]}) ` +
              `outranks ${loser.authorityLevel} (rank ${AUTHORITY_RANK[loser.authorityLevel]}); ` +
              `${winner.effect} governs, ${loser.effect} is overridden. ` +
              `No last-command-wins: the recorded order never decides.`,
            resolvedAt: this.ts(),
          },
        };
        this.conflicts.set(conflict.conflictId, conflict);
        this.audit('AUTHORITY_CONFLICT_DETECTED', {
          conflictId: conflict.conflictId,
          target: `${input.targetKind}:${input.targetId}`,
          directives: conflict.directiveIds,
          incompatibleEffects: [directive.effect, other.effect],
        });
        this.audit('AUTHORITY_CONFLICT_AUTO_RESOLVED', {
          conflictId: conflict.conflictId,
          rule: 'higher-authority-wins',
          winningDirectiveId: winner.directiveId,
          winningPrincipalId: winner.principalId,
        });
        return { directive, conflict, superseded };
      }

      // Equal rank, both legitimate, incompatible → AUTHORITY_CONFLICT:
      // pause the target, escalate to a higher-ranked human. Never
      // last-command-wins.
      const conflict: AuthorityConflict = {
        conflictId: this.id('ac'),
        targetKind: input.targetKind,
        targetId: input.targetId,
        status: 'OPEN',
        directiveIds: [directive.directiveId, other.directiveId],
        detectedAt: this.ts(),
      };
      this.conflicts.set(conflict.conflictId, conflict);
      this.audit('AUTHORITY_CONFLICT_DETECTED', {
        conflictId: conflict.conflictId,
        target: `${input.targetKind}:${input.targetId}`,
        directives: conflict.directiveIds,
        incompatibleEffects: [directive.effect, other.effect],
        rank: rankNew,
        escalation: 'requires strictly higher-ranked human decision',
      });
      return { directive, conflict, superseded };
    }

    return { directive, conflict: null, superseded };
  }

  /** True while an open (unresolved) conflict pauses the target. */
  isPaused(targetKind: AuthorityTargetKind, targetId: string): boolean {
    return this.openConflictOn(targetKind, targetId) !== null;
  }

  getConflict(conflictId: string): AuthorityConflict | null {
    return this.conflicts.get(conflictId) ?? null;
  }

  listConflicts(status?: ConflictStatus): AuthorityConflict[] {
    const out: AuthorityConflict[] = [];
    for (const c of this.conflicts.values()) {
      if (!status || c.status === status) out.push({ ...c, directiveIds: [...c.directiveIds] });
    }
    return out;
  }

  getDirective(directiveId: string): Directive | null {
    return this.directives.get(directiveId) ?? null;
  }

  listDirectives(targetKind?: AuthorityTargetKind, targetId?: string): Directive[] {
    const out: Directive[] = [];
    for (const d of this.directives.values()) {
      if (targetKind && d.targetKind !== targetKind) continue;
      if (targetId && d.targetId !== targetId) continue;
      out.push(d);
    }
    return out;
  }

  /**
   * Human escalation decision. The decider must be strictly higher-ranked
   * than BOTH parties — escalation goes upward, never sideways or down.
   */
  resolveConflict(
    conflictId: string,
    input: ResolveConflictInput,
  ): { ok: true; conflict: AuthorityConflict } | { ok: false; reason: string } {
    const conflict = this.conflicts.get(conflictId);
    if (!conflict) return { ok: false, reason: `unknown conflict "${conflictId}"` };
    if (conflict.status !== 'OPEN') return { ok: false, reason: 'conflict is not open' };
    if (!LEVELS.includes(input.decidedByLevel)) {
      return { ok: false, reason: `unknown decidedByLevel "${String(input.decidedByLevel)}"` };
    }
    if (!conflict.directiveIds.includes(input.winningDirectiveId)) {
      return { ok: false, reason: 'winningDirectiveId is not part of this conflict' };
    }
    const parties = conflict.directiveIds
      .map((id) => this.directives.get(id))
      .filter((d): d is Directive => !!d);
    const deciderRank = AUTHORITY_RANK[input.decidedByLevel];
    const maxPartyRank = Math.max(...parties.map((d) => AUTHORITY_RANK[d.authorityLevel]));
    if (deciderRank <= maxPartyRank) {
      return {
        ok: false,
        reason:
          `escalation must go upward: decider rank ${deciderRank} (${input.decidedByLevel}) ` +
          `is not strictly higher than the parties' max rank ${maxPartyRank}`,
      };
    }

    conflict.status = 'RESOLVED';
    conflict.resolution = {
      mode: 'human',
      decidedByPrincipalId: input.decidedByPrincipalId,
      winningDirectiveId: input.winningDirectiveId,
      rationale: input.rationale ?? '',
      resolvedAt: this.ts(),
    };
    for (const id of conflict.directiveIds) {
      if (id !== input.winningDirectiveId) {
        const d = this.directives.get(id);
        if (d && d.status === 'ACTIVE') d.status = 'OVERRIDDEN';
      }
    }
    this.audit('AUTHORITY_CONFLICT_HUMAN_RESOLVED', {
      conflictId,
      decidedByPrincipalId: input.decidedByPrincipalId,
      decidedByLevel: input.decidedByLevel,
      winningDirectiveId: input.winningDirectiveId,
    });
    return { ok: true, conflict };
  }
}

/**
 * RequirementStore — the persistence seam behind RequirementManager
 * (SPEC_V2 §16; first-run walkthrough finding F2).
 *
 * The manager used to be a bare in-process value: requirements, their
 * immutable version history, entity links, promotion holds and §16
 * evidence-compatibility declarations all vanished with the process
 * that created them, so after a restart registering evidence with a
 * requirement pin failed ("unknown requirement version") and a task
 * caught mid-STALE-gate could not proceed until an operator recreated
 * the requirement, its versions, and the declarations by hand. This
 * store keeps the manager's full state on a backing the server chooses:
 * the in-memory default below (tests, embeds without a database —
 * wiring only, no durability) or the SQLite implementation in
 * @ai-factory/db.
 *
 * The contract mirrors the OperationStore / CheckpointStore seams:
 * the manager owns ALL semantics (data-layer gates, impact analysis,
 * hold lifecycle); the store is a dumb record keeper it hydrates from
 * at construction and writes through to on every mutation.
 *
 * Copy contract: records carry nested state (version arrays, AC lists,
 * link lists), so every value crossing the seam in either direction is
 * a DEEP COPY — the manager keeps mutating its live objects after a
 * put (appendVersion pushes, releaseHold stamps), and a store that
 * aliased them would silently change persisted state without a write,
 * or let a caller corrupt the store through a read-back.
 */

import type {
  EntityLinks,
  EvidenceCompatibility,
  PromotionHold,
  Requirement,
} from './types';

/** One requirement version's entity links, as enumerated for hydration. */
export interface RequirementLinksRecord {
  requirementId: string;
  version: number;
  links: EntityLinks;
}

export interface RequirementStore {
  /** Every stored requirement, versions included, in creation order. */
  listRequirements(): Requirement[];
  /**
   * Insert a requirement, or replace the stored record for its id.
   * Versions are append-only in the manager, so a replace only ever
   * carries the same earlier versions plus newly appended ones.
   */
  putRequirement(requirement: Requirement): void;
  /** Every stored links record, in first-write order. */
  listLinks(): RequirementLinksRecord[];
  /** Insert or replace the links bound to one requirement version. */
  putLinks(requirementId: string, version: number, links: EntityLinks): void;
  /** Every promotion hold, in creation order (released ones included). */
  listHolds(): PromotionHold[];
  /** Insert a hold, or replace the stored record for its id (release). */
  putHold(hold: PromotionHold): void;
  /** Every compatibility declaration, in declaration order. */
  listCompatibility(): EvidenceCompatibility[];
  /** Append one declaration. Declarations are never edited or removed. */
  addCompatibility(record: EvidenceCompatibility): void;
  /** The auto-id sequence: how many REQ-nnn ids have been handed out. */
  getSeq(): number;
  /** Persist the auto-id sequence after an id is handed out. */
  setSeq(seq: number): void;
}

/**
 * The default store: process memory only. Constructing a manager over
 * a shared instance lets a second manager hydrate the first one's
 * state (the restart shape, minus durability); constructing one with
 * no store at all gives each manager its own private instance, which
 * is exactly the pre-seam behavior.
 */
export class InMemoryRequirementStore implements RequirementStore {
  private readonly requirements = new Map<string, Requirement>();
  private readonly links = new Map<string, RequirementLinksRecord>();
  private readonly holds = new Map<string, PromotionHold>();
  private readonly compatibility: EvidenceCompatibility[] = [];
  private seq = 0;

  private static linkKey(requirementId: string, version: number): string {
    return `${requirementId}@${version}`;
  }

  listRequirements(): Requirement[] {
    return [...this.requirements.values()].map((r) => structuredClone(r));
  }

  putRequirement(requirement: Requirement): void {
    this.requirements.set(requirement.id, structuredClone(requirement));
  }

  listLinks(): RequirementLinksRecord[] {
    return [...this.links.values()].map((r) => structuredClone(r));
  }

  putLinks(requirementId: string, version: number, links: EntityLinks): void {
    this.links.set(InMemoryRequirementStore.linkKey(requirementId, version), {
      requirementId,
      version,
      links: structuredClone(links),
    });
  }

  listHolds(): PromotionHold[] {
    return [...this.holds.values()].map((h) => structuredClone(h));
  }

  putHold(hold: PromotionHold): void {
    this.holds.set(hold.id, structuredClone(hold));
  }

  listCompatibility(): EvidenceCompatibility[] {
    return this.compatibility.map((c) => structuredClone(c));
  }

  addCompatibility(record: EvidenceCompatibility): void {
    this.compatibility.push(structuredClone(record));
  }

  getSeq(): number {
    return this.seq;
  }

  setSeq(seq: number): void {
    this.seq = seq;
  }
}

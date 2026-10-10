/**
 * Project-level autonomy settings (§80 "Project setting").
 *
 * In-memory store for the prototype. Defaults: every project starts in
 * 'assisted' (the most conservative tier) until explicitly changed by a
 * human with standing to do so. The coordinator may persist this later.
 */
import { AutonomyMode, ProjectAutonomy, isAutonomyMode } from './types';

export class ProjectAutonomyStore {
  private map = new Map<string, ProjectAutonomy>();

  constructor(private clock: () => number = Date.now) {}

  /** Current setting; defaults to assisted when the project is unknown. */
  get(projectId: string): ProjectAutonomy {
    const found = this.map.get(projectId);
    if (found) return { ...found };
    return {
      projectId,
      mode: 'assisted',
      updatedBy: 'system',
      updatedAt: new Date(this.clock()).toISOString(),
    };
  }

  /**
   * Change a project's mode. Throws on an unknown mode — never store an
   * invalid tier.
   */
  set(projectId: string, mode: string, updatedBy: string): ProjectAutonomy {
    if (!isAutonomyMode(mode)) {
      throw new Error(
        `invalid autonomy mode '${mode}'; must be one of: assisted, semi, autonomous, full`,
      );
    }
    const record: ProjectAutonomy = {
      projectId,
      mode,
      updatedBy,
      updatedAt: new Date(this.clock()).toISOString(),
    };
    this.map.set(projectId, record);
    return { ...record };
  }

  /** All known project settings, insertion order. */
  list(): ProjectAutonomy[] {
    return [...this.map.values()].map((r) => ({ ...r }));
  }

  /** For tests: replace the whole store contents. */
  clear(): void {
    this.map.clear();
  }
}

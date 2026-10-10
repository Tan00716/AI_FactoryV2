/**
 * SkillRegistry — spec §47 (SKILLS REGISTRY), §49 (SKILL VERSIONING), §74 (SKILL SECURITY).
 *
 * Responsibilities:
 *  - install(): run the §74 security checklist before a skill becomes
 *    available. A HIGH finding blocks installation and returns an
 *    InstallApprovalRequired descriptor instead of installing; the skill can
 *    only be installed after HUMAN_APPROVAL (re-issue with approvedByHuman).
 *  - list / get / getLatest: read installed skills. Multiple versions coexist;
 *    getLatest returns the newest non-retired version.
 *  - deprecate / retire: lifecycle; retired versions are never loaded.
 *  - recordUsage(): log the exact skill version a task used (§49) so runs
 *    stay reproducible as new versions land.
 */
import { scanSkill } from './security';
import {
  InstallApprovalRequired,
  InstallRequest,
  InstallResult,
  InstallSkillDef,
  Skill,
  SkillUsage,
  SkillVersion,
} from './types';

export class SkillNotFoundError extends Error {
  constructor(public readonly skillId: string) {
    super(`Skill not found: ${skillId}`);
    this.name = 'SkillNotFoundError';
  }
}

export class SkillVersionNotFoundError extends Error {
  constructor(
    public readonly skillId: string,
    public readonly version: string,
  ) {
    super(`Skill version not found: ${skillId}@${version}`);
    this.name = 'SkillVersionNotFoundError';
  }
}

export class InvalidSkillDefError extends Error {
  constructor(message: string) {
    super(`Invalid skill definition: ${message}`);
    this.name = 'InvalidSkillDefError';
  }
}

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `install-req-${requestCounter}`;
}

/** Compare semver-ish strings (falls back to lexicographic for odd shapes). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number(x));
  const pb = b.split('.').map((x) => Number(x));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) break;
    if (x !== y) return x - y;
  }
  return a.localeCompare(b);
}

function cloneVersion(v: SkillVersion): SkillVersion {
  return {
    ...v,
    content: {
      ...v.content,
      references: [...v.content.references],
      scripts: [...v.content.scripts],
      assets: [...v.content.assets],
    },
    keywords: [...v.keywords],
  };
}

function cloneSkill(s: Skill): Skill {
  return { id: s.id, versions: s.versions.map(cloneVersion) };
}

function validateDef(def: InstallSkillDef): void {
  if (!def.id || !/^[a-z0-9][a-z0-9-]*$/.test(def.id)) {
    throw new InvalidSkillDefError('id must be lowercase alphanumeric with dashes');
  }
  if (!def.version) throw new InvalidSkillDefError('version is required');
  if (typeof def.evaluationScore !== 'number' || def.evaluationScore < 0 || def.evaluationScore > 1) {
    throw new InvalidSkillDefError('evaluationScore must be a number between 0 and 1');
  }
  for (const list of [def.content.references, def.content.scripts, def.content.assets, def.keywords]) {
    if (!Array.isArray(list)) throw new InvalidSkillDefError('references/scripts/assets/keywords must be arrays');
  }
}

export class SkillRegistry {
  private skills = new Map<string, Skill>();
  private usageLog: SkillUsage[] = [];

  /**
   * §74 — install a skill after the security checklist.
   *
   * Returns { ok: true } with the installed version, or { ok: false } with
   * an InstallApprovalRequired descriptor when a HIGH finding blocked the
   * install. In the blocked case NOTHING is installed.
   */
  install(req: InstallRequest): InstallResult {
    const def = req.skill;
    validateDef(def);
    const checklist = scanSkill(def);

    if (checklist.requiresHumanApproval && !req.approvedByHuman) {
      const approval: InstallApprovalRequired = {
        kind: 'INSTALL_APPROVAL_REQUIRED',
        requestId: nextRequestId(),
        skillId: def.id,
        version: def.version,
        checklist,
        reason:
          'Install blocked: security checklist produced HIGH-severity finding(s). ' +
          'A human must approve (HUMAN_APPROVAL) before this skill becomes available.',
        requestedBy: req.requestedBy,
        createdAt: new Date().toISOString(),
      };
      return { ok: false, approval };
    }

    const now = new Date().toISOString();
    const version: SkillVersion = {
      version: def.version,
      description: def.description,
      compatibility: def.compatibility,
      author: def.author,
      source: def.source,
      trustLevel: def.trustLevel,
      createdAt: now,
      updatedAt: now,
      evaluationScore: def.evaluationScore,
      content: {
        instructions: def.content.instructions,
        references: [...def.content.references],
        scripts: [...def.content.scripts],
        assets: [...def.content.assets],
      },
      status: 'ACTIVE',
      keywords: [...def.keywords],
    };

    let skill = this.skills.get(def.id);
    if (!skill) {
      skill = { id: def.id, versions: [] };
      this.skills.set(def.id, skill);
    }
    const idx = skill.versions.findIndex((v) => v.version === def.version);
    if (idx >= 0) {
      // Re-install of the same version: refresh content, back to ACTIVE.
      version.createdAt = skill.versions[idx].createdAt;
      skill.versions[idx] = version;
    } else {
      skill.versions.push(version);
    }
    skill.versions.sort((a, b) => compareVersions(a.version, b.version));
    return { ok: true, skill: cloneSkill(skill), version: cloneVersion(version) };
  }

  /** §47 — list all installed skills (latest version metadata included), sorted by id. */
  list(): Skill[] {
    return [...this.skills.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(cloneSkill);
  }

  /** Get a skill, or one exact version of it. Throws when unknown. */
  get(id: string, version?: string): Skill | SkillVersion {
    const skill = this.skills.get(id);
    if (!skill) throw new SkillNotFoundError(id);
    if (version === undefined) return cloneSkill(skill);
    const v = skill.versions.find((x) => x.version === version);
    if (!v) throw new SkillVersionNotFoundError(id, version);
    return cloneVersion(v);
  }

  /**
   * §49 — newest version that is not RETIRED. Throws when the skill is
   * unknown or has no usable version left.
   */
  getLatest(id: string): SkillVersion {
    const skill = this.skills.get(id);
    if (!skill) throw new SkillNotFoundError(id);
    const usable = skill.versions.filter((v) => v.status !== 'RETIRED');
    if (usable.length === 0) throw new SkillVersionNotFoundError(id, 'latest');
    const latest = usable[usable.length - 1];
    return cloneVersion(latest);
  }

  /** §49 — mark a version DEPRECATED (still loadable, warns callers). */
  deprecate(id: string, version: string): SkillVersion {
    const v = this.requireVersion(id, version);
    v.status = 'DEPRECATED';
    v.updatedAt = new Date().toISOString();
    return cloneVersion(v);
  }

  /** §49 — mark a version RETIRED (never loaded into context again). */
  retire(id: string, version: string): SkillVersion {
    const v = this.requireVersion(id, version);
    v.status = 'RETIRED';
    v.updatedAt = new Date().toISOString();
    return cloneVersion(v);
  }

  private requireVersion(id: string, version: string): SkillVersion {
    const skill = this.skills.get(id);
    if (!skill) throw new SkillNotFoundError(id);
    const v = skill.versions.find((x) => x.version === version);
    if (!v) throw new SkillVersionNotFoundError(id, version);
    return v;
  }

  /**
   * §49 — record the exact skill version a task used. Throws when the
   * skill/version is unknown (a task can only record what is installed).
   */
  recordUsage(taskId: string, skillId: string, version: string): SkillUsage {
    const skill = this.skills.get(skillId);
    if (!skill || !skill.versions.some((v) => v.version === version)) {
      throw new SkillVersionNotFoundError(skillId, version);
    }
    const entry: SkillUsage = {
      taskId,
      skillId,
      version,
      recordedAt: new Date().toISOString(),
    };
    this.usageLog.push(entry);
    return { ...entry };
  }

  /** All usage records, in recording order. */
  getUsageLog(): SkillUsage[] {
    return this.usageLog.map((u) => ({ ...u }));
  }

  /** §49 — which exact skill versions a task used. */
  getUsageByTask(taskId: string): SkillUsage[] {
    return this.usageLog.filter((u) => u.taskId === taskId).map((u) => ({ ...u }));
  }
}

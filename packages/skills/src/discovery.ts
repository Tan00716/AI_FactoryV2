/**
 * Skill discovery — spec §48 (SKILL DISCOVERY).
 *
 * Pipeline: Task → Skill Discovery → Candidate Skills → Select relevant
 * Skills → Load required instructions → Execute.
 *
 * The agent must NOT load all skills into context. discover() ranks the
 * registry's skills against a TaskProfile; select() records which of the
 * candidates were chosen (auditable DiscoveryRecord); loadInstructions()
 * returns ONLY the selected skill's SKILL.md text — never the whole registry.
 */
import { SkillRegistry } from './registry';
import { SkillNotFoundError, SkillVersionNotFoundError } from './registry';
import {
  DiscoveryRecord,
  SkillCandidate,
  TaskProfile,
} from './types';

let discoveryCounter = 0;

function nextDiscoveryId(): string {
  discoveryCounter += 1;
  return `discovery-${discoveryCounter}`;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#-]+/g)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
}

/**
 * Rank every installed skill against the task profile.
 *
 * Scoring: a task keyword matching a skill keyword is worth 2 points; a
 * task keyword (or title/goal/type token) appearing in the skill id or
 * description is worth 1. Retired versions are never candidates. Only
 * skills with score > 0 are returned, ranked by score, then evaluationScore.
 */
export function discover(
  registry: SkillRegistry,
  profile: TaskProfile,
): SkillCandidate[] {
  const taskKeywords = new Set<string>();
  for (const k of profile.keywords) taskKeywords.add(k.toLowerCase());
  const haystackTokens = new Set<string>([
    ...tokenize(profile.title),
    ...tokenize(profile.goal),
    ...tokenize(profile.taskType),
  ]);

  const candidates: SkillCandidate[] = [];
  for (const skill of registry.list()) {
    let usable;
    try {
      usable = registry.getLatest(skill.id);
    } catch {
      continue; // fully retired skill — never a candidate
    }
    const skillKeywords = usable.keywords.map((k) => k.toLowerCase());
    const idTokens = new Set(tokenize(skill.id));
    const descTokens = new Set(tokenize(usable.description));

    let score = 0;
    const reasons: string[] = [];
    for (const kw of taskKeywords) {
      if (skillKeywords.includes(kw)) {
        score += 2;
        reasons.push(`keyword match: "${kw}" (skill keyword)`);
      } else if (idTokens.has(kw) || descTokens.has(kw)) {
        score += 1;
        reasons.push(`keyword match: "${kw}" (id/description)`);
      }
    }
    for (const tok of haystackTokens) {
      if (skillKeywords.includes(tok)) {
        score += 2;
        reasons.push(`task text match: "${tok}" (skill keyword)`);
      }
    }
    if (score > 0) {
      candidates.push({
        skillId: skill.id,
        version: usable.version,
        score,
        reasons,
      });
    }
  }
  candidates.sort(
    (a, b) => b.score - a.score,
  );
  return candidates;
}

/**
 * Record an auditable selection over ranked candidates: which skill ids were
 * chosen for this task and why. The agent (or a policy) chooses; this
 * function only captures the decision.
 */
export function select(
  profile: TaskProfile,
  candidates: SkillCandidate[],
  selectedIds: string[],
  reason: string,
): DiscoveryRecord {
  const candidateIds = new Set(candidates.map((c) => c.skillId));
  const unknown = selectedIds.filter((id) => !candidateIds.has(id));
  if (unknown.length > 0) {
    throw new Error(`Cannot select skills that were not candidates: ${unknown.join(', ')}`);
  }
  return {
    id: nextDiscoveryId(),
    taskProfile: {
      title: profile.title,
      goal: profile.goal,
      keywords: [...profile.keywords],
      taskType: profile.taskType,
    },
    candidates: candidates.map((c) => ({ ...c, reasons: [...c.reasons] })),
    selectedIds: [...selectedIds],
    reason,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Convenience: take the top N candidates as the selection.
 */
export function selectTop(
  profile: TaskProfile,
  candidates: SkillCandidate[],
  n = 1,
): DiscoveryRecord {
  const top = candidates.slice(0, Math.max(1, n));
  return select(
    profile,
    candidates,
    top.map((c) => c.skillId),
    `Auto-selected top ${top.length} candidate(s) by discovery score.`,
  );
}

/**
 * §48 — load ONLY this skill's SKILL.md text. Retired versions throw;
 * deprecated versions load normally (the deprecation is the caller's warning).
 */
export function loadInstructions(
  registry: SkillRegistry,
  skillId: string,
  version?: string,
): string {
  let v;
  if (version === undefined) {
    try {
      v = registry.getLatest(skillId);
    } catch {
      throw new SkillNotFoundError(skillId);
    }
  } else {
    const got = registry.get(skillId, version);
    if (!('status' in got)) throw new SkillVersionNotFoundError(skillId, version);
    v = got;
  }
  if (v.status === 'RETIRED') {
    throw new SkillVersionNotFoundError(skillId, v.version);
  }
  return v.content.instructions;
}

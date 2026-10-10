/**
 * @ai-factory/skills — skills registry for the AI Engineering Factory IDE
 * (spec §47 SKILLS REGISTRY, §48 SKILL DISCOVERY, §49 SKILL VERSIONING,
 * §74 SKILL SECURITY).
 *
 * Modules:
 *  - types     skill/version metadata, security checklist, discovery record [§49/§74/§48]
 *  - security  install-time security scan (instructions/scripts/network/file) [§74]
 *  - registry  install (approval gate), list/get, version lifecycle, usage log [§47/§49/§74]
 *  - discovery task → candidates → select (auditable) → load instructions   [§48]
 *  - builtin   8 built-in OFFICIAL skills with SKILL.md content              [§47]
 */
export * from './types';
export * from './security';
export * from './registry';
export * from './discovery';
export * from './builtin';

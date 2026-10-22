/**
 * @ai-factory/merge3 — three-way merge conflict editor core (R5-S3).
 *
 * Pure, deterministic, zero-dependency: conflict-marker parsing, Myers
 * line diff, diff3 alignment, resolution application, and a minimal
 * git CLI surface (spawnSync, no user config, no prompts).
 */
export * from './types.js';
export * from './markers.js';
export * from './myers.js';
export * from './diff3.js';
export * from './resolve.js';
export * from './gitops.js';

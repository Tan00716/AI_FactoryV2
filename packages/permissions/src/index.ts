/**
 * @ai-factory/permissions — unified permission tiers (W-C).
 *
 * read / write / exec / admin, each with an operator-editable
 * auto/ask/deny policy over dot-namespaced actions. Composes with
 * the approvals engine strictest-wins (see server layer).
 */
export * from './types.js';
export * from './policy.js';
export * from './rules.js';

/**
 * @ai-factory/tools — SPEC v2 §33 Tool Registry and controlled real tools.
 *
 * Modules:
 *  - types       tool metadata, capability grants, execution records,
 *                the §33 category taxonomy (TOOL_CATEGORIES)
 *  - schema      hand-written zero-dependency input/output validators
 *  - registry    versioned tool registration and lookup, category
 *                normalization/inference, listByCategory
 *  - validation  full §33 definition-completeness check
 *  - builtins    the shipped definition catalog for all 11 categories,
 *                each marked 'implemented' or 'definition-only'
 *  - executor    execution-point capability enforcement (action+resource,
 *                never tool name), idempotency, secret redaction,
 *                exit-code truth, unified audit log
 */
export * from './types';
export * from './schema';
export * from './registry';
export * from './validation';
export * from './builtins';
export * from './executor';

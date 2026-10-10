/**
 * @ai-factory/tools — SPEC v2 §33 Tool Registry and controlled real tools.
 *
 * Modules:
 *  - types       tool metadata, capability grants, execution records
 *  - schema      hand-written zero-dependency input/output validators
 *  - registry    versioned tool registration and lookup
 *  - executor    execution-point capability enforcement (action+resource,
 *                never tool name), idempotency, secret redaction,
 *                exit-code truth, unified audit log
 */
export * from './types';
export * from './schema';
export * from './registry';
export * from './executor';

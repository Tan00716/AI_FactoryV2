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
 *  - database    SPEC v2 §33 database environment identities (dev/staging/
 *                prod) and the fail-closed production-write gate —
 *                connections carry explicit immutable env identity, prod
 *                writes require literal prodWriteConfirmed, switches audited
 *  - db-broker   SPEC v2 §33 least-privilege Broker/Runbook — the actual
 *                query-executing agent behind the database gate: per-
 *                connection operation/table whitelists, host-injected query
 *                engines (no engine = loud refusal, never faked), named
 *                runbook templates with scalar-only bound params (values
 *                never interpolated into SQL), full execution audit
 *  - browser     SPEC v2 §33 browser profile isolation: each profile owns an
 *                independent on-disk user-data directory (no shared
 *                cookies/storage between profiles) and a bounded download
 *                directory (escape attempts rejected); lifecycle create →
 *                destroy + orphan cleanup, all audited. Directory isolation
 *                on one machine — NOT OS sandboxing/container isolation;
 *                no browser driver ships, browser.open stays definition-only
 */
export * from './types';
export * from './schema';
export * from './registry';
export * from './validation';
export * from './builtins';
export * from './executor';
export * from './database';
export * from './db-broker';
export * from './browser';

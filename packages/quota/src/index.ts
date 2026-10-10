/**
 * @ai-factory/quota — quota-aware factory (§27).
 *
 *  - types    QuotaBucket, freshness, limit events, unknown-means-unknown display
 *  - policy   STRICT_PROVIDER / ALLOW_COMPATIBLE_FALLBACK /
 *             GLOBAL_PAUSE_ON_PRIMARY_LIMIT + fallback compatibility checks
 *  - handoff  cross-model handoff packages: full §27.3 fields, hash-verified,
 *             secret-free, no-dual-write activation guard
 *  - monitor  provider usage recording, limit-event classification, §27.4
 *             inflight-deterministic-tool gate
 */
export * from './types';
export * from './policy';
export * from './handoff';
export * from './monitor';

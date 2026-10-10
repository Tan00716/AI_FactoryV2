/**
 * @ai-factory/model-router — provider-independent model router (spec §27–§30).
 *
 * Modules:
 *  - types     ModelRef, RouteRequest, RouteDecision, ProviderProfile  [§28–§30]
 *  - catalog   seeded generic catalog + shared-pool threshold          [§30, §29]
 *  - router    deterministic route(): primary/fallback/emergency        [§30, §29]
 *  - profile   provider profiles + getAccountStatus() stub             [§28, §29]
 *  - registry  §90 Model Registry view rows (provider/model/capability/
 *              context/reasoning/cost/latency/availability/fallback)
 */
export * from './types';
export * from './catalog';
export * from './router';
export * from './profile';
export * from './registry';

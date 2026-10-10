/**
 * @ai-factory/policy — policy engine (spec §43, §44, §98, §99).
 *
 * Modules:
 *  - types       7 policy layers, rules, scopes, resolution results
 *  - yaml        minimal hand-written YAML subset parser (indent maps /
 *                lists / scalars — zero external dependencies)
 *  - store       PolicyStore: per-layer set/get + top-down effective
 *                resolution with upper-wins override denial (§43)
 *  - policies    parseProjectPolicy / parseOrganizationPolicy — parse +
 *                validate project.yaml (§98) / organization.yaml (§99)
 *  - permissions checkCapability — full §44 capability permission engine
 */
export * from './types';
export * from './yaml';
export * from './store';
export * from './policies';
export * from './permissions';

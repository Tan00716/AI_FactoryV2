/**
 * @ai-factory/approvals — approval system for sensitive tool actions (spec §45)
 * and production gates (§41, §69).
 *
 * Modules:
 *  - types    approval object, statuses, store contract + in-memory impl [§69]
 *  - policy   sensitive-action → approval-level mapping                 [§45]
 *  - manager  request/decide/cancel/expire lifecycle + evidence payload [§69]
 */
export * from './types';
export * from './policy';
export * from './manager';

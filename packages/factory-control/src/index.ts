/**
 * @ai-factory/factory-control — SPEC v2 §24 factory runtime control plane.
 *
 * Modules:
 *  - types         three independent axes (control/health/capacity),
 *                  8 operations, ControlRequest, WorkerAck, FactoryStatus,
 *                  the §24.2 semantics matrix, emergency-stop prohibitions
 *  - controller    FactoryController: epoch-bumped requests, ACK-gated
 *                  terminal states (never faked), independent health/capacity
 *                  axes, emergency stop that revokes execution without
 *                  touching customer production
 */
export * from './types';
export * from './controller';

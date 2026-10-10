/**
 * @ai-factory/watchdog — agent health watchdog (§30).
 *
 *  - types     Health (8), HeartbeatConfig, ThresholdOverride, DiagnosisKind
 *  - watchdog  Watchdog: heartbeat tracking → SUSPECTED_STALL → STALLED,
 *              diagnosis before recovery, policy-gated kill/restart,
 *              circuit breaker + cooldown, self-health
 */
export * from './types';
export * from './watchdog';

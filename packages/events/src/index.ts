/**
 * @ai-factory/events — System Event Bus (spec §91) + secret redaction (§68).
 *
 *  - eventTypes  the §91 event-type vocabulary (EVENT_TYPES, isEventType)
 *  - bus         EventBus: subscribe/emit with seq + ts, retention, loose
 *                payload validation
 *  - redact      redactSecrets / redactText: credential scrubbing for traces
 */
export * from './eventTypes';
export * from './types';
export * from './bus';
export * from './redact';

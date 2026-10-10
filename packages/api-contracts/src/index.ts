/**
 * @ai-factory/api-contracts — SPEC v2 §49 API contracts.
 *
 * Modules:
 *  - types         §49.3 core TypeScript contracts (Ref, Actor,
 *                  CommandEnvelope, TransitionRequest, DelegationRequest,
 *                  EvidenceRecord)
 *  - validators    hand-written zero-dependency runtime validators;
 *                  field presence, enums, lengths, Ref shape.
 *                  NEVER trust a client-submitted actor — the server derives
 *                  identity from the authenticated session and overwrites the
 *                  envelope via applyServerActor().
 *  - reason-codes  the 16 unified reason codes shared by every surface
 *                  (UI/IPC/HTTP/Webhook/MCP).
 */
export * from './types';
export * from './validators';
export * from './reason-codes';

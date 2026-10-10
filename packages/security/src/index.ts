/**
 * @ai-factory/security — cross-cutting security (spec §71–§76).
 *
 * Modules:
 *  - credentials  SecretRef (reference-only secrets), redactSecrets,
 *                   audit-log redaction hook                     [§71]
 *  - injection    content classification (INSTRUCTION | DATA |
 *                   EXTERNAL_CONTENT), untrusted-content sanitize,
 *                   no-elevation policy gate                      [§72]
 *  - scanner      install-time MCP/skill manifest checklist scan
 *                   → {score, findings, verdict}                  [§73/§74/§75]
 *  - sandbox      ExecutionEnvironment abstraction (local/strong),
 *                   risk → policy resolution, directory-escape guard [§76]
 *  - isolation    IsolationBackend abstraction, ConfinementReport,
 *                   fail-closed autonomous-shell gate, WorkspaceRecord
 *                   (§7.2), extended path-threat analysis [SPEC v2 §7]
 *  - routes       registerSecurityRoutes(router, deps):
 *                   POST /api/security/scan, POST /api/security/redact
 */
export * from './credentials';
export * from './injection';
export * from './scanner';
export * from './sandbox';
export * from './isolation';
export * from './routes';

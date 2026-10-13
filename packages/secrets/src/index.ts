/**
 * @ai-factory/secrets — Secret Broker (spec §46.2).
 *
 * Modules:
 *  - types      refs, errors, backend seam, audit event shape
 *  - broker     ordered backend chain, short-term leases, redaction
 *  - envStore   FACTORY_SECRET_* env backend (read-only)
 *  - fileVault  AES-256-GCM vault file + machine-bound key file
 *  - keychain   OS keychain via secret-tool / security (probed)
 *  - memoryStore explicitly-configured ephemeral session backend
 *  - config     FACTORY_SECRETS_BACKEND / FACTORY_SECRETS_DIR factory
 */
export * from './types';
export * from './broker';
export * from './envStore';
export * from './fileVault';
export * from './keychain';
export * from './memoryStore';
export * from './config';

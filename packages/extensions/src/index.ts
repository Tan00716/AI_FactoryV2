/**
 * @ai-factory/extensions — public surface (round-6 R6-S1).
 * See types.ts for the contribution model and sandbox.ts for the
 * security model. This package is server-side only; the desktop talks
 * to it over REST, so a single CJS build is enough (no browser import).
 */
export * from './types.js';
export { validateManifest, validateMainSource } from './manifest.js';
export {
  EXTENSION_API_VERSION,
  EXTENSION_TRUST_FILE,
  OFFICIAL_PUBLIC_KEY_B64,
  TrustRequiredError,
  assertTrusted,
  bundleSha256,
  canonicalBundleString,
  checkApiVersion,
  computeTrust,
  parseSignature,
  readTrustDecisions,
  recordTrust,
  revokeTrust,
  signBundle,
  verifyBundleSignature,
} from './trust.js';
export {
  LOAD_TIMEOUT_MS,
  INVOKE_TIMEOUT_MS,
  MAX_ARGS_BYTES,
  MAX_RESULT_BYTES,
  MAX_PROVIDER_ITEMS,
  MAX_PROVIDER_TEXT,
  SandboxError,
  loadExtension,
  type LoadedExtension,
} from './sandbox.js';
export {
  extensionsHome,
  listExtensions,
  listExtensionsVerbose,
  readExtension,
  toInfo,
  trustOf,
  type InstallOptions,
  installExtension,
  installExtensionFromDir,
  setExtensionEnabled,
  uninstallExtension,
  enabledExtensions,
  filePatternToRegExp,
  checkLine,
} from './store.js';

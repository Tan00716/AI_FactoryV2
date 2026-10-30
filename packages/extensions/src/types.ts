/**
 * @ai-factory/extensions — VS Code-style extension API, local subset (round-6 R6-S1).
 *
 * An extension is a project-local directory:
 *
 *   <root>/.ai-factory/extensions/<name>/extension.json   (manifest)
 *   <root>/.ai-factory/extensions/<name>/main.js          (sandboxed code)
 *   <root>/.ai-factory/extensions/<name>/state.json       ({ enabled: boolean })
 *
 * Four contribution kinds (v1 subset, nothing else):
 *   - commands: declared in the manifest, handler registered from main.js
 *     via api.registerCommand(id, fn). Synchronous, JSON-in/JSON-out.
 *   - panels: purely declarative in the manifest (title + text sections),
 *     rendered read-only by the desktop. No extension HTML, no scripts.
 *   - checkers: purely declarative regex rules in the manifest, evaluated
 *     by the host against file lines (no extension code runs for checks).
 *   - context providers: declared in the manifest, handler registered from
 *     main.js via api.registerContextProvider(id, fn). Synchronous,
 *     query string in, validated item list out.
 *
 * There is no cloud marketplace and no extension auto-update in v1.
 * Extension code runs in a node:vm sandbox (see sandbox.ts); declaring a
 * permission in the manifest does NOT expand the sandbox — permissions
 * are informational metadata validated against a known vocabulary.
 */
export const EXTENSION_NAME_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
export const EXTENSION_VERSION_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?$/;
export const CONTRIBUTION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const PROVIDER_PREFIX_RE = /^@[a-z0-9-]{1,32}$/;
export const MAX_MAIN_BYTES = 256 * 1024;
export const MAX_COMMANDS = 50;
export const MAX_PANELS = 20;
export const MAX_CHECKERS = 20;
export const MAX_PROVIDERS = 20;

export const KNOWN_EXTENSION_PERMISSIONS = [
  'commands.execute',
  'panels.contribute',
  'checkers.contribute',
  'providers.contribute',
] as const;
export type ExtensionPermission = (typeof KNOWN_EXTENSION_PERMISSIONS)[number];

export interface ExtensionCommandDef {
  id: string;
  title: string;
  description?: string;
}

export interface ExtensionPanelSection {
  heading?: string;
  text: string;
}

export interface ExtensionPanelDef {
  id: string;
  title: string;
  sections: ExtensionPanelSection[];
}

export type ExtensionCheckerSeverity = 'error' | 'warning' | 'info';

export interface ExtensionCheckerDef {
  id: string;
  title: string;
  pattern: string;
  /** Only 'i' is honoured; patterns are always evaluated non-globally. */
  flags?: string;
  message: string;
  severity?: ExtensionCheckerSeverity;
  /** Simple glob (* and ?) matched against the forward-slash relative path. */
  filePattern?: string;
}

export interface ExtensionProviderDef {
  id: string;
  prefix: string;
  description?: string;
}

export interface ExtensionContributes {
  commands: ExtensionCommandDef[];
  panels: ExtensionPanelDef[];
  checkers: ExtensionCheckerDef[];
  providers: ExtensionProviderDef[];
}

export type ExtensionReviewClaim = 'unreviewed' | 'reviewed' | 'official';

export interface ExtensionManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  permissions: ExtensionPermission[];
  contributes: ExtensionContributes;
  /**
   * Host extension API version this bundle targets (V3-#9).
   * Missing = legacy (pre-trust-model) bundle: treated as API v1 with a
   * warning, never silently upgraded. A declared major other than 1 is
   * rejected at install and at load — see trust.ts checkApiVersion.
   */
  apiVersion?: string;
  /**
   * Review claim (V3-#9). This is only a claim: the trust layer honours
   * 'reviewed'/'official' only when the bundle carries a valid signature
   * (and 'official' only with the official key). Unsigned claims are
   * downgraded to 'unreviewed' with a warning.
   */
  review?: ExtensionReviewClaim;
}

/** Ed25519 bundle signature, stored beside the bundle in signature.json. */
export interface ExtensionSignature {
  algorithm: 'ed25519';
  /** Base64 SPKI DER public key. */
  publicKey: string;
  /** Base64 signature over the canonical bundle string (trust.ts). */
  signature: string;
}

export type ExtensionSignatureStatus = 'valid' | 'invalid' | 'absent';
export type ExtensionReview = 'official' | 'reviewed' | 'unreviewed';
export type ExtensionTrustSource = 'official' | 'signature' | 'user' | 'local-dev';

/** Trust verdict for one installed bundle (V3-#9). Never a security claim. */
export interface ExtensionTrust {
  apiVersion: string | null;
  legacyApi: boolean;
  signature: ExtensionSignatureStatus;
  review: ExtensionReview;
  trusted: boolean;
  trustSource: ExtensionTrustSource | null;
  bundleSha256: string;
  warnings: string[];
}

export interface ExtensionState {
  enabled: boolean;
}

export interface ExtensionInfo {
  name: string;
  version: string;
  description: string;
  author?: string;
  permissions: ExtensionPermission[];
  enabled: boolean;
  commands: ExtensionCommandDef[];
  panels: ExtensionPanelDef[];
  checkers: ExtensionCheckerDef[];
  providers: ExtensionProviderDef[];
  /** Declared host API version, or null for legacy bundles (V3-#9). */
  apiVersion: string | null;
  /** Trust verdict for the exact installed bundle (V3-#9). */
  trust: ExtensionTrust;
}

export interface ExtensionProviderItem {
  label: string;
  text: string;
}

export class ExtensionError extends Error {}

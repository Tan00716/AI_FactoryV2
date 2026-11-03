/**
 * Extension trust model (V3-#9) — API versioning + bundle signatures +
 * review badges + explicit user trust decisions.
 *
 * What this is NOT: the node:vm sandbox is not a security boundary
 * (see sandbox.ts), and nothing here makes an untrusted bundle safe.
 * Trust here means "this exact bundle is byte-identical to something a
 * key holder signed, or a user explicitly decided to trust" — provenance
 * plus an explicit decision, recorded in trust.json and in the audit log
 * by the route layer. An unsigned bundle is never silently trusted.
 *
 * Rules (also documented in README.md):
 *   - Host extension API is v1. Manifest apiVersion missing = legacy:
 *     treated as v1 with a warning (installed base keeps working).
 *     Declared major != 1 = hard reject at install and at load.
 *   - Default trust behaviour (V3R4-#3, decided by Tan 2026-11-03):
 *     WARN-THEN-CONFIRM. Executing or enabling an untrusted bundle
 *     prompts with an explicit warning (vm sandbox is not a security
 *     boundary, signature status, declared permissions); a per-execution
 *     confirmation runs it once and is audited, and never writes
 *     trust.json. There is no "trust all" switch. The rejected branch
 *     (fail-closed refusal) is archived as declined, not kept as a
 *     parallel track. Invalid signatures stay fail-closed and can
 *     never be warned past.
 *   - Signature: Ed25519 over the canonical bundle string below.
 *     Valid + official key = review 'official', auto-trusted.
 *     Valid + other key = auto-trusted (report rule: signed installs
 *     directly), review 'reviewed' only if claimed.
 *     Invalid = install rejected (tampered bundle is fail-closed, not
 *     "ask" — worse than unsigned). Absent = install requires an
 *     explicit trust decision, except local-dev installs from a
 *     project directory (the author is present; the decision is still
 *     recorded and voided when the bundle hash changes).
 *   - Review claims without a valid signature are ignored (downgraded
 *     to 'unreviewed' with a warning); a claim is not evidence.
 *   - Trust decisions are keyed by bundle hash: any change to
 *     manifest or main.js voids prior trust until re-decided.
 */
import { createHash, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ExtensionError,
  type ExtensionManifest,
  type ExtensionSignature,
  type ExtensionTrust,
  type ExtensionTrustSource,
} from './types.js';

export const EXTENSION_API_VERSION = '1';

/**
 * Official sample-signing public key (base64 SPKI DER). The private key
 * is held outside the repo; demo bundles in demo/ carry signatures made
 * with it. Rotate by replacing this key and re-signing the demos with
 * demo/sign-demo.mjs — old signatures then fail verification, which is
 * the intended fail-closed behaviour.
 */
export const OFFICIAL_PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEAputlUME9aBN2UbEdBRK1uNlcUxXBkB1b19u1r078mVg=';

/** Trust-decision file name inside the extensions home (skipped by listing). */
export const EXTENSION_TRUST_FILE = 'trust.json';
const TRUST_FILE = EXTENSION_TRUST_FILE;
const CANONICAL_PREFIX = 'extension-trust-v1';

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** Canonical bundle string: validated manifest JSON + main.js bytes. */
export function canonicalBundleString(manifest: ExtensionManifest, main: string): string {
  return [
    CANONICAL_PREFIX,
    manifest.name,
    manifest.version,
    sha256Hex(JSON.stringify(manifest)),
    sha256Hex(main),
  ].join('\0');
}

/** Bundle hash recorded in trust decisions (sha256 of the canonical string). */
export function bundleSha256(manifest: ExtensionManifest, main: string): string {
  return sha256Hex(canonicalBundleString(manifest, main));
}

/**
 * Sign a bundle. Returns the signature object to store in signature.json.
 * The public key is derived from the private key, so callers only supply
 * the private key PEM. Throws on a bad key (fail-closed).
 */
export function signBundle(
  manifest: ExtensionManifest,
  main: string,
  privateKeyPem: string,
): ExtensionSignature {
  const publicKey = createPublicKey(privateKeyPem)
    .export({ format: 'der', type: 'spki' })
    .toString('base64');
  const signature = cryptoSign(null, Buffer.from(canonicalBundleString(manifest, main), 'utf8'), privateKeyPem)
    .toString('base64');
  return { algorithm: 'ed25519', publicKey, signature };
}

/** Validate an unknown value as an ExtensionSignature (throws ExtensionError). */
export function parseSignature(input: unknown): ExtensionSignature {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ExtensionError('extension signature must be an object');
  }
  const rec = input as Record<string, unknown>;
  if (rec.algorithm !== 'ed25519') {
    throw new ExtensionError('extension signature.algorithm must be "ed25519"');
  }
  const publicKey = rec.publicKey;
  const signature = rec.signature;
  if (typeof publicKey !== 'string' || publicKey.length === 0 || publicKey.length > 4096) {
    throw new ExtensionError('extension signature.publicKey must be a non-empty string');
  }
  if (typeof signature !== 'string' || signature.length === 0 || signature.length > 4096) {
    throw new ExtensionError('extension signature.signature must be a non-empty string');
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(publicKey) || !/^[A-Za-z0-9+/=]+$/.test(signature)) {
    throw new ExtensionError('extension signature fields must be base64');
  }
  return { algorithm: 'ed25519', publicKey, signature };
}

/** Verify a signature against a bundle. Never throws: any failure is 'false'. */
export function verifyBundleSignature(
  manifest: ExtensionManifest,
  main: string,
  signature: ExtensionSignature,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(signature.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    // One-shot verify: the documented Ed25519 path (algorithm null).
    return cryptoVerify(
      null,
      Buffer.from(canonicalBundleString(manifest, main), 'utf8'),
      key,
      Buffer.from(signature.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * Host API compatibility check. Returns { compatible: true, legacy } or
 * throws ExtensionError for a declared major other than 1. A malformed
 * apiVersion is rejected by manifest validation before this runs.
 */
export function checkApiVersion(manifest: ExtensionManifest): { compatible: true; legacy: boolean } {
  if (manifest.apiVersion === undefined) return { compatible: true, legacy: true };
  const major = manifest.apiVersion.split('.')[0];
  if (major !== EXTENSION_API_VERSION) {
    throw new ExtensionError(
      `extension apiVersion ${manifest.apiVersion} is not supported by this host ` +
        `(host extension API ${EXTENSION_API_VERSION}); the extension must declare apiVersion ${EXTENSION_API_VERSION}.x`,
    );
  }
  return { compatible: true, legacy: false };
}

interface TrustDecision {
  bundleSha256: string;
  source: 'user' | 'local-dev';
  at: string;
}

function trustFilePath(root: string): string {
  return join(root, '.ai-factory', 'extensions', TRUST_FILE);
}

/** Read trust decisions leniently: a corrupt file voids decisions, never crashes listing. */
export function readTrustDecisions(root: string): Record<string, TrustDecision> {
  let raw: string;
  try {
    raw = readFileSync(trustFilePath(root), 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; decisions?: unknown };
    if (parsed.version !== 1 || typeof parsed.decisions !== 'object' || parsed.decisions === null) return {};
    const out: Record<string, TrustDecision> = {};
    for (const [name, d] of Object.entries(parsed.decisions as Record<string, unknown>)) {
      if (typeof d !== 'object' || d === null || Array.isArray(d)) continue;
      const rec = d as Record<string, unknown>;
      if (typeof rec.bundleSha256 !== 'string' || (rec.source !== 'user' && rec.source !== 'local-dev')) continue;
      out[name] = { bundleSha256: rec.bundleSha256, source: rec.source, at: typeof rec.at === 'string' ? rec.at : '' };
    }
    return out;
  } catch {
    return {};
  }
}

function writeTrustDecisions(root: string, decisions: Record<string, TrustDecision>): void {
  const path = trustFilePath(root);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ version: 1, decisions }, null, 2), 'utf8');
  renameSync(tmp, path);
}

/** Record an explicit trust decision for the exact bundle hash. */
export function recordTrust(
  root: string,
  name: string,
  hash: string,
  source: 'user' | 'local-dev',
): void {
  const decisions = readTrustDecisions(root);
  decisions[name] = { bundleSha256: hash, source, at: new Date().toISOString() };
  writeTrustDecisions(root, decisions);
}

/** Remove a trust decision (untrust). Missing entries are a no-op. */
export function revokeTrust(root: string, name: string): void {
  const decisions = readTrustDecisions(root);
  if (!(name in decisions)) return;
  delete decisions[name];
  writeTrustDecisions(root, decisions);
}

/** Compute the trust verdict for one installed bundle. Never throws. */
export function computeTrust(
  root: string,
  name: string,
  manifest: ExtensionManifest,
  main: string,
  signature?: ExtensionSignature,
): ExtensionTrust {
  const hash = bundleSha256(manifest, main);
  const warnings: string[] = [];
  const legacyApi = manifest.apiVersion === undefined;
  if (legacyApi) warnings.push('legacy: no apiVersion declared; treated as host API v1');
  const signatureStatus = signature === undefined ? 'absent' : verifyBundleSignature(manifest, main, signature) ? 'valid' : 'invalid';
  if (signatureStatus === 'invalid') {
    warnings.push('signature verification failed; the bundle may have been tampered with');
  }
  const isOfficial = signatureStatus === 'valid' && signature !== undefined && signature.publicKey === OFFICIAL_PUBLIC_KEY_B64;
  let review: ExtensionTrust['review'] = 'unreviewed';
  if (isOfficial) {
    review = 'official';
  } else if (signatureStatus === 'valid' && manifest.review === 'reviewed') {
    review = 'reviewed';
  } else if (manifest.review === 'official' || manifest.review === 'reviewed') {
    warnings.push(`review claim "${manifest.review}" ignored: bundles without a valid signature carry no review evidence`);
  }
  let trusted = false;
  let trustSource: ExtensionTrustSource | null = null;
  if (isOfficial) {
    trusted = true;
    trustSource = 'official';
  } else if (signatureStatus === 'valid') {
    trusted = true;
    trustSource = 'signature';
  } else {
    const decision = readTrustDecisions(root)[name];
    if (decision !== undefined && decision.bundleSha256 === hash) {
      trusted = true;
      trustSource = decision.source;
    }
  }
  return {
    apiVersion: manifest.apiVersion ?? null,
    legacyApi,
    signature: signatureStatus,
    review,
    trusted,
    trustSource,
    bundleSha256: hash,
    warnings,
  };
}

/** Thrown when an operation needs an explicit trust decision first (maps to 409). */
export class TrustRequiredError extends ExtensionError {
  readonly status = 409;
  readonly trust: ExtensionTrust;
  constructor(name: string, trust: ExtensionTrust) {
    super(
      `extension "${name}" requires an explicit trust decision: ` +
        'it is unsigned and no trust decision covers this exact bundle. ' +
        'Trust it explicitly (POST /api/extensions/:name/trust) or install with { trust: true }.',
    );
    this.name = 'TrustRequiredError';
    this.trust = trust;
  }
}

/**
 * Warn-then-confirm payload (V3R4-#3, Tan decision 2026-11-03: the
 * extension trust default is warn-then-confirm, not fail-closed
 * refusal). Sent with a 409 'trust-confirmation-required' so the UI can
 * render the warning BEFORE the user decides. The warning states the
 * three facts the decision needs: the vm sandbox is not a security
 * boundary, the signature status, and the declared permissions. It
 * never claims the bundle is safe, and it carries no code content.
 */
export interface TrustWarning {
  signature: ExtensionTrust['signature'];
  review: ExtensionTrust['review'];
  bundleSha256: string;
  permissions: string[];
  risks: string[];
}

export function buildTrustWarning(manifest: ExtensionManifest, trust: ExtensionTrust): TrustWarning {
  const risks: string[] = [
    'The node:vm sandbox is NOT a security boundary: it limits the API surface and blocks naive escapes, but cannot make an untrusted extension harmless.',
  ];
  if (trust.signature === 'absent') {
    risks.push('This bundle is unsigned: nothing proves it is byte-identical to what its author shipped.');
  } else if (trust.signature === 'valid') {
    risks.push('This bundle carries a valid signature, but no trust decision covers this exact bundle hash (the bundle changed, or trust was revoked).');
  }
  if (manifest.permissions.length > 0) {
    risks.push(`Declared permissions: ${manifest.permissions.join(', ')}. A permission declaration does not expand the sandbox, but it states what the extension intends to do.`);
  }
  return {
    signature: trust.signature,
    review: trust.review,
    bundleSha256: trust.bundleSha256,
    permissions: [...manifest.permissions],
    risks,
  };
}

/**
 * Thrown when an untrusted (but confirmable) extension is executed
 * without a per-execution confirmation (maps to 409). This is a PROMPT,
 * not a decision: the route layer audits nothing for it. An explicit
 * confirm:true audits EXT_TRUST_CONFIRMED; an explicit confirm:false
 * audits EXT_TRUST_REJECTED. Carries the warning so the UI can render
 * it verbatim.
 */
export class TrustConfirmationRequiredError extends ExtensionError {
  readonly status = 409;
  readonly trust: ExtensionTrust;
  readonly warning: TrustWarning;
  constructor(name: string, manifest: ExtensionManifest, trust: ExtensionTrust) {
    super(
      `extension "${name}" is untrusted: confirm the warning for this single execution ` +
        '(retry with { confirm: true }), or decline it (retry with { confirm: false }). ' +
        'A confirmation covers this one execution only and is recorded in the audit log; it does not grant persistent trust.',
    );
    this.name = 'TrustConfirmationRequiredError';
    this.trust = trust;
    this.warning = buildTrustWarning(manifest, trust);
  }
}

/**
 * Warn-then-confirm gate (V3R4-#3). Returns one of:
 *   'trusted'   — signed or covered by a trust decision: proceed, no audit.
 *   'confirmed' — untrusted but the caller passed confirm:true: proceed
 *                 for THIS execution only. The caller must audit
 *                 EXT_TRUST_CONFIRMED and must NOT write trust.json.
 *   'rejected'  — the caller passed confirm:false: the caller must audit
 *                 EXT_TRUST_REJECTED and refuse the operation.
 *   'prompt'    — no confirm flag: the caller must refuse with
 *                 TrustConfirmationRequiredError (no audit: a prompt is
 *                 not a decision).
 * Throws TrustRequiredError (hard fail-closed, never confirmable) when
 * the signature is INVALID: a tampered bundle cannot be warned past.
 */
export function checkTrustGate(
  name: string,
  manifest: ExtensionManifest,
  trust: ExtensionTrust,
  confirm: unknown,
): 'trusted' | 'confirmed' | 'rejected' | 'prompt' {
  if (trust.trusted) return 'trusted';
  if (trust.signature === 'invalid') throw new TrustRequiredError(name, trust);
  if (confirm === true) return 'confirmed';
  if (confirm === false) return 'rejected';
  return 'prompt';
}

/** Gate helper: throws TrustRequiredError unless the bundle is trusted. */
export function assertTrusted(name: string, trust: ExtensionTrust): void {
  if (!trust.trusted) throw new TrustRequiredError(name, trust);
}

export function trustFileExists(root: string): boolean {
  return existsSync(trustFilePath(root));
}

/**
 * Dev-only build attestations — SPEC v2 §40 (Batch 38).
 *
 * What this is, honestly:
 *
 *  - A DEV path, never production. A build that SUCCEEDED with a locked
 *    §40 digest can be wrapped in an in-toto Statement v1 whose subject
 *    is that digest, signed with Ed25519 (node:crypto, zero external
 *    dependencies). The statement carries `"devOnly": true` and
 *    `"signer": "dev-only"` INSIDE the signed payload, and verification
 *    REFUSES any statement where `devOnly !== true`. The label cannot
 *    be stripped: removing it breaks the signature, and re-signing a
 *    stripped statement still fails verification because the verifier
 *    checks the label first. A production verifier trusts a DIFFERENT
 *    key, so a dev attestation can never be mistaken for production.
 *  - The key comes from `FACTORY_ATTESTATION_KEY` and NOTHING else.
 *    Absent or blank → no key → no attestation → attestationRef stays
 *    null (records absence, exactly like every other §40 field). A
 *    malformed key is a LOUD error, never silently ignored: silently
 *    skipping would mislead the operator into thinking attestation is
 *    on when it is not.
 *  - Accepted key formats: a PEM `-----BEGIN PRIVATE KEY-----` PKCS#8
 *    Ed25519 private key, or a 64-hex-char Ed25519 seed (32 bytes,
 *    dev-friendly single line; encoded to PKCS#8 per RFC 8410 before
 *    import). Anything else → named error. Non-Ed25519 keys → named
 *    error (this module only speaks Ed25519).
 *  - No digest → no attestation. The subject IS the §40 digest; attesting
 *    to "a build happened" without a digest would be a weaker, vaguer
 *    claim than the one this product's §40 evidence actually makes.
 *    createDevAttestation throws on a null/empty digest; the caller
 *    leaves attestationRef null.
 *  - Production signing is NOT implemented here. The key-management
 *    decision (HSM/KMS/sigstore/local PEM with rotation, key registry,
 *    verifier trust roots) belongs to Tan — see KNOWN_LIMITATIONS.
 *
 * Wire format: newline-delimited JSON is NOT used; the envelope is a
 * single JSON document written as `attestation-<buildId>.json` next to
 * the SBOM. Signature is Ed25519 over the canonical JSON (recursive
 * key sort) of the statement object only.
 */

import {
  createPrivateKey,
  createPublicKey,
  createHash,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

/** Env var carrying the dev Ed25519 private key (PEM PKCS#8 or 64-hex seed). */
export const ATTESTATION_KEY_ENV = 'FACTORY_ATTESTATION_KEY';

/** Predicate type URI for dev build attestations. Stable; versioned. */
export const DEV_BUILD_PREDICATE_TYPE =
  'https://ai-factory.local/attestation/dev-build/v1';

/** Envelope marker — what `attestation-<buildId>.json` files contain. */
export const DEV_ATTESTATION_ENVELOPE_TYPE =
  'https://ai-factory.local/attestation/envelope/v1';

/**
 * Batch 38 — filenames the build runner writes:
 * attestation-<buildId>.json where buildId is a randomUUID. Same tight
 * shape contract as SBOM_FILE_RE: retention must only ever touch files
 * matching this shape.
 */
export const ATTESTATION_FILE_RE =
  /^attestation-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

/** Named error for key problems — loud, never silent. */
export class AttestationKeyError extends Error {
  constructor(message: string) {
    super(`attestation key: ${message}`);
    this.name = 'AttestationKeyError';
  }
}

/**
 * Load the dev attestation key from the environment. Returns null when
 * FACTORY_ATTESTATION_KEY is absent or blank — that is the honest
 * "no attestation configured" path, not an error. Throws
 * AttestationKeyError on anything malformed.
 */
export function attestationKeyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): KeyObject | null {
  const raw = (env[ATTESTATION_KEY_ENV] ?? '').trim();
  if (!raw) return null;
  let key: KeyObject;
  if (raw.includes('PRIVATE KEY')) {
    try {
      key = createPrivateKey(raw);
    } catch (err) {
      throw new AttestationKeyError(
        `unparseable PEM private key: ${(err as Error).message}`,
      );
    }
  } else if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    // 32-byte seed → PKCS#8 DER per RFC 8410:
    // 302e020100300506032b657004220420 || seed
    const seed = Buffer.from(raw, 'hex');
    const der = Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      seed,
    ]);
    try {
      key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    } catch (err) {
      throw new AttestationKeyError(
        `seed rejected by crypto: ${(err as Error).message}`,
      );
    }
  } else {
    throw new AttestationKeyError(
      'expected a PEM "-----BEGIN PRIVATE KEY-----" PKCS#8 Ed25519 key ' +
        'or a 64-hex-char Ed25519 seed',
    );
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new AttestationKeyError(
      `not an Ed25519 key (got ${key.asymmetricKeyType ?? 'unknown'}) — ` +
        'this module only signs Ed25519',
    );
  }
  return key;
}

/** The in-toto Statement v1 payload. The devOnly label lives INSIDE. */
export interface AttestationStatement {
  _type: 'https://in-toto.io/Statement/v1';
  predicateType: typeof DEV_BUILD_PREDICATE_TYPE;
  subject: Array<{ name: string; digest: { sha256: string } }>;
  predicate: {
    /** Always true. Verification refuses anything else — the label
     *  cannot be stripped. */
    devOnly: true;
    /** Plaintext, redundant with devOnly: "dev-only". */
    signer: 'dev-only';
    buildId: string;
    revision: string;
    prId: string;
    sourceBranch: string | null;
    targetBranch: string | null;
    exitCode: number;
    /** When the build finished (ISO-8601). */
    builtAt: string;
    /** SBOM file reference, or null when the build produced none. */
    sbomRef: string | null;
  };
}

export interface DevAttestationInput {
  buildId: string;
  revision: string;
  /** The §40 digest — the attestation's subject. Null/empty → throw. */
  digest: string | null;
  prId: string;
  sourceBranch: string | null;
  targetBranch: string | null;
  exitCode: number;
  sbomRef: string | null;
  builtAt?: string;
}

/** The signed envelope written to `attestation-<buildId>.json`. */
export interface DevAttestationEnvelope {
  _type: typeof DEV_ATTESTATION_ENVELOPE_TYPE;
  /** sha256 hex of the SPKI DER public key — identifies the signer. */
  keyId: string;
  /** base64 SPKI DER of the Ed25519 public key. */
  publicKey: string;
  statement: AttestationStatement;
  /** base64 Ed25519 signature over canonicalJson(statement). */
  signature: string;
}

/** Canonical JSON: recursive key sort, arrays keep order. Only the
 *  JSON value types this module produces are supported. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function publicKeyDer(key: KeyObject): Buffer {
  // A private KeyObject cannot export 'spki' directly — derive the
  // public key first.
  return createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer;
}

/**
 * Create and sign a dev attestation for a succeeded build. Throws when
 * digest is null/empty — there is nothing honest to attest to without
 * the §40 digest (the subject). The caller leaves attestationRef null.
 */
export function createDevAttestation(
  key: KeyObject,
  input: DevAttestationInput,
): DevAttestationEnvelope {
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new AttestationKeyError(
      'createDevAttestation requires an Ed25519 private key',
    );
  }
  const digest = (input.digest ?? '').trim();
  if (!digest) {
    throw new Error(
      'refusing to attest without a §40 digest — the digest is the ' +
        'attestation subject; a digest-less attestation would be a vaguer claim',
    );
  }
  const statement: AttestationStatement = {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: DEV_BUILD_PREDICATE_TYPE,
    subject: [{ name: 'build-digest', digest: { sha256: digest } }],
    predicate: {
      devOnly: true,
      signer: 'dev-only',
      buildId: input.buildId,
      revision: input.revision,
      prId: input.prId,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      exitCode: input.exitCode,
      builtAt: input.builtAt ?? new Date().toISOString(),
      sbomRef: input.sbomRef,
    },
  };
  const payload = Buffer.from(canonicalJson(statement), 'utf8');
  const signature = sign(null, payload, key);
  const pubDer = publicKeyDer(key);
  return {
    _type: DEV_ATTESTATION_ENVELOPE_TYPE,
    keyId: createHash('sha256').update(pubDer).digest('hex'),
    publicKey: pubDer.toString('base64'),
    statement,
    signature: signature.toString('base64'),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Verify a dev attestation envelope. Returns true only when ALL hold:
 *  - the envelope shape is right;
 *  - statement._type / predicateType are the expected URIs;
 *  - statement.predicate.devOnly === true (the label cannot be
 *    stripped: a re-signed stripped statement still fails here);
 *  - the Ed25519 signature over canonicalJson(statement) verifies
 *    against the envelope's own publicKey.
 * Never throws — a failed verification is a normal outcome, reported
 * as false. (Trusting the envelope's embedded publicKey is correct
 * for the DEV path: the key is self-asserted. Production verification
 * must pin an expected keyId — that is Tan's key-management decision.)
 */
export function verifyDevAttestation(envelope: unknown): boolean {
  try {
    if (!isRecord(envelope)) return false;
    if (envelope['_type'] !== DEV_ATTESTATION_ENVELOPE_TYPE) return false;
    const statement = envelope['statement'];
    if (!isRecord(statement)) return false;
    if (statement['_type'] !== 'https://in-toto.io/Statement/v1') return false;
    if (statement['predicateType'] !== DEV_BUILD_PREDICATE_TYPE) return false;
    const predicate = statement['predicate'];
    if (!isRecord(predicate)) return false;
    // The dev-only label is enforced by the verifier, not just by the
    // signature: stripping it (even with a fresh signature) fails here.
    if (predicate['devOnly'] !== true) return false;
    if (predicate['signer'] !== 'dev-only') return false;
    const subjects = statement['subject'];
    if (!Array.isArray(subjects) || subjects.length === 0) return false;
    const pubB64 = envelope['publicKey'];
    const sigB64 = envelope['signature'];
    if (typeof pubB64 !== 'string' || typeof sigB64 !== 'string') return false;
    const pubDer = Buffer.from(pubB64, 'base64');
    const sig = Buffer.from(sigB64, 'base64');
    if (pubDer.length === 0 || sig.length === 0) return false;
    // keyId must match the embedded public key — otherwise the envelope
    // could swap keys under a borrowed keyId.
    const keyId = envelope['keyId'];
    if (typeof keyId !== 'string') return false;
    if (createHash('sha256').update(pubDer).digest('hex') !== keyId) return false;
    const pubKey = createPublicKey({ key: pubDer, format: 'der', type: 'spki' });
    if (pubKey.asymmetricKeyType !== 'ed25519') return false;
    const payload = Buffer.from(canonicalJson(statement), 'utf8');
    return verify(null, payload, pubKey, sig);
  } catch {
    return false;
  }
}

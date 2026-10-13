/**
 * Dev-only build attestations — SPEC v2 §40 (Batch 38).
 *
 * What this pins:
 *  - a configured dev key signs a real Ed25519 attestation whose
 *    subject is the §40 digest, and it verifies (PEM and 64-hex-seed
 *    key formats);
 *  - flipping one byte of the signed statement breaks verification;
 *  - no FACTORY_ATTESTATION_KEY → null (absence, not an error);
 *  - a malformed key or a non-Ed25519 key is a LOUD AttestationKeyError,
 *    never silently ignored;
 *  - the dev-only label cannot be stripped: deleting devOnly (even
 *    with a fresh signature from the same key) fails verification;
 *  - no digest → createDevAttestation refuses (nothing to attest to);
 *  - canonicalJson is deterministic (key order independent).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import {
  ATTESTATION_KEY_ENV,
  AttestationKeyError,
  DEV_BUILD_PREDICATE_TYPE,
  attestationKeyFromEnv,
  canonicalJson,
  createDevAttestation,
  verifyDevAttestation,
  type DevAttestationEnvelope,
  type DevAttestationInput,
} from '../src/attestation';

const DIGEST =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function devKeypairPem(): { pem: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  return {
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
}

function input(overrides: Partial<DevAttestationInput> = {}): DevAttestationInput {
  return {
    buildId: '11111111-2222-3333-4444-555555555555',
    revision: 'abc123def456',
    digest: DIGEST,
    prId: 'pr-7',
    sourceBranch: 'feature/x',
    targetBranch: 'main',
    exitCode: 0,
    sbomRef: '/tmp/sboms/sbom-11111111-2222-3333-4444-555555555555.json',
    builtAt: '2026-10-13T00:00:00.000Z',
    ...overrides,
  };
}

describe('attestationKeyFromEnv', () => {
  it('absent or blank → null (absence, not an error)', () => {
    assert.equal(attestationKeyFromEnv({}), null);
    assert.equal(attestationKeyFromEnv({ [ATTESTATION_KEY_ENV]: '   ' }), null);
  });

  it('accepts a PEM PKCS#8 Ed25519 private key', () => {
    const { pem } = devKeypairPem();
    const key = attestationKeyFromEnv({ [ATTESTATION_KEY_ENV]: pem });
    assert.ok(key);
    assert.equal(key.asymmetricKeyType, 'ed25519');
  });

  it('accepts a 64-hex-char Ed25519 seed', () => {
    const seed = randomBytes(32).toString('hex');
    assert.equal(seed.length, 64);
    const key = attestationKeyFromEnv({ [ATTESTATION_KEY_ENV]: seed });
    assert.ok(key);
    assert.equal(key.asymmetricKeyType, 'ed25519');
  });

  it('garbage → AttestationKeyError, never silently ignored', () => {
    assert.throws(
      () => attestationKeyFromEnv({ [ATTESTATION_KEY_ENV]: 'not-a-key' }),
      (e: unknown) => e instanceof AttestationKeyError,
    );
    assert.throws(
      () =>
        attestationKeyFromEnv({
          [ATTESTATION_KEY_ENV]: 'deadbeef', // too short for a seed
        }),
      (e: unknown) => e instanceof AttestationKeyError,
    );
  });

  it('non-Ed25519 key → AttestationKeyError', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    assert.throws(
      () => attestationKeyFromEnv({ [ATTESTATION_KEY_ENV]: pem }),
      (e: unknown) =>
        e instanceof AttestationKeyError && /Ed25519/.test(e.message),
    );
  });
});

describe('createDevAttestation / verifyDevAttestation', () => {
  it('signs and verifies: subject is the §40 digest, dev-only is plaintext', () => {
    const { pem } = devKeypairPem();
    const key = attestationKeyFromEnv({ [ATTESTATION_KEY_ENV]: pem })!;
    const env = createDevAttestation(key, input());
    assert.equal(env.statement._type, 'https://in-toto.io/Statement/v1');
    assert.equal(env.statement.predicateType, DEV_BUILD_PREDICATE_TYPE);
    assert.deepEqual(env.statement.subject, [
      { name: 'build-digest', digest: { sha256: DIGEST } },
    ]);
    assert.equal(env.statement.predicate.devOnly, true);
    assert.equal(env.statement.predicate.signer, 'dev-only');
    assert.ok(env.signature.length > 0);
    assert.ok(env.publicKey.length > 0);
    assert.ok(/^[0-9a-f]{64}$/.test(env.keyId));
    assert.equal(verifyDevAttestation(env), true);
  });

  it('seed-format key also signs verifiably', () => {
    const seed = randomBytes(32).toString('hex');
    const key = attestationKeyFromEnv({ [ATTESTATION_KEY_ENV]: seed })!;
    const env = createDevAttestation(key, input());
    assert.equal(verifyDevAttestation(env), true);
  });

  it('flipping one byte of the statement breaks verification', () => {
    const { pem } = devKeypairPem();
    const key = attestationKeyFromEnv({ [ATTESTATION_KEY_ENV]: pem })!;
    const env = createDevAttestation(key, input());
    const tampered: DevAttestationEnvelope = structuredClone(env);
    // One-byte change inside the SIGNED payload, signature untouched.
    tampered.statement.predicate.exitCode = 1;
    assert.equal(verifyDevAttestation(tampered), false);
  });

  it('the dev-only label cannot be stripped — even with a fresh signature', () => {
    const { pem } = devKeypairPem();
    const key = attestationKeyFromEnv({ [ATTESTATION_KEY_ENV]: pem })!;
    const env = createDevAttestation(key, input());

    // (a) Strip the label, keep the original signature → must fail
    // (signature no longer matches, and the label gate also fires).
    const stripped: DevAttestationEnvelope = structuredClone(env);
    delete (stripped.statement.predicate as unknown as Record<string, unknown>)[
      'devOnly'
    ];
    assert.equal(verifyDevAttestation(stripped), false);

    // (b) Strip the label AND re-sign the stripped statement with the
    // same dev key (attacker holds the dev key). The signature is now
    // cryptographically valid for the stripped statement — the verifier
    // must still reject it because devOnly !== true.
    const resigned: DevAttestationEnvelope = structuredClone(env);
    delete (resigned.statement.predicate as unknown as Record<string, unknown>)[
      'devOnly'
    ];
    const payload = Buffer.from(canonicalJson(resigned.statement), 'utf8');
    resigned.signature = cryptoSign(null, payload, key).toString('base64');
    assert.equal(verifyDevAttestation(resigned), false);

    // (c) devOnly explicitly false → rejected too.
    const falsy: DevAttestationEnvelope = structuredClone(env);
    (falsy.statement.predicate as unknown as Record<string, unknown>)['devOnly'] =
      false;
    assert.equal(verifyDevAttestation(falsy), false);
  });

  it('keyId must match the embedded public key', () => {
    const { pem } = devKeypairPem();
    const key = attestationKeyFromEnv({ [ATTESTATION_KEY_ENV]: pem })!;
    const env = createDevAttestation(key, input());
    const swapped: DevAttestationEnvelope = structuredClone(env);
    swapped.keyId = 'f'.repeat(64);
    assert.equal(verifyDevAttestation(swapped), false);
  });

  it('a different key cannot verify the envelope', () => {
    const { pem } = devKeypairPem();
    const key = attestationKeyFromEnv({ [ATTESTATION_KEY_ENV]: pem })!;
    const env = createDevAttestation(key, input());
    const other = devKeypairPem();
    const otherKey = attestationKeyFromEnv({
      [ATTESTATION_KEY_ENV]: other.pem,
    })!;
    const otherEnv = createDevAttestation(otherKey, input());
    // Transplant the attacker's public key + keyId but keep the
    // victim's signature: verification must fail.
    const forged: DevAttestationEnvelope = structuredClone(env);
    forged.publicKey = otherEnv.publicKey;
    forged.keyId = otherEnv.keyId;
    assert.equal(verifyDevAttestation(forged), false);
  });

  it('refuses to attest without a digest', () => {
    const { pem } = devKeypairPem();
    const key = attestationKeyFromEnv({ [ATTESTATION_KEY_ENV]: pem })!;
    assert.throws(
      () => createDevAttestation(key, input({ digest: null })),
      /without a §40 digest/,
    );
    assert.throws(
      () => createDevAttestation(key, input({ digest: '   ' })),
      /without a §40 digest/,
    );
  });

  it('garbage envelopes verify false, never throw', () => {
    assert.equal(verifyDevAttestation(null), false);
    assert.equal(verifyDevAttestation({}), false);
    assert.equal(verifyDevAttestation('nope'), false);
    assert.equal(
      verifyDevAttestation({ _type: 'https://in-toto.io/Statement/v1' }),
      false,
    );
  });
});

describe('canonicalJson', () => {
  it('is deterministic regardless of key insertion order', () => {
    const a = canonicalJson({ z: 1, a: { y: [3, 2], b: 'x' } });
    const b = canonicalJson({ a: { b: 'x', y: [3, 2] }, z: 1 });
    assert.equal(a, b);
    assert.equal(a, '{"a":{"b":"x","y":[3,2]},"z":1}');
  });
});

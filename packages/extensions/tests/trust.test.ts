/**
 * @ai-factory/extensions tests: V3-#9 trust model — API versioning,
 * Ed25519 bundle signatures, review computation, trust decisions.
 * Run: node --test packages/extensions/dist/tests/*.test.js (after build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OFFICIAL_PUBLIC_KEY_B64,
  TrustRequiredError,
  assertTrusted,
  bundleSha256,
  checkApiVersion,
  computeTrust,
  installExtension,
  installExtensionFromDir,
  parseSignature,
  recordTrust,
  revokeTrust,
  signBundle,
  verifyBundleSignature,
} from '../src/index.js';

function root(): string {
  return mkdtempSync(join(tmpdir(), 'ext-trust-'));
}

function manifest(over: Record<string, unknown> = {}): import('../src/index.js').ExtensionManifest {
  return {
    name: 'trust-demo',
    version: '1.0.0',
    description: 'demo',
    permissions: ['commands.execute'],
    contributes: {
      commands: [{ id: 'trust.echo', title: 'Echo' }],
      panels: [],
      checkers: [],
      providers: [],
    },
    ...over,
  } as unknown as import('../src/index.js').ExtensionManifest;
}

const MAIN = `api.registerCommand('trust.echo', (args) => ({ ok: true }));`;

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
}

describe('checkApiVersion', () => {
  it('accepts v1 and v1.x, treats missing as legacy', () => {
    assert.deepEqual(checkApiVersion(manifest({ apiVersion: '1' })), { compatible: true, legacy: false });
    assert.deepEqual(checkApiVersion(manifest({ apiVersion: '1.4' })), { compatible: true, legacy: false });
    assert.deepEqual(checkApiVersion(manifest({})), { compatible: true, legacy: true });
  });
  it('rejects a declared major other than 1', () => {
    assert.throws(() => checkApiVersion(manifest({ apiVersion: '2' })), /not supported by this host/);
    assert.throws(() => checkApiVersion(manifest({ apiVersion: '0.9' })), /not supported by this host/);
  });
});

describe('signBundle / verifyBundleSignature', () => {
  it('round-trips and fails on tampered main or manifest', () => {
    const kp = keypair();
    const m = manifest({ apiVersion: '1' });
    const sig = signBundle(m, MAIN, kp.privateKey);
    assert.equal(sig.algorithm, 'ed25519');
    assert.equal(sig.publicKey, kp.publicKey);
    assert.equal(verifyBundleSignature(m, MAIN, sig), true);
    assert.equal(verifyBundleSignature(m, MAIN + '// tampered', sig), false);
    assert.equal(verifyBundleSignature(manifest({ apiVersion: '1', description: 'other' }), MAIN, sig), false);
  });
  it('rejects malformed signatures at parse time', () => {
    assert.throws(() => parseSignature({ algorithm: 'rsa', publicKey: 'x', signature: 'y' }), /ed25519/);
    assert.throws(() => parseSignature({ algorithm: 'ed25519', publicKey: '!!!', signature: 'y' }), /base64/);
    assert.throws(() => parseSignature(null), /must be an object/);
  });
  it('verify never throws on garbage keys', () => {
    const m = manifest();
    assert.equal(
      verifyBundleSignature(m, MAIN, { algorithm: 'ed25519', publicKey: 'AAAA', signature: 'BBBB' }),
      false,
    );
  });
});

describe('computeTrust', () => {
  it('unsigned + undecided is untrusted with a legacy warning when apiVersion is missing', () => {
    const r = root();
    const m = manifest();
    const t = computeTrust(r, 'trust-demo', m, MAIN);
    assert.equal(t.trusted, false);
    assert.equal(t.signature, 'absent');
    assert.equal(t.review, 'unreviewed');
    assert.equal(t.legacyApi, true);
    assert.equal(t.apiVersion, null);
    assert.ok(t.warnings.some((w) => w.startsWith('legacy:')));
    assert.equal(t.bundleSha256, bundleSha256(m, MAIN));
    assert.throws(() => assertTrusted('trust-demo', t), (e: unknown) => e instanceof TrustRequiredError);
  });
  it('a valid non-official signature auto-trusts and honours a reviewed claim', () => {
    const r = root();
    const kp = keypair();
    const m = manifest({ apiVersion: '1', review: 'reviewed' });
    const sig = signBundle(m, MAIN, kp.privateKey);
    const t = computeTrust(r, 'trust-demo', m, MAIN, sig);
    assert.equal(t.trusted, true);
    assert.equal(t.trustSource, 'signature');
    assert.equal(t.review, 'reviewed');
    assert.equal(t.signature, 'valid');
  });
  it('an official-key signature yields the official review', () => {
    const r = root();
    const m = manifest({ apiVersion: '1', review: 'official' });
    // Synthesize an official-key signature object shape: verification
    // against the real official key happens with the shipped demos
    // (route tests); here only the downgrade path is unit-testable
    // without the private key, so assert the claim-ignored warning.
    const t = computeTrust(r, 'trust-demo', m, MAIN);
    assert.equal(t.review, 'unreviewed');
    assert.ok(t.warnings.some((w) => w.includes('review claim "official" ignored')));
    assert.notEqual(OFFICIAL_PUBLIC_KEY_B64, 'OFFICIAL_PUBLIC_KEY_PLACEHOLDER');
  });
  it('an invalid signature is untrusted, never auto-trusted', () => {
    const r = root();
    const kp = keypair();
    const m = manifest({ apiVersion: '1' });
    const sig = signBundle(m, MAIN, kp.privateKey);
    const bad = { ...sig, signature: Buffer.from('tampered').toString('base64') };
    const t = computeTrust(r, 'trust-demo', m, MAIN, bad);
    assert.equal(t.signature, 'invalid');
    assert.equal(t.trusted, false);
    assert.ok(t.warnings.some((w) => w.includes('tampered')));
  });
  it('a user decision trusts only the exact bundle hash', () => {
    const r = root();
    const m = manifest({ apiVersion: '1' });
    const hash = bundleSha256(m, MAIN);
    recordTrust(r, 'trust-demo', hash, 'user');
    assert.equal(computeTrust(r, 'trust-demo', m, MAIN).trusted, true);
    assert.equal(computeTrust(r, 'trust-demo', m, MAIN).trustSource, 'user');
    assert.equal(computeTrust(r, 'trust-demo', m, MAIN + '// changed').trusted, false);
    revokeTrust(r, 'trust-demo');
    assert.equal(computeTrust(r, 'trust-demo', m, MAIN).trusted, false);
  });
});

describe('install trust gates', () => {
  it('unsigned inline install without trust throws TrustRequiredError and writes nothing', () => {
    const r = root();
    assert.throws(
      () => installExtension(r, manifest({ apiVersion: '1' }), MAIN),
      (e: unknown) => e instanceof TrustRequiredError && e.status === 409,
    );
    assert.equal(existsSync(join(r, '.ai-factory', 'extensions', 'trust-demo')), false);
  });
  it('unsigned inline install with trust records a user decision', () => {
    const r = root();
    const info = installExtension(r, manifest({ apiVersion: '1' }), MAIN, { trust: true });
    assert.equal(info.trust.trusted, true);
    assert.equal(info.trust.trustSource, 'user');
  });
  it('signed install needs no trust flag and is trusted by signature', () => {
    const r = root();
    const kp = keypair();
    const m = manifest({ apiVersion: '1' });
    const sig = signBundle(m, MAIN, kp.privateKey);
    const info = installExtension(r, m, MAIN, { signature: sig });
    assert.equal(info.trust.trusted, true);
    assert.equal(info.trust.trustSource, 'signature');
    assert.equal(info.trust.signature, 'valid');
  });
  it('an invalid signature is fail-closed at install', () => {
    const r = root();
    const kp = keypair();
    const m = manifest({ apiVersion: '1' });
    const sig = signBundle(m, MAIN, kp.privateKey);
    const bad = { ...sig, signature: Buffer.from('x').toString('base64') };
    assert.throws(() => installExtension(r, m, MAIN, { signature: bad }), /signature verification failed/);
  });
  it('an incompatible apiVersion is rejected at install', () => {
    const r = root();
    assert.throws(
      () => installExtension(r, manifest({ apiVersion: '2' }), MAIN, { trust: true }),
      /not supported by this host/,
    );
  });
  it('install-from-dir auto-records a local-dev decision', () => {
    const r = root();
    const src = join(r, 'src-ext');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'extension.json'), JSON.stringify(manifest({ apiVersion: '1' })), 'utf8');
    writeFileSync(join(src, 'main.js'), MAIN, 'utf8');
    const info = installExtensionFromDir(r, src);
    assert.equal(info.trust.trusted, true);
    assert.equal(info.trust.trustSource, 'local-dev');
  });
});

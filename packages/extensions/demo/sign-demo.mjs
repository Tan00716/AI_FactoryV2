/**
 * Re-sign the official demo extensions (V3-#9 dev tool, not a product path).
 *
 * Usage:
 *   node packages/extensions/demo/sign-demo.mjs <private-key-pem-file> [demo-dir ...]
 *
 * The private key is NEVER stored in the repo: the holder runs this script
 * with a key file outside the repo, it writes signature.json next to each
 * demo's extension.json, and the public key must match OFFICIAL_PUBLIC_KEY_B64
 * in src/trust.ts. If the key rotates, update that constant and re-sign.
 * Requires a built package (node packages/extensions/dist/... imports).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateManifest, validateMainSource, signBundle } from '../dist/src/index.js';

const keyFile = process.argv[2];
if (!keyFile) {
  console.error('usage: sign-demo.mjs <private-key-pem-file> [demo-dir ...]');
  process.exit(2);
}
const privateKey = readFileSync(resolve(keyFile), 'utf8');
const dirs = process.argv.slice(3);
const demos = dirs.length > 0 ? dirs : ['hello-command', 'info-panel', 'marker-checker', 'demo-notes'];
for (const dir of demos) {
  const abs = resolve(dir);
  const manifest = validateManifest(JSON.parse(readFileSync(join(abs, 'extension.json'), 'utf8')));
  const main = validateMainSource(readFileSync(join(abs, 'main.js'), 'utf8'));
  const sig = signBundle(manifest, main, privateKey);
  writeFileSync(join(abs, 'signature.json'), JSON.stringify(sig, null, 2) + '\n', 'utf8');
  console.log(`${manifest.name}: signed (publicKey ${sig.publicKey.slice(0, 24)}...)`);
}
console.log('public key (must equal OFFICIAL_PUBLIC_KEY_B64 in src/trust.ts):');
console.log(JSON.parse(readFileSync(join(resolve(demos[0]), 'signature.json'), 'utf8')).publicKey);

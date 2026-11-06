/**
 * Fixture for v3r18-6mn.test.ts (V3.0 audit round 18, #6(m)) — the flaky
 * vault-read probe. The test NAME encodes the probe outcome, because
 * POST /api/flaky/runs returns parsed TAP outcomes (not raw stdout):
 *   vault-probe-NO_POINTER_VAR    — the child env has no FACTORY_SECRETS_DIR
 *   vault-probe-VAULT_READ_OK     — the child read vault.json (LEAK)
 *   vault-probe-VAULT_READ_FAILED — the child named the dir but could not read it
 *
 * NOTE: this file is intentionally NOT named *.test.* — it must never be
 * picked up by the real `npm run test:server` glob. It is only executed
 * by v3r18-6mn.test.ts via POST /api/flaky/runs.
 */
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const dir = process.env.FACTORY_SECRETS_DIR;
let outcome = 'NO_POINTER_VAR';
if (dir) {
  try {
    fs.readFileSync(path.join(dir, 'vault.json'), 'utf8');
    outcome = 'VAULT_READ_OK';
  } catch (e) {
    outcome = 'VAULT_READ_FAILED';
  }
}

test('vault-probe-' + outcome, () => {});

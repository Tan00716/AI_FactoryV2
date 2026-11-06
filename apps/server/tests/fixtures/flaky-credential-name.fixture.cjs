/**
 * Fixture for flaky.test.ts (R16 N3) — the test name is built from the
 * ambient credential env. With the runTapFile scrub the child sees no
 * FACTORY_API_TOKEN and the name becomes 'TOK=undefined'; without the
 * scrub it would echo the real value into tests[].key/name.
 *
 * NOTE: this file is intentionally NOT named *.test.* — it must never be
 * picked up by the real `npm run test:server` glob. It is only executed
 * by flaky.test.ts via an explicit child-process spawn / POST
 * /api/flaky/runs.
 */
const { test } = require('node:test');

test('TOK=' + process.env.FACTORY_API_TOKEN, () => {});

/**
 * markers.test.ts — OSC 133 marker scanning + rcfile generation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findMarkers,
  generateBashIntegrationRc,
  bashIntegrationWrapper,
  INTEGRATION_ENV_VAR,
  INTEGRATION_RC_PATH,
} from '../src/index.js';

const ESC = '\x1b';

function marker(kind: string, payload = ''): string {
  return `${ESC}]133;${kind}${payload ? `;${payload}` : ''}${ESC}\\`;
}

describe('findMarkers', () => {
  it('finds markers in order with payloads', () => {
    const text = `prompt${marker('A')} $ ${marker('B')}echo hi${marker('C')}${marker('D', '0')}${marker('H', 'ZWNobyBoaQ==')}`;
    const ms = findMarkers(text);
    assert.deepEqual(ms.map((m) => m.kind), ['A', 'B', 'C', 'D', 'H']);
    assert.equal(ms[3].payload, '0');
    assert.equal(ms[4].payload, 'ZWNobyBoaQ==');
    assert.ok(ms[0].index < ms[1].index);
  });

  it('accepts BEL terminator', () => {
    const ms = findMarkers(`${ESC}]133;D;3`);
    assert.equal(ms.length, 1);
    assert.equal(ms[0].kind, 'D');
    assert.equal(ms[0].payload, '3');
  });

  it('ignores a marker split at the buffer end (no terminator yet)', () => {
    const partial = `${ESC}]133;D`;
    assert.deepEqual(findMarkers(partial), []);
    const partial2 = `${ESC}]133;H;ZWNoby`;
    assert.deepEqual(findMarkers(partial2), []);
  });

  it('ignores unknown kinds', () => {
    assert.deepEqual(findMarkers(marker('Z', 'x')), []);
  });

  it('empty payload marker (H;) parses', () => {
    const ms = findMarkers(marker('H'));
    assert.equal(ms.length, 1);
    assert.equal(ms[0].kind, 'H');
    assert.equal(ms[0].payload, '');
  });
});

describe('generateBashIntegrationRc', () => {
  it('contains the integration essentials', () => {
    const rc = generateBashIntegrationRc();
    assert.match(rc, /PROMPT_COMMAND="__af_precmd/);
    assert.match(rc, /trap '__af_debug' DEBUG/);
    assert.match(rc, /133;%s/); // __af_osc adds the 133; prefix at runtime
    assert.match(rc, /"D;\$ec"/);
    assert.match(rc, /fc -ln -1/);
    assert.match(rc, /__af_osc B/);
    assert.match(rc, /\. "\$HOME\/\.bashrc"/);
    assert.match(rc, /BASH_COMMAND/);
    // no raw control characters leak into the generated script
    assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(rc), 'rc must be plain text');
  });
});

describe('bashIntegrationWrapper', () => {
  it('wraps bash with an rcfile bootstrap via env', () => {
    const argv = bashIntegrationWrapper('/bin/bash');
    assert.equal(argv[0], '/bin/bash');
    assert.equal(argv[1], '-c');
    assert.match(argv[2], /--rcfile/);
    assert.match(argv[2], new RegExp(INTEGRATION_ENV_VAR));
    assert.match(argv[2], new RegExp(INTEGRATION_RC_PATH.replace(/\//g, '\\/')));
    assert.match(argv[2], /exec \/bin\/bash/);
  });
});

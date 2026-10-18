/**
 * W-C exec-policy hardening regression tests (H3-A2 probes, confirmed live).
 *
 * What this pins (policy-check only — NOTHING here executes a command):
 *
 *  A. node inline eval is refused: `node -e/--eval/-p/--print` used to
 *     pass the whitelist (first token `node`) while running arbitrary
 *     JS as the server user — unauditable RCE. Still allowed only via
 *     the explicit { allowInlineEval: true } opt, which exists for the
 *     operator-configured FACTORY_BUILD_COMMAND (build-runner) whose
 *     test-suite uses `node -e` commands.
 *  B. npx remote fetch is refused: `npx <pkg>` downloads and executes
 *     registry code (the curl/wget class). `--no-install` / `--offline`
 *     (local binaries only) stay allowed.
 *  C. git config-injection surface is refused: `-c/--config`
 *     (core.pager=… → command execution), `--exec-path=` (subcommand
 *     binary hijack), `ext::` transport, `protocol.ext.allow` override.
 *     Plain `git status` / `git log` stay allowed.
 *  D. checkAiShellLine (AI terminal line gate): unquoted shell
 *     metacharacters (`, $, <, >, (, ), lone &) are denied — the old
 *     gate ran checkCommandPolicy, which assumes no shell, while the
 *     pty runs bash -i, so `echo $(id)` / `echo a; id` sailed through
 *     and bash executed the smuggled commands. Pipelines/chains split
 *     on unquoted ; | && || still work when EVERY segment passes the
 *     policy alone; quoted metacharacters stay inert.
 *
 * Imports the COMPILED ../dist/routes/exec.js (dual-mode rule: the src
 * module value-imports the sibling '../redaction-monitor' extensionless,
 * so src-direct import would break under node type-stripping).
 * Requires the workspace build (root `npm run build`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkCommandPolicy,
  checkAiShellLine,
  ExecPolicyDenied,
} from '../dist/routes/exec.js';

function denied(fn: () => unknown): ExecPolicyDenied {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ExecPolicyDenied, `expected ExecPolicyDenied, got ${(e as Error)?.constructor?.name}`);
    return e as ExecPolicyDenied;
  }
  assert.fail('expected the command to be refused');
}

function allowed(fn: () => unknown): unknown {
  return fn();
}

describe('W-C: node inline eval', () => {
  for (const cmd of ['node -e "process.exit(0)"', 'node --eval "1+1"', 'node -p "1+1"', 'node --print "1+1"']) {
    it(`refuses ${cmd.split(' ')[1]}`, () => {
      const err = denied(() => checkCommandPolicy(cmd));
      assert.match(err.reason, /inline eval/);
    });
  }
  it('allows node script files', () => {
    allowed(() => checkCommandPolicy('node scripts/build.js'));
  });
  it('allows inline eval only via the explicit operator opt (build-runner)', () => {
    allowed(() => checkCommandPolicy('node -e "process.exit(0)"', { allowInlineEval: true }));
  });
});

describe('W-C: npx remote fetch', () => {
  for (const cmd of ['npx some-pkg', 'npx -y some-pkg', 'npx --yes create-next-app']) {
    it(`refuses ${cmd}`, () => {
      const err = denied(() => checkCommandPolicy(cmd));
      assert.match(err.reason, /download/);
    });
  }
  it('allows npx --no-install (local binaries only)', () => {
    allowed(() => checkCommandPolicy('npx --no-install tsc --version'));
  });
  it('allows npx --offline', () => {
    allowed(() => checkCommandPolicy('npx --offline jest --listTests'));
  });
});

describe('W-C: git config-injection surface', () => {
  const cases: Array<[string, RegExp]> = [
    ['git -c core.pager=touch /tmp/pwn log --oneline', /-c\/--config/],
    ['git --config core.editor=evil status', /-c\/--config/],
    ['git --exec-path=/tmp/evil status', /exec-path/],
    ['git clone ext::sh -c id', /ext::/],
    ['git -c protocol.ext.allow=always clone ext::x', /-c\/--config/],
  ];
  for (const [cmd, re] of cases) {
    it(`refuses: ${cmd.slice(0, 44)}`, () => {
      const err = denied(() => checkCommandPolicy(cmd));
      assert.match(err.reason, re);
    });
  }
  it('allows plain git subcommands', () => {
    allowed(() => checkCommandPolicy('git status'));
    allowed(() => checkCommandPolicy('git log --oneline'));
    allowed(() => checkCommandPolicy('git diff --stat'));
  });
});

describe('W-C: checkAiShellLine (AI terminal line gate)', () => {
  const smuggled: Array<[string, string]> = [
    ['echo $(id)', 'command substitution'],
    ['echo `id`', 'backticks'],
    ['echo $HOME', 'expansion'],
    ['echo ${PATH}', 'expansion'],
    ['echo hi > /tmp/x', 'redirection'],
    ['cat < /etc/passwd', 'redirection'],
    ['sleep 5 &', 'backgrounding'],
    ['echo (sub)', 'subshell parens'],
    ['node -e "evil()"', 'inline eval via segment'],
    ['echo ok; rm -rf /', 'denied segment in chain'],
  ];
  for (const [line, what] of smuggled) {
    it(`denies ${what}: ${line}`, () => {
      denied(() => checkAiShellLine(line));
    });
  }

  it('allows pipelines when every segment passes alone', () => {
    const segs = allowed(() => checkAiShellLine('git log --oneline | head -5')) as string[][];
    assert.equal(segs.length, 2);
    assert.deepEqual(segs[0][0], 'git');
    assert.deepEqual(segs[1][0], 'head');
  });
  it('allows ; && || chains when every segment passes alone', () => {
    assert.equal((allowed(() => checkAiShellLine('echo a; echo b')) as string[][]).length, 2);
    assert.equal((allowed(() => checkAiShellLine('echo a && echo b || echo c')) as string[][]).length, 3);
  });
  it('treats quoted metacharacters as inert', () => {
    const segs = allowed(() => checkAiShellLine('echo "a;b"')) as string[][];
    assert.equal(segs.length, 1);
  });
  it('denies empty lines', () => {
    denied(() => checkAiShellLine('   '));
  });
  it('still denies non-whitelisted binaries per segment', () => {
    denied(() => checkAiShellLine('echo hi | evil-bin'));
  });
});

describe('W-C: pre-existing policy behavior unchanged', () => {
  it('still denies rm outright', () => {
    denied(() => checkCommandPolicy('rm -rf /'));
  });
  it('still allows the read-only set', () => {
    allowed(() => checkCommandPolicy('ls -la'));
    allowed(() => checkCommandPolicy('npm --version'));
  });
  it('still denies empty commands', () => {
    denied(() => checkCommandPolicy('   '));
  });
});

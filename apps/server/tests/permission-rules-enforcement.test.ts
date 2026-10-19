/**
 * Declarative allow/ask/deny permission rules — server enforcement.
 *
 * What this pins:
 *  1. A deny rule at the tool-runner choke point refuses the call with a
 *     PERMISSION_DENIED_BY_RULE marker — even when the executor's
 *     approval gate is in full bypass/auto-approve mode (the runner
 *     refuses AFTER any upstream approval decision).
 *  2. An ask rule fails closed with APPROVAL_REQUIRED (no silent pass,
 *     no fake approval — this surface has no interactive approval path).
 *  3. No matching rule → default behavior unchanged (runtime.echo still
 *     succeeds).
 *  4. Three layers merge (project → personal → global); deny always wins.
 *  5. Rules hot-reload on file mtime change; a corrupt layer is skipped
 *     (loud) while other layers keep enforcing.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ToolExecutor,
  ToolRegistry,
  registerBuiltinTools,
  type ToolCall,
} from '@ai-factory/tools';
import { createServerToolRunner } from '../dist/tool-runner.js';
import {
  permissionRules,
  resetPermissionRulesForTests,
} from '../dist/permission-rules.js';
// NOTE (dual-mode rule): tool-runner.ts / permission-rules.ts value-import
// extensionless siblings, which tsc resolves but node type-stripping
// cannot. Tests import the compiled dist here so both modes work; run
// `npm run build` (root) before the server suite.

const PRINCIPAL = { id: 'p1', kind: 'human' } as const;
const CAPABILITY = {
  id: 'cap1',
  principalId: 'p1',
  actions: ['*'],
  resourcePrefixes: [''],
  revoked: false,
} as const;

function call(toolId: string, args: Record<string, unknown>): ToolCall {
  return {
    toolId,
    args,
    action: toolId, // the grant check requires an action the tool offers
    resource: 'res',
    principal: { ...PRINCIPAL },
    capability: { ...CAPABILITY, actions: [toolId] },
  } as ToolCall;
}

let root: string;
let globalFile: string;

function projectFile(): string {
  return join(root, '.ai-factory', 'permissions.json');
}
function personalFile(): string {
  return join(root, '.ai-factory', 'permissions.local.json');
}

/** Bypass-mode executor: the approval gate approves EVERYTHING. */
function bypassExecutor() {
  const registry = registerBuiltinTools(new ToolRegistry());
  return new ToolExecutor(registry, {
    runner: createServerToolRunner(),
    approvalChecker: async () => ({ approved: true, reason: 'bypass mode: auto-approve' }),
  });
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'perm-rules-'));
  globalFile = join(root, 'global-permissions.json');
  process.env['FACTORY_PERMISSION_RULES_ROOT'] = root;
  process.env['FACTORY_PERMISSION_RULES_GLOBAL'] = globalFile;
  resetPermissionRulesForTests();
});

after(() => {
  delete process.env['FACTORY_PERMISSION_RULES_ROOT'];
  delete process.env['FACTORY_PERMISSION_RULES_GLOBAL'];
  resetPermissionRulesForTests();
  rmSync(root, { recursive: true, force: true });
});

describe('permission rule enforcement at the tool-runner choke point', () => {
  it('no rules → default behavior unchanged (runtime.echo succeeds)', async () => {
    permissionRules().saveLayer('project', []);
    const rec = await bypassExecutor().execute(call('runtime.echo', { msg: 'hi' }));
    assert.equal(rec.outcome, 'SUCCEEDED');
  });

  it('deny rule refuses shell.execute before anything runs', async () => {
    permissionRules().saveLayer('project', [
      { tool: 'Bash', pattern: 'rm -rf **', effect: 'deny' },
    ]);
    const rec = await bypassExecutor().execute(call('shell.execute', { command: 'rm -rf /tmp/x' }));
    assert.equal(rec.outcome, 'DENIED');
    assert.match(rec.note ?? '', /PERMISSION_DENIED_BY_RULE/);
    assert.match(rec.note ?? '', /\[project\]/);
  });

  it('deny wins even when the approval gate is in bypass/auto-approve mode', async () => {
    // The executor above approves everything (bypass). The deny must still
    // fire because enforcement lives in the runner itself, downstream of
    // any approval decision.
    permissionRules().saveLayer('project', [
      { tool: 'shell.execute', pattern: '*', effect: 'deny' },
    ]);
    const rec = await bypassExecutor().execute(call('shell.execute', { command: 'echo harmless' }));
    assert.equal(rec.outcome, 'DENIED');
    assert.match(rec.note ?? '', /PERMISSION_DENIED_BY_RULE/);
  });

  it('deny beats allow across layers', async () => {
    permissionRules().saveLayer('project', [{ tool: 'Bash', pattern: 'rm -rf **', effect: 'deny' }]);
    permissionRules().saveLayer('personal', [{ tool: 'Bash', pattern: '**', effect: 'allow' }]);
    const rec = await bypassExecutor().execute(call('shell.execute', { command: 'rm -rf /tmp/x' }));
    assert.equal(rec.outcome, 'DENIED');
    assert.match(rec.note ?? '', /\[project\]/);
  });

  it('ask fails closed with APPROVAL_REQUIRED (no silent pass)', async () => {
    permissionRules().saveLayer('project', [{ tool: 'runtime.echo', pattern: '*', effect: 'ask' }]);
    const rec = await bypassExecutor().execute(call('runtime.echo', { msg: 'hi' }));
    assert.equal(rec.outcome, 'DENIED');
    assert.match(rec.note ?? '', /APPROVAL_REQUIRED/);
  });

  it('allow verdict is a no-op at the choke point (call proceeds)', async () => {
    permissionRules().saveLayer('project', [{ tool: 'runtime.echo', pattern: '*', effect: 'allow' }]);
    const rec = await bypassExecutor().execute(call('runtime.echo', { msg: 'hi' }));
    assert.equal(rec.outcome, 'SUCCEEDED');
  });

  it('non-matching command is not denied', async () => {
    permissionRules().saveLayer('project', [
      { tool: 'Bash', pattern: 'rm -rf **', effect: 'deny' },
    ]);
    permissionRules().saveLayer('personal', []);
    const v = permissionRules().evaluate('shell.execute', { command: 'npm run build' });
    assert.equal(v, undefined);
    // ...and through the runner, the call still succeeds.
    const rec = await bypassExecutor().execute(call('runtime.echo', { msg: 'hi' }));
    assert.equal(rec.outcome, 'SUCCEEDED');
  });
});

describe('rule hot reload and corrupt layers', () => {
  it('rules hot-reload when the file mtime changes', () => {
    const store = permissionRules();
    store.saveLayer('project', []);
    assert.equal(store.evaluate('shell.execute', { command: 'rm -rf /tmp/x' }), undefined);
    // Write directly (bypassing saveLayer's cache bust) and force a newer mtime.
    const f = projectFile();
    writeFileSync(f, JSON.stringify({ rules: [{ tool: 'Bash', pattern: 'rm -rf **', effect: 'deny' }] }));
    const m = statSync(f).mtimeMs;
    utimesSync(f, new Date(m + 2000), new Date(m + 2000));
    const v = store.evaluate('shell.execute', { command: 'rm -rf /tmp/x' });
    assert.equal(v?.effect, 'deny');
  });

  it('a corrupt layer is skipped (loud) while other layers keep enforcing', () => {
    const store = permissionRules();
    store.saveLayer('project', [{ tool: 'Bash', pattern: 'rm -rf **', effect: 'deny' }]);
    writeFileSync(personalFile(), '{ not json');
    const layers = store.layers();
    const personal = layers.find((l) => l.name === 'personal');
    assert.equal(personal?.corrupt, true);
    assert.equal(personal?.rules.length, 0);
    // Project layer still enforces.
    const v = store.evaluate('shell.execute', { command: 'rm -rf /tmp/x' });
    assert.equal(v?.effect, 'deny');
  });
});

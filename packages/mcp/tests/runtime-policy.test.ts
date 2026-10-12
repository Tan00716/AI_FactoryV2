/**
 * Tests for §34.3 runtime restrictions: stdio environment inheritance,
 * HTTP credentials/redirects, OAuth audience/scope, TLS stance,
 * dynamic URLs and resource size — modelled as policy, checked before
 * execution, and enforced by the tool-call gate where decidable.
 * Run: node --test dist/tests/runtime-policy.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  McpManager,
  McpRegistry,
  ToolCallGate,
  checkResourceSize,
  defaultRuntimePolicy,
  evaluateOAuth,
  evaluateRedirect,
  evaluateServerUrl,
  filterStdioEnv,
  validateRuntimePolicy,
} from '../src/index';

describe('§34.3 stdio environment inheritance', () => {
  it('filterStdioEnv keeps only allowlisted variables and applies fixed values', () => {
    const policy = {
      ...defaultRuntimePolicy('stdio'),
      stdioEnvAllowlist: ['PATH', 'HOME'],
      stdioEnvFixed: { MCP_MODE: 'sandbox' },
    };
    const filtered = filterStdioEnv(policy, {
      PATH: '/usr/bin',
      HOME: '/home/op',
      OPENAI_API_KEY: 'sk-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      UNRELATED: 'x',
    });
    assert.deepEqual(filtered, { PATH: '/usr/bin', HOME: '/home/op', MCP_MODE: 'sandbox' });
  });
});

describe('§34.3 HTTP credentials + redirects', () => {
  it('redirects are refused outright when the policy does not follow them', () => {
    const policy = defaultRuntimePolicy('http'); // followRedirects: false
    const v = evaluateRedirect(policy, 'https://a.example/mcp', 'https://a.example/mcp2', { credentialsPresent: true });
    assert.equal(v.allowed, false);
    assert.equal(v.forwardCredentials, false);
  });

  it('same-host redirects may forward credentials; unlisted cross-host redirects may not', () => {
    const policy = { ...defaultRuntimePolicy('http'), followRedirects: true };
    const same = evaluateRedirect(policy, 'https://a.example/mcp', 'https://a.example/v2', { credentialsPresent: true });
    assert.equal(same.allowed, true);
    assert.equal(same.forwardCredentials, true);

    const cross = evaluateRedirect(policy, 'https://a.example/mcp', 'https://evil.example/mcp', { credentialsPresent: true });
    assert.equal(cross.allowed, false);
    assert.equal(cross.forwardCredentials, false);
    assert.match(cross.reason, /must not be forwarded/);

    const crossNoCreds = evaluateRedirect(policy, 'https://a.example/mcp', 'https://b.example/mcp', { credentialsPresent: false });
    assert.equal(crossNoCreds.allowed, true);
    assert.equal(crossNoCreds.forwardCredentials, false);

    const listed = evaluateRedirect(
      { ...policy, redirectHostAllowlist: ['b.example'] },
      'https://a.example/mcp',
      'https://b.example/mcp',
      { credentialsPresent: true },
    );
    assert.equal(listed.allowed, true);
    assert.equal(listed.forwardCredentials, true);
  });
});

describe('§34.3 server URL / TLS stance', () => {
  it('a changed URL is denied while dynamic URLs are off; credentials over plain HTTP are denied', () => {
    const policy = { ...defaultRuntimePolicy('http'), serverUrl: 'https://a.example/mcp' };
    const changed = evaluateServerUrl(policy, 'https://other.example/mcp', { credentialsPresent: false });
    assert.equal(changed.allowed, false);
    assert.match(changed.reason, /dynamic URLs are not allowed/);

    const dynamic = evaluateServerUrl({ ...policy, allowDynamicUrl: true }, 'https://other.example/mcp', { credentialsPresent: false });
    assert.equal(dynamic.allowed, true);

    const plain = evaluateServerUrl(policy, 'https://a.example/mcp', { credentialsPresent: true });
    assert.equal(plain.allowed, true);
    const insecure = evaluateServerUrl(
      { ...defaultRuntimePolicy('http') },
      'http://a.example/mcp',
      { credentialsPresent: true },
    );
    assert.equal(insecure.allowed, false);
    assert.match(insecure.reason, /require TLS/);
  });

  it('validateRuntimePolicy flags a contradictory TLS stance', () => {
    const bad = { ...defaultRuntimePolicy('http'), tlsMode: 'insecure-declared' as const };
    assert.ok(validateRuntimePolicy(bad).some((p) => /contradicts/.test(p)));
    assert.deepEqual(validateRuntimePolicy(defaultRuntimePolicy('http')), []);
  });
});

describe('§34.3 OAuth audience/scope + resource size', () => {
  it('evaluateOAuth enforces audience and required scopes', () => {
    const policy = {
      ...defaultRuntimePolicy('http'),
      oauth: { audience: 'mcp://github', requiredScopes: ['repo:read', 'issues:write'] },
    };
    const wrongAud = evaluateOAuth(policy, { audience: 'mcp://other', scopes: ['repo:read', 'issues:write'] });
    assert.equal(wrongAud.allowed, false);
    const missing = evaluateOAuth(policy, { audience: 'mcp://github', scopes: ['repo:read'] });
    assert.equal(missing.allowed, false);
    assert.deepEqual(missing.missingScopes, ['issues:write']);
    const ok = evaluateOAuth(policy, { audience: 'mcp://github', scopes: ['repo:read', 'issues:write'] });
    assert.equal(ok.allowed, true);
  });

  it('checkResourceSize enforces the byte limit', () => {
    const policy = { ...defaultRuntimePolicy('http'), maxResourceBytes: 100 };
    assert.equal(checkResourceSize(policy, 100).allowed, true);
    const over = checkResourceSize(policy, 101);
    assert.equal(over.allowed, false);
    assert.match(over.reason, /exceeds/);
  });
});

describe('§34.3 enforcement in the tool-call gate', () => {
  function gatedServer() {
    const registry = new McpRegistry();
    const manager = new McpManager(registry);
    const gate = new ToolCallGate({ registry, manager });
    registry.register(
      {
        name: 'gh',
        version: '1.0.0',
        provider: 'GitHub',
        transport: 'http',
        tools: [{ name: 'create_issue' }],
        permissions: [],
        runtimePolicy: {
          ...defaultRuntimePolicy('http'),
          oauth: { audience: 'mcp://github', requiredScopes: ['repo'] },
          maxResourceBytes: 10,
        },
      },
      { trust: 'VERIFIED', policy: 'AUTO' },
    );
    manager.requestInstall('gh', '1.0.0');
    return { registry, manager, gate };
  }

  it('denies a call whose token audience is wrong, allows a conforming call', () => {
    const { gate } = gatedServer();
    const denied = gate.checkCall({
      server: 'gh',
      tool: 'create_issue',
      oauthToken: { audience: 'mcp://evil', scopes: ['repo'] },
    });
    assert.equal(denied.allowed, false);
    assert.match(denied.reason, /OAuth denied/);
    const allowed = gate.checkCall({
      server: 'gh',
      tool: 'create_issue',
      oauthToken: { audience: 'mcp://github', scopes: ['repo'] },
      resourceBytes: 5,
    });
    assert.equal(allowed.allowed, true);
  });

  it('denies a call whose declared payload exceeds the resource limit', () => {
    const { gate } = gatedServer();
    const denied = gate.checkCall({ server: 'gh', tool: 'create_issue', resourceBytes: 11 });
    assert.equal(denied.allowed, false);
    assert.match(denied.reason, /resource size denied/);
  });

  it('a server without a runtime policy keeps the pre-§34.3 gate behavior', () => {
    const registry = new McpRegistry();
    const manager = new McpManager(registry);
    const gate = new ToolCallGate({ registry, manager });
    registry.register(
      { name: 'plain', version: '1.0.0', provider: 'Acme', transport: 'http', tools: [{ name: 't' }] },
      { trust: 'VERIFIED', policy: 'AUTO' },
    );
    manager.requestInstall('plain', '1.0.0');
    const v = gate.checkCall({
      server: 'plain',
      tool: 't',
      oauthToken: { audience: 'anything', scopes: [] },
      resourceBytes: 10_000_000,
    });
    assert.equal(v.allowed, true);
  });
});

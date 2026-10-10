/**
 * Tests for project.yaml (§98) / organization.yaml (§99) parsing + validation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { flattenPolicy, parseOrganizationPolicy, parseProjectPolicy } from '../src/index';

const VALID_PROJECT = `project:
  name: MyApp

workflow:
  production_approval: human

security:
  production_write: denied

agents:
  max_concurrent: 8

deployment:
  auto_uat: true
  auto_prod: false

testing:
  require_unit: true
  require_e2e: true
  require_security: true
`;

const VALID_ORG = `organization:
  agent_creation:
    enabled: true
    max_depth: 3
    max_children: 5

permissions:
  production:
    default: denied

skills:
  auto_publish: false

mcp:
  unknown_servers: denied
`;

describe('parseProjectPolicy (§98)', () => {
  it('parses the spec example as valid', () => {
    const r = parseProjectPolicy(VALID_PROJECT);
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
    assert.equal(r.policy?.project.name, 'MyApp');
    assert.equal(r.policy?.workflow.production_approval, 'human');
    assert.equal(r.policy?.security.production_write, 'denied');
    assert.equal(r.policy?.agents.max_concurrent, 8);
    assert.equal(r.policy?.deployment.auto_uat, true);
    assert.equal(r.policy?.deployment.auto_prod, false);
    assert.equal(r.policy?.testing.require_security, true);
  });

  it('rejects an invalid production_approval enum value', () => {
    const r = parseProjectPolicy(VALID_PROJECT.replace('production_approval: human', 'production_approval: nobody'));
    assert.equal(r.ok, false);
    const e = r.errors.find((x) => x.path === 'workflow.production_approval');
    assert.ok(e, 'expected enum error');
    assert.equal(e.code, 'INVALID_ENUM');
    assert.match(e.message, /human, ai, auto/);
  });

  it('rejects a missing required section', () => {
    const r = parseProjectPolicy(VALID_PROJECT.replace(/security:\n  production_write: denied\n\n/, ''));
    assert.equal(r.ok, false);
    const e = r.errors.find((x) => x.path === 'security');
    assert.ok(e, 'expected missing-section error');
    assert.equal(e.code, 'MISSING_REQUIRED');
  });

  it('rejects out-of-range max_concurrent', () => {
    const r = parseProjectPolicy(VALID_PROJECT.replace('max_concurrent: 8', 'max_concurrent: 500'));
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, 'OUT_OF_RANGE');
  });

  it('rejects a non-boolean deployment flag', () => {
    const r = parseProjectPolicy(VALID_PROJECT.replace('auto_prod: false', 'auto_prod: maybe'));
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, 'INVALID_TYPE');
  });

  it('returns INVALID_YAML for broken syntax', () => {
    const r = parseProjectPolicy('project:\n\tname: x\n');
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, 'INVALID_YAML');
  });
});

describe('parseOrganizationPolicy (§99)', () => {
  it('parses the spec example as valid', () => {
    const r = parseOrganizationPolicy(VALID_ORG);
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
    assert.equal(r.policy?.organization.agent_creation.max_depth, 3);
    assert.equal(r.policy?.organization.permissions.production.default, 'denied');
    assert.equal(r.policy?.organization.mcp.unknown_servers, 'denied');
    assert.equal(r.policy?.organization.skills.auto_publish, false);
  });

  it('also accepts sections nested under organization:', () => {
    const nested = VALID_ORG.replace(/^permissions:$/m, '  permissions:')
      .replace(/^  production:$/m, '    production:')
      .replace(/^    default: denied$/m, '      default: denied')
      .replace(/^skills:$/m, '  skills:')
      .replace(/^  auto_publish: false$/m, '    auto_publish: false')
      .replace(/^mcp:$/m, '  mcp:')
      .replace(/^  unknown_servers: denied$/m, '    unknown_servers: denied');
    const r = parseOrganizationPolicy(nested);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.policy?.organization.mcp.unknown_servers, 'denied');
  });

  it('rejects invalid mcp.unknown_servers enum value', () => {
    const r = parseOrganizationPolicy(VALID_ORG.replace('unknown_servers: denied', 'unknown_servers: ask'));
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, 'INVALID_ENUM');
  });

  it('collects multiple structured errors', () => {
    const r = parseOrganizationPolicy('organization:\n  agent_creation:\n    enabled: true\n');
    assert.equal(r.ok, false);
    assert.ok(r.errors.length >= 3, `expected ≥3 errors, got ${r.errors.length}`);
    for (const e of r.errors) {
      assert.ok(e.path && e.message && e.code, 'each error is structured');
    }
  });
});

describe('flattenPolicy', () => {
  it('flattens a parsed project policy into store-ready keys', () => {
    const r = parseProjectPolicy(VALID_PROJECT);
    assert.equal(r.ok, true);
    const flat = flattenPolicy(r.policy!);
    assert.equal(flat['security.production_write'], 'denied');
    assert.equal(flat['workflow.production_approval'], 'human');
    assert.equal(flat['agents.max_concurrent'], 8);
  });
});

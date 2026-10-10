/**
 * project.yaml (§98) and organization.yaml (§99) parsing + validation.
 *
 * Both functions take raw YAML text, parse it with the hand-written minimal
 * parser, and validate required fields, enum values, and boolean/number
 * ranges. Invalid documents return a structured error list instead of
 * throwing (except for YAML syntax errors, which surface as
 * YamlParseError-derived INVALID_YAML errors).
 */
import { YamlMap, YamlNode, YamlParseError, parseYaml } from './yaml';

export type PolicyErrorCode =
  | 'INVALID_YAML'
  | 'MISSING_REQUIRED'
  | 'INVALID_TYPE'
  | 'INVALID_ENUM'
  | 'OUT_OF_RANGE';

export interface PolicyError {
  path: string;
  message: string;
  code: PolicyErrorCode;
}

export interface ParseResult<T> {
  ok: boolean;
  policy?: T;
  errors: PolicyError[];
}

/** §98 — project.yaml shape. */
export interface ProjectPolicy {
  project: { name: string };
  workflow: { production_approval: 'human' | 'ai' | 'auto' };
  security: { production_write: 'allowed' | 'denied' };
  agents: { max_concurrent: number };
  deployment: { auto_uat: boolean; auto_prod: boolean };
  testing: { require_unit: boolean; require_e2e: boolean; require_security: boolean };
}

/** §99 — organization.yaml shape. */
export interface OrganizationPolicy {
  organization: {
    agent_creation: { enabled: boolean; max_depth: number; max_children: number };
    permissions: { production: { default: 'allowed' | 'denied' } };
    skills: { auto_publish: boolean };
    mcp: { unknown_servers: 'allowed' | 'denied' };
  };
}

class Validator {
  errors: PolicyError[] = [];

  missing(path: string, what: string): null {
    this.errors.push({ path, message: `${what} is required`, code: 'MISSING_REQUIRED' });
    return null;
  }

  node(root: YamlNode, path: string, section: string): YamlMap | null {
    if (root === null || typeof root !== 'object' || Array.isArray(root)) {
      this.errors.push({ path, message: 'document root must be a mapping', code: 'INVALID_TYPE' });
      return null;
    }
    const sec = (root as YamlMap)[section];
    if (sec === undefined || sec === null || typeof sec !== 'object' || Array.isArray(sec)) {
      return this.missing(path ? `${path}.${section}` : section, `"${section}" section`);
    }
    return sec as YamlMap;
  }

  field(map: YamlMap, path: string, name: string): YamlNode | null {
    const v = map[name];
    if (v === undefined || v === null) return this.missing(path, `"${name}"`);
    return v;
  }

  str(map: YamlMap, path: string, name: string, nonEmpty = true): string | null {
    const full = path ? `${path}.${name}` : name;
    const v = this.field(map, full, name);
    if (v === null) return null;
    if (typeof v !== 'string' || (nonEmpty && v.trim() === '')) {
      this.errors.push({ path: full, message: `"${name}" must be a non-empty string`, code: 'INVALID_TYPE' });
      return null;
    }
    return v;
  }

  bool(map: YamlMap, path: string, name: string): boolean | null {
    const full = path ? `${path}.${name}` : name;
    const v = this.field(map, full, name);
    if (v === null) return null;
    if (typeof v !== 'boolean') {
      this.errors.push({ path: full, message: `"${name}" must be a boolean`, code: 'INVALID_TYPE' });
      return null;
    }
    return v;
  }

  num(map: YamlMap, path: string, name: string, min: number, max: number): number | null {
    const full = path ? `${path}.${name}` : name;
    const v = this.field(map, full, name);
    if (v === null) return null;
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      this.errors.push({ path: full, message: `"${name}" must be an integer`, code: 'INVALID_TYPE' });
      return null;
    }
    if (v < min || v > max) {
      this.errors.push({
        path: full,
        message: `"${name}" must be between ${min} and ${max}`,
        code: 'OUT_OF_RANGE',
      });
      return null;
    }
    return v;
  }

  enum<T extends string>(map: YamlMap, path: string, name: string, allowed: readonly T[]): T | null {
    const full = path ? `${path}.${name}` : name;
    const v = this.field(map, full, name);
    if (v === null) return null;
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
      this.errors.push({
        path: full,
        message: `"${name}" must be one of: ${allowed.join(', ')}`,
        code: 'INVALID_ENUM',
      });
      return null;
    }
    return v as T;
  }

  allowDeny(map: YamlMap, path: string, name: string): 'allowed' | 'denied' | null {
    return this.enum(map, path, name, ['allowed', 'denied'] as const);
  }

  sub(map: YamlMap, path: string, name: string): YamlMap | null {
    const full = path ? `${path}.${name}` : name;
    const v = this.field(map, full, name);
    if (v === null) return null;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      this.errors.push({ path: full, message: `"${name}" must be a mapping`, code: 'INVALID_TYPE' });
      return null;
    }
    return v as YamlMap;
  }
}

function parseDocument(yaml: string): { root: YamlNode; err: PolicyError | null } {
  try {
    return { root: parseYaml(yaml), err: null };
  } catch (e) {
    const msg = e instanceof YamlParseError ? e.message : `invalid YAML: ${(e as Error).message}`;
    return { root: null, err: { path: '', message: msg, code: 'INVALID_YAML' } };
  }
}

/**
 * Parse + validate a project.yaml (§98 example format).
 * All sections/fields shown in the spec example are required.
 */
export function parseProjectPolicy(yaml: string): ParseResult<ProjectPolicy> {
  const { root, err } = parseDocument(yaml);
  if (err || root === null) return { ok: false, errors: [err ?? { path: '', message: 'empty document', code: 'INVALID_YAML' }] };
  const v = new Validator();

  const project = v.node(root, '', 'project');
  const name = project ? v.str(project, 'project', 'name') : null;

  const workflow = v.node(root, '', 'workflow');
  const production_approval = workflow
    ? v.enum(workflow, 'workflow', 'production_approval', ['human', 'ai', 'auto'] as const)
    : null;

  const security = v.node(root, '', 'security');
  const production_write = security ? v.allowDeny(security, 'security', 'production_write') : null;

  const agents = v.node(root, '', 'agents');
  const max_concurrent = agents ? v.num(agents, 'agents', 'max_concurrent', 1, 100) : null;

  const deployment = v.node(root, '', 'deployment');
  const auto_uat = deployment ? v.bool(deployment, 'deployment', 'auto_uat') : null;
  const auto_prod = deployment ? v.bool(deployment, 'deployment', 'auto_prod') : null;

  const testing = v.node(root, '', 'testing');
  const require_unit = testing ? v.bool(testing, 'testing', 'require_unit') : null;
  const require_e2e = testing ? v.bool(testing, 'testing', 'require_e2e') : null;
  const require_security = testing ? v.bool(testing, 'testing', 'require_security') : null;

  if (v.errors.length > 0) return { ok: false, errors: v.errors };
  return {
    ok: true,
    errors: [],
    policy: {
      project: { name: name as string },
      workflow: { production_approval: production_approval as 'human' | 'ai' | 'auto' },
      security: { production_write: production_write as 'allowed' | 'denied' },
      agents: { max_concurrent: max_concurrent as number },
      deployment: { auto_uat: auto_uat as boolean, auto_prod: auto_prod as boolean },
      testing: {
        require_unit: require_unit as boolean,
        require_e2e: require_e2e as boolean,
        require_security: require_security as boolean,
      },
    },
  };
}

/**
 * Parse + validate an organization.yaml (§99 example format).
 *
 * The spec example puts `agent_creation` under `organization:` and the
 * remaining sections (`permissions`, `skills`, `mcp`) at document root.
 * To be forgiving of both layouts, each section is read from its nested
 * position first and then from document root; everything is normalized
 * into the `organization` object of the result.
 */
export function parseOrganizationPolicy(yaml: string): ParseResult<OrganizationPolicy> {
  const { root, err } = parseDocument(yaml);
  if (err || root === null) return { ok: false, errors: [err ?? { path: '', message: 'empty document', code: 'INVALID_YAML' }] };
  const v = new Validator();

  const rootMap = root as YamlMap;
  const org = v.node(root, '', 'organization');

  /** Find a section either nested under `organization:` or at root. */
  const section = (name: string): { map: YamlMap; path: string } | null => {
    const nested = org?.[name];
    if (nested !== undefined && nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
      return { map: nested as YamlMap, path: `organization.${name}` };
    }
    const atRoot = rootMap[name];
    if (atRoot !== undefined && atRoot !== null && typeof atRoot === 'object' && !Array.isArray(atRoot)) {
      return { map: atRoot as YamlMap, path: name };
    }
    v.missing(name, `"${name}" section`);
    return null;
  };

  let agent_creation: OrganizationPolicy['organization']['agent_creation'] | null = null;
  let permissions: OrganizationPolicy['organization']['permissions'] | null = null;
  let skills: OrganizationPolicy['organization']['skills'] | null = null;
  let mcp: OrganizationPolicy['organization']['mcp'] | null = null;

  const ac = section('agent_creation');
  if (ac) {
    const enabled = v.bool(ac.map, ac.path, 'enabled');
    const max_depth = v.num(ac.map, ac.path, 'max_depth', 1, 10);
    const max_children = v.num(ac.map, ac.path, 'max_children', 0, 100);
    if (enabled !== null && max_depth !== null && max_children !== null) {
      agent_creation = { enabled, max_depth, max_children };
    }
  }
  const perm = section('permissions');
  if (perm) {
    const production = v.sub(perm.map, perm.path, 'production');
    if (production) {
      const def = v.allowDeny(production, `${perm.path}.production`, 'default');
      if (def !== null) permissions = { production: { default: def } };
    }
  }
  const sk = section('skills');
  if (sk) {
    const auto_publish = v.bool(sk.map, sk.path, 'auto_publish');
    if (auto_publish !== null) skills = { auto_publish };
  }
  const mc = section('mcp');
  if (mc) {
    const unknown_servers = v.allowDeny(mc.map, mc.path, 'unknown_servers');
    if (unknown_servers !== null) mcp = { unknown_servers };
  }

  if (v.errors.length > 0) return { ok: false, errors: v.errors };
  return {
    ok: true,
    errors: [],
    policy: {
      organization: {
        agent_creation: agent_creation as OrganizationPolicy['organization']['agent_creation'],
        permissions: permissions as OrganizationPolicy['organization']['permissions'],
        skills: skills as OrganizationPolicy['organization']['skills'],
        mcp: mcp as OrganizationPolicy['organization']['mcp'],
      },
    },
  };
}

/**
 * Flatten a parsed project/organization policy into the flat rule map used
 * by PolicyStore (e.g. `security.production_write` → 'denied').
 */
export function flattenPolicy(policy: ProjectPolicy | OrganizationPolicy): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (node: unknown, prefix: string): void => {
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      for (const [k, val] of Object.entries(node as Record<string, unknown>)) {
        walk(val, prefix ? `${prefix}.${k}` : k);
      }
    } else {
      out[prefix] = node;
    }
  };
  walk(policy, '');
  return out;
}

/**
 * Sanitized export — SPEC v2 §52.2.
 *
 * Export produces a de-sensitized manifest (versions, artifact refs,
 * licenses). The following are NEVER exported by default:
 * Secrets, OAuth tokens, Capabilities, active Leases, private sessions.
 * Code/evidence inclusion is opt-in per call.
 *
 * Cross user/project permission is checked BEFORE anything is serialized:
 * the requester must hold export rights in every user/project scope the
 * data touches.
 */

export const DEFAULT_EXPORT_EXCLUSIONS = [
  'secrets',
  'oauth',
  'capabilities',
  'activeLeases',
  'privateSessions',
] as const;

export type ExclusionKind = (typeof DEFAULT_EXPORT_EXCLUSIONS)[number];

export interface ExportActor {
  id: string;
  kind: 'HUMAN' | 'AI' | 'SERVICE';
}

export interface ExportScope {
  userIds: string[];
  projectIds: string[];
}

export interface ExportPermission {
  /** Returns true when the actor may export the given user/project scope. */
  canExport(actor: ExportActor, scope: ExportScope): boolean;
}

export interface SanitizedExportRequest {
  actor: ExportActor;
  scope: ExportScope;
  /** The raw project data tree (plain JSON-able object). */
  data: Record<string, unknown>;
  /** Opt-in: also include code and evidence blobs. Default false. */
  includeCode?: boolean;
  includeEvidence?: boolean;
  /** Extra exclusions on top of the defaults. */
  exclude?: ExclusionKind[];
}

export interface SanitizedManifest {
  schemaVersion: '2.0';
  exportedAt: string;
  exportedBy: string;
  scope: ExportScope;
  excluded: ExclusionKind[];
  files: Record<string, string>;
  /** sha256 per file, for import-side verification. */
  fileHashes: Record<string, string>;
}

export class ExportDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportDeniedError';
  }
}

import { createHash } from 'node:crypto';

const SECRET_KEY_RE = /secret|token|passwd|password|api[-_ ]?key|credential|private[-_ ]?key|oauth/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-strip anything that looks like a secret VALUE (refs stay). */
function stripSecretValues(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripSecretValues);
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    const isRef = /_refs?$/.test(k) || k === 'env_refs';
    if (SECRET_KEY_RE.test(k) && !isRef && typeof v === 'string' && v !== '') {
      out[k] = '***REDACTED***';
    } else {
      out[k] = stripSecretValues(v);
    }
  }
  return out;
}

export interface SanitizeOptions {
  now?: () => string;
}

/**
 * Build the sanitized manifest. Throws ExportDeniedError when the actor
 * lacks export rights in any touched scope.
 */
export function buildSanitizedManifest(
  req: SanitizedExportRequest,
  permission: ExportPermission,
  opts: SanitizeOptions = {},
): SanitizedManifest {
  if (!permission.canExport(req.actor, req.scope)) {
    throw new ExportDeniedError(
      `actor ${req.actor.id} lacks export rights for scope users=[${req.scope.userIds}] projects=[${req.scope.projectIds}]`,
    );
  }
  const excluded: ExclusionKind[] = [...DEFAULT_EXPORT_EXCLUSIONS, ...(req.exclude ?? [])];
  const data = JSON.parse(JSON.stringify(req.data)) as Record<string, unknown>;

  // Apply default exclusions: drop whole sections.
  const sectionOf: Record<ExclusionKind, string> = {
    secrets: 'secrets',
    oauth: 'oauth',
    capabilities: 'capabilities',
    activeLeases: 'activeLeases',
    privateSessions: 'privateSessions',
  };
  for (const kind of excluded) {
    delete data[sectionOf[kind]];
  }
  if (!req.includeCode) {
    delete data['code'];
    delete data['repositories'];
  }
  if (!req.includeEvidence) {
    delete data['evidenceBlobs'];
    delete data['rawArtifacts'];
  }

  const sanitized = stripSecretValues(data) as Record<string, unknown>;
  const files: Record<string, string> = {
    '.ai/manifest.json': JSON.stringify(
      {
        schemaVersion: '2.0',
        scope: req.scope,
        exportedBy: req.actor.id,
        excluded,
        sections: Object.keys(sanitized),
      },
      null,
      2,
    ),
  };
  for (const [section, value] of Object.entries(sanitized)) {
    files[`.ai/export/${section}.json`] = JSON.stringify(value, null, 2);
  }
  const fileHashes: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) {
    fileHashes[path] = createHash('sha256').update(text, 'utf8').digest('hex');
  }
  return {
    schemaVersion: '2.0',
    exportedAt: (opts.now ?? (() => new Date().toISOString()))(),
    exportedBy: req.actor.id,
    scope: req.scope,
    excluded,
    files,
    fileHashes,
  };
}

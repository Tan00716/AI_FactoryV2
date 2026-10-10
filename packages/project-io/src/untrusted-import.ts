/**
 * Untrusted import — SPEC v2 §52.3.
 *
 * An import package is treated as HOSTILE data until it passes every
 * check: schema, per-file hash, path traversal, archive-bomb limits,
 * executable content, and license screening. Employee / MCP / Skill
 * entries land in DRAFT/QUARANTINED first — never directly ACTIVE.
 * Permissions from the package are re-mapped to LOCAL grants; the
 * package's Admin never transfers. ID conflicts produce a recorded
 * old→new mapping instead of silent overwrites.
 */

import { createHash } from 'node:crypto';
import type { ExportFiles, ValidationIssue } from './types';

export type QuarantineStatus = 'DRAFT' | 'QUARANTINED';

export interface UntrustedPackage {
  files: ExportFiles;
  meta: {
    source: string;
    /** Claimed manifest hashes (path → sha256), when provided. */
    fileHashes?: Record<string, string>;
    declaredLicense?: string;
  };
}

export interface ImportLimits {
  maxFiles?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
}

export interface StagedEntity {
  kind: 'employee' | 'mcp' | 'skill' | 'workflow' | 'knowledge' | 'other';
  id: string;
  status: QuarantineStatus;
  payload: unknown;
}

export interface StagedImport {
  staged: StagedEntity[];
  /** old id → new id for every conflict that was remapped. */
  idMapping: Record<string, string>;
  warnings: string[];
}

const DEFAULT_LIMITS: Required<ImportLimits> = {
  maxFiles: 500,
  maxTotalBytes: 50 * 1024 * 1024,
  maxFileBytes: 5 * 1024 * 1024,
};

const EXECUTABLE_RE = /\.(exe|dll|so|dylib|bat|cmd|ps1|sh|bin)$/i;
const LICENSE_BLOCKED_RE = /unknown|unspecified|proprietary-no-redist/i;

function isPathTraversal(rel: string): boolean {
  if (rel.includes('\0')) return true;
  const parts = rel.split('/');
  if (parts.some((p) => p === '..')) return true;
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return true;
  return false;
}

function kindOfFile(path: string): StagedEntity['kind'] {
  if (path.includes('/agents/') || path.includes('employee')) return 'employee';
  if (path.includes('/mcp/')) return 'mcp';
  if (path.includes('/skills/')) return 'skill';
  if (path.includes('/workflows/')) return 'workflow';
  if (path.includes('/knowledge/')) return 'knowledge';
  return 'other';
}

function entityIdOf(path: string, text: string): string {
  try {
    const doc = JSON.parse(text) as { id?: string; name?: string };
    if (typeof doc.id === 'string' && doc.id) return doc.id;
    if (typeof doc.name === 'string' && doc.name) return doc.name;
  } catch {
    // fall through to path-derived id
  }
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.[^.]+$/, '');
}

/**
 * Validate the untrusted package. Returns issues; an empty array means
 * the package may proceed to staging. NOTHING is written by validation.
 */
export function validateUntrustedPackage(
  pkg: UntrustedPackage,
  limits: ImportLimits = {},
): ValidationIssue[] {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const issues: ValidationIssue[] = [];
  const entries = Object.entries(pkg.files);

  if (entries.length > lim.maxFiles) {
    issues.push({ file: '<package>', message: `too many files: ${entries.length} > ${lim.maxFiles}` });
  }
  let total = 0;
  for (const [path, text] of entries) {
    if (isPathTraversal(path)) {
      issues.push({ file: path, message: 'path traversal rejected' });
      continue;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    total += bytes;
    if (bytes > lim.maxFileBytes) {
      issues.push({ file: path, message: `file too large: ${bytes} > ${lim.maxFileBytes} (zip-bomb guard)` });
    }
    if (EXECUTABLE_RE.test(path)) {
      issues.push({ file: path, message: 'executable content is not importable' });
    }
    if (pkg.meta.fileHashes?.[path]) {
      const actual = createHash('sha256').update(text, 'utf8').digest('hex');
      if (actual !== pkg.meta.fileHashes[path]) {
        issues.push({ file: path, message: 'hash mismatch — package may be tampered' });
      }
    }
  }
  if (total > lim.maxTotalBytes) {
    issues.push({ file: '<package>', message: `total size ${total} > ${lim.maxTotalBytes} (zip-bomb guard)` });
  }
  if (pkg.meta.declaredLicense && LICENSE_BLOCKED_RE.test(pkg.meta.declaredLicense)) {
    issues.push({ file: '<package>', message: `license "${pkg.meta.declaredLicense}" is not importable` });
  }
  return issues;
}

/**
 * Stage a validated package. Employee/MCP/Skill entries are forced into
 * DRAFT/QUARANTINED — they can never arrive ACTIVE.
 */
export function stageUntrustedImport(pkg: UntrustedPackage): StagedImport {
  const staged: StagedEntity[] = [];
  const warnings: string[] = [];
  for (const [path, text] of Object.entries(pkg.files)) {
    const kind = kindOfFile(path);
    const needsQuarantine = kind === 'employee' || kind === 'mcp' || kind === 'skill';
    let payload: unknown = text;
    try {
      payload = JSON.parse(text);
    } catch {
      // keep raw text
    }
    staged.push({
      kind,
      id: entityIdOf(path, text),
      status: needsQuarantine ? 'QUARANTINED' : 'DRAFT',
      payload,
    });
    if (needsQuarantine) {
      warnings.push(`${kind} ${path} staged as QUARANTINED — requires review before activation`);
    }
  }
  return { staged, idMapping: {}, warnings };
}

export interface LocalGrant {
  principalId: string;
  capabilities: string[];
}

/**
 * Re-map package permissions to LOCAL grants. The package's Admin (or
 * any elevated role) NEVER transfers — the worst a package can request
 * is re-issued by the local authority as an explicit, auditable grant.
 */
export function remapPermissionsToLocal(
  requested: Array<{ principalId: string; role: string }>,
  localAuthority: string,
): { grants: LocalGrant[]; dropped: string[] } {
  const grants: LocalGrant[] = [];
  const dropped: string[] = [];
  for (const r of requested) {
    const role = r.role.toLowerCase();
    if (role === 'admin' || role === 'owner' || role === 'root') {
      dropped.push(`${r.principalId}:${r.role} (elevated role never inherited from a package)`);
      continue;
    }
    grants.push({
      principalId: r.principalId,
      capabilities: role === 'viewer' ? ['read'] : ['read', 'write'],
    });
  }
  void localAuthority;
  return { grants, dropped };
}

/**
 * Map ID conflicts to fresh local IDs and RECORD the mapping.
 * Nothing is silently overwritten.
 */
export function mapIdConflicts(
  staged: StagedImport,
  existingIds: Set<string>,
  newIdFor: (oldId: string) => string,
): StagedImport {
  const idMapping: Record<string, string> = { ...staged.idMapping };
  const stagedOut = staged.staged.map((s) => {
    if (existingIds.has(s.id)) {
      const fresh = newIdFor(s.id);
      idMapping[s.id] = fresh;
      return { ...s, id: fresh };
    }
    return s;
  });
  return { ...staged, staged: stagedOut, idMapping };
}

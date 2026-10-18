/**
 * Task image attachments (W-E, multimodal input).
 *
 * Images attached to a task live on disk under
 *   <AI_FACTORY_DATA_DIR|data>/attachments/<taskId>/<attachmentId>
 * with a `<attachmentId>.meta.json` sidecar carrying the declared
 * filename/mime/size. No DB migration: the runner resolves attachments
 * by task id straight from this store.
 *
 * Security: taskId is allowlisted to [A-Za-z0-9_-]{1,64}; attachment
 * ids are server-generated (`<hex16>-<safe-name>`); lookups resolve
 * the path and verify it stays inside the task directory (path jail,
 * same posture as W-C's control-dir guard). Only image/* mime types
 * on an explicit whitelist, 10 MiB per file. Writes are temp+rename.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { basename, resolve, sep } from 'node:path';

export interface TaskAttachment {
  id: string;
  taskId: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  sha256: string;
}

/** Max decoded bytes per attachment: 10 MiB. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Explicit image whitelist — nothing else is stored. */
export const ATTACHMENT_MIME_ALLOW = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Server-generated ids only: <16 hex>-<sanitized name>. */
const ATTACHMENT_ID_RE = /^[0-9a-f]{16}-[A-Za-z0-9_.-]{1,120}$/;

export function attachmentsRoot(): string {
  return resolve(process.env.AI_FACTORY_DATA_DIR ?? 'data', 'attachments');
}

export function taskAttachmentsDir(taskId: string): string {
  return resolve(attachmentsRoot(), taskId);
}

export function assertValidTaskId(taskId: string): void {
  if (!TASK_ID_RE.test(taskId)) throw new Error(`invalid task id: ${taskId}`);
}

/** Strip directories, control chars; keep a safe, bounded name. */
export function sanitizeFilename(name: string, mimeType: string): string {
  const base = basename(name || 'image')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80) || 'image';
  const wantExt = MIME_EXT[mimeType] ?? '';
  const hasExt = /\.[A-Za-z0-9]{2,5}$/.test(base);
  return hasExt ? base : base + wantExt;
}

/** Resolve an attachment path, jailed inside its task directory. */
export function attachmentFilePath(taskId: string, attachmentId: string): string {
  assertValidTaskId(taskId);
  if (!ATTACHMENT_ID_RE.test(attachmentId)) throw new Error(`invalid attachment id: ${attachmentId}`);
  const dir = taskAttachmentsDir(taskId);
  const p = resolve(dir, attachmentId);
  if (p !== dir && !p.startsWith(dir + sep)) throw new Error('attachment path escapes task directory');
  if (p === dir) throw new Error('attachment path escapes task directory');
  return p;
}

function writeAtomic(path: string, data: Buffer | string): void {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export interface SaveAttachmentInput {
  filename: string;
  mimeType: string;
  /** Base64-encoded image bytes (data URL prefix tolerated and stripped). */
  dataBase64: string;
}

export function saveTaskAttachment(taskId: string, input: SaveAttachmentInput): TaskAttachment {
  assertValidTaskId(taskId);
  if (!ATTACHMENT_MIME_ALLOW.has(input.mimeType)) {
    throw new Error(`unsupported mime type: ${input.mimeType}`);
  }
  let b64 = input.dataBase64;
  const comma = b64.indexOf(',');
  if (b64.startsWith('data:') && comma !== -1) b64 = b64.slice(comma + 1);
  if (!/^[A-Za-z0-9+/=\s]*$/.test(b64)) throw new Error('dataBase64 is not valid base64');
  const bytes = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  if (bytes.length === 0) throw new Error('empty image');
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`image exceeds ${MAX_ATTACHMENT_BYTES} byte limit`);
  }
  const dir = taskAttachmentsDir(taskId);
  mkdirSync(dir, { recursive: true });
  const id = `${randomBytes(8).toString('hex')}-${sanitizeFilename(input.filename, input.mimeType)}`;
  const filePath = attachmentFilePath(taskId, id);
  writeAtomic(filePath, bytes);
  const record: TaskAttachment = {
    id,
    taskId,
    filename: sanitizeFilename(input.filename, input.mimeType),
    mimeType: input.mimeType,
    size: bytes.length,
    createdAt: new Date().toISOString(),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  writeAtomic(`${filePath}.meta.json`, JSON.stringify(record, null, 2));
  return record;
}

function readMeta(taskId: string, id: string): TaskAttachment | null {
  try {
    const raw = readFileSync(`${attachmentFilePath(taskId, id)}.meta.json`, 'utf8');
    const m = JSON.parse(raw) as TaskAttachment;
    if (m.id !== id || m.taskId !== taskId) return null;
    return m;
  } catch {
    return null;
  }
}

export function listTaskAttachments(taskId: string): TaskAttachment[] {
  assertValidTaskId(taskId);
  const dir = taskAttachmentsDir(taskId);
  if (!existsSync(dir)) return [];
  const out: TaskAttachment[] = [];
  for (const name of readdirSync(dir)) {
    if (!ATTACHMENT_ID_RE.test(name)) continue;
    if (name.endsWith('.meta.json')) continue;
    const meta = readMeta(taskId, name);
    if (meta) {
      try {
        meta.size = statSync(attachmentFilePath(taskId, name)).size;
      } catch {
        continue;
      }
      out.push(meta);
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return out;
}

/** Read attachment bytes (jail-checked). Returns null when missing. */
export function readTaskAttachment(taskId: string, attachmentId: string): { record: TaskAttachment; bytes: Buffer } | null {
  const meta = readMeta(taskId, attachmentId);
  if (!meta) return null;
  try {
    const bytes = readFileSync(attachmentFilePath(taskId, attachmentId));
    return { record: meta, bytes };
  } catch {
    return null;
  }
}

/** Extension actually stored for a mime (used by upload clients). */
export function extensionForMime(mimeType: string): string {
  return MIME_EXT[mimeType] ?? '';
}

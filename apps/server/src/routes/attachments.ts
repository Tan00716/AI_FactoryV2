/**
 * Task image attachments (W-E, multimodal input).
 *
 *   POST /api/tasks/:id/attachments
 *     { filename, mimeType, dataBase64 } → 201 { attachment }
 *   GET  /api/tasks/:id/attachments → { attachments: [...] }
 *   GET  /api/tasks/:id/attachments/:attId → image bytes (content-type set)
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) maps GET → viewer,
 * POST → operator for this prefix — uploads are operator-only, reads are
 * viewer-readable. No auth.ts change.
 *
 * Limits: image/* whitelist (png/jpeg/webp/gif), 10 MiB per file,
 * task-id allowlist + resolved-path jail in attachment-store.ts.
 *
 * The coordinator wires this in: handleAttachmentRoutes(req, res, url, ctx).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './context';
import {
  ATTACHMENT_MIME_ALLOW,
  listTaskAttachments,
  readTaskAttachment,
  saveTaskAttachment,
} from '../attachment-store';

const PREFIX = '/api/tasks';

function taskExists(ctx: RouteContext, id: string): boolean {
  try {
    ctx.tasks.get(id);
    return true;
  } catch {
    return false;
  }
}

export async function handleAttachmentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const m = /^\/api\/tasks\/([^/]+)\/attachments(?:\/([^/]+))?$/.exec(path);
  if (!m) return false;
  const taskId = decodeURIComponent(m[1]);
  const attId = m[2] ? decodeURIComponent(m[2]) : null;

  if (!taskExists(ctx, taskId)) {
    ctx.json(res, 404, { error: 'task not found' });
    return true;
  }

  // POST /api/tasks/:id/attachments — upload one image.
  if (method === 'POST' && attId === null) {
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    const filename = body['filename'];
    const mimeType = body['mimeType'];
    const dataBase64 = body['dataBase64'];
    if (typeof filename !== 'string' || !filename.trim()) {
      ctx.json(res, 400, { error: 'filename is required' });
      return true;
    }
    if (typeof mimeType !== 'string' || !ATTACHMENT_MIME_ALLOW.has(mimeType)) {
      ctx.json(res, 400, {
        error: `mimeType must be one of: ${[...ATTACHMENT_MIME_ALLOW].join(', ')}`,
      });
      return true;
    }
    if (typeof dataBase64 !== 'string' || !dataBase64.length) {
      ctx.json(res, 400, { error: 'dataBase64 is required' });
      return true;
    }
    try {
      const attachment = saveTaskAttachment(taskId, {
        filename: filename.trim(),
        mimeType,
        dataBase64,
      });
      ctx.audit.record('human', 'ATTACHMENT_UPLOADED', 'task', taskId, {
        attachmentId: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        sha256: attachment.sha256,
      });
      ctx.json(res, 201, { attachment });
    } catch (err) {
      ctx.json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  // GET /api/tasks/:id/attachments — list.
  if (method === 'GET' && attId === null) {
    try {
      ctx.json(res, 200, { attachments: listTaskAttachments(taskId) });
    } catch (err) {
      ctx.json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  // GET /api/tasks/:id/attachments/:attId — download bytes.
  if (method === 'GET' && attId !== null) {
    let found;
    try {
      found = readTaskAttachment(taskId, attId);
    } catch {
      ctx.json(res, 400, { error: 'invalid attachment id' });
      return true;
    }
    if (!found) {
      ctx.json(res, 404, { error: 'attachment not found' });
      return true;
    }
    res.writeHead(200, {
      'content-type': found.record.mimeType,
      'content-length': found.bytes.length,
      'cache-control': 'private, max-age=3600',
    });
    res.end(found.bytes);
    return true;
  }

  return false;
}

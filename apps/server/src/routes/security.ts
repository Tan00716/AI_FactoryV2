/**
 * Security routes — spec §71–§76.
 *
 *  POST /api/security/scan      {manifest} → checklist verdict (ALLOW/REVIEW/BLOCK)
 *  POST /api/security/redact    {text} → redacted text
 *  POST /api/security/classify  {text, source?} → INSTRUCTION/DATA/EXTERNAL_CONTENT + elevation check
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  checkElevation,
  classifyContent,
  redactSecrets,
  scanManifest,
} from '@ai-factory/security';
import type { RouteContext } from './context';

export async function handleSecurityRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/security/')) return false;
  const method = req.method ?? 'GET';
  const seg = path.slice('/api/security/'.length).split('/').filter(Boolean);

  if (method === 'POST' && seg.length === 1 && seg[0] === 'scan') {
    const body = await ctx.readBody(req);
    const manifest = body['manifest'] as Record<string, unknown> | undefined;
    if (!manifest || typeof manifest !== 'object') {
      ctx.json(res, 400, { error: 'manifest object is required' });
      return true;
    }
    const m = manifest as { name?: unknown; instructions?: unknown; scripts?: unknown; declared?: unknown };
    if (typeof m.name !== 'string' || typeof m.instructions !== 'string' || !Array.isArray(m.scripts) || typeof m.declared !== 'object' || m.declared === null) {
      ctx.json(res, 400, { error: 'manifest requires: name (string), instructions (string), scripts (string[]), declared {network, fileAccess, shell}' });
      return true;
    }
    const result = scanManifest(manifest as never);
    ctx.audit.record('system', 'SECURITY_SCAN', 'manifest', String(manifest['name'] ?? 'unknown'), {
      verdict: result.verdict,
      score: result.score,
    });
    ctx.json(res, 200, result);
    return true;
  }

  if (method === 'POST' && seg.length === 1 && seg[0] === 'redact') {
    const body = await ctx.readBody(req);
    const text = body['text'];
    if (typeof text !== 'string') {
      ctx.json(res, 400, { error: 'text is required' });
      return true;
    }
    ctx.json(res, 200, { redacted: redactSecrets(text) });
    return true;
  }

  if (method === 'POST' && seg.length === 1 && seg[0] === 'classify') {
    const body = await ctx.readBody(req);
    const text = body['text'];
    if (typeof text !== 'string') {
      ctx.json(res, 400, { error: 'text is required' });
      return true;
    }
    const source = (body['source'] as 'system' | 'developer' | 'user' | 'external' | 'unknown' | undefined) ?? 'unknown';
    const classification = classifyContent(text, { source });
    const elevation = checkElevation(text, { source });
    ctx.json(res, 200, { classification, elevation });
    return true;
  }

  return false;
}

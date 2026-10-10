/**
 * Security HTTP routes — spec §71–§76.
 *
 *  POST /api/security/scan    {manifest} → {score, findings, verdict, …}
 *  POST /api/security/redact  {text}     → {redacted}
 *
 * Registration style: `registerSecurityRoutes(router, deps)`. The router
 * contract is intentionally loose — any object with `post(path, handler)`
 * works; the handler receives the parsed JSON body and a `ctx` with a
 * `json(status, payload)` responder. (Other route files in this repo use a
 * `handleXRoutes(req, res, url, ctx)` shape; this router-registration shape
 * was requested for the security module so it can mount on other stacks.)
 */
import { redactSecrets } from './credentials';
import { ScanManifest, scanManifest } from './scanner';

export interface SecurityRouter {
  post(
    path: string,
    handler: (body: Record<string, unknown>, ctx: SecurityRouteContext) => Promise<void> | void,
  ): void;
}

export interface SecurityRouteContext {
  json(status: number, payload: unknown): void;
}

/** Deps are minimal and loosely typed: overrides + an optional audit sink. */
export interface SecurityRouteDeps {
  scan?: (manifest: ScanManifest) => unknown;
  redact?: (text: string) => string;
  audit?: {
    record(
      actor: string,
      action: string,
      entityType: string,
      entityId: string,
      details?: Record<string, unknown>,
    ): unknown;
  };
}

function isManifest(v: unknown): v is ScanManifest {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m['name'] === 'string' &&
    typeof m['instructions'] === 'string' &&
    Array.isArray(m['scripts']) &&
    !!m['declared'] &&
    typeof (m['declared'] as Record<string, unknown>)['network'] === 'boolean'
  );
}

export function registerSecurityRoutes(router: SecurityRouter, deps: SecurityRouteDeps = {}): void {
  const scan = deps.scan ?? scanManifest;
  const redact = deps.redact ?? redactSecrets;

  // POST /api/security/scan — install-time manifest security scan.
  router.post('/api/security/scan', (body, ctx) => {
    const manifest = body['manifest'];
    if (!isManifest(manifest)) {
      ctx.json(400, { error: 'manifest is required: {name, instructions, scripts[], declared{network, fileAccess, shell}}' });
      return;
    }
    const actor = typeof body['actor'] === 'string' ? body['actor'] : 'human';
    const result = scan(manifest) as { verdict?: string; name?: string };
    deps.audit?.record(actor, 'SECURITY_SCAN', 'manifest', String(manifest.name), {
      verdict: result.verdict,
    });
    ctx.json(200, result);
  });

  // POST /api/security/redact — secret redaction demo.
  router.post('/api/security/redact', (body, ctx) => {
    const text = body['text'];
    if (typeof text !== 'string') {
      ctx.json(400, { error: 'text is required' });
      return;
    }
    ctx.json(200, { redacted: redact(text) });
  });
}

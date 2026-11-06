/**
 * Trojan Source protection — server routes (round-5 task R5-A5).
 *
 *   POST /api/trojan/scan   scan one file (by path, jailed) or inline text
 *
 * Body: { path?: string; text?: string; filename?: string; root?: string }
 *   - text given  -> scan the inline text (editor live buffer; filename is
 *     cosmetic context only, defaults to 'untitled').
 *   - text absent -> path is required and is jailed to the inspection root
 *     (max 1MB, fail-closed 413); root is resolved via the injected
 *     resolver, never by importing ../inspections (dual-mode import rule:
 *     this module is imported from src by tests, so no extensionless
 *     value-imports of sibling modules).
 *
 * The 'unicode-trojan' inspection checker is exposed through
 * trojanCheckerProvider() and wired into the inspection run in
 * apps/server/src/index.ts via setExtraCheckerProvider — the same
 * setter-injection pattern as round-4 A4 (routes/ssr.ts). The checker
 * only runs when the committed profile enables 'unicode-trojan'.
 *
 * This route only DETECTS. It never rewrites source (removing a bidi
 * override or "fixing" a confusable can silently change program
 * semantics — remediation is always a human decision).
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleTrojanRoutes, setTrojanInspectionRootResolver, trojanCheckerProvider } from './routes/trojanscan';
 *   if (await handleTrojanRoutes(req, res, url, ctx)) return;
 *   setTrojanInspectionRootResolver((root) => resolveInspectionRoot(root));
 *   setExtraCheckerProvider((root) => [...ssrCheckerProvider(root), ...trojanCheckerProvider(root)]);
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { RouteContext } from './context';
import { canonicalPathIsInside, canonicalizePathSync } from '@ai-factory/security';
import type { Checker, Finding } from '../inspections';
import { scanText, type TrojanHit } from '@ai-factory/trojanscan';

export const TROJAN_CHECKER_NAME = 'unicode-trojan';

const PREFIX = '/api/trojan';
const MAX_SCAN_BYTES = 1 * 1024 * 1024;

class TrojanRouteError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'TrojanRouteError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Inspection-root resolver (setter injection, A4 pattern)
// ---------------------------------------------------------------------------

let inspectionRootResolver: ((root?: string) => string) | null = null;

export function setTrojanInspectionRootResolver(fn: ((root?: string) => string) | null): void {
  inspectionRootResolver = fn;
}

function resolveRoot(rawRoot?: string): string {
  if (!inspectionRootResolver) {
    throw new TrojanRouteError('inspection root resolver is not wired', 500);
  }
  try {
    return inspectionRootResolver(rawRoot);
  } catch (e) {
    throw new TrojanRouteError((e as Error).message, 403);
  }
}

function jailFile(root: string, raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024) {
    throw new TrojanRouteError('path is required');
  }
  // V3R19 #6(p): decide on the canonical path — a symlink inside the
  // scan root that points outside it must be refused exactly like a
  // direct path outside the root.
  const abs = canonicalizePathSync(resolve(root, raw));
  const realRoot = canonicalizePathSync(root);
  if (abs !== realRoot && !canonicalPathIsInside(abs, realRoot)) {
    throw new TrojanRouteError(`path escapes the scan root: ${raw.slice(0, 80)}`, 403);
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch {
    throw new TrojanRouteError(`path does not exist: ${raw.slice(0, 80)}`, 404);
  }
  if (!st.isFile()) throw new TrojanRouteError(`path is not a file: ${raw.slice(0, 80)}`);
  if (st.size > MAX_SCAN_BYTES) {
    throw new TrojanRouteError(`file exceeds ${MAX_SCAN_BYTES} bytes`, 413);
  }
  return abs;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export interface TrojanApiHit {
  line: number;
  column: number;
  length: number;
  kind: TrojanHit['kind'];
  severity: TrojanHit['severity'];
  codePoint: string;
  name: string;
  script?: string;
  latin?: string;
  message: string;
}

export function hitToMessage(h: TrojanHit): string {
  const extra =
    h.kind === 'confusable' && h.script && h.latin
      ? ` (looks like Latin '${h.latin}', ${h.script} script)`
      : '';
  return `suspicious Unicode: ${h.codePoint} ${h.name}${extra}`;
}

export function hitToApi(h: TrojanHit): TrojanApiHit {
  return {
    line: h.line,
    column: h.column,
    length: h.length,
    kind: h.kind,
    severity: h.severity,
    codePoint: h.codePoint,
    name: h.name,
    ...(h.script ? { script: h.script } : {}),
    ...(h.latin ? { latin: h.latin } : {}),
    message: hitToMessage(h),
  };
}

function findingIdFor(checker: string, file: string, h: TrojanHit): string {
  const sig = [checker, file, h.line, h.column, hitToMessage(h)].join('');
  return createHash('sha1').update(sig, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Inspection checker provider (wired via setExtraCheckerProvider).
 * Stateless and root-independent: the scanner is pure text analysis,
 * so the provider ignores `root` apart from satisfying the signature.
 */
export function trojanCheckerProvider(_root: string): Checker[] {
  const checker: Checker = {
    name: TROJAN_CHECKER_NAME,
    description:
      'Trojan Source protection: bidi controls, zero-width chars, mixed-script confusables (round-5 A5).',
    run({ file, lines }: { file: string; lines: string[] }): Finding[] {
      const findings: Finding[] = [];
      for (const h of scanText(lines.join('\n'))) {
        const message = hitToMessage(h);
        findings.push({
          id: findingIdFor(TROJAN_CHECKER_NAME, file, h),
          checker: TROJAN_CHECKER_NAME,
          severity: h.severity,
          file,
          line: h.line,
          message,
          detail: JSON.stringify({
            column: h.column,
            kind: h.kind,
            codePoint: h.codePoint,
            name: h.name,
            ...(h.script ? { script: h.script } : {}),
            ...(h.latin ? { latin: h.latin } : {}),
          }),
        });
      }
      return findings;
    },
  };
  return [checker];
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function handleTrojanRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // POST /api/trojan/scan — one file or inline text (viewer).
  if (method === 'POST' && path === `${PREFIX}/scan`) {
    const body = (await ctx.readBody(req).catch(() => ({}))) as Record<string, unknown>;
    let text: string;
    let label: string;
    const inline = body['text'];
    if (typeof inline === 'string') {
      if (inline.length > MAX_SCAN_BYTES) {
        ctx.json(res, 413, { error: `text exceeds ${MAX_SCAN_BYTES} bytes` });
        return true;
      }
      text = inline;
      const fn = body['filename'];
      label = typeof fn === 'string' && fn.trim() ? fn.trim().slice(0, 256) : 'untitled';
    } else {
      let root: string;
      try {
        const rawRoot = body['root'];
        root = resolveRoot(typeof rawRoot === 'string' ? rawRoot : undefined);
      } catch (e) {
        const err = e as TrojanRouteError;
        ctx.json(res, err.status || 403, { error: err.message });
        return true;
      }
      let abs: string;
      try {
        abs = jailFile(root, body['path']);
      } catch (e) {
        const err = e as TrojanRouteError;
        ctx.json(res, err.status || 400, { error: err.message });
        return true;
      }
      try {
        text = readFileSync(abs, 'utf8');
      } catch (e) {
        ctx.json(res, 500, { error: `cannot read file: ${(e as Error).message}` });
        return true;
      }
      label = abs;
    }
    const findings = scanText(text).map(hitToApi);
    ctx.audit.record('viewer', 'TROJAN_SCAN', 'trojan-scan', label, {
      findings: findings.length,
      errors: findings.filter((f) => f.severity === 'error').length,
    });
    ctx.json(res, 200, { findings });
    return true;
  }

  return false;
}

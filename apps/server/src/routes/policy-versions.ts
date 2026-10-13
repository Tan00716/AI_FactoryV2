/**
 * Versioned policy documents — SPEC v2 §48.2 Authorization domain
 * (Batch 34).
 *
 *   POST /api/policy/versions                 publish a new version of a
 *                                             policy document (operator)
 *   GET  /api/policy/versions[?policy_id=]    version history, newest-first (viewer)
 *   GET  /api/policy/versions/:policyId/:version  one published version (viewer)
 *
 * Body: { policy_id: string, content: object|string, created_by?: string }.
 * `content` is stored byte-exact as JSON; the store hashes the bytes
 * (sha256) so a reader can verify a version was not altered.
 *
 * Semantics (pinned by tests):
 *  - version is a per-policy monotonic integer starting at 1, assigned
 *    by the store inside one BEGIN IMMEDIATE transaction; the caller
 *    never supplies a version number — the API cannot renumber history.
 *  - published versions are immutable: there is no PUT/DELETE and no
 *    update API on the store. `status` is derived — the highest version
 *    of a policy is CURRENT, lower ones SUPERSEDED.
 *  - restarts hydrate as-is: versions are terminal records, there is no
 *    in-flight state to demote (Batch 32 delegations differ on purpose).
 *  - every POST writes a POLICY_VERSION_REGISTERED audit record.
 *
 * NOT in scope (stated honestly, not invented): the existing
 * `policy_version` STRING fields on approvals (§23.3), escalations and
 * projects are independent shapes — labels, not document references —
 * and keep their meaning as-is. This surface does not rewire them.
 *
 * RBAC: reads are viewer, POST is operator (the auth gate default).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  statusOf,
  type PolicyVersionRecord,
  type PolicyVersionView,
} from '@ai-factory/db';
import type { RouteContext } from './context';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toView(
  record: PolicyVersionRecord,
  versions: readonly PolicyVersionRecord[],
): PolicyVersionView {
  return { ...record, status: statusOf(record, versions) };
}

export async function handlePolicyVersionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const p = url.pathname;
  if (p !== '/api/policy/versions' && !p.startsWith('/api/policy/versions/')) return false;
  const { json, readBody, audit, fdb } = ctx;
  const method = req.method ?? 'GET';
  const store = fdb.policyVersions;

  // POST /api/policy/versions — publish the next version of a policy.
  if (p === '/api/policy/versions') {
    if (method === 'POST') {
      const b = await readBody(req);
      if (!isRecord(b)) {
        return json(res, 400, { error: 'body must be a JSON object' }), true;
      }
      const policyId = b['policy_id'];
      const content = b['content'];
      const createdBy = b['created_by'];
      if (typeof policyId !== 'string' || policyId.length === 0) {
        return json(res, 400, { error: 'policy_id (non-empty string) is required' }), true;
      }
      if (content === undefined || content === null) {
        return json(res, 400, { error: 'content (object or string) is required' }), true;
      }
      if (typeof content === 'string' && content.length === 0) {
        return json(res, 400, { error: 'content must not be empty' }), true;
      }
      if (createdBy !== undefined && typeof createdBy !== 'string') {
        return json(res, 400, { error: 'created_by must be a string' }), true;
      }
      const contentJson = typeof content === 'string' ? content : JSON.stringify(content);
      const record = store.registerPolicyVersion({
        policyId,
        contentJson,
        createdBy: createdBy ?? 'unknown',
        createdAt: Date.now(),
      });
      const versions = store.listPolicyVersions(policyId);
      audit.record('policy-service', 'POLICY_VERSION_REGISTERED', 'policy_version', policyId, {
        version: record.version,
        content_hash: record.contentHash,
      });
      return json(res, 201, { version: toView(record, versions) }), true;
    }
    if (method === 'GET') {
      const policyId = url.searchParams.get('policy_id') ?? undefined;
      const rows = store.listPolicyVersions(policyId);
      const versions = toViewAll(rows);
      return json(res, 200, { versions }), true;
    }
    return json(res, 405, { error: 'method not allowed' }), true;
  }

  // GET /api/policy/versions/:policyId/:version — one published version.
  const m = p.match(/^\/api\/policy\/versions\/([^/]+)\/(\d+)$/);
  if (m) {
    if (method !== 'GET') {
      return json(res, 405, { error: 'method not allowed' }), true;
    }
    const policyId = decodeURIComponent(m[1]);
    const version = Number.parseInt(m[2], 10);
    const row = store.getPolicyVersion(policyId, version);
    if (!row) {
      return json(res, 404, { error: `unknown policy version ${policyId} v${version}` }), true;
    }
    return json(res, 200, { version: toView(row, store.listPolicyVersions(policyId)) }), true;
  }
  // Malformed /api/policy/versions/* path.
  return json(res, 400, { error: 'expected /api/policy/versions or /api/policy/versions/:policyId/:version' }), true;
}

function toViewAll(rows: PolicyVersionRecord[]): PolicyVersionView[] {
  return rows.map((r) => ({ ...r, status: statusOf(r, rows) }));
}

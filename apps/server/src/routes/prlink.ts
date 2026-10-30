/**
 * PR review and Issue linkage routes (round-7 task R7-#6).
 *
 *   GET  /api/prlink/status                          provider + write-gate state
 *   GET  /api/prlink/local?root=                     branch + log references (read-only)
 *   GET  /api/prlink/linked?root=&repo=              local refs resolved by the provider
 *   GET  /api/prlink/linked/:number?repo=            item + review excerpts + checks
 *   GET  /api/prlink/reviews/local?repo=&number=     locally archived comments
 *   POST /api/prlink/reviews/local                   archive a comment LOCALLY
 *   POST /api/prlink/issues/import                   issue -> task (DRAFT)
 *   POST /api/prlink/write/comment                   REMOTE write (gated, see below)
 *
 * Authentication: normal API token gate (GET -> viewer, writes ->
 * operator by the default prefix rule — no auth.ts change). The
 * provider token is NOT an API credential: it lives only in the
 * provider object built by index.ts and is never logged, audited,
 * returned, or stored by this module.
 *
 * No provider, no data: when the provider is null, /linked answers
 * configured:false with zero items — never fabricated data.
 *
 * Remote writes are OFF by default. POST /write/comment requires
 * ALL of: FACTORY_PRLINK_WRITES_ENABLED=1, body { confirm: true },
 * and a configured provider. Anything less is 403/400/503, audited
 * as PRLINK_WRITE_REFUSED (repo + number only, never the body).
 * Local review archiving is a different, local-only action and is
 * not gated by the remote-write flag — the UI labels it as such.
 *
 * Dual-mode: value imports are node builtins + @ai-factory/* packages
 * only (no src-relative value imports), so tests may import this
 * module from src with an explicit `.ts` suffix. The jail resolver,
 * data dir, and provider are setter-injected from index.ts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import {
  FixtureProvider,
  GitHubProvider,
  addLocalReview,
  getLocalLink,
  listLocalReviews,
  validateNumber,
  validateRepoSlug,
  type PrLinkError,
  type PrLinkProvider,
} from '@ai-factory/prlink';
import type { RouteContext } from './context';

const PREFIX = '/api/prlink';

export interface PrLinkDeps {
  resolveRoot: (root?: string) => string;
  resolveDataDir: () => string;
  provider: PrLinkProvider | null;
}

let deps: PrLinkDeps | null = null;

/** Installed once by index.ts at boot. */
export function setPrLinkDeps(d: PrLinkDeps | null): void {
  deps = d;
}

function needDeps(): PrLinkDeps {
  if (!deps) throw new Error('prlink routes are not wired');
  return deps;
}

/**
 * Build the provider from the server environment (called by index.ts
 * at boot, not per request). Precedence: fixture (offline/tests) >
 * GitHub token (env, or a file named by env) > none (honest
 * unconfigured state). The token value never leaves this closure.
 */
export function buildPrLinkProviderFromEnv(): PrLinkProvider | null {
  if (process.env.FACTORY_PRLINK_PROVIDER === 'fixture' && process.env.FACTORY_PRLINK_FIXTURE_FILE) {
    return new FixtureProvider(process.env.FACTORY_PRLINK_FIXTURE_FILE);
  }
  let token = process.env.FACTORY_PRLINK_TOKEN ?? '';
  const tokenFile = process.env.FACTORY_PRLINK_TOKEN_FILE;
  if (!token && tokenFile) {
    try {
      token = readFileSync(tokenFile, 'utf8').trim();
    } catch {
      token = '';
    }
  }
  if (token) return new GitHubProvider(token);
  return null;
}

export function prLinkWritesEnabled(): boolean {
  return process.env.FACTORY_PRLINK_WRITES_ENABLED === '1';
}

function errStatus(e: unknown): number {
  if (e instanceof Error && (e as PrLinkError).code) {
    switch ((e as PrLinkError).code) {
      case 'bad-repo':
      case 'bad-number':
      case 'bad-reference':
      case 'too-large':
      case 'too-many':
        return 400;
      case 'not-a-repo':
        return 409;
      case 'not-found':
        return 404;
      case 'corrupt-store':
      case 'git-failed':
      case 'provider-failed':
        return 502;
      default:
        return 500;
    }
  }
  return 500;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export async function handlePrLinkRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const p = url.pathname;
  if (p !== PREFIX && !p.startsWith(`${PREFIX}/`)) return false;
  const seg = p.slice(PREFIX.length).split('/').filter((s) => s.length > 0);
  const d = needDeps();
  try {
    // GET /api/prlink/status
    if (method === 'GET' && seg.length === 1 && seg[0] === 'status') {
      ctx.json(res, 200, {
        configured: d.provider !== null,
        provider: d.provider?.name ?? null,
        writesEnabled: prLinkWritesEnabled(),
      });
      return true;
    }
    // GET /api/prlink/local?root=
    if (method === 'GET' && seg.length === 1 && seg[0] === 'local') {
      const root = d.resolveRoot(url.searchParams.get('root') ?? undefined);
      const link = getLocalLink(root, 20);
      ctx.json(res, 200, { root, ...link });
      return true;
    }
    // GET /api/prlink/linked?root=&repo=
    if (method === 'GET' && seg.length === 1 && seg[0] === 'linked') {
      const root = d.resolveRoot(url.searchParams.get('root') ?? undefined);
      const link = getLocalLink(root, 20);
      const repoParam = url.searchParams.get('repo') ?? '';
      if (!d.provider) {
        ctx.json(res, 200, { configured: false, provider: null, root, local: link, items: [] });
        return true;
      }
      const scoped = link.references.filter((r) => (r.repo ?? repoParam) === repoParam || (!r.repo && repoParam));
      const numbers = [...new Set(scoped.map((r) => r.number))];
      const repo = repoParam || scoped.find((r) => r.repo)?.repo;
      if (!repo) {
        ctx.json(res, 200, { configured: true, provider: d.provider.name, root, local: link, items: [], note: 'no repo in scope: pass ?repo=owner/repo' });
        return true;
      }
      validateRepoSlug(repo);
      const items = await d.provider.listLinked(repo, numbers);
      ctx.json(res, 200, { configured: true, provider: d.provider.name, root, local: link, items });
      return true;
    }
    // GET /api/prlink/linked/:number?repo=
    if (method === 'GET' && seg.length === 2 && seg[0] === 'linked') {
      const number = Number(seg[1]);
      const repo = url.searchParams.get('repo') ?? '';
      validateNumber(number);
      validateRepoSlug(repo);
      if (!d.provider) {
        ctx.json(res, 200, { configured: false, provider: null, items: [] });
        return true;
      }
      const detail = await d.provider.getDetail(repo, number);
      ctx.json(res, 200, { configured: true, provider: d.provider.name, ...detail });
      return true;
    }
    // GET /api/prlink/reviews/local?repo=&number=
    if (method === 'GET' && seg.length === 2 && seg[0] === 'reviews' && seg[1] === 'local') {
      const repo = url.searchParams.get('repo') ?? '';
      const number = Number(url.searchParams.get('number') ?? '');
      const reviews = listLocalReviews(d.resolveDataDir(), repo, number);
      ctx.json(res, 200, { reviews });
      return true;
    }
    // POST /api/prlink/reviews/local — local-only archive, never sent remotely.
    if (method === 'POST' && seg.length === 2 && seg[0] === 'reviews' && seg[1] === 'local') {
      const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
      const review = addLocalReview(d.resolveDataDir(), {
        repo: str(body.repo),
        number: Number(body.number),
        file: str(body.file) || undefined,
        line: typeof body.line === 'number' ? body.line : undefined,
        body: str(body.body),
        author: ctx.callerRole ?? 'operator',
      });
      ctx.audit.record('human', 'PRLINK_LOCAL_REVIEW', 'prlink-review', review.id, {
        repo: review.repo,
        number: review.number,
      });
      ctx.json(res, 201, { review });
      return true;
    }
    // POST /api/prlink/issues/import — issue -> DRAFT task (operator confirms in UI).
    if (method === 'POST' && seg.length === 2 && seg[0] === 'issues' && seg[1] === 'import') {
      const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
      const projectId = str(body.projectId);
      const repo = str(body.repo);
      const number = Number(body.number);
      if (!projectId) {
        ctx.json(res, 400, { error: 'projectId is required' });
        return true;
      }
      validateRepoSlug(repo);
      validateNumber(number);
      let title = str(body.title);
      let description = str(body.description);
      if (d.provider && !title) {
        const detail = await d.provider.getDetail(repo, number);
        title = detail.item.title;
        description = detail.item.bodyExcerpt;
      }
      if (!title) {
        ctx.json(res, 400, { error: 'title is required when no provider is configured' });
        return true;
      }
      let task;
      try {
        task = ctx.tasks.create({
          projectId,
          title: title.slice(0, 200),
          description: `Imported from ${repo}#${number} via PR/Issue linkage (read-only source; verify before dispatch).\n${description}`.slice(0, 4000),
          creator: 'prlink',
          authorizationStatus: 'DRAFT',
        });
      } catch (e) {
        // SQLite-backed task store enforces the project FK: an unknown
        // projectId surfaces as a constraint failure, not a 500.
        if (/FOREIGN KEY/i.test((e as Error).message)) {
          ctx.json(res, 409, { error: `unknown project: ${projectId}` });
          return true;
        }
        throw e;
      }
      ctx.audit.record('human', 'PRLINK_ISSUE_IMPORTED', 'prlink-issue', `${repo}#${number}`, {
        repo,
        number,
        taskId: task.id,
      });
      ctx.json(res, 201, { task });
      return true;
    }
    // POST /api/prlink/write/comment — remote write, gated three ways.
    if (method === 'POST' && seg.length === 2 && seg[0] === 'write' && seg[1] === 'comment') {
      const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
      const repo = str(body.repo);
      const number = Number(body.number);
      validateRepoSlug(repo);
      validateNumber(number);
      if (!prLinkWritesEnabled()) {
        ctx.audit.record('human', 'PRLINK_WRITE_REFUSED', 'prlink-write', `${repo}#${number}`, { reason: 'writes-disabled' });
        ctx.json(res, 403, { error: 'remote writes are disabled (FACTORY_PRLINK_WRITES_ENABLED is not 1)' });
        return true;
      }
      if (body.confirm !== true) {
        ctx.audit.record('human', 'PRLINK_WRITE_REFUSED', 'prlink-write', `${repo}#${number}`, { reason: 'confirm-required' });
        ctx.json(res, 400, { error: 'confirm: true is required for remote writes' });
        return true;
      }
      if (!d.provider) {
        ctx.json(res, 503, { error: 'no provider configured' });
        return true;
      }
      if (d.provider.name === 'fixture') {
        ctx.json(res, 501, { error: 'fixture provider cannot post comments' });
        return true;
      }
      const commentBody = str(body.body);
      if (!commentBody.trim()) {
        ctx.json(res, 400, { error: 'body is required' });
        return true;
      }
      const posted = await d.provider.postComment(repo, number, commentBody);
      ctx.audit.record('human', 'PRLINK_COMMENT_POSTED', 'prlink-write', `${repo}#${number}`, {
        repo,
        number,
        commentId: posted.id,
      });
      ctx.json(res, 201, { posted });
      return true;
    }
    return false;
  } catch (e) {
    const status = errStatus(e);
    ctx.json(res, status, { error: (e as Error).message });
    return true;
  }
}

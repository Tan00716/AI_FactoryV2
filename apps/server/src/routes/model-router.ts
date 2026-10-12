/**
 * Model Router routes — spec §28–§30.
 *
 *  POST /api/router/route   {taskType, complexity, requiredTools?, latencyPref?,
 *                            costPref?, privacy?, needsReasoning?, contextNeeded?,
 *                            needsVision?, currentUsage?} → RouteDecision
 *  GET  /api/router/catalog → model catalog
 *  GET  /api/router/account  → provider profile + plan usage status
 *  GET  /api/models          → §90 Model Registry rows: provider, model,
 *                              capability, context, reasoning, cost, latency,
 *                              availability, fallback
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleModelRouterRoutes } from './routes/model-router';
 *   if (await handleModelRouterRoutes(req, res, url, ctx)) return;
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  MODEL_CATALOG,
  getAccountStatus,
  registryRows,
  route,
  type AccountStatus,
} from '@ai-factory/model-router';
import { CodexAdapter, type CodexAccountStatus } from '@ai-factory/runtime';
import type { RouteContext } from './context';

function bad(json: RouteContext['json'], res: ServerResponse, msg: string) {
  json(res, 400, { error: msg });
}

/** Source label stamped into the live status' usageNote by getAccountStatus(). */
const LIVE_SOURCE = 'codex-app-server';

/**
 * Injectable live-account query for GET /api/router/account. Returns a
 * fully-mapped live AccountStatus, or null when no honest live status is
 * available (→ stub fallback). Tests inject this — they must never depend
 * on a real codex binary or login.
 */
export type LiveAccountQuery = () => Promise<AccountStatus | null>;

export interface ModelRouterRouteDeps {
  liveAccountQuery?: LiveAccountQuery;
}

/**
 * Map CodexAdapter's real app-server status onto the §29 AccountStatus
 * shape. Fields the server did not actually report are left absent or
 * explicitly noted — never invented (INV-29: no simulated success).
 *
 * - Unreachable → null (caller falls back to the stub, which labels
 *   itself STUB in its usageNote).
 * - Reachable but NOT logged in (authMethod null) → still a LIVE status:
 *   the reachability/auth facts are real server answers, and the payload
 *   says so verbatim (authMethod=null, requiresOpenaiAuth=…) with
 *   authenticated:false and no usage numbers.
 * - Logged in → account/plan from account/read; usedPct from the primary
 *   rate-limit window (RateLimitSnapshot.primary.usedPercent, the shared
 *   5h pool window per §29) when the server reported one; otherwise
 *   usedPct 0 with resetInfo stating no window was reported (0 = "no
 *   data", the same placeholder convention as the stub — never a
 *   measured value).
 */
export function mapCodexAccountStatus(s: CodexAccountStatus): AccountStatus | null {
  if (!s.reachable) return null;

  if (s.authMethod === null) {
    return {
      profile: {
        kind: 'chatgpt-oauth',
        usageNote:
          'codex app-server reachable but NOT logged in ' +
          `(authMethod=null, requiresOpenaiAuth=${s.requiresOpenaiAuth ?? 'unknown'}). ` +
          'Run `codex login` for live usage; nothing is simulated meanwhile.',
      },
      usage: {
        usedPct: 0,
        resetInfo: 'Unavailable — not logged in',
        authenticated: false,
      },
    };
  }

  const kind =
    s.authMethod === 'apikey'
      ? ('api-key' as const)
      : s.authMethod === 'chatgpt'
        ? ('chatgpt-oauth' as const)
        : ('other' as const);

  let usedPct: number | null = null;
  let resetInfo = 'Server did not report a rate-limit window';
  const snap = s.rateLimits as
    | {
        primary?: {
          usedPercent?: number;
          windowDurationMins?: number | null;
          resetsAt?: number | null;
        } | null;
      }
    | undefined;
  const primary = snap?.primary ?? null;
  if (primary && typeof primary.usedPercent === 'number') {
    usedPct = primary.usedPercent;
    if (typeof primary.resetsAt === 'number') {
      // Protocol reports epoch seconds; tolerate epoch ms defensively.
      const ms = primary.resetsAt > 1e12 ? primary.resetsAt : primary.resetsAt * 1000;
      resetInfo = `Primary window resets at ${new Date(ms).toISOString()}`;
    } else {
      resetInfo = 'Primary window reported without a reset time';
    }
  }

  return {
    profile: {
      kind,
      account: s.account?.email ?? s.account?.type ?? undefined,
      plan: s.account?.planType
        ? kind === 'chatgpt-oauth'
          ? `ChatGPT ${s.account.planType}`
          : s.account.planType
        : undefined,
      usageNote: 'Live account status from codex app-server (getAuthStatus + account/read).',
    },
    usage: {
      usedPct: usedPct ?? 0,
      resetInfo:
        usedPct === null
          ? `${resetInfo}; usedPct shown as 0 = no window data, not measured usage`
          : resetInfo,
      authenticated: true,
    },
  };
}

/**
 * Default live query: ask a real Codex app-server via CodexAdapter
 * (spawn mode, or CODEX_APP_SERVER_URL when set — same env conventions
 * as packages/runtime/demo/codex-live.demo.ts). Short 5s timeout so the
 * account endpoint stays responsive; any failure → null → stub.
 */
async function defaultLiveAccountQuery(): Promise<AccountStatus | null> {
  try {
    const adapter = new CodexAdapter({
      auth: 'chatgpt-oauth',
      appServerUrl: process.env['CODEX_APP_SERVER_URL'] || undefined,
      timeoutMs: process.env['CODEX_TIMEOUT_MS']
        ? Number(process.env['CODEX_TIMEOUT_MS'])
        : 5_000,
    });
    return mapCodexAccountStatus(await adapter.getAccountStatus());
  } catch {
    return null;
  }
}

export async function handleModelRouterRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
  deps: ModelRouterRouteDeps = {},
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // §90 — Model Registry UI data.
  if (method === 'GET' && path === '/api/models') {
    return ctx.json(res, 200, { models: registryRows() }), true;
  }

  if (!path.startsWith('/api/router/')) return false;

  if (method === 'GET' && path === '/api/router/catalog') {
    return ctx.json(res, 200, { models: MODEL_CATALOG }), true;
  }

  if (method === 'GET' && path === '/api/router/account') {
    // §28/§29 — try the REAL provider first (Codex app-server via
    // CodexAdapter): a live result is injected into getAccountStatus()
    // and labelled 'LIVE via codex-app-server'. On any failure the stub
    // answers instead — its usageNote labels itself STUB, so the source
    // is always honest (INV-29: never simulate live data).
    const query = deps.liveAccountQuery ?? defaultLiveAccountQuery;
    let live: AccountStatus | null = null;
    try {
      live = await query();
    } catch {
      live = null;
    }
    if (live) {
      return ctx.json(res, 200, getAccountStatus({ live, liveSource: LIVE_SOURCE })), true;
    }
    return ctx.json(res, 200, getAccountStatus()), true;
  }

  if (method === 'POST' && path === '/api/router/route') {
    const b = await ctx.readBody(req);
    const taskType = b['taskType'];
    const complexity = b['complexity'];
    if (
      typeof taskType !== 'string' ||
      typeof complexity !== 'number' ||
      complexity < 1 ||
      complexity > 5
    ) {
      bad(ctx.json, res, 'taskType (string) and complexity (1-5) are required');
      return true;
    }
    try {
      const decision = route({
        taskType: taskType as never,
        complexity: complexity as 1 | 2 | 3 | 4 | 5,
        requiredTools: Array.isArray(b['requiredTools'])
          ? (b['requiredTools'] as string[])
          : [],
        latencyPref: b['latencyPref'] === 'high' ? 'high' : 'low',
        costPref: b['costPref'] === 'high' ? 'high' : 'low',
        privacy:
          b['privacy'] === 'sensitive' || b['privacy'] === 'internal'
            ? b['privacy']
            : 'public',
        needsReasoning: b['needsReasoning'] === true,
        contextNeeded:
          b['contextNeeded'] === 'large' || b['contextNeeded'] === 'medium'
            ? b['contextNeeded']
            : 'small',
        needsVision: b['needsVision'] === true,
        currentUsage: {
          usedPct:
            typeof b['usedPct'] === 'number'
              ? (b['usedPct'] as number)
              : typeof (b['currentUsage'] as Record<string, unknown> | undefined)
                    ?.['usedPct'] === 'number'
                ? ((b['currentUsage'] as Record<string, unknown>)[
                    'usedPct'
                  ] as number)
                : 0,
        },
      });
      return ctx.json(res, 200, decision), true;
    } catch (e) {
      bad(ctx.json, res, e instanceof Error ? e.message : 'routing failed');
      return true;
    }
  }

  return false;
}

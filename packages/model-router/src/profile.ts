/**
 * Provider profiles and account status — spec §28 (Codex integration) and
 * §29 (ChatGPT plan usage).
 *
 * IMPORTANT — shared usage pool (§29):
 * For ChatGPT Plus/Pro plan usage, OpenAI documents a single SHARED five-hour
 * usage limit across participating apps using the ChatGPT plan. Usage is NOT
 * multiplied by creating more agents: ten agents do not get ten allowances.
 * The UI must display the connected account, plan, usage status and reset
 * information honestly, and the Model Router (see router.ts) must consult
 * currentUsage.usedPct and prefer local/fallback models when the pool is
 * exhausted, instead of pretending every AI Employee has its own allowance.
 *
 * getAccountStatus() is a stub in this prototype: it returns the profile
 * shape the UI needs, with placeholder usage fields. A real implementation
 * would query the provider (OAuth token status / app-server usage endpoint).
 *
 * Optional live injection: a caller that has queried a real provider (e.g.
 * CodexAdapter.getAccountStatus() in @ai-factory/runtime mapped to this
 * shape) can pass it via `overrides.live`; it is then returned with the
 * usageNote annotated as LIVE + source. model-router cannot import the
 * runtime (the dependency runs the other way), so the live result is
 * injected, never called from here. Default behavior is unchanged.
 */
import type { AccountStatus, ProviderKind } from './types';

export interface AccountStatusOverrides {
  kind?: ProviderKind;
  account?: string;
  plan?: string;
  usedPct?: number;
  resetInfo?: string;
  authenticated?: boolean;
  /** Live AccountStatus from a real provider integration; wins over the stub fields. */
  live?: AccountStatus;
  /** Human-readable origin of `live` (e.g. 'codex app-server getAuthStatus'). */
  liveSource?: string;
}

const DEFAULT_USAGE_NOTE =
  'STUB: connect a real provider (ChatGPT OAuth, API key, or local model) to report live usage. ' +
  'Until then the router works from the usedPct you pass in RouteRequest.currentUsage.';

/** Stub returning the §29 account-status shape with placeholder values. */
export function getAccountStatus(overrides: AccountStatusOverrides = {}): AccountStatus {
  if (overrides.live) {
    const live = overrides.live;
    return {
      ...live,
      profile: {
        ...live.profile,
        usageNote: `LIVE via ${overrides.liveSource ?? 'injected provider'} — ${live.profile.usageNote}`,
      },
    };
  }
  const kind = overrides.kind ?? 'chatgpt-oauth';
  return {
    profile: {
      kind,
      account: overrides.account,
      plan: overrides.plan ?? (kind === 'chatgpt-oauth' ? 'ChatGPT Plus (shared 5h pool)' : undefined),
      usageNote: DEFAULT_USAGE_NOTE,
    },
    usage: {
      usedPct: overrides.usedPct ?? 0,
      resetInfo: overrides.resetInfo ?? 'Resets on the provider 5-hour window (stub: no live data)',
      authenticated: overrides.authenticated ?? false,
    },
  };
}

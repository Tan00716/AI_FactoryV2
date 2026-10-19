import { useCallback, useEffect, useRef, useState } from 'react';
import { defaultApiBase, authHeaders } from '../api';
import { useLang } from '../i18n';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface SandboxModeState {
  /** Effective mode (env override applied; a project config may still win per-request). */
  mode: SandboxMode;
  persistedMode: SandboxMode;
  approvalPolicy: 'on-request' | 'never';
  envForced: boolean;
  updatedAt: string;
  updatedBy: string;
}

async function req<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as T;
  if (!res.ok) {
    const err = body as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return body;
}

export function createSandboxModeApi(base: string = defaultApiBase()) {
  return {
    mode: () => req<SandboxModeState>(base, '/sandbox/mode'),
    setMode: (mode: SandboxMode) =>
      req<SandboxModeState>(base, '/sandbox/mode', {
        method: 'POST',
        body: JSON.stringify({ mode }),
      }),
  };
}

/**
 * Shared sandbox-mode state: polls the effective tier every 10s so the
 * UI never disagrees with the gate. mode is null while the server is
 * unreachable or the route is missing (older server) — callers hide
 * the badge rather than showing a wrong tier.
 */
export function useSandboxMode(base?: string) {
  const [mode, setMode] = useState<SandboxModeState | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMode(await createSandboxModeApi(base).mode());
    } catch {
      setMode(null);
    }
  }, [base]);

  useEffect(() => {
    void refresh();
    timer.current = setInterval(() => { void refresh(); }, 10_000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [refresh]);

  const setSandboxMode = useCallback(
    async (next: SandboxMode): Promise<void> => {
      setMode(await createSandboxModeApi(base).setMode(next));
    },
    [base],
  );

  return { mode, refresh, setSandboxMode };
}

const TIER_ICON: Record<SandboxMode, string> = {
  'read-only': '🔒',
  'workspace-write': '🛡️',
  'danger-full-access': '☠️',
};

/**
 * Sandbox tier badge for the top bar + the full-width danger banner.
 * Hidden when base is omitted or the server doesn't answer.
 */
export function SandboxModeBadge({ base }: { base?: string }) {
  const { t } = useLang();
  const { mode, setSandboxMode } = useSandboxMode(base);
  const [busy, setBusy] = useState(false);
  if (!mode) return null;

  const change = async (next: SandboxMode) => {
    if (busy || next === mode.mode) return;
    if (next === 'danger-full-access' && !window.confirm(t('sandbox.confirmDanger'))) return;
    setBusy(true);
    try {
      await setSandboxMode(next);
    } catch (err) {
      window.alert(t('sandbox.switchFailed', { msg: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <label className={`sandbox-badge is-${mode.mode}`} title={t('sandbox.changeTier')}>
      {t('sandbox.tier')}:{' '}
      <select
        value={mode.mode}
        disabled={busy || mode.envForced}
        onChange={(e) => { void change(e.target.value as SandboxMode); }}
        aria-label={t('sandbox.changeTier')}
      >
        <option value="read-only">{`${TIER_ICON['read-only']} ${t('sandbox.readOnly')}`}</option>
        <option value="workspace-write">{`${TIER_ICON['workspace-write']} ${t('sandbox.workspaceWrite')}`}</option>
        <option value="danger-full-access">{`${TIER_ICON['danger-full-access']} ${t('sandbox.dangerFullAccess')}`}</option>
      </select>
      {mode.envForced && <span className="env-forced">{t('sandbox.envForced')}</span>}
    </label>
  );
}

/**
 * Full-width danger banner. Rendered OUTSIDE the top-bar header (next
 * to the offline banner) so it spans the window instead of being
 * squeezed into the header's flex row.
 */
export function SandboxDangerBanner({ base }: { base?: string }) {
  const { t } = useLang();
  const { mode } = useSandboxMode(base);
  if (!mode || mode.mode !== 'danger-full-access') return null;
  return (
    <div className="sandbox-danger-banner" role="alert">
      {TIER_ICON['danger-full-access']} {t('sandbox.dangerBanner')}
    </div>
  );
}

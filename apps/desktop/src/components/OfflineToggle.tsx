import { useCallback, useEffect, useRef, useState } from 'react';
import { defaultApiBase, authHeaders } from '../api';

export interface NetworkMode {
  /** Effective state (env override applied) — what the UI must show. */
  offline: boolean;
  persistedOffline: boolean;
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

export function createNetworkModeApi(base: string = defaultApiBase()) {
  return {
    mode: () => req<NetworkMode>(base, '/network/mode'),
    setOffline: (enabled: boolean) =>
      req<NetworkMode>(base, '/network/offline', {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      }),
  };
}

/**
 * Shared network-mode state: polls the effective mode (the server
 * applies the FACTORY_NETWORK_OFFLINE env override) every 10s so the
 * UI never disagrees with the gate. mode is null while the server is
 * unreachable or the route is missing (older server) — callers hide
 * the toggle rather than showing a wrong state.
 */
export function useNetworkMode(base?: string) {
  const [mode, setMode] = useState<NetworkMode | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMode(await createNetworkModeApi(base).mode());
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

  const setOffline = useCallback(
    async (enabled: boolean): Promise<void> => {
      setMode(await createNetworkModeApi(base).setOffline(enabled));
    },
    [base],
  );

  return { mode, refresh, setOffline };
}

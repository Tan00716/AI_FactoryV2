/**
 * PluginsPanel — W-F desktop surface for local plugin install/management.
 * Wired to apps/server/src/routes/plugins.ts via PluginsApi.
 */
import { useCallback, useEffect, useState } from 'react';
import { authHeaders } from '../api';
import { useLang } from '../i18n';

// ------------------------------------------------------------- API ----

export interface PluginCapabilitySummary {
  skills: { id: string; version: string }[];
  slashCommands: { name: string; description: string; template: string }[];
  hooks: { id: string; event: string; command: string }[];
  mcpServers: { name: string; version: string; transport: string }[];
}

export interface PluginInfo {
  name: string;
  version: string;
  description: string;
  permissions: string[];
  enabled: boolean;
  installedAt: string;
  installedBy: string;
  capabilities: PluginCapabilitySummary;
}

export interface PluginsApi {
  list(): Promise<{ plugins: PluginInfo[]; home: string }>;
  install(sourceDir: string): Promise<{ ok: boolean; plugin: PluginInfo }>;
  enable(name: string): Promise<{ ok: boolean; plugin: PluginInfo }>;
  disable(name: string): Promise<{ ok: boolean; plugin: PluginInfo }>;
  uninstall(name: string): Promise<{ ok: boolean; name: string }>;
}

export function createPluginsApi(base: string): PluginsApi {
  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
    });
    const body = (await res.json()) as T;
    if (!res.ok) {
      const err = body as { error?: string };
      const e = new Error(err.error ?? `HTTP ${res.status}`) as Error & { status: number };
      e.status = res.status;
      throw e;
    }
    return body;
  }
  return {
    list: () => req<{ plugins: PluginInfo[]; home: string }>('/plugins'),
    install: (sourceDir) =>
      req<{ ok: boolean; plugin: PluginInfo }>('/plugins/install', {
        method: 'POST',
        body: JSON.stringify({ sourceDir }),
      }),
    enable: (name) =>
      req<{ ok: boolean; plugin: PluginInfo }>(`/plugins/${encodeURIComponent(name)}/enable`, {
        method: 'POST',
      }),
    disable: (name) =>
      req<{ ok: boolean; plugin: PluginInfo }>(`/plugins/${encodeURIComponent(name)}/disable`, {
        method: 'POST',
      }),
    uninstall: (name) =>
      req<{ ok: boolean; name: string }>(`/plugins/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      }),
  };
}

// ------------------------------------------------------------ panel ----

export function PluginsPanel({ api }: { api: PluginsApi }) {
  const { t } = useLang();
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [home, setHome] = useState('');
  const [sourceDir, setSourceDir] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const r = await api.list();
      setPlugins(r.plugins);
      setHome(r.home);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('plugin.loadFailed'));
    }
  }, [api, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<void>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('plugin.opFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: 12, overflowY: 'auto', height: '100%' }}>
      <h3 style={{ margin: '0 0 8px' }}>{t('plugin.title')}</h3>
      {err && <div className="banner err">{err}</div>}
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        {t('plugin.installHint')}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          type="text"
          placeholder={t('plugin.sourceDirPlaceholder')}
          value={sourceDir}
          onChange={(e) => setSourceDir(e.target.value)}
          style={{ flex: 1, padding: 6, borderRadius: 4 }}
        />
        <button
          className="primary"
          disabled={busy || !sourceDir.trim()}
          onClick={() => void run(() => api.install(sourceDir).then(() => setSourceDir('')))}
        >
          {t('plugin.install')}
        </button>
      </div>

      {home && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          {home}
        </div>
      )}

      {plugins.length === 0 && <div className="muted">{t('plugin.noPlugins')}</div>}
      {plugins.map((p) => (
        <div
          key={p.name}
          style={{
            border: '1px solid var(--border, #2d333b)',
            borderRadius: 6,
            padding: 10,
            marginBottom: 8,
          }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
            <strong style={{ fontSize: 14 }}>{p.name}</strong>
            <span className="pill">v{p.version}</span>
            <span className="pill">{p.enabled ? t('plugin.enabled') : t('plugin.disabled')}</span>
            <span style={{ flex: 1 }} />
            {p.enabled ? (
              <button disabled={busy} onClick={() => void run(() => api.disable(p.name).then(() => undefined))}>
                {t('plugin.disable')}
              </button>
            ) : (
              <button disabled={busy} onClick={() => void run(() => api.enable(p.name).then(() => undefined))}>
                {t('plugin.enable')}
              </button>
            )}
            <button
              disabled={busy}
              onClick={() => {
                if (window.confirm(`${t('plugin.confirmUninstall')} "${p.name}"?`)) {
                  void run(() => api.uninstall(p.name).then(() => undefined));
                }
              }}
            >
              {t('plugin.uninstall')}
            </button>
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{p.description}</div>
          <div style={{ fontSize: 12 }}>
            <span className="muted">{t('plugin.permissions')}: </span>
            {p.permissions.length > 0 ? p.permissions.join(', ') : '—'}
            <span className="muted" style={{ marginLeft: 12 }}>
              {t('plugin.installedBy')}: {p.installedBy}
            </span>
          </div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            <span className="muted">{t('plugin.capabilities')}: </span>
            {p.capabilities.skills.length > 0 && (
              <span className="pill" style={{ marginRight: 4 }}>
                {t('plugin.skills')} {p.capabilities.skills.length}
              </span>
            )}
            {p.capabilities.slashCommands.length > 0 && (
              <span className="pill" style={{ marginRight: 4 }}>
                {t('plugin.commands')} {p.capabilities.slashCommands.length}
              </span>
            )}
            {p.capabilities.hooks.length > 0 && (
              <span className="pill" style={{ marginRight: 4 }}>
                {t('plugin.hooks')} {p.capabilities.hooks.length}
              </span>
            )}
            {p.capabilities.mcpServers.length > 0 && (
              <span className="pill" style={{ marginRight: 4 }}>
                {t('plugin.mcpServers')} {p.capabilities.mcpServers.length}
              </span>
            )}
            {p.capabilities.skills.length +
              p.capabilities.slashCommands.length +
              p.capabilities.hooks.length +
              p.capabilities.mcpServers.length ===
              0 && <span className="muted">—</span>}
          </div>
          {(p.capabilities.slashCommands.length > 0 || p.capabilities.skills.length > 0) && (
            <div className="muted" style={{ fontSize: 11, marginTop: 4, fontFamily: 'monospace' }}>
              {p.capabilities.slashCommands.map((c) => `/${c.name}`).join(' ')}
              {p.capabilities.skills.map((s) => ` ${s.id}`).join('')}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

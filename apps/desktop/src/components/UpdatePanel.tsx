/**
 * Updates tab (R3-T1): app update channel status + manual check +
 * changelog panel. Download + install run in the Electron main process
 * (electron-updater) behind an explicit user click — never silent.
 */
import { useCallback, useEffect, useState } from 'react';
import { authHeaders } from '../api';
import { useLang } from '../i18n';

export interface UpdateStatus {
  currentVersion: string;
  feedConfigured: boolean;
  feedHost: string | null;
  autoCheck: boolean;
  checkIntervalMs: number;
  lastCheck: { at: number; result: UpdateCheckResult } | null;
  /** V3R3 #10: true when the persisted lastCheck record is corrupt (ignored, not a check). */
  lastCheckCorrupt?: boolean;
  /** V3R3 #10: non-null when the last persist attempt failed (in-memory value still served). */
  lastCheckPersistError?: string | null;
}

export interface UpdateFeedInfo {
  version: string;
  path?: string;
  releaseDate?: string;
  releaseNotes?: string;
}

export type UpdateCheckResult =
  | { status: 'not-configured' }
  | { status: 'up-to-date'; current: string; latest: string }
  | { status: 'update-available'; current: string; latest: string; feed: UpdateFeedInfo }
  | { status: 'feed-error'; reason: string }
  | { status: 'fetch-error'; reason: string };

export interface ChangelogEntry {
  version: string;
  date: string | null;
  title: string | null;
  notes: string[];
}

export interface UpdateApi {
  status: () => Promise<UpdateStatus>;
  check: () => Promise<{ result: UpdateCheckResult }>;
  changelog: () => Promise<{ entries: ChangelogEntry[]; note: string | null }>;
}

export function createUpdateApi(base: string): UpdateApi {
  async function req<T>(p: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${base}${p}`, { headers: { ...authHeaders() }, ...init });
    const body = (await res.json()) as T;
    if (!res.ok) {
      const err = body as { error?: string };
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    return body;
  }
  return {
    status: () => req('/updates/status'),
    check: () => req('/updates/check', { method: 'POST' }),
    changelog: () => req('/updates/changelog'),
  };
}

function fmtTime(at: number): string {
  try {
    return new Date(at).toLocaleString();
  } catch {
    return String(at);
  }
}

export function UpdatePanel({ api }: { api: UpdateApi }) {
  const { t } = useLang();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [entries, setEntries] = useState<ChangelogEntry[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([api.status(), api.changelog()]);
      setStatus(s);
      setEntries(c.entries);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const doCheck = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      await api.check();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }, [api, refresh]);

  const doDownload = useCallback(async () => {
    const bridge = window.aiFactory;
    if (!bridge?.updateDownload || !status?.feedConfigured) return;
    setDownloading(true);
    setError(null);
    try {
      // The feed URL is server-side config; the main process resolves it
      // from its own env (same env the backend was spawned with).
      const out = await bridge.updateDownload();
      if (out.downloaded) setDownloaded(out.version ?? '?');
      else setError(t('update.downloadNoUpdate'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
      void refresh();
    }
  }, [status, t, refresh]);

  const doQuitInstall = useCallback(async () => {
    try {
      await window.aiFactory?.updateQuitAndInstall();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const last = status?.lastCheck?.result;
  const available = last?.status === 'update-available' ? last : null;

  return (
    <div className="panel updates-panel">
      <h2>{t('update.title')}</h2>
      {error && <div className="error-banner">{error}</div>}

      <section className="card">
        <h3>{t('update.channelTitle')}</h3>
        {status ? (
          <dl className="kv">
            <div>
              <dt>{t('update.currentVersion')}</dt>
              <dd>v{status.currentVersion}</dd>
            </div>
            <div>
              <dt>{t('update.feed')}</dt>
              <dd>
                {status.feedConfigured ? (
                  <span className="pill ok">{t('update.feedConfigured', { host: status.feedHost ?? '' })}</span>
                ) : (
                  <span className="pill warn">{t('update.feedNotConfigured')}</span>
                )}
              </dd>
            </div>
            <div>
              <dt>{t('update.lastCheck')}</dt>
              <dd>
                {!status.feedConfigured ? (
                  <>
                    <span className="pill warn">{t('update.lastCheckNotConfigured')}</span>{' '}
                    <span className="muted">{t('update.feedDecisionHint')}</span>
                  </>
                ) : status.lastCheckCorrupt ? (
                  <span className="muted">{t('update.lastCheckCorrupt')}</span>
                ) : status.lastCheck ? (
                  <>
                    {fmtTime(status.lastCheck.at)} —{' '}
                    {(status.lastCheck.result.status === 'feed-error' ||
                      status.lastCheck.result.status === 'fetch-error') && 'reason' in status.lastCheck.result ? (
                      <span className="pill warn">
                        {t(`update.result_${status.lastCheck.result.status}` as const)} —{' '}
                        {(status.lastCheck.result as { reason: string }).reason}
                      </span>
                    ) : (
                      t(`update.result_${status.lastCheck.result.status}` as const)
                    )}
                  </>
                ) : (
                  t('update.neverChecked')
                )}
              </dd>
            </div>
            <div>
              <dt>{t('update.autoCheck')}</dt>
              <dd>
                {status.autoCheck
                  ? t('update.autoCheckOn', { hours: String(Math.round(status.checkIntervalMs / 3600000)) })
                  : t('update.autoCheckOff')}
              </dd>
            </div>
          </dl>
        ) : (
          <div className="muted">{t('update.loading')}</div>
        )}
        <div className="row">
          <button onClick={doCheck} disabled={checking}>
            {checking ? t('update.checking') : t('update.checkNow')}
          </button>
          {!status?.feedConfigured && <span className="muted">{t('update.feedHint')}</span>}
        </div>
        {available && (
          <div className="update-available card">
            <strong>{t('update.available', { version: available.latest })}</strong>
            {available.feed.releaseDate && (
              <div className="muted">{t('update.releasedAt', { date: available.feed.releaseDate })}</div>
            )}
            {available.feed.releaseNotes && <p>{available.feed.releaseNotes}</p>}
            <div className="row">
              {downloaded ? (
                <button onClick={doQuitInstall}>{t('update.restartInstall')}</button>
              ) : (
                <button onClick={doDownload} disabled={downloading || !window.aiFactory?.updateDownload}>
                  {downloading ? t('update.downloading') : t('update.downloadInstall')}
                </button>
              )}
              {!window.aiFactory?.updateDownload && (
                <span className="muted">{t('update.desktopOnlyHint')}</span>
              )}
            </div>
            {downloaded && <div className="muted">{t('update.downloadedReady', { version: downloaded })}</div>}
          </div>
        )}
      </section>

      <section className="card">
        <h3>{t('update.changelogTitle')}</h3>
        {entries === null ? (
          <div className="muted">{t('update.loading')}</div>
        ) : entries.length === 0 ? (
          <div className="muted">{t('update.noChangelog')}</div>
        ) : (
          entries.map((e) => (
            <details key={e.version} className="changelog-entry" open={e.version === status?.currentVersion}>
              <summary>
                <strong>v{e.version}</strong>
                {e.date && <span className="muted"> · {e.date}</span>}
                {e.title && <span> — {e.title}</span>}
              </summary>
              <ul>
                {e.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </details>
          ))
        )}
      </section>
    </div>
  );
}

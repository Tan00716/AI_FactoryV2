/**
 * Settings sync panel (R7-#10) — export/import settings as a versioned
 * JSON document, with a pre-apply diff preview. Conflict and removed
 * entries need an explicit per-key decision (incoming vs keep); nothing
 * is overwritten silently. The optional private remote stores one JSON
 * document at the user's own URL; its token lives in the server
 * environment and is never shown here, never in a document, and never
 * in an audit record.
 *
 * Synced in v1: keybindings (user layer) and global rules. Secrets,
 * .env files, tokens, extension code, and project files are never
 * synced — a document matching a secret pattern is refused server-side.
 * Desktop-only preferences (vim mode, nav tier, golden-path progress)
 * live in localStorage and are NOT synced in v1.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type SettingsyncDiffEntry } from '../api';
import { useLang } from '../i18n';

type Doc = Record<string, unknown>;

function short(v: unknown): string {
  const s = JSON.stringify(v) ?? 'null';
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

export function SettingsSyncPanel() {
  const { t } = useLang();
  const [remoteUrl, setRemoteUrl] = useState('');
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [importText, setImportText] = useState('');
  const [doc, setDoc] = useState<Doc | null>(null);
  const [entries, setEntries] = useState<SettingsyncDiffEntry[]>([]);
  const [summary, setSummary] = useState<Record<string, number> | null>(null);
  const [baseline, setBaseline] = useState(false);
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  const loadRemote = useCallback(async () => {
    try {
      const r = await api.settingsyncRemoteGet();
      setRemoteUrl(r.url ?? '');
      setTokenConfigured(r.tokenConfigured);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    loadRemote();
  }, [loadRemote]);

  const download = (name: string, content: string) => {
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const doExport = useCallback(async () => {
    setError(null);
    setStatus('');
    try {
      const r = await api.settingsyncExport();
      download('ai-factory-settings.json', JSON.stringify(r.doc, null, 2));
      setStatus(t('sync.exported'));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [t]);

  const doPreview = useCallback(async (d: Doc) => {
    setError(null);
    setStatus('');
    setLoading(true);
    try {
      const r = await api.settingsyncPreview(d);
      setDoc(d);
      setEntries(r.entries);
      setSummary(r.summary);
      setBaseline(r.baseline);
      setResolutions({});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const previewFromText = useCallback(async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(importText) as unknown;
    } catch {
      setError(t('sync.invalidJson'));
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setError(t('sync.invalidJson'));
      return;
    }
    await doPreview(parsed as Doc);
  }, [importText, doPreview, t]);

  const doApply = useCallback(async () => {
    if (!doc) return;
    setError(null);
    setStatus('');
    try {
      const r = await api.settingsyncApply(doc, resolutions);
      setStatus(t('sync.applied', { applied: r.applied.length, kept: r.kept.length }));
      setDoc(null);
      setEntries([]);
      setSummary(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [doc, resolutions, t]);

  const needsDecision = entries.filter((e) => e.kind === 'conflict' || e.kind === 'removed');
  const unresolved = needsDecision.filter((e) => resolutions[`${e.section}:${e.key}`] === undefined);

  const saveRemote = useCallback(async () => {
    setError(null);
    try {
      const r = await api.settingsyncRemotePut(remoteUrl.trim() === '' ? null : remoteUrl.trim());
      setRemoteUrl(r.url ?? '');
      setTokenConfigured(r.tokenConfigured);
      setStatus(t('sync.remoteSaved'));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [remoteUrl, t]);

  const doPush = useCallback(async () => {
    setError(null);
    try {
      const r = await api.settingsyncRemotePush();
      setStatus(t('sync.pushed', { sections: r.sections.join(', ') }));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [t]);

  const doPull = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const r = await api.settingsyncRemotePull();
      setDoc(r.doc);
      setEntries(r.entries);
      setSummary(r.summary);
      setBaseline(r.baseline);
      setResolutions({});
      setStatus(t('sync.pulled'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [t]);

  return (
    <div>
      <h3>{t('sync.title')}</h3>
      <p>{t('sync.intro')}</p>
      <p>{t('sync.neverSynced')}</p>
      <p>{t('sync.desktopPrefsNote')}</p>
      {error && <p style={{ color: 'red' }}>{error}</p>}
      {status && <p>{status}</p>}
      <div>
        <button onClick={doExport}>{t('sync.export')}</button>
      </div>
      <h4>{t('sync.importTitle')}</h4>
      <textarea
        value={importText}
        onChange={(e) => setImportText(e.target.value)}
        rows={8}
        cols={80}
        placeholder={t('sync.importPlaceholder')}
      />
      <div>
        <button onClick={previewFromText} disabled={loading}>{t('sync.preview')}</button>
      </div>
      {summary && (
        <div>
          <p>
            {t('sync.summary', {
              added: summary['added'] ?? 0,
              modified: summary['modified'] ?? 0,
              conflict: summary['conflict'] ?? 0,
              removed: summary['removed'] ?? 0,
            })}{' '}
            {baseline ? t('sync.hasBaseline') : t('sync.noBaseline')}
          </p>
          {entries.length === 0 && <p>{t('sync.noChanges')}</p>}
          {entries.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>{t('sync.colSection')}</th>
                  <th>{t('sync.colKey')}</th>
                  <th>{t('sync.colKind')}</th>
                  <th>{t('sync.colCurrent')}</th>
                  <th>{t('sync.colIncoming')}</th>
                  <th>{t('sync.colDecision')}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const id = `${e.section}:${e.key}`;
                  const decision = e.kind === 'conflict' || e.kind === 'removed';
                  return (
                    <tr key={id}>
                      <td>{e.section}</td>
                      <td>{e.key}</td>
                      <td>{t(`sync.kind.${e.kind}`)}</td>
                      <td>{short(e.currentValue)}</td>
                      <td>{short(e.incomingValue)}</td>
                      <td>
                        {decision ? (
                          <select
                            value={resolutions[id] ?? ''}
                            onChange={(ev) => setResolutions((prev) => ({ ...prev, [id]: ev.target.value }))}
                          >
                            <option value="">{t('sync.choose')}</option>
                            <option value="incoming">{t('sync.useIncoming')}</option>
                            <option value="keep">{t('sync.keepLocal')}</option>
                          </select>
                        ) : (
                          t('sync.auto')
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {entries.length > 0 && (
            <button onClick={doApply} disabled={unresolved.length > 0}>
              {unresolved.length > 0
                ? t('sync.resolveFirst', { n: unresolved.length })
                : t('sync.apply')}
            </button>
          )}
        </div>
      )}
      <h4>{t('sync.remoteTitle')}</h4>
      <p>{t('sync.remoteIntro')}</p>
      <p>
        {t('sync.tokenStatus')}: {tokenConfigured ? t('sync.tokenYes') : t('sync.tokenNo')}
      </p>
      <input
        value={remoteUrl}
        onChange={(e) => setRemoteUrl(e.target.value)}
        placeholder={t('sync.remotePlaceholder')}
        size={60}
      />
      <div>
        <button onClick={saveRemote}>{t('sync.remoteSave')}</button>{' '}
        <button onClick={doPush} disabled={remoteUrl.trim() === ''}>{t('sync.push')}</button>{' '}
        <button onClick={doPull} disabled={remoteUrl.trim() === '' || loading}>{t('sync.pull')}</button>
      </div>
    </div>
  );
}

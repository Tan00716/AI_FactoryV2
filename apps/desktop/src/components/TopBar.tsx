import { useState } from 'react';
import { Project } from '../api';
import { NotificationCenter } from './NotificationCenter';
import { SlashCommandBar } from './SlashCommandBar';
import { useNetworkMode } from './OfflineToggle';
import { SandboxModeBadge, SandboxDangerBanner } from './SandboxModeBadge';
import { useLang } from '../i18n';

/** §3 top bar: product name, active project, agent count, run status, notification bell (§30). */
export function TopBar({
  projects, projectId, onProject, agentCount, connected, notificationsBase, networkBase, sandboxBase,
  onOpenProjectSettings, identityLabel, onCommandNavigate,
}: {
  projects: Project[];
  projectId: string;
  onProject: (id: string) => void;
  agentCount: number;
  connected: boolean;
  /** API base for the notification bell; bell hidden when omitted. */
  notificationsBase?: string;
  /** API base for the offline-mode switch; switch hidden when omitted. */
  networkBase?: string;
  /** API base for the sandbox tier badge; badge hidden when omitted. */
  sandboxBase?: string;
  /** Jump to the Project settings tab (import/export); button hidden when omitted. */
  onOpenProjectSettings?: () => void;
  /** Batch 15: current API identity label (role / local mode); hidden when omitted. */
  identityLabel?: string;
  /** W-B: slash command bar navigation; bar hidden when omitted. */
  onCommandNavigate?: (tab: string) => void;
}) {
  const { lang, setLang, t } = useLang();
  // Offline mode (加强项6): one polled state shared by the switch and the banner.
  const { mode: networkMode, setOffline } = useNetworkMode(networkBase);
  const [netBusy, setNetBusy] = useState(false);
  const toggleNetwork = async () => {
    if (!networkMode || netBusy) return;
    const next = !networkMode.offline;
    if (next && !window.confirm(t('offline.confirmOffline'))) return;
    setNetBusy(true);
    try {
      await setOffline(next);
    } catch (err) {
      window.alert(t('offline.toggleFailed', { msg: err instanceof Error ? err.message : String(err) }));
    } finally {
      setNetBusy(false);
    }
  };
  return (
    <>
    <header className="topbar">
      <div className="brand">🤖 AI FACTORY</div>
      <div className="topbar-center">
        <label>
          Project:{' '}
          <select value={projectId} onChange={(e) => onProject(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        {onOpenProjectSettings && (
          <button className="bell-btn" title={t('topbar.projectSettings')} onClick={onOpenProjectSettings}>⚙️</button>
        )}
        {typeof window !== 'undefined' && window.aiFactory?.openWindow && (
          <button
            className="bell-btn"
            title={t('topbar.openInNewWindowTitle')}
            aria-label={t('topbar.openInNewWindow')}
            onClick={() => window.aiFactory!.openWindow(projectId)}
          >⧉</button>
        )}
        <span className="agent-count">{agentCount} Agents</span>
        {onCommandNavigate && <SlashCommandBar onNavigateTab={onCommandNavigate} />}
        {identityLabel && (
          <span className="agent-count" title={t('topbar.identityTitle')}>{identityLabel}</span>
        )}
        {networkMode && (
          <button
            className={`offline-toggle ${networkMode.offline ? 'is-offline' : 'is-online'}`}
            title={networkMode.offline ? t('offline.goOnline') : t('offline.goOffline')}
            onClick={() => { void toggleNetwork(); }}
            disabled={netBusy}
          >
            <span className="dot" />
            {networkMode.offline ? `📴 ${t('offline.offline')}` : `📡 ${t('offline.online')}`}
          </button>
        )}
        {sandboxBase !== undefined && <SandboxModeBadge base={sandboxBase} />}
      </div>
      {notificationsBase && <NotificationCenter base={notificationsBase} />}
      {/* i18n 试点：中 / EN 切换。只影响已接入 i18n 的面板
          （Dashboard / Board / Approvals / NeedsHuman），其余面板本批不动。 */}
      <div className="lang-switch" role="group" aria-label="language">
        <button
          className={lang === 'zh' ? 'active' : ''}
          title={t('topbar.switchToZh')}
          onClick={() => setLang('zh')}
        >中</button>
        <button
          className={lang === 'en' ? 'active' : ''}
          title={t('topbar.switchToEn')}
          onClick={() => setLang('en')}
        >EN</button>
      </div>
      <div className={`run-status ${connected ? 'on' : 'off'}`}>
        <span className="dot" /> {connected ? 'Running' : 'Offline'}
      </div>
    </header>
    {networkMode?.offline && (
      <div className="offline-banner" role="alert">{t('offline.banner')}</div>
    )}
    {sandboxBase !== undefined && <SandboxDangerBanner base={sandboxBase} />}
    </>
  );
}

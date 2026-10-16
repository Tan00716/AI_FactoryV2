import { Project } from '../api';
import { NotificationsBell } from './NotificationsBell';
import { useLang } from '../i18n';

/** §3 top bar: product name, active project, agent count, run status, notification bell (§30). */
export function TopBar({
  projects, projectId, onProject, agentCount, connected, notificationsBase,
  onOpenProjectSettings, identityLabel,
}: {
  projects: Project[];
  projectId: string;
  onProject: (id: string) => void;
  agentCount: number;
  connected: boolean;
  /** API base for the notification bell; bell hidden when omitted. */
  notificationsBase?: string;
  /** Jump to the Project settings tab (import/export); button hidden when omitted. */
  onOpenProjectSettings?: () => void;
  /** Batch 15: current API identity label (role / local mode); hidden when omitted. */
  identityLabel?: string;
}) {
  const { lang, setLang, t } = useLang();
  return (
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
        <span className="agent-count">{agentCount} Agents</span>
        {identityLabel && (
          <span className="agent-count" title={t('topbar.identityTitle')}>{identityLabel}</span>
        )}
      </div>
      {notificationsBase && <NotificationsBell base={notificationsBase} />}
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
  );
}

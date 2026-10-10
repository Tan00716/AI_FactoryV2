import { Project } from '../api';
import { NotificationsBell } from './NotificationsBell';

/** §3 top bar: product name, active project, agent count, run status, notification bell (§30). */
export function TopBar({
  projects, projectId, onProject, agentCount, connected, notificationsBase,
  onOpenProjectSettings,
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
}) {
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
          <button className="bell-btn" title="项目设置（导入 / 导出）" onClick={onOpenProjectSettings}>⚙️</button>
        )}
        <span className="agent-count">{agentCount} Agents</span>
      </div>
      {notificationsBase && <NotificationsBell base={notificationsBase} />}
      <div className={`run-status ${connected ? 'on' : 'off'}`}>
        <span className="dot" /> {connected ? 'Running' : 'Offline'}
      </div>
    </header>
  );
}

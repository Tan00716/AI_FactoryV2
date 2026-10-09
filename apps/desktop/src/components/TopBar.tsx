import { Project } from '../api';

/** §3 top bar: product name, active project, agent count, run status. */
export function TopBar({
  projects, projectId, onProject, agentCount, connected,
}: {
  projects: Project[];
  projectId: string;
  onProject: (id: string) => void;
  agentCount: number;
  connected: boolean;
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
        <span className="agent-count">{agentCount} Agents</span>
      </div>
      <div className={`run-status ${connected ? 'on' : 'off'}`}>
        <span className="dot" /> {connected ? 'Running' : 'Offline'}
      </div>
    </header>
  );
}

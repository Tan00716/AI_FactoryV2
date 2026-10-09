import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, BoardCard, OrgNode, Project } from './api';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { Board } from './components/Board';
import { BottomPanel } from './components/BottomPanel';
import { CreateTaskModal } from './components/CreateTaskModal';
import { GitPanel, createGitApi } from './components/GitPanel';
import { QaPanel, createQaApi } from './components/QaPanel';
import { ApprovalsPanel } from './components/ApprovalsPanel';
import './styles.css';

const API_BASE = 'http://localhost:3100/api';

/**
 * IDE shell per spec §3:
 *   top bar (project · agents · run status)
 *   left rail (project tree · AI org · skills)
 *   center (board / editor placeholder)
 *   bottom (activity · terminal · tests · logs)
 */
export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('proj-myapp');
  const [columns, setColumns] = useState<Record<string, BoardCard[]>>({});
  const [org, setOrg] = useState<OrgNode[]>([]);
  const [agentCount, setAgentCount] = useState(0);
  const [connected, setConnected] = useState(false);
  const [centerTab, setCenterTab] = useState<'Board' | 'Git' | 'QA' | 'Approvals' | 'Editor'>('Board');
  const [showCreate, setShowCreate] = useState(false);
  const [bootError, setBootError] = useState('');
  const [qaTaskId, setQaTaskId] = useState<string | null>(null);

  const gitApi = useMemo(() => createGitApi(API_BASE), []);
  const qaApi = useMemo(() => createQaApi(API_BASE), []);
  // Flatten board cards for the QA task picker.
  const allCards = useMemo(
    () => Object.values(columns).flat(),
    [columns],
  );
  useEffect(() => {
    if (!qaTaskId && allCards.length > 0) setQaTaskId(allCards[0].id);
  }, [qaTaskId, allCards]);

  const refresh = useCallback(async () => {
    try {
      await api.health();
      setConnected(true);
      const [ps, board, tree, agents] = await Promise.all([
        api.projects(), api.board(projectId), api.org(), api.agents(),
      ]);
      setProjects(ps);
      if (!ps.some((p) => p.id === projectId) && ps.length) setProjectId(ps[0].id);
      setColumns(board.columns);
      setOrg(tree);
      setAgentCount(agents.length);
      setBootError('');
    } catch (e) {
      setConnected(false);
      setBootError(`Cannot reach the local API at http://localhost:3100 — is the backend running? (${(e as Error).message})`);
    }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="ide">
      <TopBar
        projects={projects}
        projectId={projectId}
        onProject={setProjectId}
        agentCount={agentCount}
        connected={connected}
      />
      <div className="ide-mid">
        <Sidebar org={org} />
        <main className="center">
          {bootError && <div className="banner err">{bootError}</div>}
          <div className="center-tabs">
            {(['Board', 'Git', 'QA', 'Approvals', 'Editor'] as const).map((t) => (
              <button key={t} className={centerTab === t ? 'active' : ''} onClick={() => setCenterTab(t)}>{t}</button>
            ))}
          </div>
          {centerTab === 'Board' ? (
            <Board columns={columns} onChanged={refresh} onCreate={() => setShowCreate(true)} />
          ) : centerTab === 'Git' ? (
            <GitPanel api={gitApi} />
          ) : centerTab === 'QA' ? (
            <div className="qa-tab">
              <div className="qa-task-picker">
                <label className="muted" htmlFor="qa-task">Task:&nbsp;</label>
                <select
                  id="qa-task"
                  value={qaTaskId ?? ''}
                  onChange={(e) => setQaTaskId(e.target.value || null)}
                >
                  {allCards.map((c) => (
                    <option key={c.id} value={c.id}>{c.title} ({c.status})</option>
                  ))}
                </select>
              </div>
              <QaPanel taskId={qaTaskId} qa={qaApi} />
            </div>
          ) : centerTab === 'Approvals' ? (
            <ApprovalsPanel />
          ) : (
            <div className="editor-placeholder">
              <h2>Editor</h2>
              <p className="muted">
                Monaco editor goes here (§65). <span className="pill">placeholder</span>
              </p>
              <pre className="code-sample">{`// AI Coder #01 changed: src/payment/service.ts\n+ validatePaymentState()\n+ idempotency protection\n- unsafe async update`}</pre>
            </div>
          )}
        </main>
      </div>
      <BottomPanel />
      {showCreate && (
        <CreateTaskModal projectId={projectId} onClose={() => setShowCreate(false)} onCreated={refresh} />
      )}
    </div>
  );
}

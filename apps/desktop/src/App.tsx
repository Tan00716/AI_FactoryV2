import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, defaultApiBase, BoardCard, OrgNode, Project, TaskSummary } from './api';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { Board } from './components/Board';
import { TaskDetailDrawer } from './components/TaskDetail';
import { EmployeeDetail } from './components/EmployeeDetail';
import { BottomPanel } from './components/BottomPanel';
import { CreateTaskModal } from './components/CreateTaskModal';
import { GitPanel, createGitApi } from './components/GitPanel';
import { QaPanel, createQaApi } from './components/QaPanel';
import { ApprovalsPanel } from './components/ApprovalsPanel';
import { PermissionsPanel } from './components/PermissionsPanel';
import { PlanPanel, createPlanApi } from './components/PlanPanel';
import { HooksPanel, createHooksApi } from './components/HooksPanel';
import { SessionPanel, createSessionApi } from './components/SessionPanel';
import { PluginsPanel, createPluginsApi } from './components/PluginsPanel';
import { MetricsPanel, createMetricsApi } from './components/MetricsPanel';
import { CommandPalette } from './components/CommandPalette';
import { DispatchPanel } from './components/DispatchPanel';
import { CicdPanel, createCicdApi } from './components/CicdPanel';
import { SkillsPanel, createSkillsApi } from './components/SkillsPanel';
import { MemoryPanel, createMemoryApi } from './components/MemoryPanel';
import { WorkforcePanel } from './components/WorkforcePanel';
import { OrchestratePanel } from './components/OrchestratePanel';
import { ObservatoryPanel } from './components/ObservatoryPanel';
import { ManagerPanel } from './components/ManagerPanel';
import { McpPanel, createMcpApi } from './components/McpPanel';
import { KnowledgePanel, createKnowledgeApi } from './components/KnowledgePanel';
import { EvaluationPanel, createEvaluationApi } from './components/EvaluationPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { EditorPanel } from './components/EditorPanel';
import { ChangesPanel, createChangesApi } from './components/ChangesPanel';
import { StabilityPanel } from './components/StabilityPanel';
import { DashboardPanel, createDashboardApi } from './components/DashboardPanel';
import { OpsPanel } from './components/OpsPanel';
import { FinalReportPanel } from './components/FinalReportPanel';
import { BackupPanel } from './components/BackupPanel';
import { ProjectPanel } from './components/ProjectPanel';
import { ActivityPanel } from './components/ActivityPanel';
import { EventsPanel } from './components/EventsPanel';
import { ModelsPanel } from './components/ModelsPanel';
import { NeedsHumanPanel } from './components/NeedsHumanPanel';
import { LanguageProvider, useLang } from './i18n';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

const API_BASE = defaultApiBase();

/**
 * IDE shell per spec §3:
 *   top bar (project · agents · run status)
 *   left rail (project tree · AI org · skills)
 *   center (board / editor placeholder)
 *   bottom (activity · terminal · tests · logs)
 */
function IdeShell() {
  const { t } = useLang();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('proj-myapp');
  const [columns, setColumns] = useState<Record<string, BoardCard[]>>({});
  /** §85 完整看板数据源（含 createdAt，供运行时长/进度/门禁展示）。 */
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [org, setOrg] = useState<OrgNode[]>([]);
  const [agentCount, setAgentCount] = useState(0);
  const [connected, setConnected] = useState(false);
  /** Batch 15: API identity label for the top bar (role / local mode /
   *  unknown when whoami cannot be fetched — displayed as-is, never guessed). */
  const [apiIdentityLabel, setApiIdentityLabel] = useState('');
  const [centerTab, setCenterTab] = useState<'Dashboard' | 'Ops' | 'Report' | 'Board' | 'Git' | 'QA' | 'Approvals' | 'Permissions' | 'NeedsHuman' | 'Dispatch' | 'CI/CD' | 'Skills' | 'Memory' | 'MCP' | 'Knowledge' | 'Evaluation' | 'Agents' | 'Orchestrate' | 'Observatory' | 'Manager' | 'Editor' | 'Terminal' | 'Changes' | 'Stability' | 'Project' | 'Activity' | 'Events' | 'Models' | 'Plan' | 'Hooks' | 'Session' | 'Plugins' | 'Metrics'>('Dashboard');
  const [showCreate, setShowCreate] = useState(false);
  const [bootError, setBootError] = useState('');
  const [qaTaskId, setQaTaskId] = useState<string | null>(null);
  const [firstAgentId, setFirstAgentId] = useState<string | null>(null);
  /** §86 任务详情抽屉 / §87 员工详情浮层。 */
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const gitApi = useMemo(() => createGitApi(API_BASE), []);
  const qaApi = useMemo(() => createQaApi(API_BASE), []);
  const cicdApi = useMemo(() => createCicdApi(API_BASE), []);
  const skillsApi = useMemo(() => createSkillsApi(API_BASE), []);
  const memoryApi = useMemo(() => createMemoryApi(API_BASE), []);
  const mcpApi = useMemo(() => createMcpApi(API_BASE), []);
  const knowledgeApi = useMemo(() => createKnowledgeApi(API_BASE), []);
  const evaluationApi = useMemo(() => createEvaluationApi(API_BASE), []);
  const planApi = useMemo(() => createPlanApi(API_BASE), []);
  const hooksApi = useMemo(() => createHooksApi(API_BASE), []);
  const sessionApi = useMemo(() => createSessionApi(API_BASE), []);
  const pluginsApi = useMemo(() => createPluginsApi(API_BASE), []);
  const metricsApi = useMemo(() => createMetricsApi(API_BASE), []);
  const changesApi = useMemo(() => createChangesApi(API_BASE), []);
  const dashboardApi = useMemo(() => createDashboardApi(API_BASE), []);
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
      // Identity is display-only: a failed whoami (older server, bad
      // token) must not break the refresh — it just shows as unknown.
      api.whoami()
        .then((w) => setApiIdentityLabel(w.mode === 'open' ? t('app.identityLocal') : t('app.identityRole', { role: w.role })))
        .catch(() => setApiIdentityLabel(t('app.identityUnknown')));
      const [ps, board, tree, agents, taskList] = await Promise.all([
        api.projects(), api.board(projectId), api.org(), api.agents(), api.tasks(projectId),
      ]);
      setProjects(ps);
      if (!ps.some((p) => p.id === projectId) && ps.length) setProjectId(ps[0].id);
      setColumns(board.columns);
      setTasks(taskList);
      setOrg(tree);
      setAgentCount(agents.length);
      if (!firstAgentId && agents.length) setFirstAgentId(agents[0].id);
      setBootError('');
    } catch (e) {
      setConnected(false);
      setBootError(`Cannot reach the local API at ${API_BASE} — is the backend running? (${(e as Error).message})`);
    }
  }, [projectId, t]);

  useEffect(() => { refresh(); }, [refresh]);

  /**
   * QA-R1: "Running" 指示灯之前只在启动 refresh() 里探测一次——服务端中途
   * 挂掉后指示灯永远绿色，误导用户。加轻量心跳：每 10s 只调 /health，
   * 不触发全量数据刷新（各面板已有自己的轮询）。
   */
  useEffect(() => {
    let alive = true;
    const probe = async () => {
      try {
        await api.health();
        if (alive) setConnected(true);
      } catch {
        if (alive) setConnected(false);
      }
    };
    const id = setInterval(() => { void probe(); }, 10000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  /**
   * Boot race: the packaged app spawns the backend concurrently with window
   * creation, so the first health probe can legitimately fail while the
   * backend is still listening. Keep probing until the first success so a
   * transient startup race never freezes a permanent "Cannot reach the local
   * API" misreport: a successful refresh clears bootError, which tears this
   * interval down.
   */
  useEffect(() => {
    if (!bootError) return;
    const t = setInterval(() => { void refresh(); }, 2000);
    return () => clearInterval(t);
  }, [bootError, refresh]);

  return (
    <div className="ide">
      <TopBar
        projects={projects}
        projectId={projectId}
        onProject={setProjectId}
        agentCount={agentCount}
        connected={connected}
        identityLabel={apiIdentityLabel || undefined}
        notificationsBase={API_BASE}
        onOpenProjectSettings={() => setCenterTab('Project')}
        onCommandNavigate={(tab) => setCenterTab(tab as typeof centerTab)}
      />
      <div className="ide-mid">
        <Sidebar org={org} onSelectAgent={setSelectedAgentId} />
        <main className="center">
          {bootError && <div className="banner err">{bootError}</div>}
          <div className="center-tabs">
            {(['Dashboard', 'Ops', 'Report', 'Board', 'Git', 'QA', 'Approvals', 'Permissions', 'NeedsHuman', 'Dispatch', 'CI/CD', 'Skills', 'Memory', 'MCP', 'Knowledge', 'Evaluation', 'Agents', 'Orchestrate', 'Observatory', 'Manager', 'Editor', 'Terminal', 'Changes', 'Stability', 'Project', 'Activity', 'Events', 'Models', 'Plan', 'Hooks', 'Session', 'Plugins', 'Metrics'] as const).map((name) => (
              <button key={name} className={centerTab === name ? 'active' : ''} onClick={() => setCenterTab(name)}>{t(`tab.${name.toLowerCase().replace('/', '')}` as const)}</button>
            ))}
          </div>
          {centerTab === 'Dashboard' ? (
            <DashboardPanel api={dashboardApi} />
          ) : centerTab === 'Ops' ? (
            <>
              <OpsPanel />
              <BackupPanel />
            </>
          ) : centerTab === 'Report' ? (
            <FinalReportPanel
              projectId={projectId}
              projectName={projects.find((pr) => pr.id === projectId)?.name ?? projectId}
            />
          ) : centerTab === 'Board' ? (
            <Board
              tasks={tasks}
              onChanged={refresh}
              onCreate={() => setShowCreate(true)}
              onSelectTask={setSelectedTaskId}
            />
          ) : centerTab === 'Git' ? (
            <GitPanel api={gitApi} />
          ) : centerTab === 'QA' ? (
            <div className="qa-tab">
              <div className="qa-task-picker">
                <label className="muted" htmlFor="qa-task">{t('app.qaTaskLabel')}&nbsp;</label>
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
          ) : centerTab === 'Permissions' ? (
            <PermissionsPanel />
          ) : centerTab === 'NeedsHuman' ? (
            <NeedsHumanPanel />
          ) : centerTab === 'Dispatch' ? (
            <DispatchPanel />
          ) : centerTab === 'CI/CD' ? (
            <CicdPanel taskId={qaTaskId} cicd={cicdApi} />
          ) : centerTab === 'Skills' ? (
            <SkillsPanel taskId={qaTaskId} skills={skillsApi} />
          ) : centerTab === 'Memory' ? (
            <MemoryPanel memory={memoryApi} />
          ) : centerTab === 'MCP' ? (
            <McpPanel mcp={mcpApi} />
          ) : centerTab === 'Knowledge' ? (
            <KnowledgePanel knowledge={knowledgeApi} />
          ) : centerTab === 'Evaluation' ? (
            <EvaluationPanel evaluation={evaluationApi} taskId={qaTaskId} />
          ) : centerTab === 'Agents' ? (
            <WorkforcePanel agentTree={org} onSelectAgent={setSelectedAgentId} />
          ) : centerTab === 'Orchestrate' ? (
            <OrchestratePanel agentId={firstAgentId} taskId={qaTaskId} />
          ) : centerTab === 'Observatory' ? (
            <ObservatoryPanel />
          ) : centerTab === 'Manager' ? (
            <ManagerPanel />
          ) : centerTab === 'Terminal' ? (
            <TerminalPanel />
          ) : centerTab === 'Changes' ? (
            <ChangesPanel api={changesApi} />
          ) : centerTab === 'Stability' ? (
            <StabilityPanel />
          ) : centerTab === 'Project' ? (
            <ProjectPanel
              projectId={projectId}
              projectName={projects.find((pr) => pr.id === projectId)?.name ?? projectId}
            />
          ) : centerTab === 'Activity' ? (
            <ActivityPanel />
          ) : centerTab === 'Events' ? (
            <EventsPanel />
          ) : centerTab === 'Models' ? (
            <ModelsPanel />
          ) : centerTab === 'Plan' ? (
            <PlanPanel planApi={planApi} />
          ) : centerTab === 'Hooks' ? (
            <HooksPanel hooksApi={hooksApi} />
          ) : centerTab === 'Session' ? (
            <SessionPanel sessionApi={sessionApi} />
          ) : centerTab === 'Plugins' ? (
            <PluginsPanel api={pluginsApi} />
          ) : centerTab === 'Metrics' ? (
            <MetricsPanel api={metricsApi} />
          ) : (
            <EditorPanel />
          )}
        </main>
      </div>
      <BottomPanel />
      {showCreate && (
        <CreateTaskModal projectId={projectId} onClose={() => setShowCreate(false)} onCreated={refresh} />
      )}
      {selectedTaskId && (
        <TaskDetailDrawer
          taskId={selectedTaskId}
          onClose={() => setSelectedTaskId(null)}
          onChanged={refresh}
          onSelectTask={setSelectedTaskId}
          onSelectAgent={setSelectedAgentId}
        />
      )}
      {selectedAgentId && (
        <EmployeeDetail
          agentId={selectedAgentId}
          onClose={() => setSelectedAgentId(null)}
          onSelectTask={(id) => {
            setSelectedAgentId(null);
            setSelectedTaskId(id);
          }}
        />
      )}
      <CommandPalette
        tasks={tasks}
        org={org}
        onNavigateTab={setCenterTab}
        onSelectTask={setSelectedTaskId}
        onSelectAgent={setSelectedAgentId}
        onCreateTask={() => setShowCreate(true)}
      />
    </div>
  );
}

export default function App() {
  return (
    <LanguageProvider>
      <ErrorBoundary>
        <IdeShell />
      </ErrorBoundary>
    </LanguageProvider>
  );
}

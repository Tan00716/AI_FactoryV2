import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, defaultApiBase, BoardCard, OrgNode, Project, TaskSummary, initApiTokenFromMain, rotateApiToken } from './api';
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
import { BatchChangesPanel, createBatchChangesApi } from './components/BatchChangesPanel';
import { InspectionsPanel, createInspectionsApi } from './components/InspectionsPanel';
import { CollabPanel } from './components/CollabPanel';
import { RecipesPanel, createRecipesApi } from './components/RecipesPanel';
import { DesignPanel, createDesignApi } from './components/DesignPanel';
import { CoveragePanel, createCoverageApi } from './components/CoveragePanel';
import { UpdatePanel, createUpdateApi } from './components/UpdatePanel';
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
import { RefactorPanel } from './components/RefactorPanel';
import { MergePanel } from './components/MergePanel';
import { RebasePanel } from './components/RebasePanel';
import { SearchPanel } from './components/SearchPanel';
import SnippetsPanel from './components/SnippetsPanel';
import ExtensionsPanel from './components/ExtensionsPanel';
import { EnvPanel } from './components/EnvPanel';
import { DataPreviewPanel } from './components/DataPreviewPanel';
import RulesPanel from './components/RulesPanel';
import { SlashCommandsPanel } from './components/SlashCommandsPanel';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { initSnippets } from './snippets/manager';
import { ScratchesPanel } from './components/ScratchesPanel';
import { SchedulesPanel } from './components/SchedulesPanel';
import { DebugPanel } from './components/DebugPanel';
import { TimelinePanel } from './components/TimelinePanel';
import { ProfilerPanel } from './components/ProfilerPanel';
import { HttpPanel } from './components/HttpPanel';
import { DashboardPanel, createDashboardApi } from './components/DashboardPanel';
import { OpsPanel } from './components/OpsPanel';
import { BudgetPanel } from './components/BudgetPanel';
import { FinalReportPanel } from './components/FinalReportPanel';
import { BackupPanel } from './components/BackupPanel';
import { ProjectPanel } from './components/ProjectPanel';
import { ActivityPanel } from './components/ActivityPanel';
import { EventsPanel } from './components/EventsPanel';
import { ModelsPanel } from './components/ModelsPanel';
import { NeedsHumanPanel } from './components/NeedsHumanPanel';
import { LanguageProvider, useLang } from './i18n';
import { ErrorBoundary } from './components/ErrorBoundary';
import { GoldenPathWizard } from './components/GoldenPathWizard';
import { LangSrvPanel } from './components/LangSrvPanel';
import { RemotePanel } from './components/RemotePanel';
import { TestExplorerPanel } from './components/TestExplorerPanel';
import { PrLinkPanel } from './components/PrLinkPanel';
import { SettingsSyncPanel } from './components/SettingsSyncPanel';
import { NotebookPanel } from './components/NotebookPanel';
import { WebhooksPanel } from './components/WebhooksPanel';
import {
  CENTER_TABS,
  DEFAULT_NAV_TIER_STATE,
  GOTO_TAB_EVENT,
  OPEN_CREATE_EVENT,
  loadGoldenPathProgress,
  loadNavTierState,
  saveGoldenPathProgress,
  saveNavTierState,
  tabsOfTier,
  tierOf,
} from './navigation/tiers';
import type { NavTierState } from './navigation/tiers';
import { initialProjectId } from './utils/project-query';
import { KeybindingHost } from './keybinding/host';
import { onCommand, tabNameForCommand, LANGUAGE_SWITCH_COMMAND } from './keybinding/commands';
import { KeybindingSettings } from './keybinding/KeybindingSettings';
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
  const { t, lang, setLang } = useLang();
  const [projects, setProjects] = useState<Project[]>([]);
  // Multi-project: a window opened via "open in new window" carries
  // ?project=<id>; each window keeps its own projectId state, so two
  // windows can work on two projects against the same backend.
  const [projectId, setProjectId] = useState(() =>
    typeof window === 'undefined' ? 'proj-myapp' : initialProjectId(window.location.search),
  );
  const [columns, setColumns] = useState<Record<string, BoardCard[]>>({});
  /** §85 完整看板数据源（含 createdAt，供运行时长/进度/门禁展示）。 */
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [org, setOrg] = useState<OrgNode[]>([]);
  const [agentCount, setAgentCount] = useState(0);
  const [connected, setConnected] = useState(false);
  /** Batch 15: API identity label for the top bar (role / local mode /
   *  unknown when whoami cannot be fetched — displayed as-is, never guessed). */
  const [apiIdentityLabel, setApiIdentityLabel] = useState('');
  /** V3-#1 completion: true while the server runs in explicit open local
   *  mode (FACTORY_ALLOW_OPEN_LOCAL=1); renders the warning banner below. */
  const [apiOpenLocal, setApiOpenLocal] = useState(false);
  /** V3-#1 completion: rotation result notice; the rotated token itself is
   *  shown once only in the no-bridge fallback (it is never stored in
   *  state in the Electron path, where main re-reads the token file). */
  const [authNotice, setAuthNotice] = useState('');
  const [rotatedTokenOnce, setRotatedTokenOnce] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [centerTab, setCenterTab] = useState<'Dashboard' | 'Ops' | 'Report' | 'Board' | 'Git' | 'QA' | 'Approvals' | 'Permissions' | 'NeedsHuman' | 'Dispatch' | 'CI/CD' | 'Skills' | 'Memory' | 'MCP' | 'Knowledge' | 'Evaluation' | 'Agents' | 'Orchestrate' | 'Observatory' | 'Manager' | 'Editor' | 'Terminal' | 'Changes' | 'Stability' | 'Project' | 'Activity' | 'Events' | 'Models' | 'Plan' | 'Hooks' | 'Session' | 'Plugins' | 'Metrics' | 'Inspections' | 'Batch' | 'Collab' | 'Coverage' | 'Recipes' | 'Design' | 'Updates' | 'Refactor' | 'Profiler' | 'HTTP' | 'Debug' | 'Timeline' | 'Keybindings' | 'Merge' | 'Search' | 'Scratches' | 'Snippets' | 'Schedules' | 'Rebase' | 'Extensions' | 'Rules' | 'DataPreview' | 'Env' | 'Slash' | 'Diagnostics' | 'LangSrv' | 'Notebook' | 'Webhooks' | 'Remote' | 'TestExplorer' | 'SettingsSync' | 'PrLink'>('Dashboard');
  const [showCreate, setShowCreate] = useState(false);
  /** V3-#3 tiered navigation: persisted, progressive disclosure. */
  const [navTier, setNavTier] = useState<NavTierState>(() =>
    typeof window === 'undefined' ? { ...DEFAULT_NAV_TIER_STATE } : loadNavTierState(window.localStorage),
  );
  /** V3-#3 golden path wizard: first run unless dismissed. */
  const [wizardOpen, setWizardOpen] = useState(() =>
    typeof window === 'undefined' ? false : !loadGoldenPathProgress(window.localStorage).dismissed,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    saveNavTierState(navTier, window.localStorage);
  }, [navTier]);
  /** EmptyState / wizard jump events: keep panels prop-light. */
  useEffect(() => {
    const onGoto = (e: Event) => {
      const d = (e as CustomEvent<{ tab?: string }>).detail;
      if (d && typeof d.tab === 'string' && (CENTER_TABS as readonly string[]).includes(d.tab)) {
        setCenterTab(d.tab as typeof centerTab);
      }
    };
    const onCreate = () => {
      setCenterTab('Board');
      setShowCreate(true);
    };
    window.addEventListener(GOTO_TAB_EVENT, onGoto);
    window.addEventListener(OPEN_CREATE_EVENT, onCreate);
    return () => {
      window.removeEventListener(GOTO_TAB_EVENT, onGoto);
      window.removeEventListener(OPEN_CREATE_EVENT, onCreate);
    };
  }, []);
  /** Navigating (e.g. via command palette) into a collapsed tier expands it. */
  useEffect(() => {
    const tier = tierOf(centerTab);
    if (tier === 'advanced' && !navTier.expandedAdvanced && !navTier.showAll) {
      setNavTier((prev) => ({ ...prev, expandedAdvanced: true }));
    } else if (tier === 'expert' && !navTier.expandedExpert && !navTier.showAll) {
      setNavTier((prev) => ({ ...prev, expandedExpert: true }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerTab]);
  /**
   * Design panel → editor jump (task ⑨): the Design panel dispatches an
   * 'ai-factory:open-file' CustomEvent with {path, line}; we hand it to
   * the Editor as a prop (the Editor tab is conditionally rendered, so
   * an event alone could fire while it is unmounted and be lost).
   */
  const [editorOpenRequest, setEditorOpenRequest] = useState<{ path: string; line: number; nonce: number } | null>(null);
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<{ path: string; line: number }>).detail;
      if (d && typeof d.path === 'string' && typeof d.line === 'number') {
        setEditorOpenRequest({ path: d.path, line: d.line, nonce: Date.now() });
        setCenterTab('Editor');
      }
    };
    window.addEventListener('ai-factory:open-file', onOpen);
    return () => window.removeEventListener('ai-factory:open-file', onOpen);
  }, []);
  // Round-5 R5-A6: register the Monaco snippet completion provider once.
  useEffect(() => {
    initSnippets();
  }, []);
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
  const batchChangesApi = useMemo(() => createBatchChangesApi(API_BASE), []);
  const recipesApi = useMemo(() => createRecipesApi(API_BASE), []);
  const inspectionsApi = useMemo(() => createInspectionsApi(API_BASE), []);
  const coverageApi = useMemo(() => createCoverageApi(API_BASE), []);
  const updateApi = useMemo(() => createUpdateApi(API_BASE), []);
  const designApi = useMemo(() => createDesignApi(API_BASE), []);
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
      // V3-#1 completion: the per-install token must be in memory before
      // the first authenticated call; previously initApiTokenFromMain was
      // defined but never invoked, so an Electron renderer sent no token.
      await initApiTokenFromMain();
      await api.health();
      setConnected(true);
      // Identity is display-only: a failed whoami (older server, bad
      // token) must not break the refresh — it just shows as unknown.
      api.whoami()
        .then((w) => {
          setApiIdentityLabel(w.mode === 'open' ? t('app.identityLocal') : t('app.identityRole', { role: w.role }));
          setApiOpenLocal(w.mode === 'open');
        })
        .catch(() => {
          setApiIdentityLabel(t('app.identityUnknown'));
          setApiOpenLocal(false);
        });
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

  // Multi-project: Ctrl/Cmd+Shift+N opens a new window bound to the
  // current project (Electron main handles it via IPC).
  const projectIdRef = useRef(projectId);
  useEffect(() => { projectIdRef.current = projectId; }, [projectId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
        if (window.aiFactory?.openWindow) {
          e.preventDefault();
          window.aiFactory.openWindow(projectIdRef.current);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Round-5 R5-S1: keybinding commands dispatched by the KeybindingManager.
  useEffect(() => onCommand((id) => {
    if (id === LANGUAGE_SWITCH_COMMAND) {
      setLang(lang === 'zh' ? 'en' : 'zh');
      return;
    }
    const tab = tabNameForCommand(id);
    if (tab) setCenterTab(tab as typeof centerTab);
  }), [lang, setLang]);

  // Multi-project: the native window title follows the bound project so
  // two windows are distinguishable at a glance (Electron mirrors
  // document.title onto the window).
  useEffect(() => {
    const name = projects.find((p) => p.id === projectId)?.name ?? projectId;
    document.title = `AI Factory — ${name}`;
  }, [projects, projectId]);

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

  /** V3-#1 completion: rotate the per-install token (admin only). The old
   *  token dies immediately server-side; rotateApiToken re-syncs the
   *  client so the next request does not 401. */
  const onRotateToken = async () => {
    setRotating(true);
    setAuthNotice('');
    setRotatedTokenOnce(null);
    try {
      const r = await rotateApiToken();
      setAuthNotice(t('app.rotateOk'));
      if (!r.viaBridge && r.token) setRotatedTokenOnce(r.token);
      await refresh();
    } catch (e) {
      setAuthNotice(t('app.rotateFail', { message: (e as Error).message }));
    } finally {
      setRotating(false);
    }
  };

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
        networkBase={API_BASE}
        sandboxBase={API_BASE}
        onOpenProjectSettings={() => setCenterTab('Project')}
        onCommandNavigate={(tab) => setCenterTab(tab as typeof centerTab)}
      />
      <div className="ide-mid">
        <Sidebar org={org} onSelectAgent={setSelectedAgentId} onOpenUpdates={() => setCenterTab('Updates')} />
        <main className="center">
          {bootError && <div className="banner err">{bootError}</div>}
          {apiOpenLocal && (
            <div className="banner err">{t('app.openLocalWarning')}</div>
          )}
          {connected && !apiOpenLocal && (
            <div className="banner">
              <button disabled={rotating} onClick={onRotateToken}>{t('app.rotateToken')}</button>
              {authNotice && <span style={{ marginLeft: 8 }}>{authNotice}</span>}
              {rotatedTokenOnce && (
                <span style={{ marginLeft: 8 }}>
                  {t('app.rotateTokenOnce')}: <code>{rotatedTokenOnce}</code> {t('app.rotateTokenNote')}
                </span>
              )}
            </div>
          )}
          {wizardOpen && (
            <GoldenPathWizard
              onClose={() => setWizardOpen(false)}
              onDismiss={() => {
                if (typeof window !== 'undefined') {
                  const prev = loadGoldenPathProgress(window.localStorage);
                  saveGoldenPathProgress({ ...prev, dismissed: true }, window.localStorage);
                }
                setWizardOpen(false);
              }}
            />
          )}
          {/* V3-#3 tier toolbar: outside .center-tabs so e2e tab indexing is unchanged. */}
          <div className="nav-tier-bar">
            <span className="muted">{t('nav.tierLabel')}</span>
            <button onClick={() => setNavTier((prev) => ({ ...prev, expandedAdvanced: !prev.expandedAdvanced, showAll: false }))}>
              {navTier.expandedAdvanced ? t('nav.hideAdvanced') : t('nav.showAdvanced')}
            </button>
            <button onClick={() => setNavTier((prev) => ({ ...prev, expandedExpert: !prev.expandedExpert, showAll: false }))}>
              {navTier.expandedExpert ? t('nav.hideExpert') : t('nav.showExpert')}
            </button>
            <button onClick={() => setNavTier((prev) => ({ ...prev, showAll: !prev.showAll }))}>
              {navTier.showAll ? t('nav.showTiered') : t('nav.showAll')}
            </button>
            <button onClick={() => setWizardOpen(true)}>{t('nav.wizard')}</button>
          </div>
          <div className="center-tabs">
            {(['common', 'advanced', 'expert'] as const).map((tier) => {
              const collapsed = tier !== 'common'
                && !navTier.showAll
                && (tier === 'advanced' ? !navTier.expandedAdvanced : !navTier.expandedExpert);
              return (
                <span key={tier} className="center-tab-group" data-tier={tier} style={collapsed ? { display: 'none' } : undefined}>
                  <span className="center-tab-group-label muted">{t(`nav.tier.${tier}`)}</span>
                  {tabsOfTier(tier).map((name) => (
                    <button key={name} className={centerTab === name ? 'active' : ''} onClick={() => setCenterTab(name)}>{t(`tab.${name.toLowerCase().replace('/', '')}` as const)}</button>
                  ))}
                </span>
              );
            })}
          </div>
          {centerTab === 'Dashboard' ? (
            <DashboardPanel api={dashboardApi} />
          ) : centerTab === 'Ops' ? (
            <>
              <OpsPanel />
              <BudgetPanel />
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
          ) : centerTab === 'Inspections' ? (
            <InspectionsPanel api={inspectionsApi} projectId={projectId} />
          ) : centerTab === 'Coverage' ? (
            <CoveragePanel api={coverageApi} projectId={projectId} />
          ) : centerTab === 'Batch' ? (
            <BatchChangesPanel api={batchChangesApi} />
          ) : centerTab === 'Collab' ? (
            <CollabPanel
              projectId={projectId}
              currentTab={centerTab}
              onFollowPanel={(tab) => setCenterTab(tab as typeof centerTab)}
            />
          ) : centerTab === 'Recipes' ? (
            <RecipesPanel api={recipesApi} />
          ) : centerTab === 'Design' ? (
            <DesignPanel api={designApi} />
          ) : centerTab === 'Updates' ? (
            <UpdatePanel api={updateApi} />
          ) : centerTab === 'Refactor' ? (
            <RefactorPanel projectId={projectId} />
          ) : centerTab === 'Profiler' ? (
            <ProfilerPanel />
          ) : centerTab === 'HTTP' ? (
            <HttpPanel />
          ) : centerTab === 'Debug' ? (
            <DebugPanel projectId={projectId} />
          ) : centerTab === 'Timeline' ? (
            <TimelinePanel />
          ) : centerTab === 'Keybindings' ? (
            <KeybindingSettings />
          ) : centerTab === 'Merge' ? (
            <MergePanel />
          ) : centerTab === 'Rebase' ? (
            <RebasePanel />
          ) : centerTab === 'Search' ? (
            <SearchPanel />
          ) : centerTab === 'Scratches' ? (
            <ScratchesPanel />
          ) : centerTab === 'Snippets' ? (
            <SnippetsPanel projectRoot={projects.find((pr) => pr.id === projectId)?.path ?? ''} />
          ) : centerTab === 'Extensions' ? (
            <ExtensionsPanel projectRoot={projects.find((pr) => pr.id === projectId)?.path ?? ''} />
          ) : centerTab === 'Env' ? (
            <EnvPanel projectRoot={projects.find((pr) => pr.id === projectId)?.path ?? ''} />
          ) : centerTab === 'DataPreview' ? (
            <DataPreviewPanel projectRoot={projects.find((pr) => pr.id === projectId)?.path ?? ''} />
          ) : centerTab === 'Rules' ? (
            <RulesPanel projectRoot={projects.find((pr) => pr.id === projectId)?.path ?? ''} />
          ) : centerTab === 'Slash' ? (
            <SlashCommandsPanel projectRoot={projects.find((pr) => pr.id === projectId)?.path ?? ''} />
          ) : centerTab === 'Diagnostics' ? (
            <DiagnosticsPanel />
          ) : centerTab === 'LangSrv' ? (
            <LangSrvPanel projectRoot={projects.find((pr) => pr.id === projectId)?.path ?? ''} />
          ) : centerTab === 'TestExplorer' ? (
            <TestExplorerPanel projectRoot={projects.find((pr) => pr.id === projectId)?.path ?? ''} />
          ) : centerTab === 'PrLink' ? (
            <PrLinkPanel projectRoot={projects.find((pr) => pr.id === projectId)?.path ?? ''} projectId={projectId} />
          ) : centerTab === 'Remote' ? (
            <RemotePanel />
          ) : centerTab === 'Notebook' ? (
            <NotebookPanel />
          ) : centerTab === 'Webhooks' ? (
            <WebhooksPanel projectRoot={projects.find((pr) => pr.id === projectId)?.path ?? ''} />
          ) : centerTab === 'SettingsSync' ? (
            <SettingsSyncPanel />
          ) : centerTab === 'Schedules' ? (
            <SchedulesPanel />
          ) : (
            <EditorPanel openRequest={editorOpenRequest} />
          )}
        </main>
      </div>
      <BottomPanel projectId={projectId} />
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
      <KeybindingHost />
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

/**
 * Panel tier navigation + golden path + panel guides (V3-#3).
 *
 * Pure module: no React, no DOM imports, so node:test can import it
 * directly under type-stripping (same reason as utils/cmdk.ts and
 * keybinding/manager.ts). All persistence goes through an injectable
 * storage shim so tests never touch real localStorage.
 *
 * Tiers are progressive disclosure, not removal: every center tab stays
 * mounted as a button (e2e clicks `.center-tabs button` by index), a
 * collapsed tier only hides its buttons with CSS. Routing semantics
 * (centerTab values, command-palette navigation) are unchanged.
 */

/** All center tabs, in the order App.tsx renders them. */
export const CENTER_TABS = [
  'Dashboard', 'Ops', 'Report', 'Board', 'Git', 'QA', 'Approvals',
  'Permissions', 'NeedsHuman', 'Dispatch', 'CI/CD', 'Skills', 'Memory',
  'MCP', 'Knowledge', 'Evaluation', 'Agents', 'Orchestrate', 'Observatory',
  'Manager', 'Editor', 'Terminal', 'Changes', 'Stability', 'Project',
  'Activity', 'Events', 'Models', 'Plan', 'Hooks', 'Session', 'Plugins',
  'Metrics', 'Inspections', 'Batch', 'Collab', 'Coverage', 'Recipes',
  'Design', 'Updates', 'Refactor', 'Profiler', 'HTTP', 'Debug', 'Timeline',
  'Keybindings', 'Merge', 'Search', 'Scratches', 'Snippets', 'Schedules',
  'Rebase', 'Extensions', 'Rules', 'DataPreview', 'Env', 'Slash',
  'Diagnostics', 'LangSrv',
] as const;

export type CenterTab = (typeof CENTER_TABS)[number];
export type NavTier = 'common' | 'advanced' | 'expert';

/** Daily workflow: capped at 12 by the V3-#3 success standard. */
export const COMMON_TABS: readonly CenterTab[] = [
  'Dashboard', 'Board', 'Project', 'Editor', 'Git', 'QA', 'Approvals',
  'Dispatch', 'Search', 'Terminal', 'Changes', 'Timeline',
];

/** Deep tooling: history/config/internals surgery and diagnostics. */
export const EXPERT_TABS: readonly CenterTab[] = [
  'MCP', 'Observatory', 'Stability', 'Refactor', 'Profiler', 'Debug',
  'Keybindings', 'Merge', 'Rebase', 'Extensions', 'Rules', 'Env', 'Slash',
  'Diagnostics',
];

/** Everything else: team / quality / ops capabilities. */
export const ADVANCED_TABS: readonly CenterTab[] = CENTER_TABS.filter(
  (t) => !COMMON_TABS.includes(t) && !EXPERT_TABS.includes(t),
);

export function tierOf(tab: string): NavTier {
  if ((COMMON_TABS as readonly string[]).includes(tab)) return 'common';
  if ((EXPERT_TABS as readonly string[]).includes(tab)) return 'expert';
  return 'advanced';
}

export interface NavTierState {
  /** Advanced group expanded (default false: progressive disclosure). */
  expandedAdvanced: boolean;
  /** Expert group expanded (default false). */
  expandedExpert: boolean;
  /** Show-all toggle: expands both groups at once. */
  showAll: boolean;
}

export const DEFAULT_NAV_TIER_STATE: NavTierState = {
  expandedAdvanced: false,
  expandedExpert: false,
  showAll: false,
};

export const NAV_TIER_STORAGE_KEY = 'ai-factory.navTiers.v1';

export interface TierStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadNavTierState(storage?: TierStorage | null): NavTierState {
  if (!storage) return { ...DEFAULT_NAV_TIER_STATE };
  try {
    const raw = storage.getItem(NAV_TIER_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_NAV_TIER_STATE };
    const parsed = JSON.parse(raw) as Partial<NavTierState>;
    return {
      expandedAdvanced: parsed.expandedAdvanced === true,
      expandedExpert: parsed.expandedExpert === true,
      showAll: parsed.showAll === true,
    };
  } catch {
    return { ...DEFAULT_NAV_TIER_STATE };
  }
}

export function saveNavTierState(state: NavTierState, storage?: TierStorage | null): void {
  if (!storage) return;
  try {
    storage.setItem(NAV_TIER_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable: navigation still works for the session */
  }
}

/** Tabs whose buttons are visible for a given state. */
export function visibleTabs(state: NavTierState): CenterTab[] {
  if (state.showAll) return [...CENTER_TABS];
  return CENTER_TABS.filter((t) => {
    const tier = tierOf(t);
    if (tier === 'common') return true;
    if (tier === 'advanced') return state.expandedAdvanced;
    return state.expandedExpert;
  });
}

/** Tabs of one tier, in render order. */
export function tabsOfTier(tier: NavTier): CenterTab[] {
  return CENTER_TABS.filter((t) => tierOf(t) === tier);
}

/* ------------------------------------------------------------------ */
/* Golden path: first-run guided checklist (V3-#3, no server changes). */
/* ------------------------------------------------------------------ */

export type GoldenStepAction = 'goto-tab' | 'open-create';

export interface GoldenStep {
  id: string;
  /** Center tab the step jumps to (open-create jumps to Board). */
  target: CenterTab;
  action: GoldenStepAction;
}

/**
 * Four steps, each a jump to an existing flow (never a new backend):
 * pick a project -> run one check -> create/run one task -> review
 * approvals and the rollback surface (Changes).
 */
export const GOLDEN_PATH_STEPS: readonly GoldenStep[] = [
  { id: 'project', target: 'Project', action: 'goto-tab' },
  { id: 'check', target: 'QA', action: 'goto-tab' },
  { id: 'task', target: 'Board', action: 'open-create' },
  { id: 'approve', target: 'Approvals', action: 'goto-tab' },
];

export const GOLDEN_PATH_STORAGE_KEY = 'ai-factory.goldenPath.v1';

export interface GoldenPathProgress {
  done: string[];
  dismissed: boolean;
}

export const DEFAULT_GOLDEN_PATH_PROGRESS: GoldenPathProgress = {
  done: [],
  dismissed: false,
};

export function loadGoldenPathProgress(storage?: TierStorage | null): GoldenPathProgress {
  if (!storage) return { ...DEFAULT_GOLDEN_PATH_PROGRESS, done: [] };
  try {
    const raw = storage.getItem(GOLDEN_PATH_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_GOLDEN_PATH_PROGRESS, done: [] };
    const parsed = JSON.parse(raw) as Partial<GoldenPathProgress>;
    const done = Array.isArray(parsed.done)
      ? parsed.done.filter((d) => GOLDEN_PATH_STEPS.some((s) => s.id === d))
      : [];
    return { done, dismissed: parsed.dismissed === true };
  } catch {
    return { ...DEFAULT_GOLDEN_PATH_PROGRESS, done: [] };
  }
}

export function saveGoldenPathProgress(progress: GoldenPathProgress, storage?: TierStorage | null): void {
  if (!storage) return;
  try {
    storage.setItem(GOLDEN_PATH_STORAGE_KEY, JSON.stringify(progress));
  } catch {
    /* ignore */
  }
}

/** Glossary terms shown in the wizard help section (one line each). */
export const GLOSSARY_TERMS = [
  'squads',
  'employeeFactory',
  'authority',
  'needsHuman',
] as const;

export type GlossaryTerm = (typeof GLOSSARY_TERMS)[number];

/* ------------------------------------------------------------------ */
/* Panel guides: empty-state content for the Top 20 list panels.      */
/* ------------------------------------------------------------------ */

export const PANEL_GUIDE_KEYS = [
  'board', 'git', 'qa', 'approvals', 'search', 'changes', 'timeline',
  'dispatch', 'skills', 'memory', 'knowledge', 'inspections', 'coverage',
  'recipes', 'batch', 'collab', 'events', 'models', 'session', 'metrics',
] as const;

export type PanelGuideKey = (typeof PANEL_GUIDE_KEYS)[number];

/** Where the guide's "go" button jumps. */
export const PANEL_GUIDE_TARGETS: Record<PanelGuideKey, CenterTab> = {
  board: 'Board',
  git: 'Git',
  qa: 'QA',
  approvals: 'Approvals',
  search: 'Search',
  changes: 'Changes',
  timeline: 'Timeline',
  dispatch: 'Dispatch',
  skills: 'Skills',
  memory: 'Memory',
  knowledge: 'Knowledge',
  inspections: 'Inspections',
  coverage: 'Coverage',
  recipes: 'Recipes',
  batch: 'Batch',
  collab: 'Collab',
  events: 'Events',
  models: 'Models',
  session: 'Session',
  metrics: 'Metrics',
};

/** Custom events App.tsx listens for (keeps panels prop-light). */
export const GOTO_TAB_EVENT = 'ai-factory:goto-tab';
export const OPEN_CREATE_EVENT = 'ai-factory:open-create';

export function gotoTabDetail(tab: string): { tab: string } {
  return { tab };
}

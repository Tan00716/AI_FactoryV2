import type { I18nKey } from './zh';

/**
 * 英文语言包（i18n 试点，Batch 237）。
 * - key 集合由 `Record<I18nKey, string>` 类型强制与 zh.ts 完全一致；
 *   zh 加 key 而 en 漏加时 `tsc` 直接报错。
 * - 插值占位符 `{name}` 必须与 zh.ts 同名同数（运行时缺失会原样保留 `{name}`，
 *   目检时一眼可见）。
 */
export const en: Record<I18nKey, string> = {
  // ---- Dashboard ----
  'dashboard.status': 'Status',
  'dashboard.metrics': 'Metrics',
  'dashboard.noData': 'No data',
  'dashboard.live': 'Live',
  'dashboard.source': 'Source: {source}',
  'dashboard.updatedAt': 'Updated {time} · refreshes every 5s',
  'dashboard.showingStale': '(showing last successful data)',

  // ---- Dashboard: server-provided /stats display fields ----
  // Translated per stat key; the desktop falls back to the server-sent
  // Chinese strings when a key is absent (see DashboardPanel stat helpers).
  'dashboard.stat.activeTasks.label': 'Active tasks',
  'dashboard.stat.activeTasks.source': 'Task store tasks (GET /api/tasks)',
  'dashboard.stat.activeTasks.unit': '',
  'dashboard.stat.blockedTasks.label': 'Blocked tasks',
  'dashboard.stat.blockedTasks.source': 'Task store tasks (GET /api/tasks)',
  'dashboard.stat.blockedTasks.unit': '',
  'dashboard.stat.runningAgents.label': 'Running agents',
  'dashboard.stat.runningAgents.source': 'Agent registry agents (GET /api/agents)',
  'dashboard.stat.runningAgents.unit': '',
  'dashboard.stat.qaFailures.label': 'QA failures',
  'dashboard.stat.qaFailures.source': 'QA run history (GET /api/qa/runs)',
  'dashboard.stat.qaFailures.unit': '',
  'dashboard.stat.latestDeployment.label': 'Latest deployment',
  'dashboard.stat.latestDeployment.source': 'CI/CD deployment history (GET /api/deployments)',
  'dashboard.stat.latestDeployment.unit': '',
  'dashboard.stat.productionStatus.label': 'Production status',
  'dashboard.stat.productionStatus.source': 'CI/CD deployment history (GET /api/deployments)',
  'dashboard.stat.productionStatus.unit': '',
  'dashboard.stat.resourceUsage.label': 'Resource usage',
  'dashboard.stat.resourceUsage.source': 'Resource usage history (GET /api/resources/usage)',
  'dashboard.stat.resourceUsage.unit': '',
  'dashboard.stat.authorizedOutcomeCompletionRate.label': 'Authorized outcome completion rate (AOCR)',
  'dashboard.stat.authorizedOutcomeCompletionRate.source': 'Approved outcome records outcomes (§1.2 primary metric)',
  'dashboard.stat.authorizedOutcomeCompletionRate.unit': '%',
  'dashboard.stat.tasksCompleted.label': 'Tasks completed',
  'dashboard.stat.tasksCompleted.source': 'Task store tasks (GET /api/tasks)',
  'dashboard.stat.tasksCompleted.unit': '',
  'dashboard.stat.firstPassSuccessRate.label': 'First-pass success rate',
  'dashboard.stat.firstPassSuccessRate.source': 'QA run history (GET /api/qa/runs)',
  'dashboard.stat.firstPassSuccessRate.unit': '%',
  'dashboard.stat.avgTaskDuration.label': 'Average task duration',
  'dashboard.stat.avgTaskDuration.source': 'Task store tasks (GET /api/tasks)',
  'dashboard.stat.avgTaskDuration.unit': ' min',
  'dashboard.stat.avgRepairLoops.label': 'Average repair loops',
  'dashboard.stat.avgRepairLoops.source': 'QA run history (GET /api/qa/runs)',
  'dashboard.stat.avgRepairLoops.unit': ' rounds',
  'dashboard.stat.failedDeployments.label': 'Failed deployments',
  'dashboard.stat.failedDeployments.source': 'CI/CD deployment history (GET /api/deployments)',
  'dashboard.stat.failedDeployments.unit': '',
  'dashboard.stat.rollbackCount.label': 'Rollbacks',
  'dashboard.stat.rollbackCount.source': 'CI/CD deployment history (GET /api/deployments)',
  'dashboard.stat.rollbackCount.unit': '',
  'dashboard.stat.humanInterventions.label': 'Human interventions',
  'dashboard.stat.humanInterventions.source': 'Approval records approvals (GET /api/approvals)',
  'dashboard.stat.humanInterventions.unit': '',

  // ---- Board ----
  'board.justNow': 'just now',
  'board.minute': '{m}m',
  'board.hour': '{h}h',
  'board.day': '{d}d',
  'board.dropNotAllowed': 'Engine does not allow moving "{title}" directly into the {lane} column',
  'board.transitionOk': '✓ {title}: {from} → {to}',
  'board.gateDenied': '⛔ Gate denied (missing evidence): {missing}',
  'board.sep': '; ',
  'board.unauthorized': '⛔ Unauthorized (§17.2): {message} — dispatch it from the Dispatch tab first',
  'board.transitionFailed': 'Transition failed: {message}',
  'board.taskCount': '§85 · {count} tasks',
  'board.cardTitle': 'Click to open task details §86 · drag across columns to transition',
  'board.unassigned': 'Unassigned',
  'board.gate': 'Gate: ',
  'board.gateFetchFailed': 'Failed to load gates (retry)',
  'board.gateNone': 'None (can transition directly)',

  // ---- Approvals ----
  'approvals.processing': 'Working…',
  'approvals.renderFailed': 'Approvals panel failed to render ({message}); other panels are unaffected.',

  // ---- NeedsHuman ----
  'needshuman.subtitle': '§81 escalation records (read-only)',
  'needshuman.refresh': 'Refresh',
  'needshuman.refreshing': 'Refreshing…',
  'needshuman.desc':
    'Lists OPEN escalation requests — rows waiting for human handling. This panel is read-only: for acknowledge / resolve, use the server API (POST /api/needs-human/:id/resolve); the desktop offers no write actions.',
  'needshuman.loading': 'Loading…',
  'needshuman.loadFailed': 'needs-human list unavailable: {message}',
  'needshuman.emptyTitle': 'No OPEN escalation records',
  'needshuman.emptyBody':
    'This only means no rows are waiting for human handling — records are created only when real server-side paths trigger them (the 8 §81 triggers: ai-disagreement, budget-exceeded, repeated-failure, high-risk-deployment, policy-violation, security-issue, requirement-ambiguity, irrecoverable-env-error). An empty list is neither evidence that the mechanism is off nor that the feature is missing.',
  'needshuman.listHead': '{total} OPEN records (newest first):',
  'needshuman.severity': 'Severity: {sev}',
  'needshuman.sevCritical': 'Critical',
  'needshuman.sevHigh': 'High',
  'needshuman.sevMedium': 'Medium',
  'needshuman.meta': 'Raised {time} · source {source} · requires level {level} decider',
  'needshuman.recipient': ' · recipient {name}',
  'needshuman.noNarrative':
    '(No narrative provided by the server — the record\u2019s detailJson has no narrative field; nothing is inferred.)',

  // ---- TopBar ----
  'topbar.projectSettings': 'Project settings (import / export)',
  'topbar.identityTitle': 'Current API identity (GET /api/auth/whoami)',
  'topbar.switchToEn': 'Switch to English',
  'topbar.switchToZh': 'Switch to Chinese',
};

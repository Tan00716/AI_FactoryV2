/**
 * 中文语言包（i18n 试点，Batch 237）。
 * - 只有用户可见的 UI 文案进这里；代码注释里的中文不动。
 * - key 命名：`<panel>.<name>`，`<panel>` 为 dashboard / board / approvals / needshuman / topbar。
 * - 插值用 `{name}`，由 i18n/index.ts 的 t() 替换。
 * - en.ts 必须覆盖全部 key（类型级强制，缺 key 会 tsc 报错）。
 */
export const zh = {
  // ---- Dashboard ----
  'dashboard.status': '状态',
  'dashboard.metrics': '指标',
  'dashboard.noData': '暂无数据',
  'dashboard.live': '实时',
  'dashboard.source': '来源: {source}',
  'dashboard.updatedAt': '更新于 {time} · 每 5 秒刷新',
  'dashboard.showingStale': '（显示上次成功数据）',

  // ---- Dashboard: 服务端 /stats 下发的指标展示字段 ----
  // label/source 的中文必须与 packages/dashboard/src/aggregate.ts 的服务端常量逐字一致
  // （en 包负责翻译）；unit 含空格约定：中文无空格、英文前置空格。
  'dashboard.stat.activeTasks.label': '活跃任务',
  'dashboard.stat.activeTasks.source': '任务存储 tasks (GET /api/tasks)',
  'dashboard.stat.activeTasks.unit': '',
  'dashboard.stat.blockedTasks.label': '阻塞任务',
  'dashboard.stat.blockedTasks.source': '任务存储 tasks (GET /api/tasks)',
  'dashboard.stat.blockedTasks.unit': '',
  'dashboard.stat.runningAgents.label': '运行中 Agent',
  'dashboard.stat.runningAgents.source': '智能体注册表 agents (GET /api/agents)',
  'dashboard.stat.runningAgents.unit': '',
  'dashboard.stat.qaFailures.label': 'QA 失败',
  'dashboard.stat.qaFailures.source': 'QA 运行记录 (GET /api/qa/runs)',
  'dashboard.stat.qaFailures.unit': '',
  'dashboard.stat.latestDeployment.label': '最近部署',
  'dashboard.stat.latestDeployment.source': 'CI/CD 部署记录 (GET /api/deployments)',
  'dashboard.stat.latestDeployment.unit': '',
  'dashboard.stat.productionStatus.label': '生产状态',
  'dashboard.stat.productionStatus.source': 'CI/CD 部署记录 (GET /api/deployments)',
  'dashboard.stat.productionStatus.unit': '',
  'dashboard.stat.resourceUsage.label': '资源用量',
  'dashboard.stat.resourceUsage.source': '资源用量记录 (GET /api/resources/usage)',
  'dashboard.stat.resourceUsage.unit': '',
  'dashboard.stat.authorizedOutcomeCompletionRate.label': '授权结果完成率 (AOCR)',
  'dashboard.stat.authorizedOutcomeCompletionRate.source': '获准结果记录 outcomes (§1.2 主指标)',
  'dashboard.stat.authorizedOutcomeCompletionRate.unit': '%',
  'dashboard.stat.tasksCompleted.label': '任务完成数',
  'dashboard.stat.tasksCompleted.source': '任务存储 tasks (GET /api/tasks)',
  'dashboard.stat.tasksCompleted.unit': '',
  'dashboard.stat.firstPassSuccessRate.label': '首过成功率',
  'dashboard.stat.firstPassSuccessRate.source': 'QA 运行记录 (GET /api/qa/runs)',
  'dashboard.stat.firstPassSuccessRate.unit': '%',
  'dashboard.stat.avgTaskDuration.label': '平均任务时长',
  'dashboard.stat.avgTaskDuration.source': '任务存储 tasks (GET /api/tasks)',
  'dashboard.stat.avgTaskDuration.unit': '分钟',
  'dashboard.stat.avgRepairLoops.label': '平均修复轮数',
  'dashboard.stat.avgRepairLoops.source': 'QA 运行记录 (GET /api/qa/runs)',
  'dashboard.stat.avgRepairLoops.unit': '轮',
  'dashboard.stat.failedDeployments.label': '失败部署数',
  'dashboard.stat.failedDeployments.source': 'CI/CD 部署记录 (GET /api/deployments)',
  'dashboard.stat.failedDeployments.unit': '',
  'dashboard.stat.rollbackCount.label': '回滚数',
  'dashboard.stat.rollbackCount.source': 'CI/CD 部署记录 (GET /api/deployments)',
  'dashboard.stat.rollbackCount.unit': '',
  'dashboard.stat.humanInterventions.label': '人工干预数',
  'dashboard.stat.humanInterventions.source': '审批记录 approvals (GET /api/approvals)',
  'dashboard.stat.humanInterventions.unit': '',

  // ---- Board ----
  'board.justNow': '刚刚',
  'board.minute': '{m}分钟',
  'board.hour': '{h}小时',
  'board.day': '{d}天',
  'board.dropNotAllowed': '引擎不允许将「{title}」直接移入 {lane} 列',
  'board.transitionOk': '✓ {title}: {from} → {to}',
  'board.gateDenied': '⛔ 门禁拒绝（缺证据）: {missing}',
  /** 缺失证据列表的连接符（英文包用 "; "）。 */
  'board.sep': '；',
  'board.unauthorized': '⛔ 未授权（§17.2）: {message} —— 请先在 Dispatch 页签完成派发',
  'board.transitionFailed': '流转失败: {message}',
  'board.taskCount': '§85 · {count} 个任务',
  'board.cardTitle': '点击打开任务详情 §86 · 拖拽跨列发起流转',
  'board.unassigned': '未分配',
  'board.gate': '门禁: ',
  'board.gateFetchFailed': '门禁拉取失败（请重试）',
  'board.gateNone': '无（可直接流转）',

  // ---- Approvals ----
  'approvals.processing': '处理中…',
  'approvals.renderFailed': '审批面板渲染失败（{message}），其余面板未受影响。',

  // ---- NeedsHuman ----
  'needshuman.subtitle': '§81 人工升级记录（只读）',
  'needshuman.refresh': '刷新',
  'needshuman.refreshing': '刷新中…',
  'needshuman.desc':
    '列出状态为 OPEN 的升级请求 —— 等待人工处理的行。本面板只读：acknowledge / resolve 请走服务端 API（POST /api/needs-human/:id/resolve），桌面不提供写操作。',
  'needshuman.loading': '加载中…',
  'needshuman.loadFailed': 'needs-human 列表不可用：{message}',
  'needshuman.emptyTitle': '当前没有 OPEN 的升级记录',
  'needshuman.emptyBody':
    '这只表示没有等待人工处理的行 —— 记录只会在服务端真实路径触发时产生（§81 的 8 个触发器：ai-disagreement、budget-exceeded、repeated-failure、high-risk-deployment、policy-violation、security-issue、requirement-ambiguity、irrecoverable-env-error）。空列表不是"机制关闭"的证据，也不是"功能缺失"。',
  'needshuman.listHead': '共 {total} 条 OPEN 记录（按触发时间倒序）：',
  'needshuman.severity': '严重度 {sev}',
  'needshuman.sevCritical': '严重',
  'needshuman.sevHigh': '高',
  'needshuman.sevMedium': '中',
  'needshuman.meta': '触发于 {time} · 来源 {source} · 解决需 {level} 级别',
  'needshuman.recipient': ' · 接收者 {name}',
  'needshuman.noNarrative':
    '（服务端未提供 narrative —— 该记录的 detailJson 中无 narrative 字段，不做推断）',

  // ---- TopBar ----
  'topbar.projectSettings': '项目设置（导入 / 导出）',
  'topbar.identityTitle': '当前 API 身份（GET /api/auth/whoami）',
  'topbar.switchToEn': '切换到英文',
  'topbar.switchToZh': '切换到中文',
};

export type I18nKey = keyof typeof zh;

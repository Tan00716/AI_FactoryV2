# 中心 Tab 全量盘点（65 个）

- 基线：本地 main `ba64414`（V3R6 代码侧收口后；R7 #8 刷新。R6 快照基线为 `5b93f74`，R5 快照基线为 `da648a1`，R4 快照基线为 `ce9ff66`，历史验证记录见“本轮验证”一节）。
- 复核日期：2026-11-04（R7 #8 刷新；计数复核、旧别名 grep、占位符比对四项全重跑，见文末“R7 #8 刷新记录”）。
- 范围：仅中心 tab（`CENTER_TABS`）。底部 12 个 tab（AI Activity、Terminal、Tests、Problems、TODO、Database、Tasks、Queue、Watch、Bookmarks、Logs、Evidence）不在本盘点内；底部 Terminal 与中心 Terminal 是两个独立入口，见“近似重复说明”。
- 方法：`apps/desktop/src/navigation/tiers.ts` 的 `CENTER_TABS` 与 `apps/desktop/src/App.tsx` 的渲染分支双向比对；i18n 键按 App.tsx 的派生规则（`name.toLowerCase().replace('/', '')`）逐个核对；旧别名全树 grep 引用。
- 复核方法：任一改动后重跑本节“计数复核”三条命令，tab 数、分支数、i18n 键数三者须同时吻合；复核周期：每次增删 tab 后更新本表，不得让表过期。维护责任见“维护责任（R5 #8 S2）”一节；基线过期须复核，不得静默沿用。

## 对审计原文的一处纠正（现测为准）

审计第 6 条称“CENTER_TABS 65 个与 App.tsx 去重分支 62 个的差是渲染合并”。本轮双向比对实测：**显性分支为 64 个，不是 62 个**；唯一无显性分支的 tab 是 Editor，它走三元链末尾的默认分支渲染 `EditorPanel`。因此 64 + 1（默认分支）= 65，**无缺失、无渲染合并**，不存在需要解释的“差”。本表以实测为准。

## 计数复核（清理后）

- `CENTER_TABS`：65 个，无重名。
- App.tsx 显性分支：64 个；默认分支：Editor（`EditorPanel`）。
- i18n `tab.*` 键：zh/en 各 65 个，双向 0 差；派生键逐个解析，零缺失。
- 分层：common 12 个、expert 14 个、advanced 39 个，合计 65 个。
- 可达性：65 个按钮全部常驻挂载（分层折叠仅以 CSS 隐藏按钮，不卸载）；无条件渲染、无角色门禁隐藏的中心 tab。Editor 另可通过默认分支到达。

## 盘点表

列说明：入口 = 中心 tab 栏按钮（分层见“分层”列）；渲染 = App.tsx 分支对应的面板组件；重复/别名结论中“独立”表示该 tab 有独立面板与独立功能，不是别名。

| # | Tab | 中文 | 英文 | 分层 | 入口 | 渲染 | 用途 | 重复/别名结论 |
|---|---|---|---|---|---|---|---|---|
| 1 | Dashboard | 仪表盘 | Dashboard | common | 中心 tab 按钮 | DashboardPanel | 总览仪表盘 | 独立 |
| 2 | Ops | 运维 | Ops | advanced | 中心 tab 按钮 | OpsPanel + BudgetPanel + BackupPanel | 运维、预算、备份三面板合一 | 独立（同 tab 内三面板，非别名） |
| 3 | Report | 报告 | Report | advanced | 中心 tab 按钮 | FinalReportPanel | 项目最终报告 | 独立 |
| 4 | Board | 看板 | Board | common | 中心 tab 按钮 | Board | 任务看板 | 独立 |
| 5 | Git | Git | Git | common | 中心 tab 按钮 | GitPanel | Git 操作 | 独立 |
| 6 | QA | QA | QA | common | 中心 tab 按钮 | QaPanel（+任务选择器） | 质量门禁与 QA 抽检 | 独立 |
| 7 | Approvals | 审批 | Approvals | common | 中心 tab 按钮 | ApprovalsPanel | 待审批队列 | 独立 |
| 8 | Permissions | 权限 | Permissions | advanced | 中心 tab 按钮 | PermissionsPanel | 权限四档配置 | 独立 |
| 9 | NeedsHuman | 需人工 | NeedsHuman | advanced | 中心 tab 按钮 | NeedsHumanPanel | 需人工升级记录（只读） | 独立 |
| 10 | Dispatch | 调度 | Dispatch | common | 中心 tab 按钮 | DispatchPanel | 人工调度队列 | 独立 |
| 11 | CI/CD | CI/CD | CI/CD | advanced | 中心 tab 按钮 | CicdPanel | CI/CD 状态与流水线 | 独立（i18n 键为 tab.cicd，派生规则去斜杠） |
| 12 | Skills | 技能 | Skills | advanced | 中心 tab 按钮 | SkillsPanel | 技能管理 | 独立 |
| 13 | Memory | 记忆 | Memory | advanced | 中心 tab 按钮 | MemoryPanel | 智能体记忆 | 独立（与 Knowledge 来源不同，见近似重复说明） |
| 14 | MCP | MCP | MCP | expert | 中心 tab 按钮 | McpPanel | MCP 服务器管理 | 独立 |
| 15 | Knowledge | 知识库 | Knowledge | advanced | 中心 tab 按钮 | KnowledgePanel | 知识库检索与管理 | 独立 |
| 16 | Evaluation | 评估 | Evaluation | advanced | 中心 tab 按钮 | EvaluationPanel | 评估与语料 | 独立 |
| 17 | Agents | 智能体 | Agents | advanced | 中心 tab 按钮 | WorkforcePanel | 智能体组织树 | 独立 |
| 18 | Orchestrate | 编排 | Orchestrate | advanced | 中心 tab 按钮 | OrchestratePanel | 编排运行 | 独立 |
| 19 | Observatory | 观测 | Observatory | expert | 中心 tab 按钮 | ObservatoryPanel | 全局运行观测 | 独立（与 Activity/Events/Timeline 数据源不同，见近似重复说明） |
| 20 | Manager | 管理 | Manager | advanced | 中心 tab 按钮 | ManagerPanel | 管理聚合呈现（12 阶段走查） | 独立 |
| 21 | Editor | 编辑器 | Editor | common | 中心 tab 按钮；另为默认分支 | EditorPanel | 编辑器；未知 tab 值也落到此分支 | 独立（默认分支是兜底，不是别名） |
| 22 | Terminal | 终端 | Terminal | common | 中心 tab 按钮 | TerminalPanel | 终端 | 独立（底部另有 Terminal 入口，见近似重复说明） |
| 23 | Changes | 变更 | Changes | common | 中心 tab 按钮 | ChangesPanel | 变更审阅 | 独立 |
| 24 | Stability | 稳定性 | Stability | expert | 中心 tab 按钮 | StabilityPanel | 稳定性 / Flaky 相关 | 独立 |
| 25 | Project | 项目 | Project | common | 中心 tab 按钮 | ProjectPanel | 项目信息与配置 | 独立 |
| 26 | Activity | 动态 | Activity | advanced | 中心 tab 按钮 | ActivityPanel | 智能体动态事件流（/api/activity） | 独立（与 Events/Timeline 数据源不同） |
| 27 | Events | 事件 | Events | advanced | 中心 tab 按钮 | EventsPanel | 系统事件总线流（/api/events） | 独立 |
| 28 | Models | 模型 | Models | advanced | 中心 tab 按钮 | ModelsPanel | 模型与账号（含 stub 标注） | 独立 |
| 29 | Plan | 计划 | Plan | advanced | 中心 tab 按钮 | PlanPanel | Plan 模式 | 独立 |
| 30 | Hooks | 钩子 | Hooks | advanced | 中心 tab 按钮 | HooksPanel | Hooks 配置 | 独立 |
| 31 | Session | 会话 | Sessions | advanced | 中心 tab 按钮 | SessionPanel | 会话与检查点恢复 | 独立 |
| 32 | Plugins | 插件 | Plugins | advanced | 中心 tab 按钮 | PluginsPanel | 本地插件安装与管理 | 独立（与 Extensions 分工不同，见近似重复说明） |
| 33 | Metrics | 性能 | Metrics | advanced | 中心 tab 按钮 | MetricsPanel | 度量指标 | 独立 |
| 34 | Inspections | 质检 | Inspections | advanced | 中心 tab 按钮 | InspectionsPanel | 团队质量门禁 inspections | 独立 |
| 35 | Batch | 批量变更 | Batch | advanced | 中心 tab 按钮 | BatchChangesPanel | 批量变更 | 独立 |
| 36 | Collab | 协同 | Collab | advanced | 中心 tab 按钮 | CollabPanel | 团队协同 | 独立 |
| 37 | Coverage | 覆盖率 | Coverage | advanced | 中心 tab 按钮 | CoveragePanel | 覆盖率可视化 | 独立 |
| 38 | Recipes | 配方迁移 | Recipes | advanced | 中心 tab 按钮 | RecipesPanel | 确定性配方 | 独立 |
| 39 | Design | 设计模式 | Design | advanced | 中心 tab 按钮 | DesignPanel | 可视化设计模式 | 独立 |
| 40 | Updates | 更新 | Updates | advanced | 中心 tab 按钮 | UpdatePanel | 更新检查（含 lastCheck 三态） | 独立 |
| 41 | Refactor | 重构 | Refactor | expert | 中心 tab 按钮 | RefactorPanel | 确定性重构 | 独立 |
| 42 | Profiler | 性能剖析 | Performance Profiler | expert | 中心 tab 按钮 | ProfilerPanel | 性能剖析 | 独立 |
| 43 | HTTP | HTTP | HTTP | advanced | 中心 tab 按钮 | HttpPanel | HTTP/REST 客户端 | 独立 |
| 44 | Debug | 调试 | Debug | expert | 中心 tab 按钮 | DebugPanel | DAP 调试器 | 独立 |
| 45 | Timeline | 时间线 | Timeline | common | 中心 tab 按钮 | TimelinePanel | 任务时间线（含持久化 run 标记） | 独立 |
| 46 | Keybindings | 快捷键 | Keyboard Shortcuts | expert | 中心 tab 按钮 | KeybindingSettings | 快捷键体系与 which-key | 独立 |
| 47 | Merge | 合并 | Merge | expert | 中心 tab 按钮 | MergePanel | 三路合并 | 独立 |
| 48 | Search | 搜索 | Search | common | 中心 tab 按钮 | SearchPanel | 搜索编辑器 | 独立 |
| 49 | Scratches | 草稿 | Scratches | advanced | 中心 tab 按钮 | ScratchesPanel | 草稿文件（不审计、不受密钥扫描保护） | 独立 |
| 50 | Snippets | 代码片段 | Snippets | advanced | 中心 tab 按钮 | SnippetsPanel | 片段库 | 独立 |
| 51 | Schedules | 任务计划 | Schedules | advanced | 中心 tab 按钮 | SchedulesPanel | 任务计划（cron，UTC 解析） | 独立 |
| 52 | Rebase | 变基 | Rebase | expert | 中心 tab 按钮 | RebasePanel | rebase -i 与 stash 管理 | 独立 |
| 53 | Extensions | 扩展 | Extensions | expert | 中心 tab 按钮 | ExtensionsPanel | 扩展系统与信任签名 | 独立（与 Plugins 分工不同，见近似重复说明） |
| 54 | Rules | 规则 | Rules | expert | 中心 tab 按钮 | RulesPanel | 规则文件分级管理 | 独立 |
| 55 | DataPreview | 数据预览 | Data Preview | advanced | 中心 tab 按钮 | DataPreviewPanel | 数据文件预览 | 独立 |
| 56 | Env | .env | .env | expert | 中心 tab 按钮 | EnvPanel | .env 可视化管理 | 独立 |
| 57 | Slash | 斜杠命令 | Slash | expert | 中心 tab 按钮 | SlashCommandsPanel | 自定义斜杠命令 | 独立 |
| 58 | Diagnostics | 诊断包 | Diagnostics | expert | 中心 tab 按钮 | DiagnosticsPanel | 诊断包导出 | 独立 |
| 59 | LangSrv | 代码智能 | Code Intel | advanced | 中心 tab 按钮 | LangSrvPanel | LSP 代码智能 | 独立 |
| 60 | Notebook | 笔记本 | Notebook | advanced | 中心 tab 按钮 | NotebookPanel | Notebook（共享 exec 通道，无 Jupyter 内核协议） | 独立 |
| 61 | Webhooks | Webhooks | Webhooks | advanced | 中心 tab 按钮 | WebhooksPanel | Webhook 事件触发 | 独立 |
| 62 | Remote | 远程开发 | Remote | advanced | 中心 tab 按钮 | RemotePanel | 远程开发接入 | 独立 |
| 63 | TestExplorer | 测试资源管理器 | Test Explorer | advanced | 中心 tab 按钮 | TestExplorerPanel | 测试资源管理器 | 独立 |
| 64 | PrLink | PR / Issue 联动 | PR / Issues | advanced | 中心 tab 按钮 | PrLinkPanel | PR/Issue 联动 | 独立 |
| 65 | SettingsSync | 设置同步 | Settings Sync | advanced | 中心 tab 按钮 | SettingsSyncPanel | 设置同步（导出/预览/裁决/应用/远端） | 独立；旧别名键已清理，见下节 |

## 别名清理记录（本轮唯一清理项）

- 清理对象：i18n 旧别名键 `tab.settingsync`（单 s），中英各 1 行。
  - `apps/desktop/src/i18n/zh.ts`：删 `'tab.settingsync': '设置同步'` 一行。
  - `apps/desktop/src/i18n/en.ts`：删 `'tab.settingsync': 'Settings Sync'` 一行。
- 清理依据：App.tsx 按钮派生键为 `name.toLowerCase().replace('/', '')`，`SettingsSync` 派生为 `settingssync`（双 s），旧键 `settingsync` 永不被查到；全树 grep（`apps/desktop/src`、`apps/desktop/tests`）确认除 i18n 文件本身外零引用；`tab.settingssync`（双 s）保留，标签不变。
- 清理后：`tab.*` 键 zh/en 各 65 个，与 `CENTER_TABS` 65 个一一对应（CI/CD 对应 `tab.cicd`），双向 0 差。
- 未清理项：`settingsync` 作为服务端路由与 api 方法名前缀（如 `/api/settingsync/export`、`settingsyncExport`）是另一命名空间，与 i18n 别名无关，不得误删；文档中出现的 `settingsync` 均为路由名，同样保留。
- 其余 tab：65 个 tab 名无重名，64 个显性分支无重复分支条件，**无其他别名可清**。不得以“功能相近”为由合并独立 tab（见下节）。

## 近似重复说明（功能相近但均保留，不合并）

以下几组容易被误读为重复，经面板源码核对均为独立功能，保留并在此说明分工，避免后人误删：

1. **Plugins vs Extensions**：PluginsPanel 是本地插件安装与管理（走 `routes/plugins.ts`）；ExtensionsPanel 是扩展系统与信任签名（V3-#9 信任模型）。一管安装，一管信任，分工不同。
2. **Activity vs Events vs Timeline vs Observatory**：Activity 是智能体动态流（`/api/activity`）；Events 是系统事件总线流（`/api/events`）；Timeline 是任务时间线（含 run-history 持久化标记）；Observatory 是全局运行观测面。四个数据源不同，不是同一流的四个别名。
3. **Manager vs Agents vs Orchestrate**：Agents 是组织树（WorkforcePanel）；Orchestrate 是编排运行；Manager 是管理聚合呈现。分工不同。
4. **Memory vs Knowledge**：Memory 是智能体记忆；Knowledge 是知识库。来源与用途不同。
5. **中心 Terminal vs 底部 Terminal**：底部面板另有独立 Terminal 入口，与中心 TerminalPanel 是两个入口实例；本盘点只覆盖中心 tab，底部入口不在清理范围内，不得以此为由删中心 tab。
6. **Ops 内三面板**：Ops tab 一次渲染 OpsPanel + BudgetPanel + BackupPanel，是同一 tab 内的组合，不是三个 tab 的别名。

## 治理落差显性说明（文案先行，视图待客群判定）

- 现状：治理能力目前只有文案三件套（`docs/governance/`：策略清单、成本视图文案、演示脚本），**没有中心 tab 入口、没有治理视图**。本盘点 65 个 tab 中无治理 tab，这不是遗漏，而是 R3 #9 / R4 #6 的既定状态：视图门控于 Tan 的客群判定。
- 显性声明：用户在任何 tab 里都点不到“治理视图”；治理文案不等于治理视图，指挥屏（Tasks 页签顶部的 CommandPanel）是运行指挥视角，不是治理视图。客群判定一出，按判定上视图或继续文案，在此之前不新增 tab、不把文案说成视图。
- 本说明即为治理入口的落差显性化落点（UI 内无治理入口可贴，故落在本盘点文档与 `docs/governance/` 配套）；视图部分仍属门控后执行，不在本轮清理范围内。

## 计数复核命令（改动 tab 后重跑）

```bash
cd ~/workspace/ai-factory
python3 - <<'EOF'
import re
src = open('apps/desktop/src/navigation/tiers.ts').read()
tabs = re.findall(r"'([^']+)'", re.search(r"CENTER_TABS = \[(.*?)\] as const", src, re.S).group(1))
app = open('apps/desktop/src/App.tsx').read()
branches = re.findall(r"centerTab === '([^']+)'", app)
for lang in ('zh','en'):
    s = open(f'apps/desktop/src/i18n/{lang}.ts').read()
    keys = set(re.findall(r"'tab\.([a-z0-9]+)'", s))
    derived = {t.lower().replace('/','') for t in tabs}
    print(lang, 'tab.* keys:', len(keys), 'missing:', sorted(derived-keys), 'extra:', sorted(keys-derived))
print('CENTER_TABS:', len(tabs), 'unique:', len(set(tabs)))
print('explicit branches:', len(branches), 'fallback-only:', [t for t in tabs if t not in branches])
EOF
grep -rn "tab\.settingsync'" apps/desktop/src apps/desktop/tests || echo "orphan alias refs: none"
```

## R5 刷新记录（基线 da648a1，R5 #8）

- 盘点重跑（64+1 口径）：`CENTER_TABS` 65 个、无重名；App.tsx 显性分支 64 个、无重复分支条件、无分支指向表外 tab；唯一无显性分支的 tab 仍是 Editor，走默认分支。盘点表 65 行与当前 `CENTER_TABS` 逐行比对，顺序与集合完全一致，行内容无需改动（ce9ff66 → da648a1 无增删 tab）。
- i18n `tab.*` 键：zh/en 各 65 个，双向 0 差；派生键逐个解析，零缺失。
- 旧别名复核：`tab.settingsync`（单 s）全树 grep 除本盘点表自身的清理记录文字外零引用；服务端路由与 api 方法名前缀 `settingsync` 是另一命名空间，保留（见别名清理记录）。
- 治理落差复核：治理仍只有文案三件套、无中心 tab 入口、无治理视图，落差说明继续有效；视图门控于客群判定（R5 #10 决策单先行），本条不新增 tab、不把盘点完成说成治理完成。
- 失败降级形态：盘点未完成时不得宣称“65 tab 全可达”；占位符差异未清零时差异清单本身就是交付物，不得为清零而删键或改占位符名。

### i18n 占位符比对（同名同数，逐键）

- 方法：比对脚本 `~/v3r5-8-shots/compare-placeholders.mjs`，以 node 类型剥离直接导入 `apps/desktop/src/i18n/zh.ts` 与 `en.ts` 的导出对象（与 `apps/desktop/tests/unit/i18n.test.mjs` 同机制）；`{{name}}` 双花括号先剔除（两处均为“支持 {{name}} 占位符”的说明文字，非插值）；单花括号 `{name}` 按名与出现次数逐键比对为多重集。`${1:${2:x}}`（snippets.honest 嵌套占位符示例）与 en.ts 首行 import 类型花括号均非插值，不计入。
- 结果：zh/en 各 3321 键、键集合双向 0 差；占位符差异共 1 条（不是 0 条，见下表），其余 3320 键全部同名同数。（R7 #8 重跑，2026-11-04，结果与 R6 一致；R5 版数字 3311 已过期，以重跑为准。）

| 键 | zh 占位符 | en 占位符 | 定性 |
|---|---|---|---|
| `changes.changeCount` | `{count}` | `{count}, {plural}` | 有意例外，非缺陷：中文无需复数后缀；调用点（ChangesPanel）同时传 `count` 与 `plural`（单数为空、复数为 s），中文串只用 `count`。与 `i18n.test.mjs` 的 ALLOWLIST 一致，不得为“清零”而给中文串加无意义的 `{plural}`，也不得删 en 串的 `{plural}`。 |

- 本比对严于既有单测：单测只比占位符名集合，本比对加比出现次数；单测的 ALLOWLIST 例外在本比对中仍记为差异并定性，不静默豁免。
- 完整比对输出：`~/v3r7-8-shots/placeholder-diffs.txt`（R7 #8 重跑；R6 版输出见 `~/v3r6-8-shots/placeholder-diffs.txt`，R5 版输出见 `~/v3r5-8-shots/placeholder-diffs.txt`）。

### 维护责任（R5 #8 S2）

- 责任人：每轮审计/开发的执行方（收口人），不是某个固定人名；责任随轮次交接，交接时须把本表基线字段一并更新。
- 触发条件（任一即刷新）：(1) 本地 main 基线变更（每轮收口提交后）；(2) 增删或改名中心 tab；(3) i18n 键集合或占位符规则变化。刷新内容：基线 commit、计数复核、旧别名 grep、占位符比对四项全重跑，只改数字不跑比对视为未刷新。
- 复核周期：基线字段过期（表注基线落后于本地 main）时，下一轮开工前必须先刷新本表，再以新基线开展该轮工作；不得静默沿用旧基线表。
- 归属：本表只覆盖中心 tab；底部 12 tab 与治理视图不在本表维护范围内，治理视图排期待客群判定后另立盘点。

### 收口清单机制：基线注记刷新（R7 #8，修复本身，不降为附录）

R5→R6→R7 三轮同一模式（每轮基线前进一步、文档注记落后一轮）证明：只改数字不改机制，下一轮还会再来一轮。此后每个代码侧收口提交必须含“基线注记刷新”检查项，六项逐项打勾或显性标“内容未变、注记已刷”，缺一即该收口的文档保真项未完成：

| # | 文档 | 本轮（R7，基线 ba64414） |
|---|---|---|
| 1 | 本盘点表（表头 + 复核日期 + 刷新记录） | 已刷（见文末 R7 #8 刷新记录） |
| 2 | 规则文档 `docs/rules-priority.md`（H1 与正文基线） | 已刷（R7 #8 保真注记，引擎 5b93f74→ba64414 零改动） |
| 3 | 计量披露页 `docs/governance/metering-disclosure.md`（页首三项） | 由 R7 #7 同步刷新，本条只列入清单、不代刷（不得两处各写一套基线） |
| 4 | 客群决策单 `docs/governance/audience-decision.md`（基线注记，只刷注记不改“待 Tan”状态） | 已刷（R7 注记：悬空三轮，状态不变） |
| 5 | ACP 指针页 `docs/governance/acp-extension-hosting-pointer.md`（复核节） | 已刷（R7 #8 复核节） |
| 6 | 本地通道指针页 `docs/local-channel-spike-pointer.md`（复核注记） | 已刷（R7 复核注记） |

机制细则：指针页与主本的同步责任引用既有约定（修订只改主本，指针页随后同步状态行），不重立；披露页与设计稿的口径同步仍由 #7 负责，本机制只保证基线数字不分裂；刷注记不得删键、改占位符名、改主本结论或改决策单状态，违者视为未刷新。

## 本轮验证（实测）

- 桌面 tsc（`tsconfig.check.json --noEmit`）：0 error。
- 桌面 unit 全量：88/88，含 i18n 对称单测。
- e2e `test:desktop`：7/7；其中 tabs-clickable 一项逐个点了 65 个 tab，全部渲染，0 JS 错误。
- 别名清理后键集合复核：zh/en 各 65 个，双向 0 差；`tab.settingsync` 全树零引用。
- 仓库 `data/factory.db`：mtime 仍为 2026-10-19，无 WAL/SHM，未污染；e2e 进程（server/electron/Xvfb/vite）均已由 harness 杀净。
- 注意：i18n 两文件的工作树 diff 除本轮删的 2 行外另有兄弟任务（R4 #5）的 `budget.estimatedSuffix` 新增行，不属本轮；收口 commit 时须按行认领，不得整文件打包。

## R7 #8 刷新记录（2026-11-04，基线 ba64414）

- 触发：S2 触发条件 (1)，本地 main 基线由 `5b93f74` 变更为 `ba64414`；`apps/desktop/src/App.tsx`、`apps/desktop/src/navigation/tiers.ts` 与 `apps/desktop/src/i18n/` 在 `5b93f74` → `ba64414` 间零改动（`git diff --name-only` 为空），表内容仍准，本次只刷表头、复核日期与占位符比对结果数字。
- 四项全重跑（脚本 `~/v3r7-8-shots/verify-inventory.mjs` 与 `~/v3r7-8-shots/compare-placeholders.mjs`，由 R6 版脚本原样复用）：`CENTER_TABS` 65 个、无重名；App.tsx 显性分支 64 个、唯一无显性分支为 Editor（默认分支），无多余分支；分层 common 12 / expert 14 / advanced 39，合计 65；盘点表 65 行与 `CENTER_TABS` 顺序与集合完全一致；i18n 派生 `tab.*` 键 zh/en 各 65 个、双向 0 差；键集合总量 zh/en 各 3321、双向 0 差；占位符比对差异 1 条（`changes.changeCount` 有意例外，与单测 ALLOWLIST 一致），其余 3320 键同名同数。
- 旧别名 grep 口径分开写：`apps/desktop/src` 与 `apps/desktop/tests` 内 `tab.settingsync'`（单 s）为 0 命中；全树 grep 除本盘点表自身的清理记录文字外同样 0 命中（打包产物 `release/` 内二进制 asar 的一次匹配为构建产物，不是源码引用，不计入）。盘点表自身的全树声称引用时须注明为盘点表声称，不得 bare 写成全树已证——本条即按此口径写。
- 机制段落盘：收口清单“基线注记刷新”机制见下节“维护责任”新增的收口清单机制段与 `docs/governance/baseline-note-refresh.md`，本轮六项打勾见该机制文档。

## R6 #8 刷新记录（2026-11-04，基线 5b93f74）

- 触发：S2 触发条件 (1)，本地 main 基线由 `da648a1` 变更为 `5b93f74`；`apps/desktop/src/App.tsx` 与 `apps/desktop/src/navigation/tiers.ts` 在 `da648a1` → `5b93f74` 间零改动（`git diff --name-only` 为空），表内容仍准，本次只刷表头、复核日期与占位符比对结果数字。
- 四项全重跑（脚本 `~/v3r6-8-shots/verify-inventory.mjs` 与 `~/v3r6-8-shots/compare-placeholders.mjs`）：`CENTER_TABS` 65 个、无重名；App.tsx 显性分支 64 个、唯一无显性分支为 Editor（默认分支），无多余分支；分层 common 12 / expert 14 / advanced 39，合计 65；i18n 派生 `tab.*` 键 zh/en 各 65 个、双向 0 差；键集合总量 zh/en 各 3321、双向 0 差；旧别名 `tab.settingsync`（单 s）全树 grep 除本表自身清理记录文字外零引用；占位符比对差异 1 条（`changes.changeCount` 有意例外，与单测 ALLOWLIST 一致），其余 3320 键同名同数。
- 历史修正：本表占位符一节原写 3311 键已过期（R5 收口与 R6 审计独立实测均为 3321 键），本次以重跑结果 3321 键为准；R5 版“本轮验证”一节为历史记录，未动。

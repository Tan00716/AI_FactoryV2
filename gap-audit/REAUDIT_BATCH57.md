# Batch 57 独立复核报告（REAUDIT_BATCH57）

- **基线**：`76dbc78`（Batch 57）
- **复核方式**：隔离 worktree（`git worktree add /tmp/reaudit-b57 76dbc78`，`node_modules`/`dist` 软链自主树），亲读 + 亲跑；主树零干扰；复核后 worktree 已删除。
- **结论**：Batch 57 的实质声明全部成立，未发现夸大或造假。**偏差 0 处。**

## (a) 桌面"好用"审计 —— 成立

commit 恰好 **22 个文件**，其中 18 个是 `apps/desktop/src/components/`，其余是 CHANGELOG + 2 个 docs + `gap-audit/REAUDIT_BATCH56.md`。**服务端零改动**：`git diff a43bbec 76dbc78 --name-only -- apps/server packages` → 0 个文件。零产品代码改动以外的服务端改动为零，成立。

18 个桌面文件 diff **逐个亲读**（219 insertions(+), 66 deletions(−)）：

**吞错 → error banner（真实修复）**：
- `BottomPanel.tsx`：AI Activity 的 audit 拉取失败现在显示「审计日志加载失败：{err}」；5 秒轮询改静默模式（`load(true)` 不闪错、不熄加载态）；`cancelled` 防卸载竞态。
- `Board.tsx`：门禁拉取失败不再静默渲染「无（可直接流转）」——新增 `gateErr` 状态，卡片显示「门禁拉取失败（请重试）」。这是真实的防误导修复：之前拉取失败会**误导用户直接流转**。
- `NotificationsBell.tsx`：错误横幅「通知加载/更新失败」。
- `QaPanel.tsx`：`orgErr` 横幅「QA org 加载失败」。
- `TaskDetail.tsx`：Team/Subtasks/Tests/Security/Deployments/Memory 六个 tab 各加错误横幅（此前 `catch(() => setX([]))` 把失败吞成空态）；EvidenceTab 附加失败横幅「附加失败：{evError}」。
- `KnowledgePanel.tsx`：**功能级修复**——Search 按钮之前是 `run(async () => {})`，字面意义上的 no-op，点搜索什么都不做；现在是 `run(() => refresh())`，真正执行搜索。另加「暂无知识条目」空态。

**双提交门控（全部真实，disabled + 文案切换）**：
- `ApprovalsPanel.tsx`：`acting` 按行 map，Approve/Reject/Cancel 在提交期间禁用，文案「处理中…」，`finally` 释放。
- `CreateTaskModal.tsx`：`busy` 门控，「创建中…」。
- `EditorPanel.tsx`：`saving`/`savingRef` 双保险，Save 按钮 `disabled={!dirty || saving}`；另加空目录「（目录为空）」提示。
- `OrchestratePanel.tsx`：`busy` 三态（decompose/route/run），三个动作按钮互斥禁用。
- `TaskDetail.tsx`（OverviewTab）：`moving` 门控，「流转中…」。
- `WorkforcePanel.tsx`：hire/assemble/archive 共享 `busy` 门控；`AddNodeForm` 加 `adding` 门控。
- `EvidenceTab`：`evBusy` 门控，按钮 `disabled={!evTitle.trim() || evBusy}`。

**loading/空态**：`ActivityPanel`/`EventsPanel`/`ModelsPanel` 加 `loaded` 标志，区分「加载中…」与真空态（此前首次渲染会闪一下空态文案）；`EvaluationPanel` 加「暂无评估记录 / 暂无画像数据 / 暂无改进提案」；`GitPanel` 加输入引导文案；`McpPanel`/`SkillsPanel` 加「暂无已注册的 MCP 服务器 / 暂无已安装的 skill」。

**样式抽查**：修复用的 `.pill.warn`、`.banner.err`、`.err` 类全部在 `apps/desktop/src/styles.css` 真实存在（第 76/85–86/193 行）——横幅不是裸文本，确实有样式。

**亲验数字**：`npx tsc -p apps/desktop/tsconfig.json` → **0 错误**（基线 @76dbc78 亲跑）。

## (b) 文档 findings 编号一致性修复 —— 成立

"5 处修复"逐处 grep 亲验（其中 3 处在仓库外的 `SELLABLE_CHECKLIST.md`，与报告口径一致）：

1. `docs/FIRST_RUN_WALKTHROUGH.md` 表头：`(Batch 54)` → `(Batch 56)` ✓（diff 亲验）。
2. `docs/KNOWN_LIMITATIONS.md` 第 68 行：「Walkthrough index 14 行」→「15 行」；legs 枚举追加 audit-chain watch leg（Batch 56，A–C，1/1×3，F39–F40）；「Findings index（F1–F37…）」→「F1–F40」✓。
3. `SELLABLE_CHECKLIST.md` A 项：追加 Batch 56 条目（audit-chain watch leg 1/1×3 + 「走查总览索引补到 Batch 56（Walkthrough index 15 行 + Findings F1–F40）」）✓（第 9 行）。
4. `SELLABLE_CHECKLIST.md` B 项已关闭枚举：追加「audit-chain watch leg 走查 + 总览索引补到 Batch 56（Batch 56：Walkthrough index 15 行 + Findings F1–F40）」✓（第 15 行）。
5. `SELLABLE_CHECKLIST.md` C 项 README 同步行：「走查文档总览（14 行 + Findings F1–F38）」→「（15 行 + Findings F1–F40）」✓（第 20 行）。

**前瞻性口径一致**：Walkthrough index 数据行 = **15 行**（v1–v8 8 行 + redaction / §81 sweep / escalation / audit-chain / verify endpoint / verify leg / watch leg 7 个 leg）；Findings index = **F1–F40**（40 行，F38/F39/F40 亲验在位）。docs 与可售清单的前瞻性口径全部一致。

**历史快照刻意未动，逐条核实无歧义**：可售清单第 9 行 Batch 55 条目保留「Walkthrough index 14 行 + Findings F1–F38」、第 15 行 B 项保留「走查文档总览索引补齐（Batch 55：Walkthrough index 14 行 + Findings F1–F38）」、第 38 行「走查文档总览补到 Batch 54（Batch 55）：Walkthrough index 14 行 + Findings index F1–F38」——这些都是 **Batch 55 语境下的准确历史描述**（Batch 55 时确实是 14 行/F1–F38，watch leg 行是 Batch 56 才补的），不是当前口径声明；当前口径由新追加的 Batch 56 条目（第 9 行尾段、第 20 行）承载。`gap-audit/SELLABLE_REVERIFY_BATCH55.md` 的 F1–F38 记录同理——那是第七轮复验在基线 4f393a9 时的真实验证记录，改写等于篡改审计证据。保留决定正确。

## (c) Linux AppImage 复验 —— 成立

- `~/appimage-out/AI Factory-0.1.0.AppImage`：在位，130,143,440 bytes，`file` 确认 ELF 64-bit LSB x86-64 ✓
- `~/appimage-out/linux-unpacked/resources/`：`app.asar` + `server/` ✓
- `resources/server/audit-chain-watch.js` 在位（Batch 55 的周期自检已打包进产物）✓
- `resources/server/node_modules/@ai-factory/`：**42 个包** ✓
- 全部在仓库外；commit 文件清单中无任何仓库新增产物文件 ✓

## (d) commit 文件清单 —— 成立

`git show --name-only 76dbc78` → **恰好 22 个文件**：CHANGELOG.md + 18 个 `apps/desktop/src/components/*.tsx` + docs/FIRST_RUN_WALKTHROUGH.md + docs/KNOWN_LIMITATIONS.md + gap-audit/REAUDIT_BATCH56.md。无意外文件，无服务端文件。

## 真实验证数字（隔离 worktree @76dbc78）

- desktop tsc：**0 错误**
- 服务端全套：**466/466**，0 fail（Batch 57 无服务端改动，与 Batch 56 基线算术吻合）

## 偏差：0 处

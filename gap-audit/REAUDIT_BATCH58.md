# Batch 58 独立复核（REAUDIT_BATCH58）

- 复核基线：`e2b32b5`（Batch 58 收口 commit）
- 复核方式：隔离 worktree（`git worktree add /tmp/reaudit-b58 e2b32b5`），亲读 + 亲跑，主树零干扰；复核后 worktree 已删除
- 复核日期：2026-10-15
- 复核人注记：主树干净（仅 `.github/` 旧未跟踪 + 兄弟 Batch 59 任务在途 PNG），我未碰主树

## 结论：偏差 0 处

### (a) ApprovalsPanel 修复 —— 成立

`git diff 76dbc78 e2b32b5 -- apps/desktop/src/components/ApprovalsPanel.tsx` 逐行亲读（103+/14−，1 个文件）：

1. **映射逻辑正确**：新增 `RawApproval` 接口 + `toApprovalItem()`。逐字段核对：
   - `id ← approval_id`、`action ← action`、`requestedBy ← requester`、`taskId ← task_id`、`riskLevel ← risk_level`（`RiskLevel` 亲验 = 'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'，与 `ApprovalItem['riskLevel']` 一致）
   - `agentId ← ''`（服务端无此字段——亲验实证见下）
   - `evidenceIds ← []`（服务端只有 `evidence_manifest_hash`，无证据 id 列表——亲验实证见下）
   - `requiredApprover ← required_approvers.join(', ')`（服务端是 `string[]`，routes/approvals.ts:99–123 亲验）
   - `status` 增加 `'INVALIDATED'`（`ApprovalStatus` 亲验含 6 个状态，含 INVALIDATED）
   - `decidedBy ← decided_by`、`createdAt ← created_at`、`decidedAt ← decided_at`、`expiresAt ← deadline`
   - `required_approvers` 用 `Array.isArray` + string 过滤，防御服务端形状漂移
   - 映射应用在 `list/get/request/decide/cancel` **全部五个路径**（decision/cancel 的 `{ approval }` 包装也处理了——`toApprovalItem(r.approval)`）
2. **防御性 guards**：`(a.evidenceIds ?? []).length` 两处渲染——就算某个注入的 `ApprovalItem` 漏了 `evidenceIds` 也不会再 `undefined.length` 崩溃
3. **React error boundary**：`ApprovalsErrorBoundary` 在同文件内（无新增文件），渲染失败显示红色中文错误卡片，不再带下线整棵 React 树；`App.tsx` 引用的 `ApprovalsPanel` 导出名不变（内部重命名为 `ApprovalsPanelInner`），调用方零改动；`ApprovalItem` 无其他文件引用（grep 亲验：仅 ApprovalsPanel.tsx）
4. **真实 server 响应形状亲验（复核人独立重验）**：用真实编译 server（临时 DB_PATH/SECRETS/PROJECTS_ROOT，FACTORY_AUDIT_CHAIN_WATCH=0）→ POST 建 project → POST 建 task → POST 建 HIGH 风险审批 → GET /api/approvals。响应**恰好 20 个 snake_case 键**（`approval_id`、`action_digest`、`task_id`、`risk_level`、`required_approvers`、`evidence_manifest_hash` 等），**没有 `evidenceIds`、`没有 agentId`**——与 58-5 报告的声称完全一致。修复前面板在真实数据下必崩（`a.evidenceIds.length` 对 undefined 抛 TypeError），不是假设。server 进程已精确 PID kill，端口已清空
5. **dual-mode 合规**：无 src 内 `.ts` 后缀 import；`RawApproval` 桌面端自带接口，未 import `packages/approvals` 类型
6. **desktop tsc**：主树亲跑（干净 @e2b32b5）→ **0 错误**
7. 未改动范围成立：`apps/server`、`packages` 零改动；其他桌面文件未碰

### (b) commit 文件清单 —— 成立

`git show --name-only e2b32b5`：**恰好 8 个文件**，无意外文件：
- CHANGELOG.md
- apps/desktop/src/components/ApprovalsPanel.tsx
- gap-audit/REAUDIT_BATCH57.md
- gap-audit/SELLABLE_REVERIFY_BATCH57.md
- gap-audit/walkthrough-appimage-main-window.png（1439×871 真 PNG，`file` 亲验）
- gap-audit/walkthrough-b58-2-approvals-crash.png（1280×972 真 PNG，`file` 亲验）
- gap-audit/walkthrough-b58-2-needshuman-empty.png
- gap-audit/walkthrough-b58-2-qapanel-orgerr.png

### (c) 八轮复验报告与真机截图 —— 在位

- `gap-audit/SELLABLE_REVERIFY_BATCH57.md`（11040 bytes）亲读：翻绿 6 项逐条可定位、新增真实缺口 0、13 项硬门槛亲验全部仍在 Tan/环境侧、结论"仍是可运行的原型 + 持续收敛，不是可交付产品"、远端 main 仍 `7e96bfe`（按 Tan 2026-10-15 暂不推送指令）——口径诚实
- 4 张 PNG 全部在位，真 PNG（抽查 2 张 `file` 亲验为真 PNG）

## 卫生注记（非偏差）

1. **`/tmp` 512MB tmpfs 空间问题复现**：复核人中途把临时 DB 放 `/tmp` 时 server 启动报 `ERR_SQLITE_ERROR disk I/O error`（/tmp 当时已用 227M/512M）；换到 `$HOME/shape-check` 后正常。57-4 的教训仍然有效：本机重 IO 测试一律避开 `/tmp`，用 `$HOME` 下临时目录
2. **`pkill -f` 误杀自己 shell**：复核人用 `pkill -f "node apps/server/dist/index.js"` 清理 server 时把自己的 shell 也匹配杀掉了（模式串出现在自己命令行里——Batch 51 同款）。改用精确 PID kill 后干净。再次确认：以后一律精确 PID，不用 `pkill -f`
3. Batch 58-5 报告里"行级 busy 真机截图还未重拍"——已看到兄弟 Batch 59-2 任务在途 PNG（`walkthrough-b59-2-approvals-busy.png`、`walkthrough-b59-2-approvals-decided.png`），按计划是 Batch 59 的工作，不在本轮复核范围

**偏差：0 处。**

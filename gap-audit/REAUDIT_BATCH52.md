# REAUDIT_BATCH52 — Batch 52 独立复核

- 基线：`7eadda6`（Batch 52 主线 commit）
- 复核方式：隔离 worktree（`git worktree add ~/workspace/tmp-reaudit-b52 7eadda6`，detached HEAD；`node_modules` 与 `dist/` 软链主树——`dist/` 是 git-ignored，主树与 worktree 同一 commit，内容一致），亲读代码 + 亲跑测试，主树零干扰，worktree 已删。
- 结论：**Batch 52 的实质声明全部成立，未发现夸大或造假。偏差 0 处。**
- 零产品代码改动（commit 文件清单亲验：恰好 6 个文件——CHANGELOG.md、audit-chain 走查测试、FIRST_RUN_WALKTHROUGH.md、2 张 PNG、REAUDIT_BATCH51.md；无意外文件）。

## (a) 审计链完整性走查——成立

- **全文亲读**（215 行）：A1/A2 全部真实——纯 HTTP、零 mock、真实编译 server（`../dist/index.js`）+ 新鲜 temp SQLite；hermetic（临时 DB + 临时 `FACTORY_SECRETS_DIR`，符合铁律）；dual-mode 合规（仅 node builtins + fetch + 编译后的 `@ai-factory/core` dist，零 src import）。
- **实现交叉验证**（`packages/core/src/audit.ts`）：`AuditLog.record` 每次写入打 `prevHash`（上一条 `summaryHash`，首条 `AUDIT_CHAIN_GENESIS`）和 `summaryHash`（sha256 over canonical JSON）；调用方永远无法自行提供两个哈希；`verifyAuditChain`：legacy 记录计数跳过，逐条校验 prevHash 链接 + summaryHash 重算，首个失败处报 `brokenAt` 并停止。
- **"无 HTTP verify 端点"亲验**：`apps/server/src` 全文无 `verifyAuditChain` 调用——服务端确实只是 writer，operator 是 verifier，Batch 52 报告的"关键发现"属实，非修辞。
- **A1 真实**：3× `POST /api/projects`（无 path，F22 下空 path 合法）→ `GET /api/audit?limit=200` 反转为追加序 → `verifyAuditChain` → ok:true、legacyCount:0、verifiedCount === 记录数。
- **A2 真实**：第二个 `node:sqlite` 连接直接 `UPDATE audit_logs SET details` 篡改中间记录（"有 DB 访问权的攻击者"，故意没有 HTTP 篡改路径）→ 重拉 → ok:false，`brokenAt` 按 id 查找精确定位（非假设），verifiedCount 恰好等于断裂前记录数；10 次重试的锁冲突卫生措施在位。
- **F32–F34 在位**（走查文档第 678 节 + 701/707/715 行）：append-order 非 API-order、分页截断 genesis、第二连接写入 timing-adjacent——全部如报告所述。
- **detection-not-prevention 边界诚实**：测试头注释与文档均明示"链阻止不了 DB 写者，它让篡改显形并定位"，无预防冒充。
- **亲跑**：`node --test apps/server/tests/first-run-walkthrough-audit-chain.test.ts`，**1/1 × 3**，0 fail。

## (b) 桌面 BackupPanel 截图——成立

- 两张 PNG 均在主树 `gap-audit/` 在位：`walkthrough-backuppanel-table.png`（195201 bytes）、`walkthrough-backuppanel-restore-confirm.png`（204837 bytes）——字节数与 commit 记录一致；均为真实 1279×995 PNG。
- **两张都实际查看**：备份表截图——Ops tab 真实渲染，面板文案是 Batch 49 修过的诚实口径（"备份范围 = 工厂数据库…+ 已收录项目的项目工作文件（含 .ai/ 配置；符号链接不跟随，有排除项与大小上限）"），备份行「范围」列「数据库+项目文件」「2 个文件」，「恢复数据库…」「恢复项目文件…」两个按钮都在；确认卡截图——完整确认卡「⚠ 确认恢复项目文件（立即生效）」，三条事实逐条在位（立即生效不排队/不对称、preRestoreDir 回滚点、422 现树不动），「确认立即恢复」「取消」按钮在位。
- 与 Batch 52 报告的描述**逐条一致**，无美化、无摆拍痕迹（真实 Electron 渲染，AI Activity 日志条目时间戳连贯）。

## (c) 走查文档总览——成立

- **Walkthrough index 表**：11 行全部在位（v1 B11 … v8 B48、redaction leg B49、§81 sweep B50、escalation leg B51），每行 = 版本/覆盖 batch/链路/验证数字/关键 findings；表头注记"各版本跨文件累积、非替代；全走查真编译 server + 纯 HTTP + 零 mock"与各走查文件实际形态一致。
- **Findings index 表**：F1–F31 编号/级别/状态/一句话全部在位；状态口径 closed（F7/F9/F14/F19/F21/F22）/open/hygiene 与 Batch 52 报告一致。
- **closed findings 证据抽查**：`runtime-run-budgets.test.ts`（F14）、`project-path-validation.test.ts`（F22）、`audit-list-contract.test.ts`（F21）全部存在；`resolveRunLoopBudgets` 在 `routes/runtime.ts` 被引用；`validateProjectPath` 在 `routes/backup.ts` 在位；审计链 leg 一节（第 678 行）与 F32–F34 在位。
- 正文各节未动（仅顶部插入 65 行），Batch 52 报告如实。

## 真实验证数字（隔离 worktree @7eadda6）

- 审计链走查测试：**1/1 × 3**，0 fail
- 服务端全套：**454/454**，0 fail（= Batch 52 主线亲验数字，一致）
- 构建：worktree 未重构建（dist 软链同 commit 主树产物）；主线 Batch 52 收口已亲验构建 0 错误

## 偏差：0 处

## 注记（非产品缺陷）

- worktree 的 `dist/` 软链自主树（同 commit `7eadda6`），因 `dist/` git-ignored 不在 commit 内；node_modules 同样软链。这是复核环境选择，不影响结论（worktree 与主树同一 commit）。
- 主树当前有兄弟 Batch 53 任务在途——本复核未碰主树任何文件；报告文件写入主树 `gap-audit/REAUDIT_BATCH52.md`（未 commit，按独立复核传统由收口人统一提交）。

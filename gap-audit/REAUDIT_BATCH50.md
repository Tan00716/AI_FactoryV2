# REAUDIT_BATCH50 — Batch 50 独立复核

**基线**：`f0d26df`（Batch 50 收口）。**结论：Batch 50 的实质声明全部成立，未发现夸大或造假。偏差 0 处。**

复核在隔离 worktree（detached HEAD `f0d26df`，`node_modules` 软链主树）亲读代码 + 亲跑测试，主树零干扰，worktree 已删。零产品代码改动，未 commit。

## (a) §81 全触发器走查——成立

- **亲读全文**（418 行）：7 条阳性链路全部真实——S1 security-issue（10 × wrong Bearer 连续 → 401 → `auth-bruteforce:<ip>` + 'counting fact' narrative）、S2 policy-violation（同 granter 3 × 空 taskScope → 403 → 'The policy held on every attempt'）、S3 requirement-ambiguity（3 次 AC refinement → 'may be ambiguous'）、S4 ai-disagreement（mgr-a ALLOW vs mgr-b BLOCK 同级冲突 → 'the conflict is structural, not a judgment on either principal'）、S5 high-risk-deployment（无 risk 信号 deploy → assessRisk HIGH → AWAITING_APPROVAL → 'no deployment was executed — the gate held'）、S6 budget-exceeded（`budgets:{maxSteps:3}` → FAILED/BUDGET_EXCEEDED → 'resource fact'）、S7 repeated-failure（4 × unknown-tool → stagnation → ESCALATED → 'retry budget was exhausted'）。每条都是真实 HTTP 流程对真实编译 server（`../dist/index.js`）+ 新鲜 temp SQLite，零 mock；每条断言 OPEN 记录的 `detailJson.narrative` 含诚实限定语（F19/Batch-45 持久化契约的 live 钉住）。
- **S8 不是伪造**：是显式的负向对照断言——断言 `irrecoverable-env-error` 记录数为 0，且 S7 的 run 恰好只有 `repeated-failure` 一条记录。文件头注释（26 行）明确写出 Batch 44/45 边界（默认 stepFn 掩码、仅 echo/add 注册、StubAdapter 永不抛、assertSandboxAvailable 零调用者；Batch-45 窄版放行只在 tool 层原则上可达），并写明"Faking a positive path would be dishonest"。最终 tally 断言 OPEN 恰好 7 个 reason、无 env-error 行。
- **F28–F29 在位**：`docs/FIRST_RUN_WALKTHROUGH.md` 第 548/558 行——F28 钉死"7/8 触发，第 8 个是钉死的边界"，并指明 S8 是未来翻转点；F29 是 auth 模式走查卫生（brute-force leg 10 个坏请求必须连续、中间无成功 admin 读）。
- **亲跑**：`node --test apps/server/tests/first-run-walkthrough-needshuman.test.ts`，**1/1 × 3**（三次独立运行，0 fail）。dual-mode 合规（node builtins + fetch，零 src 导入）、hermeticity 合规（temp DB + 临时 `FACTORY_SECRETS_DIR`）。

## (b) 桌面 needs-human 只读面板——成立

- **只读亲读验证**：`apps/desktop/src/components/NeedsHumanPanel.tsx`（128 行）全文无 `acknowledge`/`resolve` 按钮、无写路径调用；面板头注释 + 页面文案双处讲清"解决走服务端 API，桌面不提供写操作"。`api.ts` 的 `api.needsHuman()` 只有 GET，无 resolve 封装——服务器的 `POST /api/needs-human/:id/resolve` 写路径亲读确认存在（`routes/needs-human.ts`），桌面故意不接，注释写明。
- **空态诚实**："空列表不是'机制关闭'的证据，也不是'功能缺失'"——如实表述空列表的含义，未把空态当成机制可用性的证据。
- **narrative 缺失处理**：`extractNarrative()` 对 JSON 解析失败或无 `narrative` 键返回 null，UI 如实显示"服务端未提供 narrative —— 该记录的 detailJson 中无 narrative 字段，不做推断"，无虚构填充。
- **类型一致**：`NeedsHumanRecord` 逐字段镜像服务端 `NeedsHumanDbRecord`（id/reason/reasonZh/severity/source/recipient/requiredDeciderLevel/detailJson/contextJson/raisedAt/status/resolvedAt/resolvedBy/resolution，`packages/db/src/needs-human-upgrades.ts:42`）；`NeedsHumanListResponse` `{items, total}` 与路由 `ctx.json(res, 200, { items: rows, total: rows.length })`（`routes/needs-human.ts:52`）逐字吻合；非法 status → 400 与服务端行为一致。面板只拉 `status=open`。
- **样式类在位**：`panel/panel-head/muted/card/card-title/card-meta/card-top/.banner.err` 全部在 `styles.css` 亲验存在。
- **亲验**：`npx tsc -p apps/desktop/tsconfig.json`，**0 错误**。

## (c) 可售清单第五轮复验报告——成立

- "翻绿 9 项"（F22/M1 单写者/terminal 跨块脱敏/F14/工具目录预置/走查 v8/redaction leg/桌面诚实性/KNOWN_LIMITATIONS 扫荡+独立复核 22–48）逐项有具名证据，抽查全部存在：`project-path-validation.test.ts`、`runtime-run-budgets.test.ts`、`tools-builtin-preregister.test.ts`、`first-run-walkthrough-redaction.test.ts`、`first-run-walkthrough-needshuman.test.ts`、`gap-audit/GAP_SWEEP_BATCH49.md`（15KB）、`REAUDIT_BATCH46/47/48.md`；`resolveRunLoopBudgets`（runtime.ts）与 `resolveProjectsRoot`（backup.ts）亲验在位。
- 复验人对数字的处理诚实：全套数字引用收口人主线亲验（兄弟任务在途未自己重跑），并在报告中明确标注；REAUDIT_BATCH21–48 连续无断档的声明与 `ls` 亲验一致。
- 总结论口径诚实无美化：仍是"可运行的原型 + 持续收敛"，不是可交付产品；硬门槛（Codex 登录、三平台分发+签名、许可证/定价/渠道）一项没动，全部在 Tan/环境侧。

## 真实验证数字（隔离 worktree @f0d26df）

- 构建：**0 TS 错误**（exit 0）
- §81 全触发器走查：**1/1 × 3**，0 fail
- desktop tsc：**0**

## 交付物

- `gap-audit/REAUDIT_BATCH50.md`（本文件，未 commit）

**偏差：0 处。**

注记：主树上有兄弟任务在途改动（Batch 51 其他 workstream）——未碰；主树仍停在 `f0d26df`。

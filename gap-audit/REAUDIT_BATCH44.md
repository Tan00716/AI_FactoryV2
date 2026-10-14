# Batch 44 独立复核报告（REAUDIT_BATCH44）

复核基线：`e20c5df`（Batch 44 提交，已推送）。复核人在隔离 worktree（`/tmp/reaudit-b44`，detached HEAD e20c5df）亲读代码 + 亲跑测试，主树零干扰（未动主树文件）。

**结论：Batch 44 的实质声明全部成立，未发现夸大或造假。偏差 0 处。**

## (a) F19 修复：成立

- **亲读三个 builder**（worktree @e20c5df）：
  - `apps/server/src/routes/workforce.ts:392-432`（`buildPolicyViolationUpgradeRecord`）：`narrative` 抽出为常量，含 "The policy held on every attempt — no elevation occurred."；`detailJson` 新增 `narrative` 键。
  - `apps/server/src/redaction-monitor.ts:163-205`（`buildSecurityUpgradeRecord`）：narrative 含 "A single hit can be benign (e.g. a command echoing its own environment for debugging)…"；`detailJson` 新增 `narrative` 键。
  - `apps/server/src/routes/requirements.ts:357-402`（`buildRequirementAmbiguityUpgradeRecord`）：narrative 含 "may be ambiguous"；`detailJson` 新增 `narrative` 键。
- **无表结构变更**：`git diff 9448321 e20c5df` 共 11 个文件，无 migration、无建表改动、无 `needs_human_upgrades` 相关 DDL。
- **发射逻辑未动**：三个文件的删除行仅为内联 `detail:` 模板字面量（被 `narrative` 常量替换）；`needsHuman(...)` 调用参数、阈值、去重、写透失败不抛契约逐行未动。
- **亲跑**：`needs-human-policy-violation.test.ts` **10/10**（含新增读路径往返测试：builder → `needsHuman.submit` → 真实 `handleNeedsHumanRoutes` 的 `GET /api/needs-human` → 断言返回 item 的 `detailJson.narrative` 含 "The policy held on every attempt — no elevation occurred"——正是 F19 的原话场景）；`redaction-monitor.test.ts` + `needs-human-requirement-ambiguity.test.ts` **18/18**（builder 级 narrative 断言在位）。合计 **28/28**，与 44-2 自述一致。
- 注：44-2 上报的 `buildEnvErrorUpgradeRecord` 同缺口（routes/runtime.ts）确实存在，本批未修——任务限定三处，留待后续批次。口径如实。

## (b) env-error HTTP 边界：成立

- **亲读** `apps/server/tests/needs-human-irrecoverable-env-error-http.test.ts`（216 行）：测试 1（负向对照）unknown-tool 3 连 → run `ESCALATED` → 恰好 1 条 `repeated-failure`、0 条 `irrecoverable-env-error`；测试 2（tripwire）`RUNTIME_TOOL_NAMES` 断言恒为 `['echo','add']`。文件头注释把"默认 stepFn 掩码 / StubAdapter 永不抛错 / assertSandboxAvailable 零调用者"的完整链条写成了代码注释。
- **亲跑**：**2/2**（纯 HTTP、零 mock，真 server + 临时 SQLite）。
- **复核人踩中的环境坑（非产品缺陷）**：首次亲跑时 1 fail（"server exited early with code 1"）——原因是 worktree 的 `dist/` 在我第一次 `npm run build` 时尚未产出（当时 node_modules 软链还没建，tsc 没跑起来）。`/tmp` 是 512M tmpfs 装不下完整 `npm install`（ENOSPC），改用软链主树 `node_modules` 后重建，测试即 2/2。44-3 自述的"2/2 连跑 3 次"不受影响。
- **文档边界句**：`docs/needs-human-triggers.md` 的 `irrecoverable-env-error` 条目已追加 Batch 44 亲验句（发射块经 embedder 注入抛 ENV_* 的 stepFn 可达、经本 server HTTP API 暂不可达 + 测试文件名）——与代码一致。
- **Doc nit（非偏差）**：该行旧句（Batch 43 遗留）写 "`POST /api/runtime/run` 完成路径"，实际路由只有 `/api/runtime/runs`（复数，`routes/runtime.ts:1799` 确认）；新的 Batch 44 边界句用的 `/runs` / `:id/resume` 路径正确。建议后续批次顺手修正旧句。

## (c) 可售复验报告：在位

- `gap-audit/SELLABLE_REVERIFY_BATCH44.md` 在位（10567 字节）：增量口径（引用 40-3），相对 Batch 40 的翻绿（§81 4/8→8/8、走查 v5/v6、REAUDIT_BATCH21–42 连续、测试基线分解）逐条可溯；硬卡点清单（Codex 登录、Windows/macOS 分发+代码签名、许可证/定价/渠道、GitHub CI 从未运行、非 Codex 适配器 stub 等）与代码现状一致；结论"可运行的原型 + 持续收敛"诚实。

## 真实验证数字（复核人亲跑，隔离 worktree @e20c5df）

- 构建：0 错误（`npm run build`，`grep -c "error TS"` = 0）
- 目标测试：28/28（policy-violation 10、redaction-monitor + requirement-ambiguity 18）
- HTTP 边界测试：2/2
- 服务端全套：**408/408**，0 fail
- 复核过程主树零干扰；worktree 已删除。

**偏差：0 处。**

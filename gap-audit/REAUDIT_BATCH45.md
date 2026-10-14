# Batch 45 独立复核报告（REAUDIT_BATCH45）

复核基线：`cc528e8`（Batch 45 提交，已推送）。复核人在隔离 worktree（`~/workspace/tmp-reaudit-b45`，detached HEAD cc528e8）亲读代码 + 亲跑测试，主树零干扰（未动主树文件；worktree 复核后删除）。

**结论：Batch 45 的实质声明全部成立，未发现夸大或造假。偏差 0 处。**

注：复核环境踩中两个坑（均非产品缺陷）：① `/tmp` 是 512M tmpfs 只剩约 7M，`git worktree add` 到 /tmp 两次失败（`Could not reset index file`），改在 `~/workspace/tmp-reaudit-b45` 建 worktree 成功；② worktree 构建中途服务重启一次，重跑后完整通过。

## (a) narrative 持久化扫尾：成立

- **亲读 diff（`e20c5df..cc528e8`）**：4 个 builder 的改动模式统一——narrative 抽出为 `const narrative`（沿用原 detail 文案 + 一句诚实限定语）→ `detail: narrative` → `detailJson` 加 `narrative` 键：
  - `apps/server/src/routes/authority.ts`（`buildUpgradeRecord`，ai-disagreement）：含 "the conflict is structural, not a judgment on either principal"；原私有函数改为导出（注释写明是测试缝，仿其他 §81 builder 前例）。
  - `apps/server/src/routes/cicd.ts`（`buildDeployUpgradeRecord`，high-risk-deployment）：含 "no deployment was executed — the gate held"。
  - `apps/server/src/routes/runtime.ts`（`buildRunUpgradeRecord`，budget-exceeded/repeated-failure）：按 trigger 分两版限定语（"The budget limit is a resource fact; nothing is claimed about the task's validity." / "The loop's own retry budget was exhausted — a fact about the run's terminal state, not a prediction."）。
  - `apps/server/src/routes/runtime.ts`（`buildEnvErrorUpgradeRecord`，irrecoverable-env-error）：含 "'Irrecoverable' describes the loop's own recovery being exhausted — a fact about the run's terminal state, not a prediction"（44-2 上报的缺口，本批补上）。
- **无表结构变更**：diff 共 15 个文件，无 migration、无 DDL、无 packages/db 改动。✓
- **发射逻辑逐行未动**：删除行仅为内联 `detail:` 模板字面量（被 `narrative` 常量替换）；阈值、去重、写透失败不抛契约、recipient/requiredDeciderLevel/severity 均未动。✓
- **亲跑**：`needs-human-run-emission.test.ts` + `needs-human-deploy-risk.test.ts` + `needs-human-irrecoverable-env-error.test.ts` + `authority-conflict.test.ts` = **31/31**，0 fail（与 45-2 自述一致）。

## (b) env-error 窄版放行：成立

- **亲读 `packages/runtime/src/runner.ts`**：默认 stepFn tool-catch 改为 `err instanceof FactoryError && isEnvErrorCode(err.code) ? err.code : \`tool:${tc.tool}:fail\``。`BudgetExceeded` / `PERMISSION_BYPASS_ATTEMPT` 的 terminal rethrow 在改动**之上**，逐行未动。✓
- **`ENV_ERROR_CODES` 是显式集合**（`packages/runtime/src/types.ts:267`）：`{'ENV_SANDBOX_UNAVAILABLE', 'ENV_BINARY_MISSING'}`，`isEnvErrorCode` 为精确成员判定，无前缀规则。✓
- **诚实注释在位**：改动处注释明写"只让 §81 'irrecoverable-env-error' 在 tool 层原则上可达……It does NOT invent an HTTP trigger — no registered server tool throws today"——没有伪造可达性，与 Batch 44 的 HTTP 边界句一致。✓
- **亲跑**：`packages/runtime/dist/tests/env-error-codes.test.js` **13/13**，0 fail（11 旧 + 2 新增：tool 抛 `MissingBinaryError` 3 次 → escalated + `LOOP_STAGNATION` + signature `ENV_BINARY_MISSING`；tool 抛普通 Error 3 次 → 签名仍为 `tool:boom2:fail` 掩码保留）。

## (c) 备份覆盖面扩展：成立

- **亲读 diff**：`scope` 语义诚实——`backedProjects.length > 0 ? 'factory-database+project-files' : 'factory-database'`（`backup.ts:526`）；老备份、老测试契约不受影响。收集规则：符号链接永不跟随、默认排除目录/后缀、单文件 25MiB / 总量 512MiB 上限、超限记 skipped（原因码），绝不静默丢弃。✓
- **亲跑**：`apps/server/tests/backup-project-files.test.ts` **12/12**，0 fail（与 45-4 自述一致）。

## (d) REAUDIT_BATCH44.md：在位

- `gap-audit/REAUDIT_BATCH44.md` 在位（4583 字节），结论"偏差 0 处"。✓
- Doc nit 修复确认：`docs/needs-human-triggers.md` 中两处旧的 `` `POST /api/runtime/run` `` 已改为 `/api/runtime/runs`，无残留单数形式。✓

## 真实验证数字（复核人亲跑，隔离 worktree @cc528e8）

- 构建：0 TS 错误（`npm run build`，`grep -c "error TS"` = 0；grep 计 0 的 exit 1 是正常退出码）
- 目标测试：31/31（narrative）+ 13/13（env-error-codes）+ 12/12（backup-project-files），0 fail
- 服务端全套：**422/422**，0 fail（复核人亲跑，非引用）

**偏差：0 处。**

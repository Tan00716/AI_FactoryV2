# Batch 64 独立复核报告（REAUDIT_BATCH64）

- **基线**：commit `b445896`（Batch 64），本地。
- **复核方式**：隔离 worktree `~/reaudit-b64`（detached HEAD `b445896`），`node_modules` + 各包 `dist` + `apps/server/dist` 软链自主树（主树 dist 由 Batch 64 收口时同 commit 源码构建，逐字节一致来源）。主树零干扰：全程未运行 `git stash`，未 commit。worktree 复核后已删除。
- **结论：偏差 0 处。**

## (d) commit 文件清单 —— 成立

`git show --name-only b445896` = **恰好 22 个文件**，与 Batch 64 收口口径一致，无意外文件：

```
CHANGELOG.md
apps/server/src/routes/evaluation.ts
apps/server/tests/board-drag-transition.test.ts
apps/server/tests/first-run-walkthrough-auto-governance.test.ts
apps/server/tests/git-merge-queue-broker-gate.test.ts
apps/server/tests/product-authority-default.test.ts
gap-audit/REAUDIT_BATCH63.md
packages/cicd/src/release.ts
packages/cicd/tests/release.test.ts
packages/core/src/tasks.ts
packages/core/src/types.ts
packages/core/tests/task-dispatch.test.ts
packages/evaluation/src/auto-governance.ts
packages/evaluation/src/index.ts
packages/evaluation/src/loop.ts
packages/evaluation/tests/auto-governance-loop.test.ts
packages/evaluation/tests/auto-governance.test.ts
packages/qa/package.json
packages/qa/src/org.ts
packages/qa/tests/org.test.ts
packages/runtime/src/runner.ts
packages/runtime/tests/runner-data-export.test.ts
```

## (a) G10 / INV-28 —— §45.4 自动治理 —— 成立

逐项亲读 `git diff 8459647 b445896`：

1. **`packages/evaluation/src/auto-governance.ts`**（新建，~290 行）：`evaluateAutoGovernance` 确为纯函数（输入观测+评估结果 → 决策数组）；决策类型只有 `downgrade-autonomy | disable-version | switch-to-fallback` 三种变体，无授权变体；阈值确定性（≥1 失败观察或独立评估失败 → disable-version；尾部 ≥2 连续失败或独立评估失败 → downgrade-autonomy；被禁用 + 有已批准未禁用 fallback + 未在 fallback 上 → switch-to-fallback）；幂等分支齐全。`VersionRegistry`：ACTIVE/DISABLED 状态、`approve()` 的 POLICY_APPROVAL 标记、`disable()` 幂等且保留 `effectRecord`。注释与代码一致，未发现"注释冒充实现"。
2. **`packages/evaluation/src/loop.ts`**（+202/−5）：`ImprovementLoop` 接入 registry（可注入共享）；`versionProposal` 注册、`approvePolicy` 标记批准；`activateLimited`/`promote` 拒绝 DISABLED（`DISABLED_VERSION` 错误）；新增 `migrateVersion`（显式迁移，admission-checked，目标禁用版本拒绝）；新增 `autoGovern(caseId, {by})`：disable → registry + 效果记录；fallback → 显式 `migrateVersion`；downgrade → 记录在 admission trail（未假装写 autonomy store，注释明确"enforcement is the autonomy layer's job"）。observations 打 `version` 标签，`autoGovern` 只取当前版本的观测（`o.version === undefined || o.version === version`）——64-2 所说的"测试抓到的真修复"在代码里确实存在。
3. **`apps/server/src/routes/evaluation.ts`**（+26/−1）：`advance` 新增 `auto-govern` step，调用 `loops.autoGovern`，写 `AUTO_GOVERNANCE_APPLIED` 审计（含 decisions），响应带回 decisions。`packages/evaluation/src/index.ts` 导出 `auto-governance`。

亲跑：`auto-governance.test.js` + `auto-governance-loop.test.js` = **22/22，0 fail**（16+6 与 64-2 口径一致）。

## (b) G1 / G2 / G5 —— 三个测试文件在位，it 计数成立

- `board-drag-transition.test.ts`（276 行）：`it(` 计数 **5**（A–E：裸写 400、混写忽略、拖拽 payload 成功、GET/PUT 404、非法 jump 422 + 审计），与 64-3 的 5/5 口径一致。
- `git-merge-queue-broker-gate.test.ts`（279 行）：`it(` 计数 **2**（broker deny 403 零副作用 + 对照组 202），与 2/2 口径一致。
- `product-authority-default.test.ts`（221 行）：`it(` 计数 **1**（内含 A–D 四个断言场景），与 1/1 口径一致。
- `first-run-walkthrough-auto-governance.test.ts`：`it(` 计数 **1**（1/1 × 3 轮口径，属 server suite 内）。

## (c) G11 / G7 / G3 / G4 —— 产品代码改动亲读成立

- **G11**（`packages/runtime/src/runner.ts` diff）：`dataExportEventFor()` 纯函数（`provider === 'local'` → null；未知 → `'unknown'` fail-safe）；`DefaultStepContext` 加 `privacy`（取自 `options.routeRequest?.privacy`）；调用点在 secret 扫描之后、预算消耗之后、`adapter.invoke` 之前；非 local 记录 `data_export` evidence（含 DATA_EXPORT/agentId/taskId/provider/model/privacy）。与 64-4 汇报一致。亲跑 `runner-data-export.test.js`：**5/5**。
- **G7**（`packages/cicd/src/release.ts` diff）：`Release.requirementRef` + `CreateReleaseInput.requirementRef`（'REQ-001@2' 形式，缺省不捏造）；`checkReleaseEvidenceCompatibility()` 纯函数；`ReleaseEvidenceMismatchError`；`deployRelease` 新增 Gate 2b（pin 不一致且无兼容性声明 → 拒绝 + `RELEASE_EVIDENCE_MISMATCH` 审计；有声明 → 放行 + `RELEASE_COMPATIBILITY_DECLARED` 审计；无可比项 → 跳过不捏造）。亲跑 `release.test.js`：**49/49**。
- **G3**（`packages/core/src/tasks.ts` + `types.ts` diff）：`Task.evidenceRefs?`；`TaskManager.reportFinding()`：标题必填、证据至少 1 个（空数组抛 `TaskDependencyError`）、`creator` 默认为发现 agent、固定 `WAITING_HUMAN_DISPATCH`（代码里无 AUTHORIZED 分支——发现不能静默开 run 的声称成立）、classification 记为约束 token。亲跑 `task-dispatch.test.js`：**12/12**。
- **G4**（`packages/qa/src/org.ts` + `package.json` diff）：`ensureQaLead`/`createQaSpecialist` 新增可选 `QaCreationGate`；传 gate 时走 `enforcePolicy`（来自 `@ai-factory/employee-factory`，value import，dual-mode 合规）；拒绝抛错且注册发生在 `enforcePolicy` 之后（零注册声称成立）；不传 gate 行为与原来一致。`packages/qa/package.json` 新增依赖。亲跑 `org.test.js`：**12/12**。

## 真实验证数字（隔离 worktree @b445896）

| 项 | 结果 |
|---|---|
| 根 `npm run build` | **0** 个 `error TS` |
| `npx tsc -p apps/desktop/tsconfig.json` | 0 |
| `npx tsc -p apps/desktop/tsconfig.electron.json` | 0 |
| `npx tsc` (packages/evaluation) | 0 |
| evaluation auto-governance 新测试 | **22/22** |
| runtime data-export 新测试 | **5/5** |
| cicd release | **49/49** |
| core task-dispatch | **12/12** |
| qa org | **12/12** |
| 服务端全套 `node --test apps/server/tests/*.test.ts` | **483/483，0 fail**（第一轮即全绿，无环境抖动） |

## 卫生注记（非偏差）

1. worktree 的 `dist` 软链自主树：Batch 64 收口时主树已用同 commit 源码构建，来源一致。复核中在 worktree 跑 `npm run build` 会透过软链回写主树 `dist`（均为 gitignored 文件，同 commit 同源码，输出一致），未污染版本库。
2. 主树在复核期间有兄弟 Batch 65 任务的在途改动——我未碰。
3. `/dev/null` 缺失：亲验本机 `/dev/null` 确为普通文件（625 bytes，64-4 应急顶替）。这是容器/mknod 权限问题，复核人无权限修复，记录在案。`git diff` 等命令工作正常，未影响复核。
4. `npm test` 全量包套件（2563）未在 worktree 重跑——scope 是 Batch 64 改动的独立复核，相关包的新测试已逐项亲跑（22+5+49+12+12），服务端全套 483/483 覆盖 server 侧新测试（9 条：G1 5 + G2 2 + G5 1 + auto-governance walkthrough 1）。

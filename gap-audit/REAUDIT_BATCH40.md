# Batch 40 独立复核报告

> 复核基线：`d5106b4`（Batch 40，已推送）。复核人独立亲读 diff + 亲跑测试；零产品代码改动，未 commit。
> 主工作树在复核时干净（仅 `.github/` 未跟踪，与本批无关），无兄弟在途污染。

## 结论：Batch 40 的实质声明全部成立，未发现夸大或造假。偏差 0 处。

### (a) 环境错误 machine-readable 信号：成立

亲读 `git show d5106b4` 的三处改动：

1. **定义**（`packages/runtime/src/types.ts`，+34 行）：`SandboxUnavailableError extends FactoryError`，code `ENV_SANDBOX_UNAVAILABLE`，带 `probeReason` 字段；`MissingBinaryError extends FactoryError`，code `ENV_BINARY_MISSING`，带 `binary` 字段。注释明写"确定性信号（OS 探针结果/ spawn ENOENT），不是启发式分类"——与 39-4 的前置条件表述一致。`packages/runtime/src/index.ts` 有 `export * from './types'`，两个类随之导出。
2. **`assertSandboxAvailable`**（`apps/server/src/build-sandbox.ts`，+22 行）：探针失败时抛 `SandboxUnavailableError(probe.reason ?? 'probe failed')`；注释明写默认 `runBuildCommand` 路径保留诚实回退——亲读 `runBuildCommand` 本体（diff 未动其逻辑），`SANDBOX_UNAVAILABLE` 审计 + unsandboxed 执行原样保留。`assertSandboxAvailable` 在 src 内无生产调用者（仅测试），"信号层"声明成立。
3. **`runCommandPipe`**（`packages/runtime/src/pty.ts`，+15 行）：仅当 `spawnError.code === 'ENOENT'` 时转 `MissingBinaryError(argv[0], se.message)`；其他 spawn 失败保持原错误抛出。仍是 Error 子类，现有 catch 行为不变。"普通错误不误报"成立。
4. **无自动发射**：`apps/server/src/routes/runtime.ts:456` 的发射门仍只认 `'BUDGET_EXCEEDED' | 'LOOP_STAGNATION'` 两个 code；新 code `ENV_SANDBOX_UNAVAILABLE`/`ENV_BINARY_MISSING` 不触发任何 needsHuman 发射。Batch 40 声明的"只做信号层"成立。

亲跑（复核人，主线亲跑）：
- `packages/runtime/dist/tests/env-error-codes.test.js`：**7/7**（code 精确透传、不自动 escalate、普通错误→null、持续同 code→stagnation 时 reasonCode 为 `LOOP_STAGNATION` 不编造 env code、缺失二进制→MissingBinaryError、现存二进制无回归、exitCode 非零不误标）
- `apps/server/tests/build-sandbox.test.ts`：**17/17**（+2：`assertSandboxAvailable` 对 bogus binary 抛 code 精确、探针可用时 resolve）
- `packages/runtime` 全包：**168/168**（161 + 7 新）
- 根 `npm run build`：**0 TS 错误**

### (b) 可售清单第二轮复验（`gap-audit/SELLABLE_REVERIFY_BATCH40.md`）：成立

抽查翻绿 4 项与代码对得上：

1. **MCP 真实握手（37）**：`packages/mcp/src/stdio-connector.ts` 在位（真实 stdio JSON-RPC 传输）；真握手本身在 Batch 37 复核（REAUDIT_BATCH37.md）已亲手复现 2/2，本报告引用不重复。
2. **构建沙箱（37）**：`apps/server/src/build-sandbox.ts` 在库，探针 + `SANDBOX_UNAVAILABLE` 诚实回退。
3. **§81 发射面 1/8 → 4/8**：四个发射点逐个在代码中亲验在位——`ai-disagreement`（`apps/server/src/routes/authority.ts:83`）、`budget-exceeded`/`repeated-failure`（`routes/runtime.ts` 的 `emitRunNeedsHuman`，:1193 调用，按 code 分类）、`high-risk-deployment`（`routes/cicd.ts` 的 `emitDeployNeedsHuman`，:1059 调用）。其余 4 个未发射（requirement-ambiguity、policy-violation、security-issue、irrecoverable-env-error），报告中的一句话诚实原因与 `docs/needs-human-triggers.md` 及代码现状相符。
4. **SBOM attestation dev + retention（38/39）**：`packages/cicd/src/attestation.ts` 在库；`packages/db/src/retention.ts:70` 有 `'attestations'` 分类；生产签名仍未做（待 Tan 密钥决策），报告如实标注。

复验报告的"仍卡"清单（Codex 登录、Win/Mac+签名、许可证/定价/渠道、§81 其余 4、非 Codex stub、远程 DB 驱动、merge 多机、Windows 探测、桌面真人验收、生产签名、CI scope）与 KNOWN_LIMITATIONS 及代码现状一致，无漏报。**本报告不代 Batch 39 复验之外的任何事项背书。**

### (c) KNOWN_LIMITATIONS 扫荡（40-4）：成立

4 条改动逐条亲验有代码依据：

1. **§6.1 Clone "缺失"→已关闭（Batch 33）**：`apps/server/src/routes/projects.ts:249` 的 `POST /api/projects/clone` 真实在位（真 `git clone`），原"入口缺失"声明确已过时。
2. **§33 Browser/db.query 口径精确化**：`BrowserProfileRegistry` 在 `packages/tools/src/browser.ts`、`builtins.ts` 在位（Batch 28 本机目录隔离）；`/api/db/query` 的 HTTP broker 在 `apps/server/src/routes/db.ts:211` 在位（Batch 29）；`db.query` 作为工具仍 definition-only（implementationGate 未接线，继续 DENY）——改写后的口径精确。
3. **§36 队列"进程内重启丢失"→已于 Batch 20 被落库取代**：`merge_queue_entries` 表在 `packages/db/src/db.ts:291-301` 在位（含迁移列 `claimed_by`），原声明确为历史残留。
4. **结论基线→`59eb7a0`**：与 `d5106b4` 的父 commit 一致，数字（2469/2469、350/350）与 Batch 39 收口亲验一致。

### (d) 清单文件更新：成立

`~/workspace/goals/ai-factory-app-prototype/files/SELLABLE_CHECKLIST.md`：

- "§81 其余四个触发器"（第 15、34 行）——与代码的 4/8 发射面一致；第 15 行括号内已注明 high-risk-deployment 于 Batch 39 发射。
- C 测试基线 `59eb7a0`（第 96 行）：2469/2469、350/350、tsc 0、smoke OK——与 Batch 39 收口亲验一致。
- 独立复核 "Batch 22–39"（第 21 行）：`gap-audit/REAUDIT_BATCH2[2-9].md` + `REAUDIT_BATCH3[0-9].md` 的 glob 亲验覆盖真实存在的全部文件（REAUDIT_BATCH29.md 在位，glob 无遗漏）。

### 小注（非偏差）

- 第 15 行"已关闭"列表的"§81 needsHuman 发射路径（Batch 36…Batch 38…）"未提及 Batch 39 的 high-risk-deployment，但括号内的"其余四个"口径已含其发射事实——表述可更顺，不构成事实错误。

## 真实验证数字（复核人主线亲跑）

- 根 build：**0 TS 错误**；env-error-codes **7/7**；build-sandbox **17/17**；runtime 全包 **168/168**
- 偏差：**0 处**

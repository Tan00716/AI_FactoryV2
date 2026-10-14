# Batch 43 独立复核报告（REAUDIT_BATCH43）

复核基线：`9448321`（Batch 43 提交，已推送）。复核人在隔离 worktree（`/tmp/reaudit-b43`，detached HEAD 9448321）亲读代码 + 亲跑测试，主树零干扰。

**结论：Batch 43 的实质声明全部成立，未发现夸大或造假。偏差 0 处。**

## (a) irrecoverable-env-error 接线：成立

- **亲读 `packages/runtime/src/types.ts`**：`ENV_ERROR_CODES` 是显式集合（`ENV_SANDBOX_UNAVAILABLE`、`ENV_BINARY_MISSING`），`isEnvErrorCode()` 是精确成员判定，无前缀规则、无正则。`RunResult.stagnationSignature?: string | null` 字段注释如实（"The server classifies §81 'irrecoverable-env-error' on this field — determinately, by code — instead of parsing the human-readable reason message"）。✓
- **亲读 `packages/runtime/src/runner.ts`**：catch `LoopStagnation` 时返回对象新增 `stagnationSignature: err.signature`（diff 确认为 1 行加法）。`reasonCode` 在该分支 = `err.code`（FactoryError），`LoopStagnation extends FactoryError` 且 code 为 `'LOOP_STAGNATION'`（types.ts:199）——`shouldEmitEnvErrorUpgrade` 的 `reasonCode === 'LOOP_STAGNATION'` 前件真实成立。✓
- **亲读 `packages/runtime/src/loop.ts`**：step 异常按步捕获，`errorSignature = err instanceof FactoryError ? err.code : 'step-throw'`（loop.ts:183）；同一签名连续到 `stagnationLimit`（3）→ `throw new LoopStagnation(sig, 3)`（loop.ts:260）。于是 MissingBinaryError 在 step 层重复 3 次 → signature `ENV_BINARY_MISSING` → stagnation → escalate 的链路是真实生产路径（`POST /api/runtime/run` → `runAgent`）。✓
- **亲读 `apps/server/src/routes/runtime.ts`**：`buildEnvErrorUpgradeRecord`（trigger `irrecoverable-env-error`，severity critical，recipient null，`operator`，source `runtime-run:<runId>`，detailJson 含 cross-reference 注明与 `repeated-failure` 共存）；`shouldEmitEnvErrorUpgrade` 纯谓词（`reasonCode === 'LOOP_STAGNATION' && isEnvErrorCode(stagnationSignature)`）；发射块放在 Batch-38 块**之后**，Batch-38 契约（`BUDGET_EXCEEDED || LOOP_STAGNATION` → `buildRunUpgradeRecord`）一字未动。✓
- **Batch 43 diff 全文 grep `classifyFailure`：0 命中**——39-4 的正则分类器确实一行没用，全程 code 成员判定。✓
- **"直接 ENV_* reasonCode 刻意不接"**：发射块注释与 `docs/needs-human-triggers.md`（"刻意不接……今天没有生产路径能让环境错误逃出 loop 的按步捕获，接上就是定义冒充实现；命名为未来钩子"）口径一致；server 测试第 94 行 `predicate: direct ENV_* reasonCode is deliberately NOT wired → false` 把该决策钉住。✓
- **39-4 三条理由处置如实**：① heuristic 未用（见上）；② `RecoveryLoop` 零 server 调用者——文档明写"**绕过而非解决**：发射走 run 自身的终局 escalation（真实生产路径），不经过 RecoveryLoop"，没有冒充解决了；③ 通用重试耗尽不发射（谓词要求 stagnation + env signature 双条件）。✓
- **亲跑**：`packages/runtime` 的 `env-error-codes.test.js` **11/11**（Batch 40 的 7 个 + Batch 43 的 4 个：真路径 3 次 MissingBinaryError → escalated + `LOOP_STAGNATION` + signature `ENV_BINARY_MISSING`；非 env stagnation 透传 signature 不误报；非 stagnation 终局无 signature；`isEnvErrorCode` 精确成员判定）；`apps/server/tests/needs-human-irrecoverable-env-error.test.ts` **8/8**（谓词真值表 4 组、builder 形状、诚实文案、与 repeated-failure 同 source 共存、写透失败审计且不抛）。✓

## (b) 走查第六版：成立

- 亲跑 `apps/server/tests/first-run-walkthrough-b43.test.ts`：**1/1**（worktree 完整 `npm run build` 后，构建 0 错误）。
- 五链路（P1/S1/R1/Q1）亲读确认：P1 同 granter 3 次 ceiling denial → OPEN，单次不发射；S1 1× 错 token 无发射、10× 连打 → `security-issue` OPEN；R1 3× exec 命中 → 脱敏输出（无 sentinel）→ ≥3 条 `SECRET_REDACTED_HIT`（不含 secret 内容）→ `security-issue` OPEN；Q1 3× ac-refinement → OPEN，第 4 次 → 409 `REQUIREMENT_REFINEMENT_PAUSED`（熔断器是真的）。
- **F19–F21 逐条如实**：
  - F19（Medium）：`brute-force-emission.ts` 的 detailJson 含 `narrative`，而 `workforce.ts` / `redaction-monitor.ts` / `requirements.ts` 三个 builder 的 detailJson 均无 `narrative`——诚实文案（如 "The policy held on every attempt — no elevation occurred"，存在于传给 `needsHuman()` 的瞬态 `detail`）确实没活过持久化。✓
  - F20（Low）：`packages/security/src/brute-force.ts` 文件头如实注记"共享 IP（NAT/loopback）下一客户端合法请求会清零整 IP 计数器"；走查 S1 相位顺序（完整新鲜 10 次）是该规则的直接后果。✓
  - F21（Info）：`apps/server/src/index.ts:1583` 的 `GET /api/audit` 返回 `audit.list().slice(-limit).reverse()`——裸数组，确非 `{records}`。✓

## (c) 文档扫荡：成立

- `docs/KNOWN_LIMITATIONS.md` 的 4 处改动逐条对代码核过：
  1. §8.1/INV-31 "全库无 AUTHORITY_CONFLICT 符号" → 已关闭口径：`grep` 在 `routes/authority.ts`（`onConflictOpened` ×2）、`disputes.ts`、`needs-human.ts` 均命中符号，Batch 36 发射落库为真。✓
  2. §81 条目补 Batch 41 `policy-violation`：`workforce.ts` 的发射代码在位（阈值 3、诚实口径、去重规则），按时间顺序补入正确。✓
  3. 结论基线 `59eb7a0` → `795d508`：Batch 42 主线亲验数字（构建 0、2498/2498、396/396）。✓
  4. §48.2 条目标题 "实体集合未落库清单" → "落库清单（Batch 32–35，已全部关闭）"：正文每条都是已落库，原标题确为批次累积遗留。✓
- `docs/needs-human-triggers.md`：`## 已发射（7/8）` → `## 已发射（8/8）`，`irrecoverable-env-error` 移入已发射行（发射路径、诚实口径、三条处置、刻意不接均与代码一致），`## 未发射（1/8）` → `## 全部发射（8/8）`。✓
- Batch 43-2 追加的 §81 条目（`irrecoverable-env-error` 发射点说明）与 (a) 的代码实现一致；"仅剩一个" → "已全部接上" 口径正确。✓

## 真实验证数字（复核人亲跑，隔离 worktree @9448321）

- 构建：0 错误（`npm run build`，`grep -c "error TS"` = 0）
- `packages/runtime` 的 `env-error-codes.test.js`：**11/11**
- `apps/server/tests/needs-human-irrecoverable-env-error.test.ts`：**8/8**
- `apps/server/tests/first-run-walkthrough-b43.test.ts`：**1/1**
- 上述测试 0 fail；复核过程主树零干扰（未动主树文件），worktree 已删除。

**偏差：0 处。**

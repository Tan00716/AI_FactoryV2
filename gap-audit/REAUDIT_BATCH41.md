# Batch 41 独立复核报告

> 复核基线：`a5a38f4`（Batch 41，已推送）。复核人独立亲读 diff + 亲跑测试；零产品代码改动，未 commit。
> 主工作树在复核时干净（仅 `.github/` 未跟踪，与本批无关），无兄弟在途污染。

## 结论：Batch 41 的实质声明全部成立，未发现夸大或造假。偏差 0 处。

### (a) policy-violation 接线：成立

- **AuditStore.countByActorAction 双实现亲读**：
  - `packages/core/src/audit.ts:135` 接口 + `InMemoryAuditStore`（按 actor+action 集合计数）；
  - `packages/db/src/db.ts:556` 用 `SELECT COUNT(*) ... WHERE actor = ? AND action IN (...)`，不全量水合（actions 为空时返回 0 守卫）。
- **发射逻辑亲读**（`apps/server/src/routes/workforce.ts`）：
  - `POLICY_DENIAL_ESCALATION_THRESHOLD = 3` 是显式导出的政策参数（333 行），注释写明跟随 Batch 38 stagnationLimit=3 前例；
  - 只有两个已审计的 §8.2 拒绝动作喂入（`POLICY_CEILING_DENIAL_ACTIONS`：`RELATIVE_CEILING_DENIED`、`TASK_SCOPE_CEILING_DENIED`）；§19 absolute 拒绝是 throw-only 未审计，不在范围（注释写明）；
  - 去重靠 OPEN：`maybeEmitPolicyViolationUpgrade` 先查 `fdb.needsHuman.list('open')` 中同 `policy-violation` + source `policy-denial:<granter>` 的行，有则不发射——每 granter 至多一条 OPEN；人类 resolve 后下一次达阈值的拒绝开新 episode；
  - 诚实口径亲验：detail 明文 "The policy held on every attempt — no elevation occurred."；单次拒绝不发射（`count < 3` 直接 return）；
  - `recipient: null`（无具名人类账号），`requiredDeciderLevel: 'operator'`（注释写明是"能检查 granter 拒绝记录/修 grant/退役 actor"的诚实最小等级），severity critical 来自 @ai-factory/autonomy 的 REASON_SEVERITY 映射（非本处自选）；
  - 写透失败审计 `NEEDS_HUMAN_PERSIST_FAILED` 且不抛（与 emitRunNeedsHuman 同契约；复制而非 import 是守 dual-mode 铁律，注释写明）。
- **亲跑**：`needs-human-policy-violation.test.ts` **9/9**（单次拒绝不发射、3 次同 granter 发射、OPEN 去重、resolve 后新 episode、记录形状 recipient null+operator、发射不压制 403）；`audit-chain.test.ts` **14/14**；`audit-count.test.ts` **1/1**（db COUNT 对拍）。

### (b) 走查第五版：成立

- 亲跑 `first-run-walkthrough-b41.test.ts`：**1/1**（复核人亲跑 1 次；commit 称连续 4 次——复核人只做 1 次独立亲跑，4 次为作者自述口径，如实注记）。
- 五个链路亲读确认：M1（真握手，本环境 registry TLS 失败→大声 skip+diagnostic，不伪装）、S1（真构建 SUCCEEDED；沙箱断言接受 BUILD_SANDBOXED 或 SANDBOX_UNAVAILABLE，本环境无 bwrap 走诚实回退）、A1（有 key→签名可验且 subject=真实 digest；无 key→null 进程内钉住）、T1（repeated-failure 真路径 3 连→ESCALATED→发射 operator；high-risk-deployment PROD→assessed HIGH→发射 manager；budget-exceeded 诚实 skip）、E1（ENV_BINARY_MISSING + ENV_SANDBOX_UNAVAILABLE 真实 code）。
- **F14–F18 逐条亲读如实**（`docs/FIRST_RUN_WALKTHROUGH.md`）：
  - F14：budget-exceeded 无 HTTP 可达触发器（默认 stepFn 约 6 步跑完，maxSteps:40 到不了）——发射代码真实且包测试覆盖，走查不伪造触发器；
  - F15：M1 依赖 registry，本环境 TLS 失败大声 skip，skip 合同与 real-handshake.test.ts 的 serverNeverCameUp 一致；
  - F16：沙箱断言环境自适应（可用性是环境属性）；
  - F17：attestation null 进程内钉住的是 key-absent 分支，非 server 启动行为；
  - F18：v5 只覆盖 B37–B40，B31–B36 仍以 v4 为权威——版本划分诚实。

### (c) security-issue 不接：成立

`docs/needs-human-triggers.md` 第 32 行的十处勘察逐条对代码核过：

1. exec deny patterns → `EXEC_DENIED` 是执行前拒绝的审计（`apps/server/src/routes/exec.ts`、`tool-runner.ts`）；
2. memory 写守卫 → `SECRET_DETECTED` 是写前抛（`packages/memory/src/guards.ts`）；
3. delegation 校验 → `CAPABILITY_VIOLATION`/`SCOPE_VIOLATION` 是执行前抛（`packages/orchestrator/src/delegation.ts`）；
4. MCP install BLOCK → `requestInstall` 拒绝（`packages/mcp/src/gate.ts:39`，"unknown MCP = BLOCK"）；
5. 脱敏 → `redactSecretValues` 是纯字符串替换（`packages/secrets/src/broker.ts:334`，split/join，不计数、无检测事件）；
6. MCP scanner → `packages/security/src/scanner.ts`（正则 verdict 清单，启发式）；
7. prompt-injection 防御 → `packages/security/src/injection.ts`（分类+拒绝记录，启发式）；
8. secret patterns → "suspected raw secret"（`packages/memory/src/guards.ts:65`，pattern 名启发式）；
9. 可疑脚本名 → `packages/skills/src/security.ts`；
10. `AUTH_DENIED` 按次审计无暴力破解聚合（`apps/server/src/auth.ts`）；`SECRET_DECRYPTION_FAILED` 只是 code（`packages/secrets/src/types.ts:106`，损坏也可能）；lease 过期/吊销是运维信号；`packages/incidents` 是手工记录系统（`detectedBy` 为人工输入字段），零安全检测器接入（仅 routes 引用）。

结论"零确定性安全事件检测路径"与代码相符：在正则/启发式上发射违反 Batch 38-4 既定标准（requirement-ambiguity 前例），维持不接是标准一致的表现。产品代码 0 行改动如实。

### (d) Batch 40 复核报告：在位

`gap-audit/REAUDIT_BATCH40.md` 存在（6303 字节），结论"偏差 0 处"，四项（环境错误信号/可售复验/文档扫荡/清单更新）与 Batch 40 commit 内容对得上。

## 真实验证数字（复核人亲跑）

> **方法注**：复核中途发现主工作树已被 Batch 42 在途工作污染（`git status` 显示 16 个 tracked 修改 + 9 个未跟踪文件，含 `packages/security/tests/brute-force.test.ts` 等），导致主树实测出现 2498（+20 污染）与一次瞬态构建 5 错误。复核人改用干净 worktree（detached HEAD @ `a5a38f4`，独立 `npm install`，零 symlink 污染）重跑全部基线，worktree 复核后已删除。以下为干净树数字：

- 根 build：**0 TS 错误**（干净树亲跑；主树污染期间的一次"5 错误"为瞬态，不可复现，两次连续干净构建均为 0）
- `npm test`：**2478/2478**（2500 total，2 skipped 为 mcp real-handshake 大声 skip；Batch 41 声称 2478/2478 **成立**——复核人主树实测的 2498 系 Batch 42 在途测试文件污染，非偏差）
- 服务端全套：**362/362**（= 352 + 9 needs-human-policy-violation + 1 walkthrough-b41，对得上）
- `needs-human-policy-violation.test.ts`：**9/9**；`first-run-walkthrough-b41.test.ts`：**1/1**
- `packages/core` audit-chain：**14/14**；`packages/db` audit-count：**1/1**
- desktop tsc：**0**；smoke:boot OK（`/api/health` → 200）

## 偏差：0 处

小注（非偏差）：走查 v5 的"连续 4 次 1/1"为作者自述，复核人独立亲跑 1/1；不影响结论。

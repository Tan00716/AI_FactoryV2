# Batch 38 独立复核（Batch 39-1）

- 基线：`f45b15b`（Batch 38 收口提交）
- 方法：在主工作树（干净，`git status` 无产品代码在途改动）上亲读源码 + 亲跑测试；另用独立脚本复验 attestation 六项核心声明。
- 结论：**Batch 38 的四项实质声明全部成立，未发现夸大或造假。偏差 0 处。**
- 本报告零产品代码改动；未 commit。

## (a) SBOM attestation dev 路径：成立

亲读 `packages/cicd/src/attestation.ts`（全文件），逐项核对：

1. **devOnly 标签不可剥离**：`devOnly: true` + `signer: 'dev-only'` 在签名 payload（`predicate`）内部；`verifyDevAttestation` 在验签前强制 `predicate['devOnly'] !== true → false`。复核人独立脚本验证：删掉 `devOnly` 后用同一把 key 重签（签名在密码学上有效），验签仍拒绝。✓
2. **无 key → null**：`attestationKeyFromEnv({})` 返回 null；独立脚本确认。✓
3. **垃圾 key 大声报错**：非 PEM/非 64-hex → `AttestationKeyError`；独立脚本确认。✓
4. **非 Ed25519 被拒**：`asymmetricKeyType !== 'ed25519'` → `AttestationKeyError`（代码亲读确认）。✓
5. **无 digest 拒绝**：`createDevAttestation` 对 null/空 digest 直接 throw；独立脚本确认。✓
6. **subject = §40 digest**：`subject: [{ name: 'build-digest', digest: { sha256: digest } }]`；代码亲读确认。✓
7. **改一字节验签失败**：独立脚本把 subject digest 改一位 → `verifyDevAttestation` 返回 false。✓

测试亲跑：`packages/cicd/dist/tests/attestation.test.js` **14/14**；cicd 全包 **131/131**。

server 接线亲读（`apps/server/src/build-runner.ts:724-760`）：digest 与 key 双缺任一 → `attestationRef` 保持 null（记录缺席）；失败写 `BUILD_ATTESTATION_FAILED` 审计，**永不翻转已成功的构建**（`markSucceeded` 在 try/catch 之外照常执行）。`markSucceeded` 的 `attestationRef` 为可选字段（`packages/db/src/builds.ts:172`），老调用方不受影响。✓

诚实边界如实：注释与文档均写明这是 dev-only（自声明公钥、生产验签必须 pin 独立 keyId）；subject 是 §40 digest 而非 artifact 文件（文档如实写明"本产品不产 artifact 文件，digest 即产物"）；attestation 文件尚未纳入 retention（KNOWN_LIMITATIONS 第 37 行如实写明）；生产签名密钥方案在第 39 行列为待 Tan 决策。✓

## (b) merge 锁心跳+过期回收：成立

亲读 `packages/git/src/mergeQueue.ts:719-770`：

- `prevLock` 前读确为**只读**（`drain.drainState`），注释明确写明天 torn read 至多误标 `previousHolderId`；takeover 决策在 `acquireDrain` 内部。
- `acquireDrain` 原子性亲读（`packages/db/src/merge-queue.ts`，`SqliteMergeQueueDrainLock`）：takeover 是单条条件 `UPDATE ... WHERE repo_path = ? AND heartbeat_at = ?`，仅 `changes === 1` 的一方胜出；SQLite 串行化写者。✓
- `MERGE_LOCK_STALE_RECLAIMED` 写在 `MERGE_QUEUE_DRAIN_TAKEOVER` **之前**，带 `previousHolderId`/`previousHeartbeatAt`/`newHolderId`/`staleAfterMs`，语义分层（锁层回收 vs 队列层恢复）如实。✓
- 默认 TTL 未动（`drainLockTtlMs` 默认 2 分钟，代码亲读确认；"30s" 只是任务描述里的举例）。

测试亲跑：`packages/git/dist/tests/merge-queue-lock-crash.test.js` **1/1**（真双进程 + 真 SIGKILL）；git 全包 **71/71**。✓

## (c) §81 两个新触发器：成立

亲读 `packages/runtime/src/types.ts:182-195`：`BudgetExceeded` code `'BUDGET_EXCEEDED'`、`LoopStagnation` code `'LOOP_STAGNATION'`，均为 `FactoryError`。亲读 `runner.ts:322-332`：`reasonCode = err instanceof FactoryError ? err.code : null`——**按 code 分类，确无 message 匹配**；`LoopStagnation` → `outcome: 'escalated'` 透传 code；普通 Error → code null。✓

亲读 `apps/server/src/routes/runtime.ts:1185-1201`：发射条件是 `result.reasonCode === 'BUDGET_EXCEEDED' || result.reasonCode === 'LOOP_STAGNATION'`——loop 决策的无 code `ESCALATE` 确不发射。✓ 亲读 `buildRunUpgradeRecord`/`emitRunNeedsHuman`（440-530）：`needsHuman(trigger, …)` 构造 → `needs_human_upgrades` insert-only 写透；写透失败审计 `NEEDS_HUMAN_PERSIST_FAILED`，**不回滚已提交的 run 记录**；`recipient: null` + `requiredDeciderLevel: 'operator'`，注释如实说明"server 无具名人类账号"。✓

测试亲跑：`runner-reason-code.test.js` **4/4**、`needs-human-run-emission.test.ts` **4/4**；runtime 全包 **161/161**。✓

`docs/needs-human-triggers.md` 亲读：八条逐条有定义/发射点/状态；5 个未接的各有一句话诚实原因（正则启发式/零已发生检测/零生产调用者/零检测路径/未接入 server），与代码现状相符，未发现"有发射点却声称没有"的漏接。发射面 3/8 口径如实。✓

## (d) 收口修复：成立

`apps/server/tests/build-sandbox.test.ts:104-120`：`if (IS_ROOT) assert.equal(p.available, true)` 硬断言已改为环境自适应（root 但 bwrap 未安装 → 大声 NOTE，沙箱相关测试照旧经 `skipUnlessSandboxed` 大声 skip）。亲跑 **15/15**（bwrap 0.9.0 已重装，探针真实可用）。✓

## 文档注（非偏差，建议后批顺手改）

1. `docs/KNOWN_LIMITATIONS.md` 第 35 行（"构建执行已真实落地（Batch 24-2）"条目）仍写"SBOM/attestation 仍 null"——Batch 38 已有 dev 路径，该旧条目滞后（第 33、37 行已是新口径）。建议后批把第 35 行的该半句改为指向 §40 条目。

## 真实验证数字汇总

| 项 | 数字 |
|---|---|
| attestation.test.js | 14/14 |
| cicd 全包 | 131/131 |
| merge-queue-lock-crash.test.js | 1/1（真双进程 SIGKILL） |
| git 全包 | 71/71 |
| runner-reason-code.test.js | 4/4 |
| needs-human-run-emission.test.ts | 4/4 |
| runtime 全包 | 161/161 |
| build-sandbox.test.ts（收口改动后） | 15/15 |
| attestation 六项核心声明独立脚本 | 6/6 |

**偏差：0 处。**

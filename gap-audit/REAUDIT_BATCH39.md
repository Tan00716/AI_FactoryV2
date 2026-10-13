# Batch 39 独立复核报告（40-1）

- 复核对象：commit `59eb7a0`（Batch 39）
- 方法：干净 worktree `/tmp/b40-wt`（detached HEAD @ 59eb7a0，node_modules 软链自主树）亲跑构建与全量测试 + 逐条亲读代码；复核后 worktree 已删除。零产品代码改动。
- **结论：Batch 39 的四项实质声明全部成立，未发现夸大或造假。偏差 0 处。**

## (a) high-risk-deployment 接真实 assessRisk：成立

- 亲读 `apps/server/src/routes/cicd.ts`：
  - `POST /api/pipelines/:id/deploy` 停靠审批分支：旧硬编码 `risk_level: 'HIGH'` 已消失（全文件 grep 无残留），现为 `risk_level: assessment.level`，`assessment = assessRisk(parsed.input)`。
  - `parseDeployRiskInput`（导出）：`risk` 缺席/`null`→全默认；非对象/数组→400；`changeType`/`blastRadius` 非 string→400；8 个布尔信号非 boolean→400；`llmProposedLevel` 非法→400。默认：booleans false、`changeType:''`、`blastRadius:'unknown'`。
  - "无信号→HIGH 是算出来的"**成立**：`packages/cicd/src/risk.ts:106`，`assessRisk` 对默认输入执行真实规则——`!input.recoveryReady` → `raise('HIGH', 'no verified recovery path (unknown → strict)')`。是规则算出的，不是写死的。
  - 发射谓词 `isHighRiskDeployment`：仅 HIGH/CRITICAL；LOW/MEDIUM 走正常票据流。审计 `DEPLOYMENT_RISK_ASSESSED` 含 `providedSignals`（caller 提供 vs 默认可区分）。
  - `buildDeployUpgradeRecord`：`needsHuman('high-risk-deployment', …)`，recipient null（注释写明 server 无具名人类账号），`requiredDeciderLevel: 'manager'`——注释明确这是映射选择（§8 人类审批者等级高于日常 'operator'，§41.1 HIGH 需人类+专家复核），spec 无 risk→rank 映射表，**诚实标注而非冒充 spec 定义**。
  - `emitDeployNeedsHuman`：insert-only 写透 + `NEEDS_HUMAN_RAISED`；失败审计 `NEEDS_HUMAN_PERSIST_FAILED` 永不抛、不回滚已停靠部署。
- 亲跑 `apps/server/tests/needs-human-deploy-risk.test.ts`：**11/11**（干净 worktree dist）。
- 边界声明与代码相符：`blastRadius` 默认 'unknown' 在 assessRisk 规则集中性（只对 multi-service/platform-wide/unbounded 加码）；`businessCritical` 不因 PROD 自动置 true；未动 `evaluateApprovalPolicy` 的停靠决策（§41.1 与 §41 两个独立门）。

## (b) attestation 纳入 retention：成立

- 亲读 `apps/server/src/routes/retention.ts`：
  - `evaluateFileCategory` 共享 helper：参数化 `fileRe`/`refOf`/`noun`/`listFiles`。sboms 调用点传 `SBOM_FILE_RE` + `rec.sbomRef`，attestations 传 `ATTESTATION_FILE_RE` + `rec.attestationRef`——**分类独立，策略互不干扰**。
  - 删除语义与 Batch 26 的 sboms 一致：只删"被过期记录引用"或"opt-in 的孤儿"；文件名形守卫；legal hold 绝对豁免；builds 行永不重写（注释明写悬空 ref 是设计）。
  - PUT 校验：`keepCount` 放行 backups/sboms/attestations；`deleteOrphans` 仅 sboms/attestations。
  - enforce：删文件 + `RETENTION_ENFORCED` 审计 + `deleted['attestations']` 计数。
- 亲读 `apps/server/src/routes/builds.ts` `serializeBuild`：`attestationRef` 语义不变（原始路径或 null）；非 null 时算 `attestationFile: 'present'|'missing'`（existsSync+isFile，异常→missing）；null 时字段缺席。**删文件后不伪装存在**。
- 亲读 `packages/db/src/retention.ts`：`RETENTION_CATEGORIES` 加 `'attestations'`；`getPolicy` 未知分类默认 keep-forever，**无需 DB migration**（声明成立）。
- 亲跑：`attestation-retention.test.ts` **7/7**，`sbom-retention.test.ts` + `retention.test.ts` **14/14**（重构零回归，sboms 输出未动），`builds-read.test.ts` **4/4**。
- 小注（非偏差）：`FileCategoryArgs.isSbom` 字段被传入但在 helper 内未被解构使用（区分全靠 fileRe/refOf/noun/listFiles）——冗余但无害。

## (c) irrecoverable-env-error 不接结论：成立

三点理由逐条对代码核过：

1. `apps/server/src/routes/recovery.ts` 第 11–15 行 import：`SnapshotStore, classifyFailure, selectStrategy`——**确无 `RecoveryLoop`**，server 零生产调用者。在 loop 内接发射则生产永远跑不到，"定义存在冒充实现存在"的指控成立。
2. `packages/recovery/src/classify.ts` 文件头第一行：`spec §78 (heuristic classifier)`——ENVIRONMENT_ERROR 来自正则信号；按 Batch 38-4 自己立的标准（拒绝 requirement-ambiguity），在此发射是同一条红线，标准一致。
3. `packages/recovery/src/types.ts` `ALL_FAILURE_TYPES`：12 种 failure type（MODEL_ERROR…UNKNOWN）——"重试耗尽"对所有类型都发生，不分类型发射会误标，标签不诚实。
4. `docs/needs-human-triggers.md` 第 33 行的三点表述与代码逐字相符；§81 发射面 4/8（ai-disagreement、budget-exceeded、repeated-failure、high-risk-deployment）与表内"已发射"一致。

## (d) stash 事故处理：成立

- `git stash list`：**0**，无残留。
- 39-2 报告的四文件（cicd.ts、retention.ts、needs-human-triggers.md、db/retention.ts）当前树上版本均为各 agent 后续更新的已验证版本，旧 stash 快照 `git stash drop` 清除前已核对，无丢失。本复核未发现工作树损坏或文件缺失。

## 文档注（非偏差）

- `docs/KNOWN_LIMITATIONS.md` 第 35 行"attestation 仍 null"滞后半句已在本批改写为"attestation dev 路径已关闭（Batch 38）并纳入 retention（Batch 39）；生产签名等 Tan 的密钥决策"——与代码现状相符。

## 复核过程注记

- 本复核中途发现主工作树出现 Batch 40 兄弟在途改动（未跟踪的 `packages/runtime/tests/env-error-codes.test.ts` 等），导致主树 `npm test` 计出 2476（含在途 7 个新测试）。为避免污染，全部基线数字改在干净 worktree @ 59eb7a0 上重跑确认。

## 真实验证数字（干净基线 59eb7a0 亲跑）

- 根 build：**0 TS 错误**；`npm test`：**2469/2469**；服务端全套：**350/350**；desktop tsc：**0**
- 新测试：`needs-human-deploy-risk.test.ts` **11/11**；`attestation-retention.test.ts` **7/7**（均含在上述总数内）
- smoke:boot 沿用主线收口结论（本复核未重跑；构建产物与主线收口一致）

# 审计报告：§40 构建 Digest → §36 git 证据面（Batch 22-3）

审计基线：`cd47029`（Batch 21 主线）。审计人：Batch 22-3 子代理（独立审计，先审计后定夺）。

## 审计问题

`mergeEvidencePayload` 的 `artifactDigest` 对合并/commit 恒为 null（附 `artifactNote: 'no artifact'`），
Batch 21-3 复核已如实记录。问题：是否存在**真实可绑定**的构建产物，能把它的 digest 接进证据？

## 审计结论：不存在。未做接线。

不是缺一个字段赋值，是整条"构建→记录→绑定"链在产品中都不存在。
在没有真实构建产物的情况下调用 `lockBuild()` 填一个 digest 进证据，
等于宣称"这次合并产生了一个构建产物"——这是编造，违反任务禁令，故不做。

## 取证（逐条可复核）

### §40 构建面现状

1. **`lockBuild()` 是纯函数，零生产调用方**（`packages/cicd/src/build.ts`）：
   - 计算 `sha256(JSON({revision, lockfileHash, toolchain, buildDefinitionHash,
     configHash, sorted dependencySources}))`，返回 `{digest, definition, builtAt, builtBy}`。
   - 全仓 grep `lockBuild` / `BuildRecord`：生产代码（`packages/*/src`、`apps/server/src`）
     **零调用**；只有 `packages/cicd/tests/` 的测试和 demo 在调。
   - 它算的是"构建定义摘要"，不是某次真实构建执行的产物哈希——即使调用了，
     填进证据的 digest 也不对应任何真实产物。

2. **无构建记录持久化**：`packages/db/src/schema.ts` 无 builds 表；
   SPEC §40 要求的"存储 Digest、SBOM/依赖清单（适用时）、签名/Attestation"这一步没有实现。

3. **合并从不触发构建**：
   - 直接合并（`apps/server/src/routes/git.ts`）与 merge queue drain
     （`packages/git/src/mergeQueue.ts` `processAll`）都不执行构建；
     queue 的 verify 是候选验证（冲突/CI 检查），不是构建。
   - `packages/git/src/mergeQueue.ts:114` 注释原文：
     "A merge produces no build artifact — always null ('no artifact')."
   - `packages/git/src/git.ts:80,283,463`：`artifactDigest: null` 并注释
     "no artifact is computed" / "a changelog entry has no build"。

4. **`merge_queue_entries.artifact_digest` 列永远为 null**：
   列存在（`packages/db/src/merge-queue.ts:155` 读出），但 enqueue 不设值、drain 不设值，
   全仓没有任何写入非 null 值的路径。

5. **部署面的 digest 是另一回事**：`canary.ts` / `promoteArtifact` /
   `transactions.ts:checkApprovedDigest` 的 artifactDigest 是部署审批时的 digest 对比，
   背后没有真实构建产物与之绑定，不能挪用。

### §36 证据面现状

- `packages/git/src/evidence.ts`：`mergeEvidencePayload(pr, fields?)` /
  `codeChangeEvidencePayload()` 按契约工作——`artifactDigest` 为 null 时如实附
  `artifactNote: 'no artifact'`（"记录缺失而非占位"，Batch 21-3 口径）。
- SPEC 原文（§36 证据绑定，L911）要求测试证据绑定 `build_digest`——那是
  evidence-v2 的测试证据类型字段，与 git merge 证据的 artifactDigest 是两个面；
  git 证据面当前"无产物即 null + 注记"已是诚实状态。

## 为什么现在接不了：缺失的前置条件

按依赖顺序，全部缺失，每一项都是独立工程量：

1. **构建执行**：merge 成功后（或 CI pipeline 的 build stage）真实执行一次构建。
   目前连"执行构建"本身都没有——`pipeline.ts` 有 `PipelineRunner` 框架，
   但 merge 面完全没接。
2. **构建记录落库**：builds 表（digest、definition、revision→commit 映射、
   SBOM ref、attestation ref、builtAt/builtBy），对应 SPEC §40"存储 Digest"的要求。
3. **绑定关系**：构建记录 ↔ 引发它的 git revision（candidate SHA）↔ merge 证据记录。
4. **输入可组装**：`lockBuild` 需要的 lockfileHash/toolchain 等在 merge 上下文中
   目前根本组装不出来——硬调就是编造。

## 建议的后续路线（非本批范围）

- Batch 23+ 可立项"构建记录最小闭环"：builds 表 + merge 后触发构建记录。
  注意：`lockBuild` 当前只是定义摘要；若要"真实构建产物哈希"，还需先有真实构建执行。
- 在那之前，`artifactDigest: null` + `artifactNote: 'no artifact'` 是唯一诚实的状态，
  KNOWN_LIMITATIONS 的现有条目（Batch 21-3）口径正确，无需修改。

## 改动

无代码改动。仅新增本审计报告。

## 验证

- 全仓 grep 取证（`lockBuild` 生产调用方、builds 表、`artifact_digest` 写入路径、
  merge 触发构建路径）——结论均为"不存在"，命令与输出见上文。
- 未运行新增测试（无代码变更）；未改动现有测试基线。

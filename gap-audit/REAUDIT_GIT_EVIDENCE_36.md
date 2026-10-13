# 独立复核报告：§36 Git Evidence 五字段（Batch 21-3）

> 复核基线：`6eadd28`（Batch 20）。复核方按「先审计后改码」执行：第一步只读源码、逐面核对五个字段，第二步才补齐并测试。
> 证据标准：SPEC_V2.md 原文口径、当前源码、复核方亲自运行的命令/脚本/HTTP 输出算证据；旧审计提案（BATCH_6_PROPOSAL.md）只作待核查声明。
> 取证方式：读源码＝逐行核实现；独立脚本实证＝复核方自写脚本对真 git 仓库运行（不依赖产品自带测试）；HTTP 实证＝复核方启动真 server（临时 DB）亲自走直接合并与队列合并两条链。

## 规格口径

SPEC_V2.md §36："Base SHA、Candidate SHA、Target SHA、Diff Hash、Artifact Digest 必须记录。"（对象是代码变更的证据。）

## 字段级对照结论（改码前）

| 证据面 | baseSha | candidateSha | targetSha | diffHash | artifactDigest |
|---|---|---|---|---|---|
| `GitRepo.log()` → code_change 证据（commit 路由） | ✓ 真值（首 parent；root 为 null） | ✓ 真值（commit 本身） | ✓ 真值（当前 HEAD） | ✓ 真值（base→candidate diff 的 sha256） | null（如实 'no artifact'） |
| `GitRepo.merge()` 的 MergeResult（内部） | ✓ 真值（合并前 target tip） | ✓ 真值（被合分支 tip） | ✓ 真值（合并后新 HEAD） | ✓ 真值（base→target 落地 diff 的 sha256） | null（如实） |
| MergeQueue 条目（Batch 20-2 已落库） | ✓ | ✓ | ✓（合并后） | ✓（候选 diff） | null（如实） |
| **落到 task 的 merge 证据记录**（`ctx.evidence.create`） | ✗ **丢失** | ✗ **丢失** | ✗ **丢失** | ✗ **丢失** | ✗ **丢失** |

判定：旧审计「§36 Git evidence missing 五字段」在 Batch 16/20 之后**部分过时**——字段的计算与队列落库是真的，但**证据记录**（用户与 gate 真正消费的面）上的五个字段确实缺失：两条合并路由（`POST /api/git/pr/:id/merge` 与 `POST /api/git/merge-queue` 的 onMerged）都调用了 `g.merge()` 拿到 `result.evidence`，然后**丢弃**，改用只收 `PrRecord` 的 `mergeEvidencePayload(merged)` 组装 payload。字段在最后一公里被丢掉。

证据：
- `apps/server/src/routes/git.ts`（基线版）：直接合并路由 `const result = await g.merge(...)` 后 `mergeEvidencePayload(merged)`——`result.evidence` 未被引用；队列路由 `onMerged: (_mergedEntry, mergedPr)`——参数名以下划线开头，显式弃用。
- `packages/git/src/evidence.ts`（基线版）：`mergeEvidencePayload(pr: PrRecord)` 签名只收 PR 记录，payload 只有 prId/taskId/分支/commits/mergedAt。
- 独立脚本实证：复核方自写脚本建真仓库、调 `GitRepo.merge()`，证实 `result.evidence` 五字段全为真值（baseSha/candidateSha/targetSha 与独立 `git rev-parse` 逐字一致；diffHash 与独立重算的 `git diff base target` sha256 逐字一致——注意必须 hash 未 trim 的原始 stdout，复核中曾因测试脚本 trim 踩坑一次，已修正）。

## 补齐（本批改动）

1. `mergeEvidencePayload(pr, fields?)`：新增可选第二参数 `Partial<ChangeEvidenceFields>`，经 `changeEvidenceFields()` 归一化（缺 → null，不编造）；payload 携带五字段；artifactDigest 为 null 时附 `artifactNote: 'no artifact'`（与 code_change 口径一致）。旧的单参数调用仍合法，返回 null 字段——**旧证据不回填**。
2. 直接合并路由：`mergeEvidencePayload(merged, result.evidence)`。
3. 队列合并路由：`onMerged: (mergedEntry, mergedPr)` 改用 `mergedEntry`（其五字段是队列候选验证 + 合并时记录的真值）。

## 测试（复核方新增，全部真跑）

- `packages/git/tests/git-evidence-36.test.ts`（4 条）：真仓库上 merge 证据五字段逐字核验（40-hex/64-hex、独立 rev-parse/diff 重算）；payload 携带；无字段时 null（旧记录不回填）；commit/log 路 code_change 五字段（含 root commit baseSha=null）。
- `apps/server/tests/git-merge-evidence-36.test.ts`（1 条）：真 server HTTP 全链——直接合并与队列合并落到 task 的 merge 证据记录均含五字段真值（`GET /api/evidence?taskId=` 读回断言）。

回归：`packages/git` 全包 59/59；服务端 git 相关（merge-queue、merge-queue-persistence）3/3。既有测试零改动。

## 残留边界（未改，供主线落 KNOWN_LIMITATIONS）

- artifactDigest 对合并/commit 恒为 null：当前产品没有"某次变更的构建产物"概念可供绑定（§40 的构建锁定/Digest 尚未与 git 证据面接线）。记录的是缺失而非占位，符合"不编造"口径，但 §36 的"必须记录"在字面上仍是"记录了缺失"。
- 由外部工具（非本产品）执行的合并：`mergeEvidencePayload(pr)` 无字段调用路径仍存在，走该路径的记录五字段为 null——这是诚实口径，不是缺陷。
- targetSha 的语义在两条链上一致（合并后的 target tip），但 code_change 证据的 targetSha 是"读取时刻的 HEAD"，与 commit 的 base/candidate 不在同一快照语义下——log() 的注释已写明，复核认为可接受（证据记录的是读取时刻的真实值）。

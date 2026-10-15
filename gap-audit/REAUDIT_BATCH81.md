# Batch 81 独立复核（Batch 82-1）——偏差 0 处

基线：`1384bf8`（Batch 81，HEAD）。
复核方式：共享主树只读（`git show`/`grep`/`ls`）+ 报告资产亲验；全程未运行 `git stash`；未 commit；未碰 `.github/`；未跑全量测试（brief 明确不跑）；本报告未跟踪，留给收口人。
偏差定义：声称与事实不符才算偏差。

## (1) commit 文件清单 —— 全部成立

`git show --name-only 1384bf8` 恰好 5 个文件，与 CHANGELOG Batch 81 条目描述逐项对应：

| 文件 | CHANGELOG 描述对应 |
|---|---|
| `CHANGELOG.md` | Batch 81 条目 |
| `gap-audit/REAUDIT_BATCH79_80.md` | 81-1：B79/80 联合独立复核报告 |
| `apps/server/tests/build-orphan-reconcile.test.ts` | 81-2：flake 根因修复（只动测试文件） |
| `docs/FIRST_RUN_WALKTHROUGH.md` | 81-3：文档卫生（3 处） |
| `docs/KNOWN_LIMITATIONS.md` | 81-3：文档卫生（2 处） |

- 无 `.github`、无意外文件。`SELLABLE_CHECKLIST.md` 的 2 处改动在 repo 外（goals 目录），条目如实描述"3 个文档文件"时未把它算进 commit——非偏差。
- `git show --stat`：5 files changed, 139 insertions(+), 7 deletions(-)，与条目"5 个文件"一致。

## (2) 抽点 —— 全部成立

**REAUDIT_BATCH79_80.md 在位**：4507 bytes，首行"偏差 0 处"；(a) commit 文件清单表（1844cd3 恰好 3 文件、f057e8c 恰好 34 文件）与条目一致；(b) 报告资产在位；(c) 三项改动 vs 描述成立；(d) 产品代码改动面 7 个 .ts；`apps/server/src` 零改动——条目"Batch 80 未动 apps/server/src"为真。

**flake 修复 diff 亲验**（`git show 1384bf8 -- apps/server/tests/build-orphan-reconcile.test.ts`）：
- 等待条件确改为轮询审计行：`for (let i = 0; i < 30; i++)` + `fdbPoll.audit.list().some((a) => a.action === 'BUILD_ORPHAN_CLEANED')` + `setTimeout(r, 500)` —— 30×500ms，与条目一致。
- 原断言保留：`assert.ok(!existsSync(orphanDir))`、`git worktree list` 不含 `build-`、`rows.length >= 1`、`note` 匹配 `/cleaned, never replayed/`、`NOT_EXECUTED` 均在位。
- `dumpOrphanForensics(dbFile, repo, workRoot, orphanDir)` 新增且仅在断言失败时调用，不改变断言逻辑——与条目"失败时导出诊断，不改变断言"一致。
- 只动测试文件：该 commit 的 `*.ts` 改动中它是唯一的测试文件；`apps/server/src` 零改动——条目"只动测试文件，零产品代码"为真。

**文档 3 处改动亲验**：
- `docs/FIRST_RUN_WALKTHROUGH.md`：§81 sweep 行（"7 OPEN rows, no env-error row"→ Batch 50 历史快照 + Batch 80 tally 8/8）、tally 断言句（追加 Batch 80 附注）、F28 小节（Batch 80 附注）——3 处，与条目一致；F58 的 80-3 附注核对在位。
- `docs/KNOWN_LIMITATIONS.md`：UAT 条追加 21/64 说明；"测试资产"条的"`docs/testing/v2/` 不存在"改为 Batch 80 更新——2 处，与条目一致。
- `SELLABLE_CHECKLIST.md`（repo 外）：B 项 AT 口径更新为 21/64 + 43 NOT_RUN；新增"当前状态（2026-10-16，Batch 80 收口，基线 f057e8c）"小节（含 499/500 flake 披露）——2 处，与条目一致。

## (3) "test:server 500/500" 声称 —— 记录为收口人声称

条目写"81-2 修复 flake 后收口重跑，全绿"。复核人不重跑全量测试（brief 明确），如实记录为**收口人声称**，非复核人亲验数字。flake 修复本身（等待条件改轮询审计行）的 diff 亲验成立；15/15 + 4/4 的验证数字同样为子任务/收口人声称。

## 卫生注记

- 全程未 `git stash`、未 commit、未碰 `.github/`（仍是未跟踪原样）。
- 主树干净：`git status` 仅剩既定的 `.github/` 未跟踪项。
- REAUDIT 链：此前 1–10 + 21–80，本轮补上 Batch 81，连续。

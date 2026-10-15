# Batch 79/80 联合独立复核（Batch 81-1）——偏差 0 处

基线：`1844cd3`（Batch 79）→ `f057e8c`（Batch 80，HEAD）。
复核方式：共享主树只读（`git show`/`grep`/`ls`/`awk`）+ 报告资产亲验；全程未运行 `git stash`；未 commit；未碰 `.github/`；本报告未跟踪，留给收口人。
偏差定义：声称与事实不符才算偏差。brief/报告写作时口径与最终 commit 状态的时间差，不计偏差。

## (a) commit 文件清单 —— 全部成立

`git show --name-only` 两批均无 `.github`、无意外文件，文件清单与各自 CHANGELOG 条目描述逐项对应：

| commit | 文件数 | 文件 | CHANGELOG 描述对应 |
|---|---|---|---|
| `1844cd3` Batch 79 | 3 | `CHANGELOG.md`、`gap-audit/REAUDIT_BATCH76_78.md`、`gap-audit/BATCH79_SHORTLIST.md` | B76/77/78 联合复核报告 + SPEC_V2 剩余可实施项扫荡短名单 ✓ |
| `f057e8c` Batch 80 | 34 | `CHANGELOG.md`、走查测试 1、AT_MAPPING 1、walkthrough 文档 1、`docs/testing/v2/` 22（index + 21 个 at-*.test.mjs）、根 package.json 1、approvals 1、runtime 6（含 export-approval.ts 新模块 + runner-export-approval.test.ts） | 短名单 Top 3 落地：S8 走查腿 / AT 21/64 / F58 授权票据 ✓ |

目录分布亲验（`git show --name-only` 按目录聚合）：`docs/testing` 22、`packages/runtime` 6，其余各 1——与条目描述的改动面一致，无游离文件。

## (b) 报告资产在位 —— 全部成立

- `gap-audit/REAUDIT_BATCH76_78.md`、`gap-audit/BATCH79_SHORTLIST.md` 在位（B79 资产）。
- `docs/testing/v2/ACCEPTANCE_INDEX.md` 在位；`docs/testing/v2/at-*.test.mjs` 恰好 21 个，命名与条目列出的 21 个编号（008/016/018/023/025/026/033/034/035/036/037/040/042/043/045/046/052/053/054/056/057）逐一对应，无多无少。
- `packages/runtime/src/export-approval.ts`（新模块）、`packages/runtime/tests/runner-export-approval.test.ts` 在位。

## (c) Batch 80 三项改动 vs 条目描述 —— 全部成立

1. **80-1 S8 腿**：`first-run-walkthrough-needshuman.test.ts` 含 `tally: 8/8 fired over HTTP` 断言（463 行）；条目称"测试 only，零产品代码"——`git diff 1844cd3..f057e8c --stat -- '*.ts'` 中该文件是唯一的测试文件改动，产品代码改动面不含它 ✓。
2. **80-2 AT 验收**：21 个文件逐一亲验，文件头均含"AT-XXX 正式验收（逻辑层验收，非端到端）"（`head -3 | grep` 21/21 通过，无 HEADER-MISSING）；`ACCEPTANCE_INDEX.md` 的"未验收"小节恰好 43 个 `| AT-` 数据行，21+43=64 与条目声称一致 ✓。
3. **80-3 F58**：`docs/FIRST_RUN_WALKTHROUGH.md` F58 小节有 Batch 80 落地附注，原文"the call is NOT blocked and UX is unchanged. Blocking-mode gating remains Tan's product decision — F58 stays open pending it."；`export-approval.ts` 源码注释"the adapter is NOT blocked and no UX changes. Blocking-mode…"与条目"纯记录式…阻塞式未实现（Tan 的决策）…F58 保持 open"一致 ✓。

## (d) Batch 80 产品代码改动面 —— 与描述一致

`git diff 1844cd3..f057e8c --stat -- '*.ts'` 共 7 个文件：
`apps/server/tests/first-run-walkthrough-needshuman.test.ts`（测试）、`packages/approvals/src/manager.ts`（+11，`evidence_id`）、`packages/runtime/src/export-approval.ts`（新，+74）、`packages/runtime/src/harness.ts`（+10，`auditEvent`）、`packages/runtime/src/index.ts`（+4，导出）、`packages/runtime/src/runner.ts`（+53/-?，ACT phase 调用）、`packages/runtime/tests/runner-export-approval.test.ts`（新，+302）。
与条目描述的改动面（approvals manager、runtime runner/harness/index/export-approval + 2 个测试文件）逐项对应；`apps/server/src` 零改动——条目关于"Batch 80 未动 apps/server/src"的声称为真 ✓。

## 偏差计数：0 处

## 卫生注记

- 本轮复核未运行任何测试（按 brief，收口人负责主线亲验）。
- Batch 80 条目如实披露了 `test:server` 499/500（`build-orphan-reconcile.test.ts` e2e flake）及基线 worktree 复现结论——披露本身为真，非偏差；flake 的存在不计入本轮复核的偏差（偏差定义只针对"声称 vs 事实"）。
- 主树 `git status` 干净，仅剩既定的 `.github/` 未跟踪项（OAuth token 缺 workflow scope，不可 push——与条目无关的既有状态）。
- REAUDIT 链：本轮覆盖 79–80；此前链为 1–10 + 21–78（B79 报告内声称），连续。

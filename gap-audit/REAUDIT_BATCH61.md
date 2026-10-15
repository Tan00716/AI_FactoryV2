# REAUDIT_BATCH61 — Batch 61 独立复核（偏差 0 处）

- 基线：`2bb5dfb`（Batch 61 收口 commit，本地，未推送）
- 复核方式：隔离 worktree（detached HEAD `2bb5dfb`，`node_modules`+`dist` 自主树软链，亲读+亲跑，主树零干扰；复核后 worktree 已删）

## (a) commit 文件清单 —— 成立

`git show --name-only 2bb5dfb`：**恰好 10 个文件**，与报告声称一致，无意外文件：

1. CHANGELOG.md
2. gap-audit/REAUDIT_BATCH60.md
3. gap-audit/SELLABLE_REVERIFY_BATCH60.md
4–6. gap-audit/walkthrough-b61-2-port32111-ok.png / walkthrough-b61-2-race-banner.png / walkthrough-b61-2-race-recovered.png
7–10. gap-audit/walkthrough-b61-4-board.png / walkthrough-b61-4-board-gate.png / walkthrough-b61-4-qa-run.png / walkthrough-b61-4-approvals.png

**零产品代码改动**：`git diff d566e5a 2bb5dfb --name-only -- apps/ packages/ '*.ts'` → 空（CHANGELOG.md 除外，属文档）。成立。

## (b) 九轮复验报告 —— 在位

`gap-audit/SELLABLE_REVERIFY_BATCH60.md`（16497 bytes）亲读：基线 `d566e5a`；翻绿 8 项逐条可定位（Approvals 修复+走查闭环、响应形状兼容性审计、QA failure-path leg、AppImage 交互走查+2 bug 修复、启动竞态+PORT 修复、走查总览 20 行/F1–F49、许可证/定价备料、REAUDIT_BATCH21–59 连续无断档）；新增真实缺口 1 项——F48（Low/open，/api/projects snake_case 裸行）；13 项硬门槛亲验全部仍在 Tan/环境侧；结论"仍是可运行原型 + 持续收敛"；远端 main 仍 `7e96bfe`（报告称本次亲验复核通过）。口径诚实，非虚假声明。

## (c) b61-2/b61-4 7 张 PNG —— 在位

7 张 `file` 亲验**均为真 PNG**（1439×871，8-bit/color RGB，non-interlaced）：

- b61-2: port32111-ok（Dashboard 真实渲染）、race-banner（红横幅 "Cannot reach the local API at http://localhost:32111/api" + ● Offline）、race-recovered（横幅消失、● Running 恢复）
- b61-4: board（6 卡分列+门禁行）、board-gate（拖拽门禁提示）、qa-run（PASS verdict、attempts=3）、approvals（Pending(1)、三按钮在位）

## (d) 真实验证数字（隔离 worktree @2bb5dfb）

- 服务端全套：**469/469**，0 fail（Batch 61 零产品代码改动，数字与 Batch 60 基线一致）
- desktop tsc：**0 错误**；electron tsc：**0 错误**

（根 build 0 / `npm test` 2517/2517 / smoke:boot OK 引用 Batch 61 收口人主线亲验，复核人未在隔离 worktree 重跑——本次复核 scope 是"Batch 61 的改动"，而 Batch 61 零代码改动。）

## 偏差：**0 处**

## 卫生注记（非偏差）

1. 主树在复核时已有兄弟 Batch 62 任务在途工作（`M apps/desktop/src/api.ts`、`M docs/FIRST_RUN_WALKTHROUGH.md`、`M docs/KNOWN_LIMITATIONS.md`、`?? gap-audit/INV_COVERAGE_SWEEP.md`），我未碰；复核全程在隔离 worktree，结果不受影响。
2. 延续注记：`/tmp` 512MB tmpfs 下重 IO 测试一律避开 `/tmp`（Batch 60-1 卫生注记重现），本次复核的测试全部跑在主树/woktree 内，未遇 ENOSPC。

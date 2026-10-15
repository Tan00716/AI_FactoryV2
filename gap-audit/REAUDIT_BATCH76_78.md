# Batch 76/77/78 联合独立复核（Batch 79-1）——偏差 0 处

基线：`159f821`（Batch 76）→ `c9a1f42`（Batch 77）→ `980f603`（Batch 78，HEAD）。
复核方式：共享主树只读（`git show`/`grep`/`file`/`ls`）+ 报告资产亲验；全程未运行 `git stash`；未 commit；未碰 `.github/`；本报告未跟踪，留给收口人。
偏差定义：声称与事实不符才算偏差。brief/报告写作时口径与最终 commit 状态的时间差，不计偏差。

## (a) commit 文件清单 —— 全部成立

`git show --name-only` 三批均无 `.github`、无意外文件，文件清单与各自 CHANGELOG 条目描述逐项对应：

| commit | 文件数 | 文件 | CHANGELOG 描述对应 |
|---|---|---|---|
| `159f821` Batch 76 | 3 | `CHANGELOG.md`、`gap-audit/REAUDIT_BATCH75.md`、`gap-audit/SELLABLE_REVERIFY_BATCH75.md` | Batch 75 独立复核报告 + 第十二轮可售复验报告 ✓ |
| `c9a1f42` Batch 77 | 4 | `CHANGELOG.md`、`gap-audit/REAUDIT_BATCH74.md`、`gap-audit/b77-board.png`、`gap-audit/b77-dashboard.png` | Batch 74 独立复核报告（补复核链缺口）+ AppImage 重打 2 张 PNG ✓ |
| `980f603` Batch 78 | 4 | `CHANGELOG.md`、`docs/KNOWN_LIMITATIONS.md`、两张 `b78-2-*.png` | 文档卫生扫荡（KNOWN_LIMITATIONS 2 行 + SELLABLE_CHECKLIST 4 处）+ F61 403 toast 走查 2 张 PNG ✓ |

注：B78 条目描述的 `SELLABLE_CHECKLIST.md` 4 处改动在 repo 之外（`~/workspace/goals/ai-factory-app-prototype/files/`），commit 未包含，条目如实——非偏差。

## (b) 零产品代码改动 —— 成立

三批分别 `git show --name-only | grep -E '\.(ts|tsx)$'` 均零匹配（3 次 exit 1）。故无需重跑全量测试：沿用 Batch 75/76 主线收口口径（构建 0、包套件 2589/0、服务端 500/500、desktop+electron tsc 0、smoke:boot OK）诚实，无复验义务。

## (c) 报告资产抽点 —— 在位且实在

| 资产 | 声称 | 实测 |
|---|---|---|
| `REAUDIT_BATCH75.md` | 8657 bytes，偏差 0 | 8657 bytes ✓；首段基线 `848d71c`+隔离 worktree 方法在位；21 个文件清单从第 2 项开始逐项亲读；尾段 4 条卫生注记 + 偏差结论在位 |
| `SELLABLE_REVERIFY_BATCH75.md` | 15471 bytes | 15471 bytes ✓；首段基线/复验方式/本地 commit 声明在位；尾段总结论"可运行的原型 + 持续收敛"、翻绿 4 项、新增缺口 0、13 硬门槛在位 |
| `REAUDIT_BATCH74.md` | 5985 bytes，偏差 0 | 5985 bytes ✓；5 文件清单 + 图标修复亲读 + worktree 亲跑数字；尾段 5 条卫生注记在位 |
| `b77-dashboard.png` | 166596 bytes，1365×739 | 166596 ✓；`file`：PNG image data, 1365×739, 8-bit/color RGB ✓ |
| `b77-board.png` | 167632 bytes，1365×739 | 167632 ✓；真 PNG 1365×739 ✓ |
| `b78-2-board-403-toast.png` | 181KB，1439×871 | 181469 ✓；真 PNG 1439×871 ✓ |
| `b78-2-board-ok.png` | 177KB，1439×871 | 176578 ✓；真 PNG 1439×871 ✓ |

## (d) 78-1 文档改动抽点 —— 成立

1. `docs/KNOWN_LIMITATIONS.md`（`git show 980f603` diff 亲读）：桌面真机 PNG "累计 **39 张**" → "**41 张**"，括号内分组新增 "Batch 77-2 重打 AppImage 复验 +2"；前瞻口径行 `Findings index（F1–F62…）` → `F1–F68`。两处均与声称一致。
2. Findings index 连续性：`docs/FIRST_RUN_WALKTHROUGH.md` 的 `| F` 数据行恰好 **68 行**（F1–F68，无断号）——脚本亲验。
3. PNG 算术：41 = B74-3 实锤的 39（8+3+3+3+3+4+9+2+2+2）+ B77-2 的 2 张；`docs/*.png + gap-audit/*.png` 共 43 个文件 = 41 桌面真机 + b78-2 的 2 张 Board 走查——口径自洽。
4. `SELLABLE_CHECKLIST.md`（repo 外，`~/workspace/goals/ai-factory-app-prototype/files/`）：4 处全部亲验在位——新增"当前状态（Batch 77 收口，基线 c9a1f42）"小节；"剩余缺口"行追加第十二轮复验引用；"6 项代码侧刻意不做"→"**5 项**"，env-error HTTP 条目删除线 + "已于 Batch 75 落地"说明；irrecoverable-env-error 条目 Batch 75 翻转附注。

## (e) 复核链状态

`REAUDIT_BATCH21.md`–`REAUDIT_BATCH75.md` awk 逐号扫描：**连续无断号**（本轮报告补上 76–78 后，复核链覆盖 1–10 + 21–78）。另有旧命名资产 `REAUDIT_BATCH_1_10.md`、`REAUDIT_GIT_EVIDENCE_36.md`（非断号）。
`SELLABLE_REVERIFY_*` 共 13 份，最新为 BATCH75（第十二轮），语义链连续。

## 卫生注记（非偏差）

1. B76 CHANGELOG 条目写 `SELLABLE_REVERIFY_BATCH75.md` "（15471 bytes，未跟踪）"——这是子任务 76-2 报告写完时的状态；收口 commit 已将其纳入跟踪（commit 文件清单第 3 项）。属写作时口径的时间差，产品事实无误，不计偏差。
2. B76 条目内"隔离 worktree @848d71c 服务端第一轮 499/1"与 Batch 75 主线"500/500"并存——条目已如实披露两者口径（499 的唯一失败是旧 `build-orphan-reconcile.test.ts` SIGKILL 时序用例抖动，单独重跑 7/7），非偏差。
3. 三批 commit message 均含"按 Tan 2026-10-15 指令，仅本地累积，暂不推送 GitHub"注——与 standing 指令一致；远端 main 仍为 `7e96bfe`（沿用既定结论，本轮未重复 ls-remote）。
4. 本轮复核未改动任何 tracked 文件；主树 `git status` 仅剩既定未跟踪项（`.github/`、本报告）。`.github/workflows/ci.yml` 仍未跟踪，未触及。

## 总结论

**三批联合复核：偏差 0 处。** 三批均为复核/验证/文档批，零产品代码改动；文件清单与 CHANGELOG 描述逐项对应；报告资产在位实在；78-1 文档改动亲验成立；复核链与 Findings 索引连续。测试基线沿用 Batch 75/76 主线收口口径诚实，无需重跑。

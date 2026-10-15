# Batch 74 独立复核（Batch 77-1）——偏差 0 处

基线：`5b3f224`（Batch 74："Batch73 独立复核 / 桌面打包元数据审计（图标缺口已修）/ gap-audit 索引扫荡 / Tan 产品决策 A A A"）。复核方式：隔离 worktree（`$HOME/wt-reaudit74 @5b3f224`）亲跑全套 + 主树亲读 diff。全程未运行 `git stash`；未 commit；未碰 `.github/`；本报告未跟踪，留给收口人。

## (a) commit 文件清单 —— 成立

`git show 5b3f224 --name-only` = 恰好 5 个文件，无意外文件、无 `.github`：

1. `CHANGELOG.md`（8 insertions）
2. `apps/desktop/electron/main.ts`（5 insertions）
3. `docs/KNOWN_LIMITATIONS.md`（1 insertion + 1 deletion）
4. `electron-builder.yml`（4 insertions）
5. `gap-audit/REAUDIT_BATCH73.md`（新文件，51 insertions，5251 bytes）

`--stat`：5 files changed, 69 insertions(+), 1 deletion(-)。零产品代码改动——Batch 74 是复核报告 + 图标缺口修复（electron 主进程壳）+ 文档审计批，声称成立。

## (b) 图标缺口修复 —— 亲读成立

- `apps/desktop/electron/main.ts`（+5）：`createWindow()` 加 `icon: path.join(__dirname, '..', 'build', 'icon.png')`，含注释说明 dev（`apps/desktop/dist-electron`）与打包后（`<app>/apps/desktop/dist-electron`）相对布局相同；`path` 已在第 9 行 import（`import * as path from 'path'`），无新 import 需求。
- `electron-builder.yml`（+4）：`files` 新增 `apps/desktop/build/icon.png` + 注释说明与 main.ts 的对应关系；yml 解析合法，`files`/`productName`/`appId` 均正确。
- `apps/desktop/build/icon.png` 在位：**512×512 8-bit/color RGBA**，尺寸合规。
- 元数据抽点：appId `com.aifactory.ide`、productName `AI Factory`、NSIS shortcutName `AI Factory`、linux executableName `ai-factory`、maintainer `AI Factory`、mac category `public.app-category.developer-tools`——yml 内全部在位；version 根与 desktop 两个 package.json 均为 `0.1.0`；description `"AI Engineering Factory IDE — runnable prototype skeleton"`、author `Tan` 与声称一致。license 刻意无（Tan 的决定），Batch 74 未动——与声称一致。

## (c) KNOWN_LIMITATIONS.md 改动 —— 1 行，不是 2 处

`git diff be15336 5b3f224 -- docs/KNOWN_LIMITATIONS.md` 恰好 1 行变更：Electron bullet 里的桌面真机 PNG"累计 33 张"→"累计 **39 张**"（+ b67-2/b69-2/b70-2 各 +2 的注释）。**/tmp bullet 未动**——Batch 74-3 只修了这一处；/tmp bullet 仍是 Batch 73 落的措辞（wrapper 已落地、bullet 写"修复待做"的滞后，REAUDIT_BATCH73 已注明保留为历史边界说明）。任务 brief 里"两处改动（PNG 33→39 + /tmp bullet）"的说法不成立，是 brief 口径问题，**commit 本身无偏差**。

PNG 算术抽点：仓库走查 PNG 实数 39 张；b67-2、b69-2、b70-2 各 +2 个文件在位（walkthrough-b67-2-dashboard/evaluation、b69-2-pill-present/gone、b70-2-dashboard/evaluation）——33+2+2+2=39 吻合。

## (d) REAUDIT_BATCH73.md —— 在位且内容实在

5251 bytes，亲读全文：(a) be15336 文件清单 6 个文件与 `git show --name-only` 逐项吻合；(b) wrapper 三行为亲读结论，TDZ 小边界的论证成立；(d) 490/490 数字诚实。非模板文档。

## (e) 产品决策记录 —— 与 Tan 的 A A A 决策一致

commit message 记录"（2026-10-15 21:15 +08，Tan 决策卡 A A A，全做）"：F61→A（v1 POST /transition 加 §17.2 授权轴检查）、F28→A（新增 HTTP 可达的环境错误信号，S8 翻正向触发）、F12→A（authority-conflict registry 持久化）。与 Tan 实际回复 "A A A（全做）" 逐字对应——已在 Batch 75 落地（本复核 scope 外，不复验 Batch 75）。

## (f) 隔离 worktree 亲跑全套 —— 与声称数字精确一致

worktree：`$HOME/wt-reaudit74 @5b3f224`；`node_modules` 软链主树（只读用）；`FACTORY_SECRETS_DIR=$HOME/wt74-secrets`；server 套件走 `npm run test:server`（TMPDIR wrapper）。

| 项 | 声称 | 亲验 |
|---|---|---|
| npm run build（真实 exit code） | 0 错误 | **BUILD_EXIT=0**，vite built in 2m 18s |
| npm test 全量 | 2567 pass / 0 fail（2569 tests，2 skipped） | 第一段 2099/2097/0，第二段 470/470/0，**TEST_EXIT=0** |
| npm run test:server | 490/490 | **490/490（suites 160），SERVER_EXIT=0**，第一轮即全绿 |
| desktop tsc | 0 | **0** |
| electron tsc | 0 | **0** |
| smoke:boot | OK | **OK**（compiled server booted, GET /api/health → 200），SMOKE_EXIT=0 |

偶发抖动：无（server suite 第一轮即 490/490）。本次 worktree 亲跑中途 VM 重启一次（uptime 1 min，后台 exec 与 /tmp 日志丢失），改用 `$HOME` 落日志后完整重跑——数字为重跑后的亲测结果，非沿用旧数。

## 偏差计数

**偏差 0 处。**

声称与事实逐项吻合；核心产品改动只有图标 2 文件加法，亲读无偷渡；测试基线数字在隔离 worktree 上亲跑复现（build 0 / 2567+2skip / 490 / tsc 0+0 / smoke OK）。

## 卫生注记（非偏差）

1. 本次 brief 写"KNOWN_LIMITATIONS.md 的两处改动（PNG 33→39 + /tmp bullet）"——实际只有 1 行（PNG），/tmp bullet 未动。是 brief 口径问题，commit 无偏差。
2. `SELLABLE_CHECKLIST.md` 的"当前状态（2026-10-15，Batch 71 收口）"小节是 goals 目录文件（`~/workspace/goals/ai-factory-app-prototype/files/`），在 repo 之外，已亲验在位——commit message 声称成立。
3. 复核链缺口补上后：REAUDIT_BATCH21–75 连续在位（本报告补齐 74），缺口清零。
4. worktree 已 `git worktree remove --force` 拆除，`git worktree list` 确认无残留；`$HOME/wt74-secrets`、`$HOME/wt74-*.log` 为复核证据暂留 $HOME（非 /tmp），收口人可删。主树工作状态未动（本复核未在主树写任何文件）。
5. 全程未运行 `git stash`；未 commit；未碰 `.github/`（仍未跟踪）。

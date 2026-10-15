# REAUDIT_BATCH72 — Batch 72 独立复核

**基线**：`1e7004d`（Batch 72，本地）
**方式**：隔离 worktree `~/reaudit-b72`（detached HEAD `1e7004d`），亲读 + 亲跑；主树零干扰，全程未运行 `git stash`；worktree 已删。
**结论：偏差 0 处。**

## (a) commit 文件清单 —— 成立

`git show --name-only 1e7004d` = **恰好 4 个文件**，无意外文件：

1. `CHANGELOG.md`
2. `docs/FIRST_RUN_WALKTHROUGH.md`
3. `gap-audit/REAUDIT_BATCH71.md`
4. `gap-audit/SELLABLE_REVERIFY_BATCH71.md`

`git show --stat`：4 files changed, 181 insertions(+), 1 deletion(-)。
**零产品代码改动** —— Batch 72 是复核报告 + 第十一轮可售复验 + F63–F68 审计卫生批，声称成立。

## (b) SELLABLE_REVERIFY_BATCH71.md —— 在位且内容实在

`wc -c` = **17517 bytes**（与报告声称的字节数精确一致）。亲读全文——13 项翻绿（相对第十轮）逐条有依据、新增真实缺口 **0 项**、A/B/C/D verdict 逐条亲验（A：真实模型回路仍 BLOCKED、三平台签名零配置；B：13 项硬门槛全部仍在 Tan/环境侧；C：复验人主线亲跑数字；D：CHANGELOG 在位、仓库刻意无 LICENSE、许可证/定价/渠道待 Tan）。verdict 「仍是"可运行的原型 + 持续收敛"，不是可交付产品」与依据一致，无"定义冒充实现"式口径。

## (c) Findings index F1–F68 —— 成立

脚本亲验 `docs/FIRST_RUN_WALKTHROUGH.md` 的 Findings index 表格（`## Findings index (F1–F68)`，行 45–147）：
**68 数据行，F1–F68 连续无断号、无重复、无多余编号**。与 72-3 的声称（68 数据行）精确一致。
`git diff HEAD~1 HEAD -- docs/FIRST_RUN_WALKTHROUGH.md`：恰好表头 `F1–F62 → F1–F68` + 追加 F63–F68 六行（7 insertions / 1 deletion），正文历史段落未动。
新行抽点：F63 closed (B66)、F64 closed (B68)、F65 closed (B69)、F66 hygiene、F67 open、F68 closed (B70) —— 状态与 72-3 报告一致。

## (d) REAUDIT_BATCH71.md —— 在位且内容实在

`wc -c` = **5293 bytes**。亲读全文：(a) Batch 71 文件清单（恰好 2 个文件，`--stat` 2 files changed, 66 insertions(+), 0 deletions）；(b) REAUDIT_BATCH70.md 核查；(c) 71-2 §58 合规结论抽点（`isolation.ts` 头注释 + `quota/policy.ts:125` —— 我同样亲读确认了这两个钉死点）；(d) 71-3 Windows 调研结论抽点（签名配置 0 处、`dist:win` 缺 `--publish never`、`which wine` 不存在）。真实数字有 worktree 口径标注，无"定义冒充实现"式口径。

## 真实验证数字（隔离 worktree @1e7004d）

- 根构建：**0 TS 错误**（`grep -c "error TS"` = 0）
- `npm test` 全量：**2567/2567，0 fail**
- 服务端全套：**490/490，0 fail**（`FACTORY_SECRETS_DIR=~/b73-1-secrets`，`TMPDIR=~/tmp-reaudit-b72` 避开 /tmp tmpfs；见卫生注记 1）
- desktop tsc **0**；electron tsc **0**
- `smoke:boot` **OK**（编译 server 启动，`GET /api/health` → 200）

## 卫生注记（非偏差）

1. **偶发 fail，已排除**：server suite 第一轮 489/1 fail；随后为定位失败项又完整重跑两轮 —— 两轮均为 **490/490，0 fail**，无稳定复现。第一轮未保留失败用例名（管道只取了汇总行），如实记录：是偶发抖动，非真实偏差。worktree 各包 dist 在 worktree 内实建，未回写主树 dist；`TMPDIR=$HOME` 避开了 /tmp 512MB tmpfs 的堆积陷阱。
2. worktree 建在 `$HOME`，`git worktree remove --force` 已拆除，`git worktree list` 确认无残留；临时目录 `~/tmp-reaudit-b72`、`~/b73-1-secrets` 已删；node_modules 为软链指向主树（仅读用）。
3. `/dev/null` 缺失状态无变化（625 bytes 普通文件，容器/mknod 权限问题这边修不了）；git 命令工作正常。
4. 全程未运行 `git stash`；复核期间主树无兄弟在途改动；本报告未 commit。

# REAUDIT_BATCH67 — Batch 67 独立复核

**基线**：`b54d36c`（Batch 67，本地）
**方式**：隔离 worktree `~/reaudit-b67`（detached HEAD `b54d36c`），亲读 + 亲跑；主树零干扰，全程未运行 `git stash`；worktree 已删。
**结论：偏差 0 处。**

## (a) commit 文件清单 —— 成立

`git show --name-only b54d36c` = **恰好 6 个文件**：

- `CHANGELOG.md`
- `docs/FIRST_RUN_WALKTHROUGH.md`
- `docs/KNOWN_LIMITATIONS.md`
- `gap-audit/REAUDIT_BATCH66.md`
- `gap-audit/walkthrough-b67-2-dashboard.png`
- `gap-audit/walkthrough-b67-2-evaluation.png`

`git diff b54d36c^ b54d36c --stat -- '*.ts' '*.tsx'` → 空。**零产品代码改动**——文档+证据批声称成立，无意外文件。

## (b) 67-2 AppImage 走查声称 —— 抽点成立

- `~/appimage-out-b67/AI Factory-0.1.0.AppImage` 在位，**130167854 bytes ≈ 130MB**（报告称 130MB）✓
- 两张 PNG `file` 亲验均为**真 PNG 1438×842**（报告称 1438×842，均已查看）✓
- 报告的走查边界（无 FUSE 跑 linux-unpacked、PORT=32111、?apiPort=32111 注入、/api/profiles 修复在打包产物生效、2 张 PNG、"审计日志加载失败" pill 观察）记录在案；我未重跑打包（scope 内注明），证据文件在位且真实。

## (c) 67-3 文档扫荡 6 处修复 —— 抽点成立

1. **F1–F4 → closed (B12)**：`docs/FIRST_RUN_WALKTHROUGH.md:53` 行 `| F1 | High | closed (B12) |` ✓，one-liner 保留原始问题描述 + 追加修复说明（`routes/v2-transitions.ts` 搬家说明在位）✓
2. **F53 → closed (B66)**：`:105` 行 `| F53 | Info | closed (B66) |` ✓，one-liner 重写为新状态 + 新边界（裸高熵字符串抓不到；adapter 路径 fail-closed 仍是硬保证；git-commit 扫描 out of scope）✓
3. **F57 → closed (B66)**：`:109` 行 `| F57 | Info | closed (B66) |` ✓，one-liner 重写为新状态 + 新边界（默认策略 permissive；收紧是产品决策）✓
4. **KNOWN_LIMITATIONS Electron 口径**：`:10` 行已补 Batch 60–66 四轮现状（打包产物交互、PORT=32111、Board/QA/Approvals、剩余 8 面板，抓 2 个真 bug 均已修，PNG 累计 33 张）；诚实边界保留（CDP 合成点击、真人冒烟仍未做）✓
5. **SELLABLE_CHECKLIST**：`~/workspace/goals/ai-factory-app-prototype/files/SELLABLE_CHECKLIST.md:28` 有"当前状态（2026-10-15，Batch 66 收口，基线 9aadfd5，本地）"小节 ✓；剩余缺口行追加了第十轮复验引用 ✓
6. 正文历史段落（`:1276` F53 open、`:1307` F57 open）仍是历史快照——67-3 汇报明确"按既定惯例（index 是现状权威）不动"，与惯例一致，非遗漏。

## 真实验证数字（隔离 worktree @b54d36c）

- 根构建：**0 错误**
- desktop tsc：**0**；electron tsc：**0**
- 服务端全套：**490/490，0 fail**（`FACTORY_SECRETS_DIR=~/b68-1-secrets`，避开 /tmp tmpfs）
- `npm test` 全量（2567）未在 worktree 重跑——Batch 67 零产品代码改动（scope 内注明）

## 卫生注记（非偏差）

1. 中途 runtime 服务重启了一次，第一轮 server 全套的后台会话丢失（`unknown session`），已完整重跑第二轮拿到 490/490 确定数字；无悬账。
2. worktree 建在 `$HOME`（`~/reaudit-b67`），避开 /tmp 512MB tmpfs；`FACTORY_SECRETS_DIR=~/b68-1-secrets`；未遇 ENOSPC。
3. `/dev/null` 缺失状态无变化（625 bytes 普通文件，容器/mknod 权限问题这边修不了）；复核期间 git 命令工作正常。
4. 复核期间主树有兄弟 Batch 68 任务在途——我未碰主树任何文件（除写本报告到 `gap-audit/REAUDIT_BATCH67.md`，按任务要求未 commit）。

# REAUDIT_BATCH68 — Batch 68 独立复核

**基线**：`c631974`（Batch 68，本地）
**方式**：隔离 worktree `~/reaudit-b68`（detached HEAD `c631974`），亲读 + 亲跑；主树零干扰，全程未运行 `git stash`；worktree 已删。
**结论：偏差 0 处。**

## (a) commit 文件清单 —— 成立

`git show --name-only c631974` = **恰好 4 个文件**：

- `CHANGELOG.md`
- `apps/desktop/src/components/BottomPanel.tsx`
- `docs/FIRST_RUN_WALKTHROUGH.md`
- `gap-audit/REAUDIT_BATCH67.md`

无意外文件。

## (b) BottomPanel 修复 —— 成立

逐行亲读 diff（`git diff c631974^ c631974 -- apps/desktop/src/components/BottomPanel.tsx`）：

- 成功分支：`if (!silent) setErr(null)` → 无条件 `setErr(null)`（附 3 行注释说明原因：启动瞬间的后端不可达造成的瞬时失败，不应在 5 秒静默轮询开始出数后留下陈旧 pill）。
- 失败分支：`if (!silent) setErr(...)` → 无条件 `setErr(...)`。
- `.finally()`：`silent` 只继续管 `setLoading(false)`（它本来的用途——避免 5 秒刷新时 spinner 闪烁），不再管错误状态。

逻辑正确：pill 从此永远反映最近一次轮询的真实状态，瞬时抖动 ≤5 秒自愈。**服务端零改动**（diff 只触及 desktop TSX 一个文件）。

"silent 模式是该文件孤例"声称成立：`grep -rln "silent" apps/desktop/src/components/` 只命中 BottomPanel.tsx 和 EvaluationPanel.tsx；后者是注释里的普通英文单词（"never silent"），不是 silent-poll 状态机——BottomPanel 确实是唯一有该模式的文件。

## (c) F36 → closed(B55) 的 index 行改动 —— 成立

`docs/FIRST_RUN_WALKTHROUGH.md` 的 F36 index 行已改写为 `closed (B55)` + 新状态描述（连续 attestation 现在默认开启的 in-process audit-chain watch；端点本身仍是 point-in-time by design，detection-not-prevention 诚实保留）。

basis 亲验：

- `apps/server/src/audit-chain-watch.ts` 在位。
- `apps/server/src/index.ts:609-621`：`if (process.env.FACTORY_AUDIT_CHAIN_WATCH !== '0')` 包裹 boot-time `tickAuditChainWatch()` + `setInterval` 60s tick——默认开启确实是代码事实，不是口径。

## (d) REAUDIT_BATCH67.md —— 在位且内容实在

3685 bytes，亲读全文。结论"偏差 0 处"；(a) commit 文件清单恰好 6 文件（亲验与我的清单口径一致）；(b) 67-2 AppImage 走查抽点（AppImage 在位 130MB、两张真 PNG；复核人未重跑打包，scope 内注明——诚实）；(c) 67-3 文档扫荡 6 处修复逐项抽点；真实验证数字部分诚实（scope 注明、卫生注记如实记录 runtime 重启导致的第一轮会话丢失后重跑）。未发现"定义冒充实现"式口径。

## 真实验证数字（隔离 worktree @c631974）

- 根构建：**0 错误**
- desktop tsc：**0**；electron tsc：**0**
- 服务端全套：**490/490，0 fail**（第一轮即全绿；`FACTORY_SECRETS_DIR=~/b69-1-secrets`，避开 /tmp tmpfs）
- `npm test` 全量：**2567/2567，0 fail**

## 卫生注记（非偏差）

1. worktree 建在 `$HOME`（`~/reaudit-b68`），各包 dist 在 worktree 内实建，没有回写主树 dist；未遇 /tmp tmpfs ENOSPC。
2. `/dev/null` 缺失状态无变化（625 bytes 普通文件，容器/mknod 权限问题这边修不了）；复核期间 git 命令工作正常。
3. 复核期间主树只有 `?? .github/` 未跟踪（本来就是未跟踪的 CI 文件，我未碰）。
4. 本报告写到 `gap-audit/REAUDIT_BATCH68.md`（主树未跟踪），按任务要求未 commit。

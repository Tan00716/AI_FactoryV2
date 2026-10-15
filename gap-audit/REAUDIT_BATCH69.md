# REAUDIT_BATCH69 — Batch 69 独立复核

**基线**：`5c9b8c4`（Batch 69，本地）
**方式**：隔离 worktree `~/reaudit-b69`（detached HEAD `5c9b8c4`），亲读 + 亲跑；主树零干扰，全程未运行 `git stash`；worktree 已删。
**结论：偏差 0 处。**

## (a) commit 文件清单 —— 成立

`git show --name-only 5c9b8c4` = 恰好 **5 个文件**，无意外文件：

1. `CHANGELOG.md`
2. `apps/desktop/src/components/ApprovalsPanel.tsx`
3. `gap-audit/REAUDIT_BATCH68.md`
4. `gap-audit/walkthrough-b69-2-pill-gone.png`（192677 bytes）
5. `gap-audit/walkthrough-b69-2-pill-present.png`（56072 bytes）

产品代码改动：仅 `ApprovalsPanel.tsx`（4+/1-，桌面端）；服务端 `apps/server`/`packages` 零改动（`git show 5c9b8c4 --stat -- apps/server packages` 为空）。

## (b) ApprovalsPanel 修复 —— 成立

亲读 diff（唯一 hunk，`refresh` 回调内）：

```diff
-      .then(setItems)
+      .then((items) => {
+        setItems(items);
+        setError('');
+      })
       .catch((e: Error) => setError(e.message));
```

逻辑正确：成功时无条件 `setError('')`，失败时仍 `setError(e.message)`；轮询成功不再保留陈旧横幅。
与 68-2 的 BottomPanel 是同一 bug 类（"静默/定期成功不清错误"），58-5 模式：服务端契约 untouched，修的是桌面端状态机。

## (c) REAUDIT_BATCH68.md —— 在位且内容实在

3584 bytes，亲读全文：结论偏差 0 处、文件清单亲验、BottomPanel diff 亲读、F36 依据亲验、卫生注记——均与本轮独立复核的事实一致，未发现"定义冒充实现"式口径。

## (d) 69-2 PNG —— 在位且为真 PNG

`file` 亲验：两张均为 PNG image data，**1439×871**，与 69-2 报告的尺寸一致。

## 真实验证数字（隔离 worktree @5c9b8c4）

- 根构建：**0 错误**
- 服务端全套：**490/490，0 fail**（`FACTORY_SECRETS_DIR=~/b70-1-secrets`，避开 /tmp tmpfs）
- desktop tsc：**0**；electron tsc：**0**
- `npm test` 全量：**2567/2567，0 fail**

## 卫生注记（非偏差）

1. worktree 建在 `$HOME`（`~/reaudit-b69`），各包 dist 在 worktree 内实建，未回写主树 dist；未遇 /tmp ENOSPC。
2. `/dev/null` 缺失状态无变化（625 bytes 普通文件，容器/mknod 权限问题这边修不了）；git 命令工作正常。
3. 复核期间主树无兄弟在途改动；本报告未 commit，worktree 已删除。

# Batch 51 独立复核报告（REAUDIT_BATCH51）

- **基线**：`4a92f6e`（Batch 51 commit），隔离 worktree（detached HEAD，`~/workspace/tmp-reaudit-b51`，`node_modules` 软链主树），worktree 已删除。
- **范围**：`git show 4a92f6e --stat` 的 8 个文件（CHANGELOG.md 8 行 + 走查新测试 308 行 + 走查文档 48 行 + KNOWN_LIMITATIONS 1 行 + backup-restore-guide.md 113 行 + REAUDIT_BATCH50.md + 2 张 PNG）。
- **结论：Batch 51 的实质声明全部成立，未发现夸大或造假。偏差 0 处。**
- **产品代码改动**：零（Batch 51 全是测试、文档、截图、复核报告——与 commit message 一致）。

## (a) 脱敏 hit → needs-human 升级走查——成立

- **亲读全文**（308 行，单 `it`、纯 HTTP、零 mock、真实编译 server + 真 pty、hermetic + dual-mode 合规）。
- **阈值语义亲读验证**（`apps/server/src/redaction-monitor.ts`）：
  - `REDACTION_ESCALATION_THRESHOLD = 3`、`REDACTION_ESCALATION_WINDOW_MS = 5 分钟`，在位。
  - `noteHit(source, hits)`：阈值比较用的是 `events.length >= this.threshold`——**计数的是检测事件数，不是 hit 总数**（`totalHits` 另行累计，只用于记录）。"计数的是检测事件数不是 hit 总数"成立。
  - key 为 `${hit.sourceType}:${hit.source}`（如 `terminal:<sid>`）——**按输出源聚合**，跨源不聚合；`escalated` Set 保证单源每 pattern 最多升级一次；窗口完全老化后 `escalated.delete(key)` 允许再升级。成立。
  - 升级路径：达阈值 → `buildSecurityUpgradeRecord`（'security-issue'）→ `emitSecurityNeedsHuman` 写透（`NEEDS_HUMAN_RAISED`；失败 `NEEDS_HUMAN_PERSIST_FAILED`，不回滚）。成立。
  - 升级用的 narrative 在 `buildSecurityUpgradeRecord` 中含 "human judgment needed" / "A single hit can be benign"——Batch 44 F19 已持久化的诚实限定语，亲读在位。
- **E2 "恰好 1 条 OPEN"**：测试断言 `escalations.length === 1`（`redaction-monitor:terminal:` 前缀 + `requiredDeciderLevel: 'operator'`）。成立。
- **F30–F31**：已写入 `docs/FIRST_RUN_WALKTHROUGH.md`（"redaction → needs-human escalation leg (Batch 51)" 一节，grep 确认在位）。F30（阈值语义是事件数不是 hit 数）、F31（escalate-once-per-pattern）均为 Info，表述准确。
- **亲跑**：`node --test apps/server/tests/first-run-walkthrough-redaction-escalation.test.ts`，**1/1**，0 fail。

## (b) 备份恢复操作手册——6 节事实准确性全部成立

亲读 `docs/backup-restore-guide.md`（113 行）并逐项对照代码：

1. **备份范围**：env 名全部吻合（`FACTORY_BACKUP_DIR`、`FACTORY_BACKUP_PROJECT_FILES !== '0'`、`FACTORY_BACKUP_MAX_FILE_BYTES`、`FACTORY_BACKUP_MAX_TOTAL_BYTES`、`FACTORY_BACKUP_EXCLUDE_DIRS`、`FACTORY_BACKUP_EXCLUDE_SUFFIXES`）；排除列表逐字吻合（node_modules/dist/build/.git/.hg/.svn/coverage/__pycache__/.venv/venv/.next/.nuxt + .log/.tmp/.DS_Store 后缀）；25MiB/512MiB 默认值在位。
2. **scope 语义**：两种取值描述准确（`backedProjects.length > 0` 判定，Batch 45 亲读过）。
3. **两条不对称恢复路径**：`.restore-pending` + JSON sidecar、`applyPendingRestore()` 把 live 文件改名为 `<db>.superseded-<ts>`（含 `-wal`/`-shm` sidecar 一并改名）、启动时写 `RESTORE_APPLIED`、旧库 `RESTORE_STAGED`——全部在位；"必须重启的原因（进程持有整套建在同一 DB 连接上的 store）"与实现一致。项目文件路径：全量校验先行、`preRestoreDir` 回滚点、恢复后重哈希——在位；422 时现树不动。
4. **F22 项目根策略**：`FACTORY_PROJECTS_ROOT`（默认 `<db dir>/projects`）、四个拒绝码（`PROJECT_PATH_NOT_ABSOLUTE` / `_NOT_FOUND` / `_NOT_DIRECTORY` / `_OUTSIDE_ROOT`）——亲读在位，与 Batch 47 复核一致。
5. **桌面两个恢复入口**：`BackupPanel.tsx` 的「恢复数据库…」/「恢复项目文件…」确认区文案与手册对照表一致。
6. **权限与审计**：审计事件名（`BACKUP_CREATED`/`PROJECT_FILES_RESTORED`/`RESTORE_STAGED`/`RESTORE_APPLIED`）在位。

## (c) 桌面面板截图——两张均为真机实拍，内容与报告一致

- `gap-audit/walkthrough-needshuman-panel-empty.png`（161,836 bytes）：AI FACTORY 桌面真实运行，NeedsHuman tab 选中，"当前没有 OPEN 的升级记录" + 诚实空态文案（"空列表不是'机制关闭'的证据，也不是'功能缺失'"）。与报告一致。
- `gap-audit/walkthrough-needshuman-panel-with-record.png`（157,692 bytes）："共 1 条 OPEN 记录"，`policy-violation 策略违规 严重度 严重`，触发时间、来源 `policy-denial:walk-granter-b51`、所需 `operator` 级别，**narrative 全文完整渲染**（"granter walk-granter-b51 was denied 3 times… The policy held on every attempt — no elevation occurred…"）；底部 AI Activity 日志显示 `NEEDS_HUMAN_RAISED` + 3× `TASK_SCOPE_CEILING_DENIED`。与报告一致。
- 边界声明诚实：报告已明确这是 Linux+Xvfb dev 模式验证，不是 AppImage 双击体验，Windows/macOS 未验证。

## 真实验证数字（隔离 worktree @4a92f6e，亲跑）

- 服务端全套：**453/453**，0 fail（= Batch 51 基线 453，含新走查测试）
- 新走查测试：1/1
- 构建：worktree 源码与主树同 commit，dist 通过软链复用主树同 commit 编译产物

**偏差：0 处。**

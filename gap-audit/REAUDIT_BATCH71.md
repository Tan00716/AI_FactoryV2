# REAUDIT_BATCH71 — Batch 71 独立复核

**基线**：`6618b36`（Batch 71，本地）
**方式**：隔离 worktree `~/reaudit-b71`（detached HEAD `6618b36`），亲读 + 亲跑；主树零干扰，全程未运行 `git stash`；worktree 已删。
**结论：偏差 0 处。**

## (a) commit 文件清单 —— 成立

`git show --name-only 6618b36` = 恰好 **2 个文件**，无意外文件：

1. `CHANGELOG.md`
2. `gap-audit/REAUDIT_BATCH70.md`（3283 bytes）

`git show --stat`：2 files changed, 66 insertions(+)，0 deletions。
**零产品代码改动** —— Batch 71 是复核报告 + 调研结论批（§58 合规 + Windows 可行性），声称成立。

## (b) REAUDIT_BATCH70.md —— 在位且内容实在

3283 bytes，亲读全文：(a) Batch 70 文件清单（恰好 4 个文件，逐项列出）；
(b) REAUDIT_BATCH69.md 内容核查；(c) 70-2 走查 PNG `file` + IHDR 亲验（PNG image data 1280×872，
与 69-2 的 1439×871 无矛盾，报告里明确注记了尺寸声称差异）；
(d) AppImage 产物在位（130167930 bytes ≈ 130MB，与 70-2 报告精确一致）。
真实数字有 worktree 口径标注（构建 0、npm test 2567/2567、server 490/490、
desktop tsc 0、electron tsc 0、smoke:boot OK）。未发现"定义冒充实现"式口径。

## (c) 71-2 的 §58 合规结论 —— 抽点成立

抽点 v1.76 SANDBOX STRATEGY → §7.3（"升级为真实可验收隔离，禁止仅凭 cwd/提示词"）：

- `packages/security/src/isolation.ts` 头注释逐字写明：
  "v2 §7.3 is explicit: intercepting tool arguments, **setting cwd**, or telling the model
  'don't use ../' **is NOT enough** for a full Shell"；
- 由 fail-closed `CONFINEMENT_UNAVAILABLE` 门强制；`docs/KNOWN_LIMITATIONS.md`
  诚实记录"无真实隔离 Host。在 Linux 本机直跑，非合规隔离后端"。
- 没有把 cwd/提示词冒充为隔离。71-2 结论"合规"成立。

另抽点 v1.29 共享额度：`packages/quota/src/policy.ts:125` 注释
"Which buckets a run's agents draw from (shared, not per-agent)"；
`packages/model-router/src/router.ts:238` 明写
"the 5h allowance is shared across agents, not per-agent"。无 per-agent 假额度。

## (d) 71-3 的 Windows 调研结论 —— 抽点成立

- `electron-builder.yml`：`win.target: nsis + portable`，NSIS 配置
  （oneClick=false、允许改安装目录、桌面/开始菜单快捷方式）、icon 已配；
  `certificateFile`/`certificatePassword` 等签名配置 **0 处** —— 三平台零签名配置属实。
- `dist:win` 脚本 = `npm run build && npm run build:electron && electron-builder --win`
  —— 确实没有 `--publish never`，与 71-3 报告一致（未改 tracked 配置）。
- `which wine` → 不存在（退出码 1）；`docs/packaging.md` 如实记录
  "wine process failed ENOENT" 历史、"Windows/macOS 安装包仍未签名、未公证（见上节，等证书采购）"。
- 71-3 的核心结论（NSIS 7z 载荷可在 Linux 产出、最终 exe 需 wine/Windows 实机、
  签名证书是 Tan 的决定）在位配置与文档层面全部成立；
  109MB 载荷产物本身随 `~/b71-3` worktree 删除而不存在，未二次亲验（scope 内注明）。

## 真实验证数字（隔离 worktree @6618b36）

- 根构建：**0 TS 错误**（`grep -c "error TS"` = 0；退出码 1 纯属 grep 零匹配惯例，非失败）
- `npm test` 全量：**2567/2567，0 fail**
- 服务端全套：**490/490，0 fail**（`FACTORY_SECRETS_DIR=~/b72-1-secrets` + `TMPDIR=~/tmp-b72-1`，
  避开 /tmp tmpfs；见下卫生注记）
- desktop tsc：**0**；electron tsc：**0**
- `smoke:boot`：**OK**（编译 server 启动，GET /api/health → 200）

## 卫生注记（非偏差）

1. **环境事故（已排除，非代码问题）**：本轮 server suite 连续跑了 4 次 ——
   run1: pass 436 / fail 54；run2: 0 失败（grep 方式）；run3: pass 273 / fail 214；
   run4: **pass 490 / fail 0**。根因：/tmp 是 512MB tmpfs，server 测试用
   `os.tmpdir()` mkdtemp 落 SQLite DB 但**不清理**（`factory-rbac-e2e-*`、
   `ai-factory-strong-*`、`aif-scope-fields-*` 等目录堆积）；/tmp 涨到 100% 后
   SQLite 报 `ERR_SQLITE_ERROR errcode 13 'database or disk is full'`，
   表现为随机的 fail 数（run1/run3），属于环境抖动。
   处理：确认无测试进程在跑后清掉了 test 残留（/tmp 100% → 68%），
   run4 用 `TMPDIR=$HOME/tmp-b72-1` 重跑 → 第一轮即 490/490。
   **建议（给收口人）**：server 测试应在 teardown 里清理 mkdtemp 目录，
   或文档要求复核跑 server suite 时设 TMPDIR=$HOME。
2. worktree 建在 `$HOME`（`~/reaudit-b71`），各包 dist 在 worktree 内实建，
   未回写主树 dist；worktree 已 `git worktree remove --force` 删除，
   `git worktree list` 确认无残留；临时目录 `~/b72-1-secrets`、`~/tmp-b72-1`、
   `~/b72-1-run3.log`、`~/b72-1-run4.log` 已删。
3. worktree 拆除后亲验：主树 HEAD 仍为 `6618b36`，tracked 文件零变动
   （仅 `?? .github/` 未跟踪残留，为既定状态）。
4. `/dev/null` 缺失状态无变化（625 bytes 普通文件，容器/mknod 权限问题这边修不了）；
   git 命令工作正常。
5. 全程未运行 `git stash`；本报告未 commit。

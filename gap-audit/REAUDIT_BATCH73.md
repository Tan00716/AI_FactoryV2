# Batch 73 独立复核（Batch 74-1）——偏差 0 处

基线：`be15336`（Batch 73）。复核方式：主树亲读 + 亲跑（主树 HEAD 即基线，复核开始时工作树干净，除既定未跟踪 `?? .github/`）。全程未运行 `git stash`；未 commit；本报告未跟踪。

## (a) commit 文件清单 —— 成立

`git show --name-only be15336` = 恰好 6 个文件，无意外文件：

1. `CHANGELOG.md`（7 insertions）
2. `docs/KNOWN_LIMITATIONS.md`（1 insertion）
3. `gap-audit/REAUDIT_BATCH72.md`（新文件，47 insertions，3925 bytes）
4. `package.json`（5 +/−：两个 `node --test` 段改走 wrapper + 新增 `test:server`）
5. `scripts/boot-smoke.mjs`（14 +/−：`cleanupTmp()` 卫生修复）
6. `scripts/run-tests-tmp.mjs`（新文件，128 行）

`--stat`：6 files changed, 199 insertions(+), 3 deletions(-)。

## (b) scripts/run-tests-tmp.mjs —— 亲读成立

逐行亲读全文，三个关键行为均与 Batch 73 声称一致：

- **TMPDIR 隔离**：`TMPDIR` 未设置时在 `$HOME` 下建独立临时根（`.aif-test-tmp-XXXXXX`），把 `TMPDIR`/`TMP`/`TEMP` 三个变量都指向它，再 `spawn(process.execPath, args)`（stdio 继承）；`process.on('exit')` 里同步 `rmSync(recursive, force)`，正常结束和失败都清理。
- **中断杀子进程组**：`spawn` 用 `detached: true`（非 win32）自建进程组；`SIGINT`/`SIGTERM` 用 `process.once` 接住 → `process.kill(-child.pid, 'SIGTERM')` 杀整个组 → 最多等 8 秒 → 升级 `SIGKILL` → 删临时根 → `process.kill(process.pid, sig)` 重抛信号，让 wrapper 以信号的默认行为死亡。注释里记录的"第一版只删目录不杀子进程会导致孤儿 mkdtemp ENOENT"顺序问题确实被处理了。
- **exit code 透传**：`child.on('exit')` → 无信号时 `process.exit(code ?? 1)`，有信号时重抛信号；`child.on('error')` → 打印 + exit 1。**预设 TMPDIR 时尊重原值**（`if (!process.env.TMPDIR)` 分支，创建/删除都不做），72-1 的手动 `TMPDIR=$HOME` 绕法继续有效。
- 小边界（非偏差）：signal handler 注册在 `const child = spawn(...)` 之前，`shutdownOnSignal` 引用 `child` 会进 TDZ——但信号只能在事件循环回合间投递，注册与 spawn 之间是同步代码，不可能被打断；安全。

## (c) REAUDIT_BATCH72.md —— 在位且内容实在

3925 bytes，在位。`(b)` 的 wrapper 行为描述与亲读代码一致；`(d)` 的数字口径诚实。

## (d) npm run test:server 真实亲跑 —— 490/490，第一轮即全绿

- 命令：`FACTORY_SECRETS_DIR=$HOME/b74-1-secrets npm run test:server`
  （按 AGENTS.md  hermeticity 铁律：本机 `apps/server/data/secrets/vault.key` 存在，必须用临时 secrets dir 隔离，否则 fail-closed 误报。）
- 结果：`ℹ tests 490 / ℹ suites 160 / ℹ pass 490 / ℹ fail 0`，exit code 0，第一轮即全绿（duration ~13.4 min）。
- **/tmp 零新增**（基线 vs 跑后）：`factory-*` 目录计数 **464 → 464**（零新增测试残留）；`df /tmp` used 387240 → 387248 1K-blocks（+8KB ≈ 0.002%，tmpfs 分配记账噪声，文件计数未变）；`~/.aif-test-tmp-*` 残留 **0**（wrapper 每次都删干净了）。
- exit code 透传亲验：故意失败的测试 → wrapper exit 1（与裸 `node --test` 一致）；无匹配 glob → wrapper exit 0（与裸 node 行为一致，是 node 自身"无测试文件"语义）；预设 `TMPDIR` 时 wrapper 不建根、不删预设目录（尊重原值分支成立）。

## 抽点（(a)–(d) 之外）

- `scripts/boot-smoke.mjs`：`cleanupTmp()` 挂在 3 个显式 exit 点（early-exit 失败、60s deadline 失败、OK），第 4 个 exit 点（`serverMain` 不存在时的 pre-flight `exit(1)`）发生在 `mkdtemp` 之前、无目录可清——"全部 4 个 exit 路径"声称成立。
- `package.json`：`test` 的两个 `node --test` 段确实都改成了 `node scripts/run-tests-tmp.mjs --test …`；新增 `"test:server": "node scripts/run-tests-tmp.mjs --test 'apps/server/tests/*.test.ts'"`（引号内 glob 由 node test runner 自行展开，正确）。
- `docs/KNOWN_LIMITATIONS.md`：新增 bullet 1 行，口径与 72-1/73-2 的真实观察一致。
- `CHANGELOG.md` 头部 `## Batch 73 (2026-10-15)` 在位。

## 卫生注记（非偏差）

1. 复核期间主树出现兄弟 Batch 74 在途改动（`M apps/desktop/electron/main.ts`、`M docs/KNOWN_LIMITATIONS.md`、`M electron-builder.yml`）——复核人**未碰**；server suite 的 490/490 不受影响（三个文件都不在 server 测试路径上）。
2. Batch 73 commit message 里有一处 mojibake（`/tmp 里仍有 460+ ���历史残留目录`）——纯 commit message 排版问题，不影响代码。
3. `KNOWN_LIMITATIONS.md` 的新增 bullet 写着"teardown 自动清理 mkdtemp 的修复待做（Batch 73-2 方向），未落地前这是硬要求"——而 73-2 的 wrapper 在同一 commit 里已经落地，措辞略滞后；但 CHANGELOG 明确注明该 bullet 保留为"历史边界说明"，是已承认的记录方式，非隐藏偏差。
4. `/dev/null` 状态：Batch 73 声称 08:22 UTC 已恢复为字符设备——本轮未复验（scope 外），沿用记录。

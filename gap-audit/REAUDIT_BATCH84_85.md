# Batch 84+85 联合独立复核（Batch 86-1）——偏差 0 处

复核对象：`32b1ddf`（Batch 84：B83 独立复核 / 可售清单当前状态更新）、`0e7428b`（Batch 85：AppImage 重打 / 打包产物验证）。
复核方式：只读（`git show --name-only/--stat`、CHANGELOG 条目逐项对照、在位资产检查），未重跑任何测试。

## （1）文件清单 vs CHANGELOG 描述——一致

- `32b1ddf`：恰好 2 个文件——`CHANGELOG.md`（+8）、`gap-audit/REAUDIT_BATCH83.md`（+31）。与 Batch 84 条目描述（"B83 独立复核 + 可售清单更新"）一致，无 `.github`、无意外文件。
- `0e7428b`：恰好 1 个文件——`CHANGELOG.md`（+9）。与 Batch 85 条目描述（"AppImage 重打 / 打包产物验证批"）一致，无 `.github`、无意外文件。
- 复核时工作树：`git status --porcelain` 仅 `?? .github/`（既定未跟踪项），干净。

## （2）抽点

- `gap-audit/REAUDIT_BATCH83.md` 在位（2116 bytes，首行"# Batch 83 独立复核（Batch 84-1）——偏差 0 处"）。
- Batch 84 条目声称的 repo 外改动在位：`~/workspace/goals/ai-factory-app-prototype/files/SELLABLE_CHECKLIST.md` 第 28 行有"当前状态（2026-10-16，Batch 83 收口，基线 5e07c3a，本地）"新小节（旧小节未动）。条目明确标注该文件在 repo 外、不进 git——如实。
- Batch 85 条目中的打包产物验证数字（服务端 HTTP 4/4、F12 经 SIGKILL 重启确认持久化、桌面 3/4 tab 目视零崩溃）记录为子任务声称（复核人不重跑），条目未冒充为收口人亲跑。
- 边界披露完整、无冒充：无 FUSE（`.AppImage` 本体未执行，跑的是 `linux-unpacked`）；CDP 合成点击、非真人验收；无 token 本地模式；`pgrep -f` 误杀自身 shell 的事故如实记录（含"server 未受影响，验证继续"）。
- "主线数字沿用 B80–83"口径如实：每项标了来源批次（构建 0、包套件 2593/0×2、服务端 500/500×2、验收 121/121、tsc 0、smoke OK），无冒充新跑。
- REAUDIT 链连续：此前 1–10 + 21–83（逐批/合并），本轮补上 84 + 85，覆盖 1–10 + 21–85，无断号。

## （3）偏差计数

**0 处。**

## 卫生注记

- 全程未 `git stash`、未 commit、未碰 `.github/`（仍是未跟踪原样）。
- 报告写入 `gap-audit/REAUDIT_BATCH84_85.md`（未跟踪，留给收口人）。

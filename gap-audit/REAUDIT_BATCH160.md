# Batch 160 独立复核（Batch 161-1）——Batch 160 自身：偏差 0 处

被审计 commit：`30d87f4`（Batch 160：B159 独立复核，B159 自身偏差 0）。

## 1. 文件清单 vs CHANGELOG 描述——一致

`git show --stat/--name-only 30d87f4`：恰好 2 个文件（`CHANGELOG.md` + `gap-audit/REAUDIT_BATCH159.md`），与 CHANGELOG Batch 160 条目描述逐项一致。文件名中 "github" 命中 0（`git show` 输出中的 "GitHub" 来自 commit message 文本"暂不推送 GitHub"，非文件名）。无 `.github/`、无意外文件。

## 2. 独立抽点——全部一致（全部亲验，不轻信条目声称）

- 被审计 commit `8cfb27b`（Batch 159）：`git diff-tree --no-commit-id --name-only -r` 亲验恰好 2 文件（`CHANGELOG.md` + `gap-audit/REAUDIT_BATCH158.md`），与 B160 条目声称一致。
- `9d3f080`/`b0fba6d`/`0c3cdc8`/`4b85e53`/`041fd29`/`0b456e9`/`b5a475d`/`dafb04e`/`716784d`/`168ddf3`/`0622a39`：亲验均恰好 2 文件（`CHANGELOG.md` + 对应复核报告），与 B160 条目声称逐项一致。
- `gap-audit/REAUDIT_BATCH159.md` 在位，首行"Batch 159 独立复核（Batch 160-1）——Batch 159 自身：偏差 0 处"；SHA-256（`d9e29597…6e8`）工作树与 commit 内嵌版本逐字节一致；`gap-audit/REAUDIT_BATCH158.md` 在位且首行一致。

## 3. B141"2 处偏差"记录验证——属实

- `git ls-tree -r 41f74af` = 106 个 REAUDIT 文件；`git cat-file -e 41f74af:gap-audit/REAUDIT_BATCH140.md` 报 "exists on disk, but not in '41f74af'"（在 `8865375` 树中确认存在）。覆盖范围误述记录属实。
- "127 个批号"算术错误记录属实（1–10 + 21–139 = 129）。无实质影响。

## 4. B138 历史偏差记录——再次验证属实

`git ls-tree -r d377d3f` = 103 个 REAUDIT 文件；`REAUDIT_BATCH136.md` 确在该提交树中（`git cat-file -e` 通过）。

## 5. 独立程序化复核链检查（全部亲验）

- `9d3f080` 时点（被 B159 审计）：124 个已提交文件（110 单批 + 14 分组），覆盖 = 1–10 + 21–157（147 个批号），无缺号、无多号——与 B160 条目声称逐项一致。
- `8cfb27b` 时点（被 B160 审计）：125 个已提交文件（111 单批 + 14 分组），覆盖 = 1–10 + 21–158（148 个批号），无缺号、无多号。
- `30d87f4` 时点（当前）：126 个已提交文件（112 单批 + 14 分组），覆盖 = 1–10 + 21–159（149 个批号），无缺号、无多号。
- 口径说明：B160 条目"复核链：1–10 + 21–158 连续"指**被审计 commit** `8cfb27b` 的覆盖（历批惯例：B159 条目"1–10 + 21–157"指 `9d3f080`），与事实一致，不构成偏差。

## 6. 测试基线

B160 条目明示"纯复核批，无产品代码改动"，数字均为历史亲跑批次（B100/B107/B81）引用，本批未声称重跑。无不实声称。

## 偏差计数

**Batch 160 自身：0 处。**（条目声称的偏差均指历史批次 B138/B141，已独立验证属实。）

本报告覆盖后，复核链为 **1–10 + 21–159 连续**（链历史累计已记录偏差：3 处——B138 × 1，B141 × 2；均为文档错误，无实质影响）。

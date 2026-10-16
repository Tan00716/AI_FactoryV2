# Batch 143 独立复核（Batch 144-1）——Batch 143 自身：偏差 0 处

## （1）文件清单 vs CHANGELOG 描述——一致

- `404f88d`（Batch 143）：恰好 2 个文件（`CHANGELOG.md` + `gap-audit/REAUDIT_BATCH142.md`）
- `git show --name-only` 中 "github" 命中 0：无 `.github/`、无意外文件
- CHANGELOG Batch 143 条目描述与 commit 内容一致

## （2）独立抽点（全部亲验，不轻信条目声称）

- `5d341c5`（B142）：亲验恰好 2 文件（`CHANGELOG.md` + `gap-audit/REAUDIT_BATCH141.md`）
- `8865375`（B141）：亲验恰好 2 文件（`CHANGELOG.md` + `gap-audit/REAUDIT_BATCH140.md`）
- `41f74af`（B140）：亲验恰好 2 文件（`CHANGELOG.md` + `gap-audit/REAUDIT_BATCH139.md`）
- `gap-audit/REAUDIT_BATCH142.md` 在位，首行"# Batch 142 独立复核（Batch 143-1）——Batch 142 自身：偏差 0 处"；SHA-256（`55065112…7bacbf`）与 commit 内嵌版本逐字节一致

## （3）B143 条目记录的 B141"2 处偏差"独立验证——属实

- **偏差 1（覆盖范围误述）**：`git ls-tree -r 41f74af` = 106 个 REAUDIT 文件属实；但 `REAUDIT_BATCH140.md` 不在 41f74af 树中（`git cat-file -e` 报 "exists on disk, but not in '41f74af'"）——它是在 8865375 才提交的。程序化解析 106 个文件：覆盖 = 1–10 + 21–139（129 批号），不是 B141 条目声称的 21–140
- **偏差 2（"127 个批号"算术错误）**：1–10 = 10，21–139 = 119，合计 = 129，不是 127
- 影响：无实质影响

## （4）B138 历史偏差记录——再次独立验证属实

- `git ls-tree -r d377d3f` = 103 个已提交 REAUDIT 文件；`REAUDIT_BATCH136.md` 确在该树中

## （5）独立程序化复核链检查

- 5d341c5 时点：131 个批号（1–10 + 21–141），无缺号、无多号（11–20 本就不存在）
- **404f88d 时点：132 个批号（1–10 + 21–142），连续，无缺号、无多号**（95 个单批报告 + 14 个分组报告；注：1–10 分组报告文件名为 `REAUDIT_BATCH_1_10.md`）
- 测试基线为条目历史记录（B100/B107/B81），本批未声称重跑；纯复核批，无产品代码改动

## 偏差计数

**Batch 143 自身：0 处。**（B143 条目声称的"2 处偏差"是指 B141 批的偏差，已独立验证属实；不是 B143 自身的偏差。）

本报告覆盖后，复核链为 **1–10 + 21–143 连续**（链历史累计已记录偏差：3 处——B138 × 1（中间口径 off-by-one），B141 × 2（覆盖范围误述 + 批号算术错误）；均为文档错误，无实质影响）。

## 卫生注记

- 全程未 `git stash`、未 commit、未碰 `.github/`（仍是未跟踪原样）
- 未跑全量测试、未改仓库任何已跟踪文件
- 工作树：仅剩既定的 `?? .github/` 未跟踪项 + 本报告

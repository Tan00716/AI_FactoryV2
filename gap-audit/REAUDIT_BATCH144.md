# Batch 144 独立复核（Batch 145-1）——Batch 144 自身：偏差 0 处

## （1）文件清单 vs CHANGELOG 描述——一致

- `071c9fe`（Batch 144）：恰好 2 个文件（`CHANGELOG.md` + `gap-audit/REAUDIT_BATCH143.md`）
- `git diff-tree --name-only` 中 "github" 命中 0：无 `.github/`、无意外文件
- CHANGELOG Batch 144 条目描述与 commit 内容一致

## （2）独立抽点（全部亲验，不轻信条目声称）

- `404f88d`（B143）：亲验恰好 2 文件（`CHANGELOG.md` + `gap-audit/REAUDIT_BATCH142.md`）
- `5d341c5`（B142）：亲验恰好 2 文件（`CHANGELOG.md` + `gap-audit/REAUDIT_BATCH141.md`）
- `8865375`（B141）：亲验恰好 2 文件（`CHANGELOG.md` + `gap-audit/REAUDIT_BATCH140.md`）
- `41f74af`（B140）：亲验恰好 2 文件（`CHANGELOG.md` + `gap-audit/REAUDIT_BATCH139.md`）
- `gap-audit/REAUDIT_BATCH143.md` 在位，首行"# Batch 143 独立复核（Batch 144-1）——Batch 143 自身：偏差 0 处"
- `gap-audit/REAUDIT_BATCH142.md` SHA-256（`550651124e25924b…`）工作树与 commit 内嵌版本逐字节一致

## （3）B144 条目记录的 B141"2 处偏差"独立验证——属实

- **偏差 1（覆盖范围误述）**：`git ls-tree -r 41f74af` = 106 个 REAUDIT 文件属实；但 `REAUDIT_BATCH140.md` 不在 41f74af 树中（`git cat-file -e` 报 "exists on disk, but not in '41f74af'"）——它是在 8865375 才提交的。程序化解析 106 个文件：覆盖 = 1–10 + 21–139（129 个批号），不是 B141 条目声称的 21–140
- **偏差 2（"127 个批号"算术错误）**：1–10 = 10，21–139 = 119，合计 = **129**，不是 127；程序化解析确认 129 个批号无缺号
- 影响：无实质影响

## （4）B138 历史偏差记录——再次独立验证属实

- `git ls-tree -r d377d3f` = 103 个已提交 REAUDIT 文件；`REAUDIT_BATCH136.md` 确在该树中（正是该 commit 本次提交的 2 个文件之一）

## （5）独立程序化复核链检查（071c9fe 时点）

- 110 个已提交 `REAUDIT_BATCH*` 文件（96 单批 + 14 分组报告），解析覆盖恰好 = **1–10 + 21–143（133 个批号）**，无缺号、无多号（11–20 本就不存在）
- 数量口径自洽：109（404f88d：95 单批 + 14 分组）→ +REAUDIT_BATCH143.md = 110；批号 132 → 133
- 测试基线为条目历史记录（B100/B107/B81，括号内均注明来源批号），本批未声称重跑；纯复核批，无产品代码改动

## 偏差计数

**Batch 144 自身：0 处。**（条目声称的偏差均指历史批次，已独立验证属实。）

本报告覆盖后，复核链为 **1–10 + 21–143 连续**（链历史累计已记录偏差：3 处——B138 × 1（中间口径 off-by-one），B141 × 2（覆盖范围误述 + 批号算术错误）；均为文档错误，无实质影响）。

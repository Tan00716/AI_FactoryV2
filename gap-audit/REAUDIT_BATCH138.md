# Batch 138 独立复核（Batch 139-1）——偏差 1 处

复核对象：`a5fca54`（Batch 138：B137 独立复核）。纯复核批，无产品代码改动。

## 1. 文件清单 vs CHANGELOG 描述——一致

- `git show --stat --name-only a5fca54`：恰好 2 个文件（`CHANGELOG.md` + `gap-audit/REAUDIT_BATCH137.md`）
- `git diff-tree --name-only` 中 "github" 命中 0：无 `.github/`、无意外文件
- CHANGELOG Batch 138 条目描述与 commit 内容一致（文件清单层面）

## 2. 独立抽点（全部亲验，不轻信条目声称）

- `d377d3f`（Batch 137）：亲验恰好 2 文件（`CHANGELOG.md` + `gap-audit/REAUDIT_BATCH136.md`），与条目声称一致
- `6276b01`（B136）、`0c08147`（B135）、`ba75fe3`（B134）、`a343daa`（B133）：亲验均恰好 2 文件（`CHANGELOG.md` + 对应 `gap-audit/REAUDIT_BATCH<N-1>.md`），与条目声称逐项一致
- `gap-audit/REAUDIT_BATCH137.md` 在位，首行"偏差 0 处"，SHA-256（`31c367f062c64c11e32d5907ec6e89c72549915b392a5fd26b1db75b825fb79d`）与 commit 内嵌版本（`git show a5fca54:...`）逐字节一致
- `gap-audit/REAUDIT_BATCH136.md` / `REAUDIT_BATCH135.md` / `REAUDIT_BATCH134.md` / `REAUDIT_BATCH133.md` 在位，首行均为"偏差 0 处"

## 3. 偏差 1 处：138-1 报告的审计时点文件数口径有误

**138-1 报告（`gap-audit/REAUDIT_BATCH137.md`）声称：**
> "gap-audit 下 103 个 `REAUDIT_BATCH*` 报告文件；其中 102 个已提交文件的解析覆盖集合恰好 = 1–10 + 21–135"

CHANGELOG Batch 138 条目逐字重复了该口径（"102 个已提交文件…覆盖 1–10 + 21–135"、"+1（第 103 个）即 Batch 137 本批新提交的 REAUDIT_BATCH136.md"）。

**事实（独立亲验）：**
- `git ls-tree -r --name-only d377d3f gap-audit/` 显示 **103** 个已提交 `REAUDIT_BATCH*.md` 文件（不是 102 个）
- `git cat-file -e d377d3f:gap-audit/REAUDIT_BATCH136.md` 成功：`REAUDIT_BATCH136.md` 在 d377d3f 的已提交树中（它正是 d377d3f 本次提交的 2 个文件之一）
- 程序化解析这 103 个已提交文件：覆盖集合恰好 = **1–10 + 21–136**（不是 1–10 + 21–135），无缺号、无多号

**偏差性质：** 中间口径的 off-by-one 算术错误。138-1 复核人把被审计 commit（d377d3f）自身提交的 `REAUDIT_BATCH136.md` 误作"未提交的新文件"，从而把已提交文件数少算了 1 个、覆盖上限少算了 1 批。

**影响评估：** 不影响实质结论。审计的最终结论是"复核链 1–10 + 21–137 连续"——本复核独立验证 a5fca54 时点：104 个已提交文件解析覆盖恰好 = 1–10 + 21–137，无缺号、无多号（11–20 本就不存在），14 个分组报告（`REAUDIT_BATCH_1_10.md` + 13 个）全部在位。链连续的结论成立。

## 4. 独立程序化复核链检查（本复核亲跑）

- a5fca54 时点：104 个已提交 `REAUDIT_BATCH*` 报告文件，解析覆盖集合恰好 = 1–10 + 21–137，**无缺号、无多号**
- 14 个分组报告全部在位
- 测试基线数字为条目历史记录并注明来源（B100/B107/B81），本批未声称重跑；纯复核批，无产品代码改动

本报告覆盖后，复核链为 **1–10 + 21–138 连续**（实质层面；注：138-1 报告的中间口径文字有上述 1 处偏差）。

## 5. 偏差计数

**1 处**（见 §3；中间口径算术错误，实质结论不受影响）。

## 卫生注记

- 全程未 `git stash`、未 commit、未碰 `.github/`（仍是未跟踪原样）
- 未跑全量测试、未改仓库任何已跟踪文件
- 工作树：仅剩既定的 `?? .github/` 未跟踪项 + 本报告（未跟踪，留给收口人暂存）

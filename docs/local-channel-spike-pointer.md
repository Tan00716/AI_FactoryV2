# 本地通道最小 spike 仓内指针页（V3R5 #2）

- 性质：**指针页，不是立项单本体，不是实现，不是可用承诺。** 本页只指明立项单存放在哪里、当前状态如何；全文以主本为准。
- 主本存放处：`~/v3r4-1-shots/local-channel-spike-charter.md`（V3R4 #1 立项单）。
- 指针规则：指针优先，不复制全文。若日后必须复制全文，须在指针页与副本页首都写清主本与同步责任人，修订只改主本。
- 路径规则：立项单与评估盘点在 home 下（`~/v3r4-1-shots/`、`~/v3r4-10-shots/`）；冒烟脚本在 workspace 下（如 `~/workspace/v3r4-3-smoke.mjs`）。两类路径不得统一改写，本页遵守此区分。
- 基线注记：立项单基线为本地 main `ce9ff66`；本指针页写于第 5 轮 V3.0 审计基线 `da648a1`。指针页本身不改变立项单内容；立项单结论若因基线推进而需复核，复核结论写入指针页修订，不改主本原意。
- R6 复核注记（2026-11-04，基线 `5b93f74`）：指针页内容与主本逐项核对一致，无需修正；spike 四条件仍未齐，本体继续暂缓。
- R7 复核注记（2026-11-04，基线 `ba64414`）：指针页内容与主本逐项核对一致，无需修正；spike 四条件仍未齐（需求确认、靶运行时、探针目标、egress 检查点定义均未补），本体继续暂缓；源码 grep（Ollama / LM Studio / llama.cpp）在 packages 与 apps/server 下仍 0 命中，无新增本地适配器。
- 同步责任人：立项方（指针页维护者）负责指针与主本的一致性；修订只改主本，指针页随后同步状态行。

## 当前状态：未启动

本地模型通道结论维持第 3 轮 V3.0 审计 #8 的“不通过（作为可执行通道）”，不降级为“部分可用”，不用 StubAdapter 回放冒充探针通过。spike 本体暂缓，至启动门四条件与立项完整性六项齐全才启动。

## 启动门：四条件，缺一不启动（当前状态均来自立项单）

| # | 启动条件 | 当前状态 | 谁来补 |
|---|---|---|---|
| 1 | 需求确认：Tan 确认需要一条独立于 Codex 的本地模型通道 | 未确认 | Tan |
| 2 | 靶运行时选定：本地运行时种类已选定 | 未选定 | Tan |
| 3 | 探针目标：探针要打的地址、模型、最小推理任务已写清 | 未写清（立项单第 4 节为空格，待选定后填入，不预填） | 立项方起草、Tan 定 |
| 4 | egress 检查点定义：adapter.invoke 前的检查点定义已写清 | 未写清（立项单第 5 节为策略框架，检查点落点待选定后填入） | 立项方起草、Tan 定 |

四条件缺一，spike 本体不启动。

## 立项完整性：六项，缺一不算立项完成

六项 = 启动门四条件 + 判定标准 + 到期 / 复议点：

| # | 完整性项 | 状态 |
|---|---|---|
| 1-4 | 启动门四条件（见上表） | 均未齐 |
| 5 | 判定标准 | 已写清，见立项单第 6 节：探针结论只有“通 / 不通 + 阻塞项”两种，无第三种模糊结论；报告标题与结论写明 spike 非实现；不出现宣称通道可用的字样，除非探针全通且经复核 |
| 6 | 到期 / 复议点 | 已写清，见立项单第 7 节：spike 周期为 1 个 spike 周期（不含完整适配器实现）；到期未通结论仍为“不通 + 阻塞项”，不自动延期为“进行中”；下一轮审计时若门仍未开，结论改写为“门控悬空 X 轮，范围重定为本地单机定位”，不得只写“待 Tan” |

## spike 范围：仅 G1 / G2 / G4

| 靶点 | spike 内做 | 不做 |
|---|---|---|
| G1 无本地适配器实现 | 探针脚本（独立目录或隔离分支，不注册为适配器，不进主线注册表） | 不写正式适配器，不进主线注册表 |
| G2 无 endpoint 配置项与探针 | endpoint 配置项（spike-only）+ 探针：地址可达、模型可列、一次最小推理可返回 | 不进默认配置，不写健康检查常驻逻辑 |
| G4 adapter.invoke 未接 egress | egress 检查点定义（允许清单 + 默认拒绝，loopback 恒豁免）+ 探针期拦截日志 | 不改 adapter.invoke 主线代码 |
| G3 / G5 / G6 / G7 | 不进本 spike，记入后续清单 | 不得用 spike 结论覆盖它们 |

**spike 成功不关闭 G1。** G1 关闭须另经实现排期与复核：正式适配器实现 + endpoint 配置 + 探针常驻 + 复核通过，缺一 G1 仍开。

## 复用 / 新建取舍（结论由 Tan 定，本页与立项单均不预设）

复用 CodexAdapter 的 API-key 本地路径 vs 新建本地适配器（Ollama / llama.cpp / 其他），从维护成本、egress 责任、云端功能缺失三点比较，见立项单第 2 节。关键区分：CodexAdapter.invoke 真实存在，但属于 Codex 云端 / app-server 路径，不是 local-private 本地通道；所谓复用，是复用“本地以 API key 调用模型、只付 token、无云端功能”的模式，不是指把 CodexAdapter 当成本地适配器。

## 防误读

1. spike 被读成“本地通道已可用”：报告标题与结论须写明 spike 非实现。
2. 探针地址写死后被当成正式配置：探针配置项标 spike-only，不进默认配置。
3. 探针误触任意 loopback 服务：以允许清单对冲；来源不明或无沙箱则 spike 不启动。

## 指针页自查（本页交付时）

- 主本路径真实存在：`~/v3r4-1-shots/local-channel-spike-charter.md` 已核实存在。
- 四条件与六项齐全：上表逐项列出，无遗漏、无启动承诺。
- 全文无宣称通道可用的肯定表述；当前状态写明为未启动。
- 本页只写指针文档，产品代码 0 改动，未 commit、未 push、未 stash、未碰 `.github/`。
- R8 复核注记（2026-11-04，基线 `7f6876d`）：指针页内容与主本逐项核对一致，无需修正；spike 四条件仍未齐（需求确认、靶运行时、探针目标、egress 检查点定义均未补），本体继续暂缓；源码 grep（Ollama / LM Studio / llama.cpp）在 packages 与 apps/server 下仍 0 命中，无新增本地适配器。
- R9 复核注记（2026-11-05，基线 `d87523c`）：指针页内容与主本逐项核对一致，无需修正；spike 四条件仍未齐（需求确认、靶运行时、探针目标、egress 检查点定义均未补），本体继续暂缓；源码 grep（Ollama / LM Studio / llama.cpp）在 packages 与 apps/server 下仍 0 命中，无新增本地适配器。
- R10 复核注记（2026-11-05，基线 `1078973`）：指针页内容与主本逐项核对一致，无需修正；spike 四条件仍未齐（需求确认、靶运行时、探针目标、egress 检查点定义均未补），本体继续暂缓；源码 grep（Ollama / LM Studio / llama.cpp）在 packages 与 apps/server 下仍 0 命中，无新增本地适配器。
- R11 复核注记（2026-11-05，基线 `95a4dcc`）：指针页内容与主本逐项核对一致，无需修正；spike 四条件仍未齐（需求确认、靶运行时、探针目标、egress 检查点定义均未补），本体继续暂缓；源码 grep（Ollama / LM Studio / llama.cpp）在 packages 与 apps/server 下仍 0 命中，无新增本地适配器；`1078973` → `95a4dcc` 区间 9 个文件全部为文档，本地通道相关代码面零改动。
- R12 复核注记（2026-11-05，基线 `18d3ae9`）：指针页内容与主本逐项核对一致，无需修正；spike 四条件仍未齐（需求确认、靶运行时、探针目标、egress 检查点定义均未补），本体继续暂缓；源码 grep（Ollama / LM Studio / llama.cpp）在 packages 与 apps/server 下仍 0 命中，无新增本地适配器；`95a4dcc` → `18d3ae9` 区间 8 个文件全部为文档，本地通道相关代码面零改动。
- R13 复核注记（2026-11-06，基线 `cc7e499`）：指针页内容与主本逐项核对一致，无需修正；spike 四条件仍未齐（需求确认、靶运行时、探针目标、egress 检查点定义均未补），本体继续暂缓；源码 grep（Ollama / LM Studio / llama.cpp）在 packages 与 apps/server 下仍 0 命中，无新增本地适配器；`18d3ae9` → `cc7e499` 区间 9 个文件（8 个文档 + tasks.ts 头注释措辞收敛，注释-only），本地通道相关代码面零改动。
- R14 复核注记（2026-11-06，基线 `ff1308d`）：指针页内容与主本逐项核对一致，无需修正；spike 四条件仍未齐（需求确认、靶运行时、探针目标、egress 检查点定义均未补），本体继续暂缓；源码 grep（Ollama / LM Studio / llama.cpp）在 packages 与 apps/server 下仍 0 命中，无新增本地适配器；`cc7e499` → `ff1308d` 区间 12 个文件（8 个文档 + package-lock.json + packages/projects 的 package.json / executor.ts / executor.test.ts，#6(d) scrub 改动），本地通道相关代码面零改动。
- R15 复核注记（2026-11-06，基线 `46d0d66`）：指针页内容与主本逐项核对一致，无需修正；spike 四条件仍未齐（需求确认、靶运行时、探针目标、egress 检查点定义均未补），本体继续暂缓；源码 grep（Ollama / LM Studio / llama.cpp）在 packages 与 apps/server 下仍 0 命中，无新增本地适配器；`ff1308d` → `46d0d66` 区间 21 个文件（8 个文档 + package-lock.json + apps/server 的 quality-gate / hooks / batch-changes / recipes 四文件源码与测试 + packages/testexplorer 的 package.json / src/run.ts / tests/run.test.ts，#6(e) scrub 改动），本地通道相关代码面零改动。
- R16 复核注记（2026-11-06，基线 `b8a9424`）：指针页内容与主本逐项核对一致，无需修正；spike 四条件仍未齐（需求确认、靶运行时、探针目标、egress 检查点定义均未补），本体继续暂缓；源码 grep（Ollama / LM Studio / llama.cpp）在 packages 与 apps/server 下仍 0 命中，无新增本地适配器；`46d0d66` → `b8a9424` 区间 23 个文件（9 个文档 + package-lock.json + apps/server 的 recipes 源码/路由/测试与 debug、remote 路由/测试（#6(f)/(g) scrub 改动）+ packages/debugger 的 package.json / src/client.ts / src/node-adapter.ts / tests/node-adapter.test.ts + packages/remote 的 package.json / src/transport.ts（#6(f) scrub 改动）），本地通道相关代码面零改动。
- R17 复核注记（2026-11-06，基线 `f6641d5`）：指针页内容与主本逐项核对一致，无需修正；spike 四条件仍未齐（需求确认、靶运行时、探针目标、egress 检查点定义均未补），本体继续暂缓；源码 grep（Ollama / LM Studio / llama.cpp）在 packages 与 apps/server 下仍 0 命中，无新增本地适配器；`b8a9424` → `f6641d5` 区间 23 个文件（9 个文档 + package-lock.json + apps/server 的 mutation/flaky 源码/路由/测试与 codesearch/todo-scan（#6(i) 修复）+ packages/mutation 的 package.json / src/report.ts / src/runner.ts / src/types.ts / tests/runner.test.ts + packages/codesearch 的 src/grep.ts（#6(i) 改动）），本地通道相关代码面零改动。

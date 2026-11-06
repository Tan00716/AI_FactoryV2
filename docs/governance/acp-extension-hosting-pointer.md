# ACP / 扩展托管评估：仓内指针页

- 状态日期：2026-11-03
- 审计基线：本地 main `da648a1`（第 5 轮 V3.0 审计 R5 的基线；R4 代码侧已落地）
- R7 复核基线：本地 main `ba64414`（2026-11-04，R7 #8；结论见文末 R7 #8 复核节）
- R9 复核基线：本地 main `d87523c`（2026-11-05，R9 #8；结论见文末 R9 #8 复核节）
- R10 复核基线：本地 main `1078973`（2026-11-05，R10 #8；结论见文末 R10 #8 复核节）
- R11 复核基线：本地 main `95a4dcc`（2026-11-05，R11 #8；结论见文末 R11 #8 复核节）
- R12 复核基线：本地 main `18d3ae9`（2026-11-05，R12 #8；结论见文末 R12 #8 复核节）
- R13 复核基线：本地 main `cc7e499`（2026-11-06，R13 #8；结论见文末 R13 #8 复核节）
- R14 复核基线：本地 main `ff1308d`（2026-11-06，R14 #8；结论见文末 R14 #8 复核节）
- R15 复核基线：本地 main `46d0d66`（2026-11-06，R15 #8；结论见文末 R15 #8 复核节）
- R16 复核基线：本地 main `b8a9424`（2026-11-06，R16 #8；结论见文末 R16 #8 复核节）
- 页首 da648a1 行保留理由：该行是本指针页写于 R5 时的历史事实（写页时的审计基线），不改写；现时基线以各轮复核基线行为准，最新为上行 R16 行。
- 本页性质：指针页（指针优先规则 M14）。评估本体不在仓内，不复制全文。

## 主本（唯一评估本体）

`~/v3r4-10-shots/acp-extension-hosting-assessment.md`（第 4 轮 V3.0 审计 Top 10 #10 的评估盘点）

同步规则：修订只改主本；本指针页只记录存放处、基线注记与时效复核结论，不与主本各写一套。若主本修订，本页的复核表须随之复核，不得静默沿用旧结论。

## 对外口径（重申，路线落地前一直有效）

- 不宣称 ACP 支持。
- 不把插件目录说成隔离。
- 不把 MCP 接入说成 ACP 托管。
- 盘点完成前的对外说法只有一句：“扩展包存在，托管隔离待评估。”

## 时效复核：da648a1 是否影响 R4 评估结论

复核方法：对照 `da648a1` 的 15 个文件清单与 extensions trust/index diff，逐项核对 R4 评估 §1.1 / §1.4 的结论。结论总述：**R4 评估结论整体仍成立；一处机制细化须在主本修订（第 6 项），其余不变。**

| # | R4 结论 | da648a1 后 | 依据 |
|---|---|---|---|
| 1 | extensions 为进程内 vm 宿主（每次执行新建 node:vm 上下文） | 不变 | `packages/extensions/src/sandbox.ts` 与 `loadExtension` 调用路径不在 da648a1 清单内，未动 |
| 2 | 隔离边界：代码生成禁用、仅暴露 `api` 宿主对象、JSON 边界、超时 2000/5000ms、64KB 上限 | 不变 | `sandbox.ts` 未动；da648a1 只改信任门，不改沙盒实现 |
| 3 | vm 沙盒不是安全边界 | 不变，且披露加强 | 原头注释结论未动；新增警告载荷（`buildTrustWarning`）把该事实写进每次提示 |
| 4 | 扩展能力面仅四类（commands、panels、checkers、context providers） | 不变 | 类型与能力面文件未动 |
| 5 | manifest permissions 仅信息性元数据，声明不扩大沙盒，路由层无权限强制点 | 不变 | da648a1 未新增任何权限强制点；警告载荷列出声明权限，但仍只作“意图声明”，不扩大沙盒 |
| 6 | 签名与信任：Ed25519、trust.json 按 bundle hash 记录、 bundle 变化作废旧信任、无效签名 fail-closed | 结论不变，机制细化一处，须修订主本 | 见下方第 6 项细化说明 |
| 7 | 审计留痕：EXT_INSTALLED、EXT_TRUST_GRANTED / REVOKED、EXT_ENABLED / DISABLED、EXT_UNINSTALLED、EXT_COMMAND_RUN | 不变，事件清单扩展 | 原有事件未删减；新增 EXT_TRUST_CONFIRMED（逐次确认）与 EXT_TRUST_REJECTED（拒绝） |
| 8 | 分发与更新：无云端市场、无自动更新，安装来源为内联 bundle 或本地目录 | 不变 | 分发路径文件未动 |
| 9 | 真实第三方扩展数为 0，树内仅 4 个 demo bundle | 不变 | `packages/extensions/demo/` 仍为 hello-command、info-panel、marker-checker、demo-notes（另有 sign-demo.mjs 脚本，非 bundle） |
| 10 | 未核实项：extensions 路由分发层的角色强制点 | 仍未知 | `apps/server/src/routes/extensions.ts` 内 `requireRole` 仍 0 命中；da648a1 未新增分发层角色检查，不得默认已强制 |
| 11 | ACP 在当前树上缺席 | 不变 | 本轮复核：`packages/extensions/src`、`packages/plugins/src`、`packages/mcp/src` 内 `acp` 0 命中（已排除 capacity 类误命中） |
| 12 | plugins / mcp 两包盘点（hook 为任意 shell 命令、MCP 输出隔离未确认等） | 沿用 R4 | 未动证据：da648a1 的 15 个文件清单中无 `packages/plugins/`、`packages/mcp/` 文件，无 `apps/server/src/hooks.ts`、`apps/server/src/routes/plugins.ts`、`apps/server/src/routes/mcp.ts` |

### 第 6 项细化说明（唯一须修订主本处）

R4 原文“无签名须显式信任决定”现分两支，须在主本 §1.1 签名与信任行补写，不改结论方向：

- 持久信任授予：仍走 POST `/api/extensions/:name/trust` 显式决定，写入 trust.json；bundle 变化仍作废旧信任。
- 逐次确认（da648a1 新增，Tan 2026-11-03 拍板“警告后确认”）：启用、运行或解析未信任 bundle 时先回 409 `trust-confirmation-required` 并附警告载荷（vm 非安全边界、签名状态、声明权限）；`confirm: true` 仅执行一次并审计 EXT_TRUST_CONFIRMED，**不写 trust.json**，下次执行仍提示；`confirm: false` 审计 EXT_TRUST_REJECTED 并拒绝；未传 confirm 只提示、不审计（提示不是决定）。
- 不变部分：安装门未动（内联安装仍需 `{ trust: true }` 或回 409 `trust-required`）；无效签名在安装与运行时均 fail-closed，**永不可经警告绕过**；无全局放行开关。

## 路线状态

- 触发门未满足：真实第三方扩展 0 个（门槛为 3 个以上），客群判定未决策。
- 路线暂缓是门控的正常状态，不是拖延；评估本身不依赖客群判定，路线依赖。
- 建议路线沿用 R4：先文档化自有 API 的隔离边界，ACP 列入候选，不立即立项。

## R6 #8 后段复核（2026-11-04，复核基线 5b93f74）

- 主本已写回：R4 主本 §1.1 签名与信任行已由“无签名须显式信任决定”改写为持久信任与逐次确认两支；新增 §1.5 信任载荷加固字段（R6 #6 评估清单）；§1.3 子进程环境与 §2 ACP 现状已同步 R6 #9 盘点结论。主本全文 grep 409 / 逐次 / EXT_TRUST_CONFIRMED 有命中。
- 一致性结论：指针页与主本第 6 项结论一致，同步完成条件满足；R4 评估整体仍成立。
- R6 #9 同步结论（本页只记结论，详情见主本与 R6 #9 执行件；R9 #6 C 补尾改写）：ACP 仍缺席（三包源码 grep 0 命中）；真实第三方扩展仍 0 个；launcher 路径子进程环境真实公式为先过滤父 env、再叠加未过滤注入值，过滤结论为部分确认（连接器层面保证仍依赖调用方）；自 R8 #6 A 起冲突键现被拒绝，注入值只覆盖非保护键。
- 本页仍只作指针：字段定义以主本 §1.5 为准，本页不另写一套；强制默认值（签名验证、冷却期）仍待 Tan 一句话，决策前对外口径不变。

## R7 #8 复核（2026-11-04，复核基线 ba64414）

- 范围核对：`5b93f74` → `ba64414` 的 15 个文件清单中无 `packages/extensions/`、`packages/plugins/`、`packages/mcp/` 文件，无 `apps/server/src/mcp-launcher.ts`、`apps/server/src/routes/extensions.ts`、`apps/server/src/routes/plugins.ts`、`apps/server/src/routes/mcp.ts`，三包盘点结论所依赖的代码面未动；主本自 R6 写回后无新修订，本页与主本结论一致性不变。
- 时效引用（本轮现测，不得再出现指针与主本各写一套）：三包源码内 `acp` 仍 0 命中（已排除 capacity 类误命中）；`apps/server/src/routes/extensions.ts` 内 `requireRole` 仍 0 命中，分发层角色强制点仍未知；`packages/extensions/demo/` 仍为 4 个 bundle（另有 sign-demo.mjs 脚本，非 bundle），真实第三方扩展数仍 0，路线触发门（盘点完成 AND（真实第三方扩展数达到 3 个以上 OR 客群判定））仍未满足，路线继续暂缓。
- 结论：R4 评估整体仍成立；R6 #8 后段写回内容（持久信任与逐次确认两支、§1.5 四项加固字段、launcher 子进程环境真实公式 / 连接器依赖调用方 = 部分确认）继续有效；强制默认值仍待 Tan 一句话，对外口径不变。

## R8 #6 C 复核（2026-11-04，复核基线 7f6876d；R9 #6 C 补尾已改写 R6/R7 节旧句，本节现时结论与主本收紧句一致）

- 主本 §1.3 子进程环境行已由 R8 #6 C 收紧为真实公式：先过滤父 env、再叠加未过滤注入值；过滤结论为部分确认，不得写成“全路径已过滤”，更不得写成“已过滤”全称；自 R8 #6 A 起冲突键现被拒绝，注入值只覆盖非保护键。R6/R7 节旧句已由 R9 #6 C 补尾改写为同一收紧句，不再并存两套表述。
- 同源三处已同步：launcher 头注释（真实公式 + 冲突键拒绝后果句，经 R8 收口补正）、runtimePolicy MUST 句（叠加例外限定：MUST 仅约束基底环境，不覆盖事后叠加值）。
- 本页仍只作指针：字段定义以主本为准，本页不另写一套；强制默认值四项仍待 Tan 一句话，对外口径不变（警告后确认，注册表来源与冷却期字段待加固评估）。

## R8 #8 复核（2026-11-04，复核基线 7f6876d）

- 范围核对：`ba64414` → `7f6876d` 的提交为纯文档（7 个文档文件），无 `packages/extensions/`、`packages/plugins/`、`packages/mcp/` 文件，无 `apps/server/src/mcp-launcher.ts`、`apps/server/src/routes/extensions.ts`、`apps/server/src/routes/plugins.ts`、`apps/server/src/routes/mcp.ts`，三包盘点结论所依赖的代码面未动；主本自 R6 写回后唯一的修订是 R8 #6 C 的真实公式收紧（见本页 R8 #6 C 复核节），本页与主本结论一致性不变。
- 时效引用（本轮现测，不得再出现指针与主本各写一套）：三包源码内 `acp` 仍 0 命中；`apps/server/src/routes/extensions.ts` 内 `requireRole` 仍 0 命中，分发层角色强制点仍未知；`packages/extensions/demo/` 仍为 4 个 bundle（另有 sign-demo.mjs 脚本，非 bundle），真实第三方扩展数仍 0，路线触发门（盘点完成 AND（真实第三方扩展数达到 3 个以上 OR 客群判定））仍未满足，路线继续暂缓。
- 结论：R4 评估整体仍成立；R6 #8 后段写回内容（持久信任与逐次确认两支、§1.5 四项加固字段）继续有效，现时子进程环境结论以 R8 #6 C 收紧句为准（部分确认）；强制默认值仍待 Tan 一句话，对外口径不变。

## R9 #8 复核（2026-11-05，复核基线 d87523c）

- 范围核对：`7f6876d` → `d87523c` 的 11 个文件清单中无 `packages/extensions/`、`packages/plugins/` 文件，仅 `packages/mcp/src/runtimePolicy.ts` 一处注释改动（MUST 句叠加例外限定，无行为变化）；无 `apps/server/src/routes/extensions.ts`、`apps/server/src/routes/plugins.ts`、`apps/server/src/routes/mcp.ts`；`apps/server/src/mcp-launcher.ts` 的改动为 #6 A 键名校验（冲突键拒绝）与 #6 C 头注释真实公式，三包盘点结论所依赖的代码面除此两项外未动；本页与主本结论一致性不变。
- 时效引用（本轮现测，不得再出现指针与主本各写一套）：三包源码内 `acp` 仍 0 命中；`apps/server/src/routes/extensions.ts` 内 `requireRole` 仍 0 命中，分发层角色强制点仍未知；`packages/extensions/demo/` 仍为 4 个 bundle（另有 sign-demo.mjs 脚本，非 bundle），真实第三方扩展数仍 0，路线触发门（盘点完成 AND（真实第三方扩展数达到 3 个以上 OR 客群判定））仍未满足，路线继续暂缓。
- 结论：R4 评估整体仍成立；R6 #8 后段写回内容（持久信任与逐次确认两支、§1.5 四项加固字段）继续有效，现时子进程环境结论以 R8 #6 C 收紧句为准（部分确认，连接器层仍依赖调用方；自 R8 #6 A 起冲突键现被拒绝，注入值只覆盖非保护键）；主本行号引用刷新（246 → 279）与指针页 :58/:65 旧句收尾归 R9 #6 C 补尾，本节不另写一套；强制默认值仍待 Tan 一句话，对外口径不变。

## R10 #6 复核（2026-11-05，复核基线 1078973）

- 主本行号引用刷新：launcher 叠加行引用 279 → 290（R9 #6 N1 插入 11 行所致，叠加行实测在 `apps/server/src/mcp-launcher.ts:290`）；runtimePolicy（`filterStdioEnv` 定义在 66 行）与 stdio-connector（env 合并 100-101 行、spawn 块 103-113 行）引用复核无漂移，不动；本页无上述三文件的数字行号引用，无需同步改写。
- 本页仍只作指针：行号与公式以主本为准，本页不另写一套；#6B 语义与连接器补丁决策先行，本项不替决策；强制默认值四项仍待 Tan 一句话，对外口径不变。

## R10 #8 复核（2026-11-05，复核基线 1078973）

- 范围核对：`d87523c` → `1078973` 的 10 个文件清单中无 `packages/extensions/`、`packages/plugins/` 文件，仅 `packages/mcp/src/runtimePolicy.ts` 无改动；无 `apps/server/src/routes/extensions.ts`、`apps/server/src/routes/plugins.ts`、`apps/server/src/routes/mcp.ts`；`apps/server/src/mcp-launcher.ts` 的改动为 #6 N1 保护键集合并入（冲突键拒绝范围扩大，fixed 值永不进子进程环境），三包盘点结论所依赖的代码面除此一项外未动；本页与主本结论一致性不变。
- 时效引用（本轮现测，不得再出现指针与主本各写一套）：三包源码内 `acp` 仍 0 命中；`apps/server/src/routes/extensions.ts` 内 `requireRole` 仍 0 命中，分发层角色强制点仍未知；`packages/extensions/demo/` 仍为 4 个 bundle（另有 sign-demo.mjs 脚本，非 bundle），真实第三方扩展数仍 0，路线触发门（盘点完成 AND（真实第三方扩展数达到 3 个以上 OR 客群判定））仍未满足，路线继续暂缓。
- 结论：R4 评估整体仍成立；R6 #8 后段写回内容（持久信任与逐次确认两支、§1.5 四项加固字段）继续有效，现时子进程环境结论以 R8 #6 C 收紧句为准（部分确认，连接器层仍依赖调用方；自 R8 #6 A 起冲突键现被拒绝，注入值只覆盖非保护键；R9 #6 N1 后保护键集合含 server 记录 allowlist + fixed 键名）；主本行号引用刷新（279 → 290）归 R10 #6，本节不另写一套；强制默认值仍待 Tan 一句话，对外口径不变。

## R11 #8 复核（2026-11-05，复核基线 95a4dcc）

- 范围核对：`1078973` → `95a4dcc` 的 9 个文件清单全部为文档，无 `packages/extensions/`、`packages/plugins/`、`packages/mcp/` 文件，无 `apps/server/src/mcp-launcher.ts`、`apps/server/src/routes/extensions.ts`、`apps/server/src/routes/plugins.ts`、`apps/server/src/routes/mcp.ts`，三包盘点结论所依赖的代码面零改动；本页与主本结论一致性不变。
- 时效引用（本轮现测，不得再出现指针与主本各写一套）：三包源码内 `acp` 仍 0 命中；`apps/server/src/routes/extensions.ts` 内 `requireRole` 仍 0 命中，分发层角色强制点仍未知；`packages/extensions/demo/` 仍为 4 个 bundle（另有 sign-demo.mjs 脚本，非 bundle），真实第三方扩展数仍 0，路线触发门（盘点完成 AND（真实第三方扩展数达到 3 个以上 OR 客群判定））仍未满足，路线继续暂缓。
- 结论：R4 评估整体仍成立；R6 #8 后段写回内容（持久信任与逐次确认两支、§1.5 四项加固字段）继续有效，现时子进程环境结论以 R8 #6 C 收紧句为准（部分确认，连接器层仍依赖调用方；自 R8 #6 A 起冲突键现被拒绝，注入值只覆盖非保护键；R9 #6 N1 后保护键集合含 server 记录 allowlist + fixed 键名）；主本行号引用本轮复核无漂移（叠加行仍为 `mcp-launcher.ts:290`，runtimePolicy `filterStdioEnv` 定义 66 行、stdio-connector env 合并 100-101 行均实测无漂移，R11 #6 不再单独立项重写已闭合的刷新），本节不另写一套；强制默认值仍待 Tan 一句话，对外口径不变。

## R12 #8 复核（2026-11-05，复核基线 18d3ae9）

- 范围核对：`95a4dcc` → `18d3ae9` 的 8 个文件清单全部为文档，无 `packages/extensions/`、`packages/plugins/`、`packages/mcp/` 文件，无 `apps/server/src/mcp-launcher.ts`、`apps/server/src/routes/extensions.ts`、`apps/server/src/routes/plugins.ts`、`apps/server/src/routes/mcp.ts`，三包盘点结论所依赖的代码面零改动；本页与主本结论一致性不变。
- 时效引用（本轮现测，不得再出现指针与主本各写一套）：三包源码内 `acp` 仍 0 命中；`apps/server/src/routes/extensions.ts` 内 `requireRole` 仍 0 命中，分发层角色强制点仍未知；`packages/extensions/demo/` 仍为 4 个 bundle（另有 sign-demo.mjs 脚本，非 bundle），真实第三方扩展数仍 0，路线触发门（盘点完成 AND（真实第三方扩展数达到 3 个以上 OR 客群判定））仍未满足，路线继续暂缓。
- 结论：R4 评估整体仍成立；R6 #8 后段写回内容（持久信任与逐次确认两支、§1.5 四项加固字段）继续有效，现时子进程环境结论以 R8 #6 C 收紧句为准（部分确认，连接器层仍依赖调用方；自 R8 #6 A 起冲突键现被拒绝，注入值只覆盖非保护键；R9 #6 N1 后保护键集合含 server 记录 allowlist + fixed 键名）；主本行号引用本轮复核无漂移（叠加行仍为 `mcp-launcher.ts:290`，runtimePolicy `filterStdioEnv` 定义 66 行、stdio-connector env 合并 100-101 行均实测无漂移，R12 #6 不再单独立项重写已闭合的刷新），本节不另写一套；强制默认值仍待 Tan 一句话，对外口径不变。

## R13 #8 复核（2026-11-06，复核基线 cc7e499）

- 范围核对：`18d3ae9` → `cc7e499` 的 9 个文件清单为 8 个文档 + `apps/server/src/routes/tasks.ts` 头注释措辞收敛（注释-only），无 `packages/extensions/`、`packages/plugins/`、`packages/mcp/` 文件，无 `apps/server/src/mcp-launcher.ts`、`apps/server/src/routes/extensions.ts`、`apps/server/src/routes/plugins.ts`、`apps/server/src/routes/mcp.ts`，三包盘点结论所依赖的代码面零改动；本页与主本结论一致性不变。
- 时效引用（本轮现测，不得再出现指针与主本各写一套）：三包源码内 `acp` 仍 0 命中；`apps/server/src/routes/extensions.ts` 内 `requireRole` 仍 0 命中，分发层角色强制点仍未知；`packages/extensions/demo/` 仍为 4 个 bundle（另有 sign-demo.mjs 脚本，非 bundle），真实第三方扩展数仍 0，路线触发门（盘点完成 AND（真实第三方扩展数达到 3 个以上 OR 客群判定））仍未满足，路线继续暂缓。
- 结论：R4 评估整体仍成立；R6 #8 后段写回内容（持久信任与逐次确认两支、§1.5 四项加固字段）继续有效，现时子进程环境结论以 R8 #6 C 收紧句为准（部分确认，连接器层仍依赖调用方；自 R8 #6 A 起冲突键现被拒绝，注入值只覆盖非保护键；R9 #6 N1 后保护键集合含 server 记录 allowlist + fixed 键名）；主本行号引用本轮复核无漂移（叠加行仍为 `mcp-launcher.ts:290`，runtimePolicy `filterStdioEnv` 定义 66 行、stdio-connector env 合并 100-101 行均实测无漂移，R13 #6 不再单独立项重写已闭合的刷新），本节不另写一套；强制默认值仍待 Tan 一句话，对外口径不变。

## R14 #8 复核（2026-11-06，复核基线 ff1308d）

- 范围核对：`cc7e499` → `ff1308d` 的 12 个文件清单为 8 个文档 + package-lock.json + packages/projects 的 package.json / executor.ts / executor.test.ts（#6(d) scrub 改动），无 `packages/extensions/`、`packages/plugins/`、`packages/mcp/` 文件，无 `apps/server/src/mcp-launcher.ts`、`apps/server/src/routes/extensions.ts`、`apps/server/src/routes/plugins.ts`、`apps/server/src/routes/mcp.ts`，三包盘点结论所依赖的代码面零改动；本页与主本结论一致性不变。
- 时效引用（本轮现测，不得再出现指针与主本各写一套）：三包源码内 `acp` 仍 0 命中；`apps/server/src/routes/extensions.ts` 内 `requireRole` 仍 0 命中，分发层角色强制点仍未知；`packages/extensions/demo/` 仍为 4 个 bundle（另有 sign-demo.mjs 脚本，非 bundle），真实第三方扩展数仍 0，路线触发门（盘点完成 AND（真实第三方扩展数达到 3 个以上 OR 客群判定））仍未满足，路线继续暂缓。
- 结论：R4 评估整体仍成立；R6 #8 后段写回内容（持久信任与逐次确认两支、§1.5 四项加固字段）继续有效，现时子进程环境结论以 R8 #6 C 收紧句为准（部分确认，连接器层仍依赖调用方；自 R8 #6 A 起冲突键现被拒绝，注入值只覆盖非保护键；R9 #6 N1 后保护键集合含 server 记录 allowlist + fixed 键名）；主本行号引用本轮复核无漂移（叠加行仍为 `mcp-launcher.ts:290`，runtimePolicy `filterStdioEnv` 定义 66 行、stdio-connector env 合并 100-101 行均实测无漂移，R14 #6 不再单独立项重写已闭合的刷新），本节不另写一套；强制默认值仍待 Tan 一句话，对外口径不变。

## R15 #8 复核（2026-11-06，复核基线 46d0d66）

- 范围核对：`ff1308d` → `46d0d66` 的 21 个文件清单为 8 个文档 + package-lock.json + apps/server 的 quality-gate / hooks / batch-changes / recipes 四文件源码与测试（#6(e) scrub 改动）+ packages/testexplorer 的 package.json / src/run.ts / tests/run.test.ts（#6(e) scrub 改动），无 `packages/extensions/`、`packages/plugins/`、`packages/mcp/` 文件，无 `apps/server/src/mcp-launcher.ts`、`apps/server/src/routes/extensions.ts`、`apps/server/src/routes/plugins.ts`、`apps/server/src/routes/mcp.ts`，三包盘点结论所依赖的代码面零改动；本页与主本结论一致性不变。
- 时效引用（本轮现测，不得再出现指针与主本各写一套）：三包源码内 `acp` 仍 0 命中；`apps/server/src/routes/extensions.ts` 内 `requireRole` 仍 0 命中，分发层角色强制点仍未知；`packages/extensions/demo/` 仍为 4 个 bundle（另有 sign-demo.mjs 脚本，非 bundle），真实第三方扩展数仍 0，路线触发门（盘点完成 AND（真实第三方扩展数达到 3 个以上 OR 客群判定））仍未满足，路线继续暂缓。
- 结论：R4 评估整体仍成立；R6 #8 后段写回内容（持久信任与逐次确认两支、§1.5 四项加固字段）继续有效，现时子进程环境结论以 R8 #6 C 收紧句为准（部分确认，连接器层仍依赖调用方；自 R8 #6 A 起冲突键现被拒绝，注入值只覆盖非保护键；R9 #6 N1 后保护键集合含 server 记录 allowlist + fixed 键名）；主本行号引用本轮复核无漂移（叠加行仍为 `mcp-launcher.ts:290`，runtimePolicy `filterStdioEnv` 定义 66 行、stdio-connector env 合并 100-101 行均实测无漂移，R15 #6 不再单独立项重写已闭合的刷新），本节不另写一套；强制默认值仍待 Tan 一句话，对外口径不变。

## R16 #8 复核（2026-11-06，复核基线 b8a9424）

- 范围核对：`46d0d66` → `b8a9424` 的 23 个文件清单为 9 个文档 + package-lock.json + apps/server 的 recipes 源码/路由/测试与 debug、remote 路由/测试（#6(f)/(g) scrub 改动）+ packages/debugger 的 package.json / src/client.ts / src/node-adapter.ts / tests/node-adapter.test.ts + packages/remote 的 package.json / src/transport.ts（#6(f) scrub 改动），无 `packages/extensions/`、`packages/plugins/`、`packages/mcp/` 文件，无 `apps/server/src/mcp-launcher.ts`、`apps/server/src/routes/extensions.ts`、`apps/server/src/routes/plugins.ts`、`apps/server/src/routes/mcp.ts`，三包盘点结论所依赖的代码面零改动；本页与主本结论一致性不变。
- 时效引用（本轮现测，不得再出现指针与主本各写一套）：三包源码内 `acp` 仍 0 命中；`apps/server/src/routes/extensions.ts` 内 `requireRole` 仍 0 命中，分发层角色强制点仍未知；`packages/extensions/demo/` 仍为 4 个 bundle（另有 sign-demo.mjs 脚本，非 bundle），真实第三方扩展数仍 0，路线触发门（盘点完成 AND（真实第三方扩展数达到 3 个以上 OR 客群判定））仍未满足，路线继续暂缓。
- 结论：R4 评估整体仍成立；R6 #8 后段写回内容（持久信任与逐次确认两支、§1.5 四项加固字段）继续有效，现时子进程环境结论以 R8 #6 C 收紧句为准（部分确认，连接器层仍依赖调用方；自 R8 #6 A 起冲突键现被拒绝，注入值只覆盖非保护键；R9 #6 N1 后保护键集合含 server 记录 allowlist + fixed 键名）；主本行号引用本轮复核无漂移（叠加行仍为 `mcp-launcher.ts:290`，runtimePolicy `filterStdioEnv` 定义 66 行、stdio-connector env 合并 100-101 行均实测无漂移，R16 #6 不再单独立项重写已闭合的刷新），本节不另写一套；强制默认值仍待 Tan 一句话，对外口径不变。

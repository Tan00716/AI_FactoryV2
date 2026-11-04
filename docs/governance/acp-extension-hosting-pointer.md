# ACP / 扩展托管评估：仓内指针页

- 状态日期：2026-11-03
- 审计基线：本地 main `da648a1`（第 5 轮 V3.0 审计 R5 的基线；R4 代码侧已落地）
- R7 复核基线：本地 main `ba64414`（2026-11-04，R7 #8；结论见文末 R7 #8 复核节）
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
- R6 #9 同步结论（本页只记结论，详情见主本与 R6 #9 执行件）：ACP 仍缺席（三包源码 grep 0 命中）；真实第三方扩展仍 0 个；launcher 路径已确认 env 过滤，连接器层面保证仍依赖调用方（部分确认）。
- 本页仍只作指针：字段定义以主本 §1.5 为准，本页不另写一套；强制默认值（签名验证、冷却期）仍待 Tan 一句话，决策前对外口径不变。

## R7 #8 复核（2026-11-04，复核基线 ba64414）

- 范围核对：`5b93f74` → `ba64414` 的 15 个文件清单中无 `packages/extensions/`、`packages/plugins/`、`packages/mcp/` 文件，无 `apps/server/src/mcp-launcher.ts`、`apps/server/src/routes/extensions.ts`、`apps/server/src/routes/plugins.ts`、`apps/server/src/routes/mcp.ts`，三包盘点结论所依赖的代码面未动；主本自 R6 写回后无新修订，本页与主本结论一致性不变。
- 时效引用（本轮现测，不得再出现指针与主本各写一套）：三包源码内 `acp` 仍 0 命中（已排除 capacity 类误命中）；`apps/server/src/routes/extensions.ts` 内 `requireRole` 仍 0 命中，分发层角色强制点仍未知；`packages/extensions/demo/` 仍为 4 个 bundle（另有 sign-demo.mjs 脚本，非 bundle），真实第三方扩展数仍 0，路线触发门（盘点完成 AND（真实第三方扩展数达到 3 个以上 OR 客群判定））仍未满足，路线继续暂缓。
- 结论：R4 评估整体仍成立；R6 #8 后段写回内容（持久信任与逐次确认两支、§1.5 四项加固字段、launcher 已过滤 / 连接器依赖调用方 = 部分确认）继续有效；强制默认值仍待 Tan 一句话，对外口径不变。

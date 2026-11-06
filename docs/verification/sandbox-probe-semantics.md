# Badge 探针语义定义（V3R10 #8 前置设计）

- 状态：**设计文档，不是实现，不是接线承诺。** 本页只定义探针语义；探针接线、字段接线、徽标文案区分均未实施，待语义行闭合后排期。
- 基线：本地 main `46d0d66`；日期：2026-11-06。（R15 收口顺手刷：页首基线由 ff1308d 刷到 46d0d66，D-2 页首滞后闭合；仅改本行，正文一字未动。本行不是 #8 的第八处注记。）
- 依据：V3R10 审计 TOP10 #8（Badge 接线先定义探针语义）、报告 §9 验证首项、§11 探针语义行（闭合条件）、Red Team M2。
- 闭合规则：语义行闭合 = 四者齐全（语义三问定义 + 字段接通 + 文案按平台区分 + 探针缺失显性态），缺一不得记为已澄清；本文档只覆盖第一项。

## 0. 术语区分（先于一切字段）

- 配置档位（configured tier）：用户要求的状态。来源三层（项目 `.ai-factory/sandbox.json` > 环境变量 > 持久化 store），现端点 `GET /api/sandbox/mode` 返回的 8 个字段（mode、persistedMode、approvalPolicy、persistedApprovalPolicy、envForced、resolutionOrder、updatedAt、updatedBy）**全部属于这一层**，没有一个字段描述实际隔离。
- 实测隔离（measured isolation）：操作系统对下一次 exec 实际施加的约束，由探针测得，不是配置推导。
- 徽标现状（诚实描述）：桌面 `SandboxModeBadge` 只展示配置档位；矩阵标注（平台可用性 / NOT_RUN）未进 UI。任何把配置档位读成“已隔离”的表述均为失实。

## 1. 第一问：探针测什么

探针是一次真实 bwrap 调用（不是版本号字符串，见矩阵 §3），测的是**下一次 exec 能否被 OS 强制隔离**，不是配置是否写对。探针输出以下可观测信号，每项都区别于配置档位：

| 信号 | 含义 | 与配置档位的关系 |
|---|---|---|
| platform | 运行平台（`linux` / `darwin` / `win32` / 其他） | 配置档位与平台无关；同一档位在不同平台实测结果不同 |
| bwrapPresent | bwrap 二进制是否存在且可执行 | 档位写 read-only 时若 bwrap 缺失，实测为拒绝，不是只读 |
| usernsEnabled | 用户命名空间是否可用（不可判定时为 null，不得默认为 true） | 同上；不可判定 = 未实测，不得按可用处理 |
| probeResult | 对所测档位的实测结论：`enforced`（已强制）/ `refused`（探针失败，exec 路径拒绝）/ `not-run`（未跑探针）/ `not-applicable`（该档位无隔离可测） | 配置档位永远不得覆盖 probeResult |
| probeError | 探针失败时的机器码（如 `SANDBOX_UNAVAILABLE`），失败原因分类，不写含糊文本 | 配置层无此字段 |
| probedAt | 探针执行时刻（ISO 时间戳）；null = 从未探针 | 档位变更（mode/persistedMode/项目配置任一变化）即宣告旧探针结果过期，须重探 |

档位与探针的对应关系（定义，不实现）：

- `read-only` / `workspace-write`：可探针档位。Linux + bwrap 可用 + 命名空间可用 → `enforced`；任一条件不满足 → `refused`（exec 路径按现有 fail-closed 行为拒绝执行，错误码 `SANDBOX_UNAVAILABLE`，绝不以未隔离方式运行并称已沙盒化）。
- `danger-full-access`：**不可探针档位**。该档位按设计就是无沙盒、直接在宿主机运行，故 probeResult 恒为 `not-applicable`，永远不得写成 `enforced`，也不得写成“探针失败”——无隔离是设计意图，不是故障。
- Win/mac：当前恒为 `not-run`（矩阵 §3.3/§3.4 为 NOT_RUN，代码分支推断不是探针结果）。真机复核前，任何 Win/mac 行都不得出现 `enforced` 或 `refused` 以外的实测断言；推断结论不得进探针字段。

作用域说明（接线时不得静默默认）：现端点返回的是 store 级有效档位，而每请求有效档位由 `resolveSandboxMode(cwd)` 解析（项目配置可逐请求胜出）。探针语义分两层：主机级探针（平台 + bwrap + 命名空间能力）与逐请求档位解析。主机级探针结果可复用；逐请求档位与探针覆盖档位不一致时，按 §3 冲突规则处理。接线方案必须显性写明探针结果的作用域，不得把主机级结果默认当成逐请求结论。

## 2. 第二问：/api/sandbox/mode 应返回的平台与探针结果字段

新增字段一律为**加法**，现有 8 个字段不动、不改语义。新增字段：

| 字段 | 类型与取值 | 缺失语义（旧服务端 / 未接线时） |
|---|---|---|
| `platform` | 字符串：`linux` / `darwin` / `win32` / 其他原值 | 缺失 = 未知平台，按 `not-run` 处理，不得按 Linux 推断 |
| `probeStatus` | `enforced` / `refused` / `not-run` / `not-applicable`（定义见 §1） | **缺失 = `not-run`**，永远不得按 `enforced` 处理 |
| `probeTier` | 探针实际覆盖的档位（`read-only` / `workspace-write`），或 null | null = 探针未覆盖任何档位；danger 档位下恒为 null |
| `probeDetail` | 对象：`{ bwrapPresent: boolean, usernsEnabled: boolean \| null, probeError?: string, probedAt: string \| null }` | 整体缺失 = 从未探针；`probedAt: null` = 从未探针；`usernsEnabled: null` = 不可判定，不得默认为可用 |
| `probeScope` | `host`（主机级能力探针）/ `request`（逐请求解析后探针），接线时定其一并写明 | 缺失 = 作用域未定义，UI 只得展示“未定义”，不得展示实测结论 |

字段语义硬规则：

- `probeStatus` 为 `enforced` 当且仅当：探针真实跑过、覆盖档位等于当前有效档位、且 `probedAt` 未过期（档位未变更）。任一条件不满足即降级为 `not-run` 或 `refused`，不得保留旧 `enforced`。
- `danger-full-access` 档位下 `probeStatus` 恒为 `not-applicable`，`probeTier` 恒为 null；UI 在此档位展示“无隔离（设计意图）”，不得展示任何探针通过态。
- 探针失败（`refused`）时 `probeError` 必填机器码，不得只写自然语言；`bwrapPresent` / `usernsEnabled` 仍须如实填写已测部分，未测部分写 null，不得补默认值。

## 3. 第三问：档位与实测不一致时以何者为准

**规则：实测为准，配置不得覆盖实测。** 冲突判定与展示规则如下（Red Team M2 要求：无此规则则冲突时仍可被记为闭合，故本节为闭合必要条件）：

| 冲突情形 | 展示为准者 | UI 与审计行为 |
|---|---|---|
| 档位为 `workspace-write` / `read-only`，探针为 `refused` | 实测（拒绝） | 徽标不得展示该档位为“生效中”；展示“隔离未生效，执行将被拒绝（SANDBOX_UNAVAILABLE）”；exec 路径已拒绝执行，UI 展示须与之同一结论，不得两处各说一套 |
| 档位为 `workspace-write` / `read-only`，探针为 `not-run`（含字段缺失、旧服务端、Win/mac 未复核、探针过期） | 无实测结论 | 徽标展示“配置档位 + 未实测（NOT_RUN）”两行，不得只展示档位；不得把“未实测”写成“已隔离”或“未隔离”任一方向 |
| 档位为 `danger-full-access` | 设计意图（无隔离） | 展示“无隔离，直接在宿主机运行”；此情形不构成档位与实测冲突，`probeStatus` 为 `not-applicable` 即是正确状态 |
| 探针为 `enforced` 但档位已变更（`probedAt` 之后 mode / persistedMode / 项目配置变化） | 无有效实测结论 | 旧 `enforced` 作废，按 `not-run` 处理并触发重探；不得展示过期 `enforced` |
| 项目配置逐请求胜出，档位与探针覆盖档位不一致 | 实测为准，逐请求档位为准的档位名 | 展示逐请求档位名 + 该档位探针状态；store 级档位名不得冒充逐请求结论 |

审计规则：每次档位与实测不一致被展示时，须记审计事件（含配置档位、探针状态、探针时刻、平台四项），不得静默按档位展示。冲突不得被“用户已确认档位”覆盖——确认档位不等于确认实测。

## 4. 平台字段 alone 不能闭合文案问题（显性警告）

接通 `platform` 字段 alone **不能**闭合 Badge 文案问题（G-07），理由两条：

1. 当前文案问题不仅是“未分平台”，更是“断言了未实测的隔离”：`sandbox.changeTier` 标题写“OS 强制隔离级别”，danger 相关文案写“将关闭所有 OS 隔离”——在 Win/mac 或 bwrap 不可用时，这些句子断言的隔离根本未经实测。按平台拼写同类断言（例如把“OS 隔离”改成“Windows 隔离”）只是换一种未实测断言，不是澄清。
2. 文案区分只允许在探针字段存在之后、且只针对已探针状态：`enforced` 态方可写隔离生效；`refused` 态写拒绝；`not-run` 态必须写未实测；`not-applicable`（danger）态写无隔离（设计意图）。未探针状态下任何平台的隔离断言句一律不得出现。

因此接线顺序固定为：语义定义（本文档）→ 字段接通 → 文案区分 → 探针缺失显性态，四者齐全方闭合；跳过任一步直接改文案者，不得记为已澄清。

## 5. 接线检查清单（语义行闭合后，实施方逐项打勾）

- [ ] 主机级探针结果与逐请求档位解析的作用域显性写明（§1 末段），不得静默默认。
- [ ] `GET /api/sandbox/mode` 新增 §2 五字段，现有 8 字段语义不变；旧服务端缺失字段时 UI 按 §2 缺失语义处理（缺失 = `not-run`）。
- [ ] 档位变更宣告旧探针结果过期并触发重探；过期 `enforced` 不得展示。
- [ ] 冲突展示按 §3 执行；冲突审计事件四项齐全。
- [ ] Win/mac 行在真机复核前恒标 `not-run`；代码分支推断不得写入探针字段。
- [ ] danger 档位 `probeStatus` 恒为 `not-applicable`，UI 展示无隔离（设计意图），不展示探针通过态。
- [ ] 文案区分只针对已探针状态；未探针状态一律写未实测，不得出现平台化隔离断言。

## 6. 非目标（本项不做）

- 不实施探针本身（exec 路径的真实 bwrap 探针调用已存在，见矩阵 §3；本页定义其结果如何被展示，不新造探针机制）。
- 不改徽标文案（`zh.ts` / `en.ts` 的 sandbox 文案、Badge 组件行为均不动，待语义行闭合后排期）。
- 不改 `/api/sandbox/mode` 现有 8 字段，不改档位解析顺序（项目配置 > 环境变量 > 持久化 store），不改 danger 档位的双重门（项目配置 `allowDanger` + 逐次审批）。
- 不回答 #6B 语义（连接器 env 过滤）与客群判定；与本页无关。

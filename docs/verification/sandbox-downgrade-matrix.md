# 跨平台沙盒降级策略矩阵（第三轮 V3.0 审计 #7，文档交付）

> 来源：第三轮 V3.0 审计 Top 10 第 7 项（`~/workspace/research_notes/ai-ide-audit-v3-20261103/`）。
> 本文档只交付策略矩阵，**不接线**。接线实施门控于审计 #2（Windows 真机结论），
> 在此之前任何代码行为均以现有实现为准，不得按本文档的“待决策”行改代码。
> 本文档与 `platform-matrix.md` 衔接不冲突：Win/mac 在 `platform-matrix.md` 中仍为 NOT_RUN；
> **流水线绿 ≠ 可分发**，信任 verdict（签名 + 人工双击记录）独立于本文档的沙盒语义。

## 0. 总原则（四条，任何一行不得违反）

1. **零静默降级**：任何一次“以为有沙盒、实际没有”的执行都是策略事故。
   降级只能是两种显性形态之一：拒绝（403 + 原因进审计），或明示降级
   （跑了，但审计与响应里如实写“未沙盒化”且 UI 可见）。
2. **策略层与沙盒层独立**：策略层（routes/exec.ts：二进制白名单、deny patterns、
   控制目录守卫、hooks 否决）决定 WHAT 可跑，在所有平台上都生效，与沙盒是否可用无关。
   沙盒层（exec-sandbox.ts / build-sandbox.ts）只决定 WHERE 跑，永不授予策略层拒绝的权限。
3. **实际 tier 永不虚构**：审计与响应里的 `sandbox` 字段只写实际 tier
   （`read-only` / `workspace-write` / `danger-full-access` / `disabled`），
   永不写含糊的 `bwrap`，永不把未沙盒化的执行写成已沙盒化。
4. **例外无全局开关**：任何放行都是逐次（per-run）的，批进审计；不存在“一开全开”的例外开关。

## 1. 现有实现语义（以代码为准，本文档不改变它们）

### 1.1 exec 路径：one-shot exec、交互终端、tool-runner shell.execute（exec-sandbox.ts）

- `read-only` 与 `workspace-write` **要求一个可工作的 bwrap**。
  探针是真实 bwrap 调用（不是版本号字符串），探针失败（非 Linux、bwrap 缺失、
  用户命名空间被禁用）时决策为 `refused=true / SANDBOX_UNAVAILABLE`，
  调用方必须以 403 拒绝该次运行，**永不以无隔离方式跑**。旧的 `none (fallback)` 行为已删除。
- `danger-full-access` 是显性 tier，设计上就是“无沙盒”，永不探针；
  它要求项目 `.ai-factory/sandbox.json` 显式设 `"allowDanger": true`，
  且每次运行须持有人审批票据（`approval_policy=never` 时直接拒绝；
  无任务绑定时须人工 mint 票据后重试）。票据按命令摘要绑定，单次有效。
- `disabled` 是操作员显式关闭沙盒的配置，同样如实上报，不伪装成沙盒化。

### 1.2 构建路径：合并后构建运行器（build-sandbox.ts）

- 与 exec 路径不同：探针失败时构建运行器**回落到无沙盒执行**，
  但同时审计 `SANDBOX_UNAVAILABLE` 并写明探针原因。
  这是“明示降级”而非静默降级——但它**不是沙盒化**，任何 UI 或报告
  都不得把它表述为“在沙盒中构建”。本矩阵第 3 节对该行单独标注。

### 1.3 策略层 deny 清单（所有平台一致，与沙盒可用性无关）

routes/exec.ts 的 DENY_PATTERNS 包括：`rm`（原型中一律禁）、`curl`、`wget`、
`ssh`、`scp`、`sudo`、`su`、`chmod`、`chown`、`dd`、`mkfs`、`mount`、`umount`、
`shutdown`、`reboot`、`halt`、`poweroff`、`kill`、`pkill`、`killall`、fork bomb、
原始磁盘写（`/dev/sda|hda|nvme`）。命中即策略拒绝，与沙盒层无关。

## 2. 风险等级定义（矩阵的行维度）

| 等级 | 含义 | 示例 |
|---|---|---|
| CRITICAL | 策略层 deny 清单命中，或 danger-full-access 命令 | rm、sudo、chmod、磁盘操作、kill、curl/wget 外发、原始磁盘写 |
| HIGH | 沙盒外才有意义的高危操作：写 workspace 之外、改系统配置、装系统级包 | 写 cwd 之外路径、改 ~/.ssh、全局 npm install -g |
| MEDIUM | workspace 内写操作与常规开发命令 | 写 cwd 内文件、项目内 npm install、git 操作 |
| LOW | 只读操作 | 读文件、ls、git status、查询类命令 |

## 3. 降级矩阵（平台 x 风险等级 x 处置）

每行四要素齐全方为完成：**放行主体**（谁批准）、**范围**（放行到哪里）、
**时效**（有效期）、**审计**（记什么）。“状态”列区分已实现与待决策：
已实现 = 现有代码行为；待决策 = 需决策记录 + #2 真机结论后才可接线，
**现阶段不得按待决策行执行**。

### 3.1 Linux，bwrap 可用（已实现，基线行为）

| 风险 | 处置 | 放行主体 | 范围 | 时效 | 审计 |
|---|---|---|---|---|---|
| CRITICAL | 策略拒绝（deny 清单） | 策略引擎（无人工 override） | 不执行 | — | 拒绝原因 + 命中 pattern |
| HIGH | 沙盒内拒绝或 workspace-write 沙盒内执行（按策略） | 策略引擎 + 沙盒 tier | 仅 cwd 可写绑定，/tmp tmpfs，家目录与 /etc 不可见 | 单次运行 | 实际 tier + 命令 + 探针结果 |
| MEDIUM | workspace-write 沙盒内执行 | 策略引擎 | 仅 cwd 可写绑定 | 单次运行 | 实际 tier + 命令 |
| LOW | read-only 沙盒内执行 | 策略引擎 | cwd 只读绑定，唯一可写路径为 /tmp | 单次运行 | 实际 tier + 命令 |

### 3.2 Linux，bwrap 不可用（bwrap 缺失或用户命名空间禁用；已实现）

| 风险 | 处置 | 放行主体 | 范围 | 时效 | 审计 |
|---|---|---|---|---|---|
| CRITICAL | 策略拒绝 | 策略引擎 | 不执行 | — | 拒绝原因 + 命中 pattern |
| HIGH / MEDIUM / LOW（exec 路径） | **拒绝**：403 SANDBOX_UNAVAILABLE | 沙盒探针结论（非人工放行） | 不执行 | — | 探针失败原因原文 + 实际 tier（未沙盒化即不写沙盒 tier） |
| HIGH / MEDIUM / LOW（构建路径） | **明示降级**：无沙盒执行，但审计 SANDBOX_UNAVAILABLE | 构建运行器回落逻辑（非人工放行） | 与无沙盒构建相同的作用域 | 单次构建 | SANDBOX_UNAVAILABLE + 探针原因 + “未沙盒化”显性标记 |
| 任何等级（danger-full-access） | 仅按 1.1 的票据路径（项目 allowDanger + 逐次人审批） | 持票据的人（逐次） | 票据绑定的命令摘要 | 单次有效 | 票据 id + 命令摘要 + risk_level CRITICAL |

### 3.3 Windows x64（当前：NOT_RUN，exec 路径行为 = 探针失败分支）

Windows 无 bwrap，exec 路径探针恒失败，因此当前行为与 3.2 的 exec 行相同；
构建路径同 3.2 的构建行。以下为矩阵行（状态：行为已实现，平台本身未验证）：

| 风险 | 处置 | 放行主体 | 范围 | 时效 | 审计 |
|---|---|---|---|---|---|
| CRITICAL | 策略拒绝 | 策略引擎 | 不执行 | — | 拒绝原因 + 命中 pattern |
| HIGH / MEDIUM / LOW（exec 路径） | **拒绝**：403 SANDBOX_UNAVAILABLE | 沙盒探针结论（非人工放行） | 不执行 | — | 探针失败原因原文 |
| HIGH / MEDIUM / LOW（构建路径） | **明示降级**：无沙盒执行 + SANDBOX_UNAVAILABLE 审计 | 构建运行器回落逻辑 | 与无沙盒构建相同的作用域 | 单次构建 | SANDBOX_UNAVAILABLE + 探针原因 + “未沙盒化”显性标记 |
| 任何等级（danger-full-access） | 仅按 1.1 的票据路径 | 持票据的人（逐次） | 票据绑定的命令摘要 | 单次有效 | 票据 id + 命令摘要 + risk_level CRITICAL |
| HIGH（审计后放行变体） | **待决策，不执行**：审计第 7 项要求“拒绝或审计后放行二选一并留决策记录”；在决策记录落盘 + #2 真机结论之前，本行不生效，不得以“审计后”名义放行高危 exec | 待决策记录（Tan 侧） | 待决策记录中限定 | 待决策记录中限定 | 若将来生效：放行人 + 范围 + 时效 + 票据 id 全量进审计；生效前任何放行均属违规 |

### 3.4 macOS arm64/x64（当前：NOT_RUN，与 Windows 同构）

macOS 同样无 bwrap，exec 路径探针恒失败；矩阵行与 3.3 完全相同
（CRITICAL 策略拒绝；exec 路径拒绝 403 SANDBOX_UNAVAILABLE；
构建路径明示降级 + SANDBOX_UNAVAILABLE 审计；danger-full-access 仅票据路径；
HIGH 审计后放行变体待决策、不执行）。macOS 另有一条分发侧约束（见 platform-matrix.md）：
直接启动二进制会绕过 Gatekeeper，双击检查属于信任门，不得用直接启动冒充双击验证；
该约束与本矩阵的沙盒语义无关，两者不得互相代证。

## 4. UI 明示要求（接线时必须满足，本文档先行规定）

1. 面板显性面必须展示当前平台的实际沙盒状态（可用 / 不可用 / 已显式关闭），
   不得只藏进日志；`disabled` 与 `danger-full-access` 必须以警告形态展示，不得作正常状态。
2. 构建路径的明示降级必须在构建记录与面板中同时可见“未沙盒化”标记；
   只写 SANDBOX_UNAVAILABLE 代码、不展示给用户的实现视为未完成。
3. 拒绝时 UI 必须展示可读原因（探针失败原因原文或策略拒绝原因），
   不得只展示裸状态码或“Not found”类无意义文本。
4. 任何“审计后放行”若将来生效，其放行记录必须在面板中可查（放行人、范围、时效、票据），
   查不到即视为未审计放行。

## 5. 接线门控与复测要求

1. **门控**：接线实施（包括 UI 明示、审计后放行变体若被选中）的前提是审计 #2
   Windows 真机结论落盘；#2 之前只允许本文档交付，不允许改沙盒相关代码行为。
2. **复测矩阵**：接线后按“平台 x 风险等级”逐格实测：Linux（bwrap 可用/不可用）、
   Windows、macOS 各跑 CRITICAL/HIGH/MEDIUM/LOW 四档，断言处置与审计记录
   与第 3 节逐行一致；任一格不一致即接线未完成。
3. **回归钉住**：exec 路径探针失败必须拒绝的语义须有回归测试钉住；
   构建路径明示降级必须审计 SANDBOX_UNAVAILABLE 的语义须有回归测试钉住；
   两者缺一即视为回归保护缺失。

## 6. 待决策记录模板（HIGH 审计后放行变体若被选中时填写）

```text
决策：Windows / macOS 上 HIGH 等级 exec 在无沙盒平台的处置
选项（二选一）：[ ] 维持拒绝（403 SANDBOX_UNAVAILABLE）  [ ] 审计后放行
若选审计后放行：
  放行主体：________________（须为逐次人审批，不得为全局开关）
  范围：________________（命令白名单或路径白名单，缺省为空）
  时效：________________（单次有效；不得为长期有效）
  审计字段：放行人 + 范围 + 时效 + 票据 id + 命令摘要
  生效前提：审计 #2 真机结论编号 __________ + 本记录落盘日期 __________
决策人：__________  日期：__________
```

## 7. 与既有文档的一致性声明

- `platform-matrix.md`：Win/mac 仍为 NOT_RUN；本文档第 3.3/3.4 节描述的是
  代码在探针失败分支下的行为，不是“Win/mac 已验证”的声明。两者不得互相代证。
- `platform-matrix.md` 的“流水线绿 ≠ 可分发”规则同样适用于本文档：
  沙盒矩阵落盘 ≠ 沙盒已接线 ≠ 平台可信分发。
- 若本文档与代码实现出现不一致，以代码实现为准，并须立即修订本文档；
  不得以文档主张覆盖代码的 fail-closed 行为。

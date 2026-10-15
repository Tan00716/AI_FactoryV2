# AT 正式验收资产索引（SPEC_V2 §54，AT-001–AT-064）

> 生成：2026-10-16（Batch 80-2）。基线：`~/workspace/user/files/SPEC_V2.md` v2.0 §54。

## 诚实声明（必读）

本目录下的 `at-*.test.mjs` 是**逻辑层验收（logic-level acceptance），非端到端验收**：

- 它们复用各包的公共 API（`packages/<pkg>/dist/src/index.js` 编译产物），在进程内执行
  `node:test` 断言，覆盖 AT 判定断言的逻辑语义；
- 它们**不**覆盖真实模型调用、真实执行环境、真实生产、真实隔离 Host、真实网络/MCP、
  真实 Worker 进程、真人验收、真实 Electron、50+ 远程 Run 压力——这些维度缺失的 AT
  继续记 `NOT_RUN`（见下表），不冒充通过；
- 运行方式：`cd ~/workspace/ai-factory && npm run test:acceptance`
  （= `node scripts/run-tests-tmp.mjs --test 'docs/testing/v2/at-*.test.mjs'`，走 TMPDIR 隔离 wrapper）。
- 当前主线实测：**tests 121，pass 121，fail 0**（2026-10-16，基线 `1844cd3` 未动——本批未 commit）。

## 已验收：21 项（逻辑层）

| AT | 场景 | 验收文件 | 断言数 | 判定要点 |
|---|---|---|---|---|
| AT-008 | Scout 新工程方法六阶段 | `at-008.test.mjs` | 6 | 六阶段顺序执行全 ok；产物 PROPOSED 不激活；community <8 验证拒绝；IRULE 运行对象字节不变；compare 只读去重 |
| AT-016 | 组织报告传播去重 | `at-016.test.mjs` | 5 | 主管理链正确；菱形横向路径去重；横向循环不风暴；hop 上限精确截断；只走横向报告边 |
| AT-018 | 越级上报 | `at-018.test.mjs` | 4 | security-issue 标 critical；上报记录完整可审计；`evaluateEscalation` 无法被改名屏蔽；未知理由不误报 |
| AT-023 | 无可信证据 Gate 不过 | `at-023.test.mjs` | 4 | trust 未声明默认 UNVERIFIED；无证据 → BLOCKED/MISSING_EVIDENCE；AI/HUMAN/SERVICE 不能自写裁决 |
| AT-025 | 进度权重可复算 | `at-025.test.mjs` | 5 | 确定性可复算；未终验 <100%；父子权重无双计；无 seal 封顶 99.99；无有效证据抛错 |
| AT-026 | 需求 v2 影响分析 | `at-026.test.mjs` | 4 | AC diff；旧审批 STALE；旧证据默认 stale；兼容性检查后未变更 AC 的证据可复用 |
| AT-033 | 模型路由三策略 | `at-033.test.mjs` | 7 | 耗尽 fallback；隐私约束；四维兼容性；STRICT_PROVIDER 未知/已知 reset；ALLOW_COMPATIBLE_FALLBACK；GLOBAL_PAUSE |
| AT-034 | Quota unknown 不编造 | `at-034.test.mjs` | 6 | unknown/stale 不编造百分比；缺半边数据 unknown；有完整数据正常显示（对照）；`UnknownQuotaData` 抛错带码 |
| AT-035 | Watchdog 分类 | `at-035.test.mjs` | 8 | 默认阈值；3 次缺失 SUSPECTED_STALL；可重连/不可重连区分；loop-stagnation；approval-wait 不误判；心跳恢复 RECOVERING；正常 HEALTHY |
| AT-036 | Takeover fencing | `at-036.test.mjs` | 6 | 接管 HUMAN_OWNED；旧 worker 写入被 fence；人工修改有归属；非接管态人工修改拒绝；过期基线拒绝；不虚假接管 |
| AT-037 | Lease 过期接管 | `at-037.test.mjs` | 7 | 单 writer；冲突；过期 → STALE_OWNER；reassign 后旧 token 拒绝；fencing 单调递增；错误 token 续约拒绝 |
| AT-040 | 锁/Lease 序列化 | `at-040.test.mjs` | 6 | 先到获锁后到排队；释放 FIFO 授予；prod env 单持有者；TTL 到期；按 key 隔离；部署单活跃持有者 |
| AT-042 | 独立性拒绝自审 | `at-042.test.mjs` | 6 | 自审拒绝；同 Run 自审拒绝；`reviewWithIndependence` 拒绝；干净对照放行；无合格候选 BLOCKED；有合格 STAFFED |
| AT-043 | QA attempt 保留 | `at-043.test.mjs` | 9 | mandatorySkipped → BLOCKED；缺工具 FAIL；隔离≠通过；全绿 PASS；failed 优先；attempt 全保留；三类失败分类 |
| AT-045 | 凭证不泄漏 | `at-045.test.mjs` | 8 | SecretRef 脱敏；序列化只含引用；Bearer/password=/URL 脱敏；对象脱敏大小写不敏感不突变；UI 导出载荷深脱敏 |
| AT-046 | 审批后修改失效 | `at-046.test.mjs` | 5 | digest 变更 INVALIDATED；失效后载荷不可用；manifest 独立触发；无误伤；历史保留 |
| AT-052 | 预算原子幂等 | `at-052.test.mjs` | 5 | 拒绝不扣款；恰好用完；兄弟超父剩余 BUDGET_EXCEEDED 原子；按父 remaining 扣；孙子从父预留扣 |
| AT-053 | 记忆 scope 过滤 | `at-053.test.mjs` | 4 | 无权跨项目返回 []；撤销 scope 为空；clearance 过滤；crossProjectReusable 标志 |
| AT-054 | 记忆 STALE/CONTRADICTED | `at-054.test.mjs` | 5 | markStale；冲突双向引用；verify 不消 CONTRADICTED；resolve 胜者/败者；权威来源裁决 |
| AT-056 | Eval 独立评分 | `at-056.test.mjs` | 6 | 冲突判定；自评+独评开争议；一致无争议；adjudicate 证据方胜；低置信 ESCALATED；高风险强制独立验证 |
| AT-057 | 组织环拒绝 | `at-057.test.mjs` | 5 | 主管理环拒绝；三段/两段委托环拒绝；applyChange 原子拒绝；无环对照放行 |

## 未验收：43 项 NOT_RUN（缺的真实环境，逐项）

`blocked` 为"缺真实环境"的 26 项（逻辑层单元已跑过）+ 17 项（无可引用的已跑测试）。

| AT | 场景 | 缺的真实环境（NOT_RUN 原因） |
|---|---|---|
| AT-001 | 派工端到端 | 真实仓库、真实测试执行、独立 QA、真实发布与 Outcome 观测 |
| AT-002 | 新目录建 CRM | 真实文件系统、真实依赖安装与构建 |
| AT-003 | 受控 Employee 生命周期 | 真实任务生命周期执行：真实创建、真实退休/保留 |
| AT-004 | QA FAIL 修复循环端到端 | 真实 Diff、独立 QA、旧 Evidence 失效联动端到端 |
| AT-005 | 越权全路径拒绝 | 真实 Shell/MCP/Python 进程的端到端拒绝与审计 |
| AT-006 | 生产发布批准 | 真实生产发布流程 |
| AT-007 | 低风险预授权发布 | 真实发布流水线、progressive rollout、Outcome 观测 |
| AT-009 | MCP 故障注入 | 真实 MCP 服务故障注入 |
| AT-010 | 崩溃恢复 | 真实 Worker 进程崩溃与重启 |
| AT-011 | 脚本越界（真实隔离） | 真实隔离 Host：子进程同约束的真实验证 |
| AT-012 | 路径攻击（真实隔离） | 真实隔离 Host：Junction/Hardlink/UNC/路径替换攻击验收 |
| AT-013 | 网络边界拒绝 | 真实网络边界环境 |
| AT-014 | AI 发现无关问题 | 真实模型 + 真实工具执行环境 |
| AT-015 | 拆解/返工预算链 | 真实执行：预算/Scope 链追踪端到端 |
| AT-017 | reject/rework/reassign | 真实任务执行端到端 |
| AT-019 | 双上司派任务 | 真实多任务并发调度环境 |
| AT-020 | 部署冲突 deny 优先 | 真实生产部署冲突场景 |
| AT-021 | AI 不能改 Human Role | 真实组织运行环境 |
| AT-022 | 递归创建治理 | 真实员工创建与清理执行 |
| AT-024 | 上报去重/防伪 | 真实上报流端到端 |
| AT-027 | 部署未执行不 Done | 真实部署 + Outcome 验证环境 |
| AT-028 | 非发布交付验收 | **真人验收**：真实交付验收流程 |
| AT-029 | Pause/Stop 语义 | 真实 Worker 进程 ACK 联动 |
| AT-030 | Pause 期间监控 | 真实暂停期间的真实监控运行 |
| AT-031 | Emergency Stop | 真实进程与真实外部部署 |
| AT-032 | Quota Hit 路由 | 真实模型 Provider 额度 + 真实 CI |
| AT-038 | 超时重启幂等 | 真实远端 Git/部署服务 |
| AT-039 | 不可逆外部动作 | 真实外部系统 |
| AT-041 | 证据不可篡改（写边界） | 真实 Collector 写边界 |
| AT-044 | 注入内容不升指令 | 真实网络/MCP 执行 |
| AT-047 | Canary 不自动 Promotion | 真实生产流量与遥测 |
| AT-048 | 生产故障恢复/补偿 | 真实生产迁移执行 |
| AT-049 | 回滚需批准 | 真实回滚执行 |
| AT-050 | 业务 AC 真人判断 | **真人验收**：真实业务验收 |
| AT-051 | Provider 全不可用 | 真实 Provider 中断 |
| AT-055 | AI 改自身配置 | 真实模型/技能运行环境 |
| AT-058 | Webhook 去重/验源 | 真实 Webhook 来源 |
| AT-059 | 磁盘满/DB 不可写 | 真实磁盘/DB 故障注入 |
| AT-060 | 备份恢复 | 真实备份恢复执行 |
| AT-061 | 桌面离线/恢复 | 真实 Electron + 真实断网环境 |
| AT-062 | 8 并发/50+ 远程压力 | 50+ 远程 Run 压力环境（§51 Benchmark） |
| AT-063 | 升级不静默切换 | 真实升级场景 |
| AT-064 | 多级组织报告 | 真实多级组织运行 |

**分组汇总**：真实执行环境 16（001/002/003/004/005/010/015/017/019/021/022/024/027/041/063/064）；
真实生产环境 10（006/007/020/030/031/047/048/049/059/060）；真实隔离 Host 2（011/012）；
真实网络/外部服务/MCP/Webhook 6（009/013/038/039/044/058）；真实模型 Provider/技能运行 4（014/032/051/055）；
真实 Worker 联动 1（029）；真人验收 2（028/050）；真实 Electron/桌面 1（061）；50+ 远程 Run 压力 1（062）。
合计 43，64 = 21 + 43 齐全。

## 已知语义注记（非缺陷，验收忠实实现行为）

- **AT-037/leases**：`LeaseManager.acquire` 每次重置 `fencing_token: 1`。因此 A 过期后 B 若用
  fresh `acquire`（而非 `reassign`）会拿到相同数字 token，`validate(A 旧 token)` 不抛；
  "迟到写入被拒绝"在包语义下靠 `reassign` 递增 token 实现。验收文件按该真实语义编写。
- **AT-008/knowledge**：`proposal.kind` 随候选 topic 变化（非固定值），验收只断言 PROPOSED 状态与
  "仅提议不激活"，不锁 kind。
- **AT-043/qa**：`isAllGreen(report)` 不带隔离上下文；quarantine 的 BLOCKED 只出现在带
  `quarantinedMandatory` 的生效 gate 判定上，验收按此真实语义编写。

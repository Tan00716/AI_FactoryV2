# INV 覆盖扫荡（Batch 62-3，基线 2bb5dfb，2026-10-15）

## 方法

- 权威规格 `~/workspace/user/files/SPEC_V2.md` 第 70–104 行 INV-01–INV-35。
- 对照 `apps/server/tests/*.test.ts`（约 90 个文件）+ `packages/*/tests/` 的测试证据。
- 口径：**测试/走查钉死才算覆盖**。"有代码没测试" = 未覆盖。
- 三个并行子任务分段亲读+grep，未改任何文件。

## 结论一览

- **覆盖：24 条**（INV-01/02/04/06/12/13/14/16/17/18/19/20/21/22/23/24/25/27/29/31/32/33/34/35）
- **真实缺口：11 条**（INV-03/05/07/08/09/10/11/15/26/28/30）

---

## 覆盖条目（证据要点）

| INV | 证据要点 |
|-----|---------|
| INV-01 | task-dispatch.test.ts（dispatch 链 DRAFT→WAITING→AUTHORIZED，未授权 403）；authorization-tickets.test.ts（预授权票据）；scheduler-constraints.test.ts（§21.1 九项硬约束先于选择）；model-router-route.test.ts（privacy tier→数据分类）；runtime-tools-allowlist.test.ts（TOOLS 由 operator allowlist 授予） |
| INV-02 | packages/orchestrator/tests/delegation.test.ts（delegation 硬规则：scope 父集子集、预算原子预留、链无环+限深）；delegations-restart.test.ts（ACTIVE→INTERRUPTED 永不自动恢复）；relative-ceiling.test.ts（grant-exceeds-granter）；rbac.test.ts + authority-conflict.test.ts（§8.1 冲突→AUTHORITY_CONFLICT 暂停） |
| INV-04 | packages/approvals/tests/exceptions.test.ts（§23.4 Exception Grant：被覆盖的 gate 记 WAIVED 永不 PASS；BLOCKED 双向不可豁免）；v2-completion.test.ts（未验证 AC/PENDING 审批/未完成依赖各自独立拒绝）；review-independence.test.ts（独立性四元组缺失→400 fail-closed） |
| INV-06 | packages/policy/tests/store-set-guard.test.ts（§23.1 locked rule 非该层及以上 authority 不可改写/删除/解锁）；relative-ceiling.test.ts + needs-human-policy-violation.test.ts（ceiling 拒绝恒成立）；authority-conflict.test.ts（低 rank 指令不获胜） |
| INV-12 | packages/progress/tests/progress.test.ts（computeProgress=100×Σ(w_i×c_i)/Σw_i；c>0 无 evidenceRef 直接拒绝）；dashboard-aocr.test.ts（AOCR 真实计算）；v2-completion.test.ts（final_seal=1 与 DONE 同一事务） |
| INV-13 | packages/core/tests/workflow-v2.test.ts（stage/condition/milestone 三轴分离；rollback 保留历史；finalize 谓词先验+同一事务 DONE+final_seal=1）；v2-completion.test.ts（谓词真正绑定，DB 行不动） |
| INV-14 | packages/security/tests/injection.test.ts（外部内容判 EXTERNAL_CONTENT；override 打标；sanitizeUntrusted 剥离祈使句）；packages/tools/tests/fetched-content.test.ts（外部文本必须带 provenance 信封，无标记 fail-closed）；store-set-guard.test.ts（locked 规则对任何调用者一视同仁）。边界：无"已批准 Skill 主体尝试写安全政策"的端到端用例 |
| INV-16 | packages/tools/tests/executor.test.ts（attempts 日志钉住 principal+capability/argv/cwd/脱敏/exit-code 真值/DENIED 审计）；audit-chain-verify.test.ts + audit-list-contract.test.ts + B51–56 走查（actor/reason/result + hash 链，operator 全链验证） |
| INV-17 | packages/cicd/tests/deploy.test.ts（无 rollback 方法的环境拒绝部署；失败自动回滚并恢复快照）；release-hardening.test.ts（可逆性分类；'forbids fake rollback of irreversible changes'；注释明写 "Code rollback is not data rollback"） |
| INV-18 | packages/employee-factory/tests/governance.test.ts（max_children/max_depth/total cap/并发活跃 cap/allow-list/超限 budget 拒绝）；runtime-run-budgets.test.ts（run-loop 预算校验） |
| INV-19 | operations-startup.test.ts（真实 server 进程 boot→kill→reboot，预置非终态 ops 状态不动）；v2-outbox.test.ts / runtime-checkpoints.test.ts（kill+reboot 持久化）；delegations/org-graph/pipeline/v2-state/runtime-runs restart 测试（状态全在 SQLite） |
| INV-20 | runtime-checkpoints.test.ts（每步一个持久 checkpoint）；runtime-resume.test.ts（未协调的 PENDING step intent 拒绝 resume；版本漂移拒绝；归档项目拒绝）；operations-startup.test.ts（UNKNOWN → MANUAL_RECOVERY_REQUIRED，永不自动重放） |
| INV-21 | packages/leases/tests/leases.test.ts（单写者；reassign 递增 generation+fencing_token，旧 token → STALE_OWNER）；operations-persistence.test.ts（幂等键绑定逻辑动作；'idempotent prepare survives a restart'）；executor.test.ts（'idempotency key prevents re-execution'） |
| INV-22 | packages/factory-control/tests/controller.test.ts（三轴独立；PAUSED 经 ACK 门控；'PAUSE_NEW_WORK and PAUSE_AI_WORK differ'；'FREEZE revokes dev writer leases; safety domain continues'；emergency stop 只 mark external UNKNOWN，且 prohibitions 含 customer production 与 delete workspaces） |
| INV-23 | packages/quota/tests/quota.test.ts（§27.4：额度耗尽只 PAUSE_DEV_DOMAIN，授权的 inflight 确定性工具继续）；incidents.test.ts（只有 pre-authorized runbook 可 auto-mitigate）；first-run-walkthrough-audit-chain-watch.test.ts（审计链 watch 纯确定性，无模型参与）。边界：无"零推理"下 monitor+recovery 串起来的单一集成走查 |
| INV-24 | packages/takeover/tests/takeover.test.ts（quiesce→fence→verify→snapshot→human→return→resume 全流程；fenced-out 的 AI worker 不可再写；human edits 在 HUMAN_OWNED 外/stale base 被拒绝） |
| INV-25 | packages/review/tests/independence.test.ts（13 个 it：身份四元组缺一不可；self-review 拒绝；高风险要求不同 runtime——"same model under another name is not independent"；无合格候选 → BLOCKED）；review-independence.test.ts（HTTP fail-closed）；evidence-v2.test.ts（Gate 求值侧 self-review 拒绝） |
| INV-27 | packages/memory/tests/memory.test.ts（§43.2 schema 默认值；§43.3 先 scope/security filter 再检索；矛盾按来源权威度解决；过期自动 RETIRED；§43.4 assertMemoryNeverAuthorizes 在写入时和独立调用下都拒绝）。诚实注：memory 引擎尚未接入 runtime 上下文装配/prompt 注入路径，"来源在 prompt 侧可见"只在引擎单元层被测 |
| INV-29 | adapter-contract.test.ts（§26.2 十方法契约双 adapter：不支持的方法返回 UNSUPPORTED；getAccountStatus/getQuota 对不可达 codex 报告 source none）；model-router-account.test.ts（未登录→明确报告"未登录"；不可达→null+STUB）；model-router-route.test.ts（capability/privacy 硬约束）；model-router tests（offline 永不入选；无可用模型→明确拒绝） |
| INV-31 | authority-conflict.test.ts（冲突→paused+审计；security_authority BLOCK over manager ALLOW 自动解决；无 last-wins）；packages/policy/tests/authority.test.ts（顺序无关；同级不兼容→AUTHORITY_CONFLICT；升级严格向上）；scheduler-ordering.test.ts（无效权力请求入队前被拒绝） |
| INV-32 | packages/qa/tests/report.test.ts（"skipped/timeout/missing-tool/infra ≠ PASS"）；classify.test.ts + loop.test.ts（UNKNOWN/ENV/INFRA 路由给 human）；workflow-v2.test.ts（finalize 在 condition 非 ACTIVE 时拒绝；直接写 DONE 被拒绝） |
| INV-33 | workflow-v2.test.ts（finalize 谓词先验+同一事务 DONE+final_seal=1）；data-layer-gates.test.ts（§16 VERIFIED_DELIVERY：eligible category+HUMAN 授权→成功并记录 N/A 依据；生产软件类别即使有 HUMAN 授权也拒绝）；release-hardening.test.ts（N/A with justification passes；final re-check 捕获 drift）；v2-gate-authorization.test.ts + v2-transitions.test.ts（REVOKED/WAITING/缺证据/STALE 证据拒绝晋级） |
| INV-34 | packages/progress/tests/progress.test.ts（失效降低进度 34%→22% 并记录原因；失效不能提高完成度）；evidence-v2.test.ts（append-only 失效；reExecute 新 lineage）；evidence-version.test.ts（版本 pin 往返；旧行读作 null）；workflow-v2.test.ts（回滚后 RELEASED 历史保留、当前 ROLLED_BACK、Outcome Gate 失效） |
| INV-35 | packages/autonomy/tests/decide.test.ts（low risk 自动执行）；approval-bridge.test.ts（auto 动作无需 approval）；escalation.test.ts（恰好八个 §81 触发器，每个生成完整升级记录；security-issue/policy-violation/irrecoverable-env-error 标 critical）；needs-human-*.test.ts（run emission/brute-force/deploy-risk/irrecoverable-env-error 含 HTTP 路径/policy-violation/requirement-ambiguity/restart 全覆盖）；decide 侧 high/critical 需人工批准、unknown mode fail-closed |

---

## 真实缺口清单（11 条）

### G1 — INV-03：Board 拖拽同 API 负向测试（小）
- **spec 章节**：§18（Workflow State Machine），§18.2 "Board 拖拽也调用同一 Transition API，Human 不绕过不变量"。
- **当前状态**：v2-transitions.test.ts 钉死合法 transition/非法 jump 422/未 pin 需求 fail-closed/缺证据拒绝；v2-gate-authorization.test.ts 钉死引擎读任务自身授权轴。但**无测试钉死"不存在直接写状态字段的路径"**（如 PUT task stage 直写被拒、board 拖拽走同一 API）。
- **建议验证**：加负向测试，断言任何路由都不接受裸 state/stage 写入；断言 board 拖拽调用的端点与 Transition API 是同一路径。

### G2 — INV-05：merge queue / build-runner 的 git 子进程能力门
- **spec 章节**：§23（Policy、Capability 与 Approval），§36（Git、Candidate 与变更审查）。
- **当前状态**：packages/policy/tests/permissions.test.ts（capability 引擎完整）；packages/tools/tests/executor.test.ts（执行面统一，按 action+resource 不认 tool 名）；tools-execute.test.ts（shell 路径）；rbac.test.ts（API 路径）；mcp-cross-process.test.ts（MCP 路径）。但 **§36 merge queue 的 git 实际执行路径（merge queue / build-runner 里的 GitRepo 子进程）无测试钉死"经过同一 capability 门"**——分类存在、executor 统一了工具路径，git 执行路径未被钉死。
- **建议验证**：构造无 git.push grant 的 principal 走 merge queue，断言被拒；构造 build-runner 无 git grant 的场景，断言同 verdict。

### G3 — INV-07：发现→待派工票据路径
- **spec 章节**：§12（Management Runtime），§17.3（Proposal 状态机）。
- **当前状态**：后半（不能凭发现扩大执行范围）被钉死——packages/core/tests/scope-checker.test.ts + subtask-scope.test.ts（超 root 范围提案 422 + 结构化 violations 且不创建任何东西）。但前半 **"普通发现可创建待派工票据"** 未被钉死：全仓库无测试覆盖 discovery/finding → 创建 DRAFT 或 WAITING_HUMAN_DISPATCH 票据的路径（无 reportFinding/createTicket API，§17.3 Proposal 状态机无测试）。
- **建议验证**：加测试断言一次普通发现经固定入口产生 WAITING_HUMAN_DISPATCH 票据、而非直接开 run。

### G4 — INV-08：专家创建 / QA 自动的政策门
- **spec 章节**：§10（AI Employee），§13（Task Squad），§38（QA Organization）。
- **当前状态**：范围内子任务自动进行被钉死（subtask-scope.test.ts、subtask-inheritance.test.ts、delegation.test.ts 预算原子预留、runtime-run-budgets.test.ts 预算真实执行）。但 **"专家创建"和"QA"两项自动进行无测试**：§10.3 task-scoped 专家、§13 Task Squad、QA 自动触发——无任何测试覆盖自动创建/自动 QA 的政策门。
- **建议验证**：专家创建受 ceiling+预算约束的测试；review 接受后 QA 自动入队的测试。

### G5 — INV-09：产品方向默认由 Human 决定
- **spec 章节**：§3.2（AI 提案 / Human 决定产品方向、预授权目标类别）。
- **当前状态**：前半（生产事故/恢复按预授权政策自动执行）被钉死——packages/incidents/tests/incidents.test.ts（只有 preauthorized: true 的 runbook 可 auto-mitigate；approvalConditions 门控）。但后半 **"产品方向默认由 Human 决定"无任何测试钉死**。
- **建议验证**：构造一次产品方向变更请求，断言无人类授权时被拒或转 Proposal/HUMAN_OR_POLICY_DECISION。

### G6 — INV-10：RunManifest 缺版本 pin + 员工版本实体
- **spec 章节**：§10.1（Run 固定版本）。
- **当前状态**：政策版本化被钉死（policy-versions-restart.test.ts）、需求版本被钉死（requirements-persistence.test.ts）、技能版本被钉死（packages/skills/tests/skills.test.ts）、manifest 对账被钉死（runtime-manifests.test.ts）、delegation pin requirement_version 被钉死。但 **`RunManifest`（packages/db/src/run-manifests.ts）没有 employee_version / organization_version / policy_version / requirement_version 字段**——§10.1 要求 "Run 固定 employee_version + organization_version + resolved_instruction_manifest + model_profile + policy_version"，manifest 只 pin 了 model、contextManifestHash、budgetLimits、grantedTools。另：员工版本化实体本身无测试（employee-factory 只有治理/ceiling 测试）。
- **建议验证**：给 RunManifest 加版本 pin 字段 + 测试断言；加员工版本实体测试。

### G7 — INV-11：Release↔需求版本关联
- **spec 章节**：§16（Requirement 是 First-Class Artifact），§41（Production 发布）。
- **当前状态**：Requirement、Code、Test、Evidence 的版本关联被钉死（requirements-links.test.ts、v2-transitions.test.ts、requirements-persistence.test.ts、git-merge-evidence-36.test.ts）。但 **Release→需求版本的关联无测试**：packages/cicd/tests/release.test.ts 覆盖了门控发布流（审批→快照→健康检查→回滚），但无测试断言 Release 记录其目标需求版本、或"证据 pin 与 release 目标版本不一致时无兼容性声明则拒绝"。
- **建议验证**：release 记录 requirement_version；版本错配无兼容性声明时拒绝晋级的测试。

### G8 — INV-15：Agent 工具路径 shell.execute 无 confinement 门控（已知硬门槛，文档在位）
- **spec 章节**：§7（Workspace、完整 Shell 与真实隔离），§7.3/§7.5。
- **当前状态**：packages/security/tests/isolation.test.ts 在单元层钉死了 fail-closed 门（UnverifiedBackend → CONFINEMENT_UNAVAILABLE）+ 路径威胁分析；build-sandbox.test.ts 验证了构建路径走真实 bwrap 沙箱。但 **Agent 面向的工具路径 `POST /api/tools/execute` → createServerToolRunner（apps/server/src/tool-runner.ts）对任意 principal+capability 直接在宿主执行 shell.execute，只有 deny-pattern/白名单/cwd 解析等字符串策略，无任何 confinement 验证**——这正是 §7.3 明说不足、§7.5 要求 fail-closed 的东西。而 `/api/exec` 路由对非 human shell 硬拒 CONFINEMENT_UNAVAILABLE（apps/server/src/routes/exec.ts:338），但 (a) 没有任何测试钉住这个拒绝，(b) tools/execute 路径完全绕过它。
- **建议验证**：服务端测试断言非 human 主体经 `/api/tools/execute` 调 shell.execute → CONFINEMENT_UNAVAILABLE（除非配置了 verified backend）；把 runner 接到 assertConfinementForAutonomousShell。

### G9 — INV-26：预发送 prompt 密钥扫描 + Git commit 密钥扫描
- **spec 章节**：§46（Security、Secrets），§46.2 "输入发送前也检查"。
- **当前状态**：输出侧被钉死（secrets.test.ts metadata-only、terminal-cross-chunk-redaction.test.ts 跨 chunk 脱敏、redaction-monitor.test.ts、first-run-walkthrough-redaction*.test.ts、packages/security/tests/credentials.test.ts、memory 写入守卫）。但两个输入侧缺口：(1) **Prompt 维度**：packages/runtime/src/runner.ts:133 的 adapter.invoke({ prompt: buildPrompt(agent, task), ... }) 直接发送，无任何预发送扫描；packages/memory/src/guards.ts 的 scanForSecrets 只被 MemoryStore.write 调用，未接入 runtime invoke 路径；无测试钉住预发送检查。(2) **Git 维度**：packages/git/src 中无任何 secret 扫描——commit/diff/push 前无预提交检查。
- **建议验证**：在 invoke 路径加 scanSecrets(prompt) 守卫 + 单元测试（prompt 含哨兵密钥 → 拒绝发送并审计）；git broker 在 commit/push 前跑一次 secret 模式扫描，测试钉住"含密钥 diff 拒绝提交"。

### G10 — INV-28：§45.4 自动治理无代码无测试
- **spec 章节**：§45（Evaluation），§45.4 自动治理三项行为。
- **当前状态**：自改进生命周期被钉死（packages/evaluation/tests/proposals.test.ts：locked domains 在创建时拒绝，即使提交者是 human:cto；loop.test.ts：阶段严格按序、VERSION 固定版本、受限激活要求非空 canary scope、INDEPENDENT_EVAL 拒绝 training-selection 样本；harness.test.ts：seal 后篡改拒绝、train/holdout 分离）。但 **§45.4 自动治理三项行为——"Policy 自动降低自主权、禁用缺陷版本、切换已批准 Fallback"——在代码中只剩 packages/evaluation/src/loop.ts:268 的注释**（"Running tasks stay on pinned versions unless explicitly migrated"），没有任何函数/测试实现或钉住它们。
- **建议验证**：为 auto-governance 写一个策略函数（输入评估结果 → 输出降级/禁用/切换决策）+ 单元测试 + 一个端到端走查（失败版本被自动禁用而运行中任务保持 pinned）。

### G11 — INV-30：云模型调用未建模为受控数据外发事件
- **spec 章节**：§26（Model Registry、Adapters 与账号）。
- **当前状态**：路由侧被钉死（model-router-route.test.ts：privacy 维度真实——sensitive 数据拒绝非本地候选；dataClasses 列表优先；fallback 不得跨越数据分类）。但 INV 的核心主张 **"发送给云模型属于受控数据外发"没有被建模为显式的授权/审计事件**——没有 DATA_EXPORT 授权票、没有发送前导出许可门、没有"prompt X（数据分类 Y）已发送给供应商 Z"的审计记录。控制只隐含在路由资格里，且与 G9 的 prompt 预发送扫描同源。
- **建议验证**：在 invoke 路径加显式的数据导出授权门（路由决策 + 审计记录 dataClasses→provider），测试钉住"云调用需导出授权、本地调用豁免、越分类调用拒绝"。

---

## 优先级建议（子任务共识）

1. **G9（INV-26）**：预发送 prompt 密钥扫描——与无测试生产环境并列最危险的诚实缺口；实现成本小（scanSecrets 已存在于 memory guards，只需接入 runtime invoke 路径）。
2. **G8（INV-15）**：已知硬门槛，文档在位；tools/execute 路径绕过 /api/exec 的 CONFINEMENT_UNAVAILABLE——这是 spec 明说的不足，不是意外。
3. **G6（INV-10）**：RunManifest 缺版本 pin——§10.1 明确要求，manifest 字段缺失是具体可修复的代码缺口。
4. **G10（INV-28）**：§45.4 自动治理——注释级承诺，无代码。
5. 其余 G1/G2/G3/G4/G5/G7/G11：负向测试或新门建模，按验证成本排序推进。

## 环境卫生注记

- 本扫荡为只读分析，未修改任何文件，未 commit。
- 61 个批的主要覆盖章节：§23、§27/§29/§30、§32、§33、§36、§58、§81。
- 正式 AT-001–AT-064 测试资产仍不存在（SELLABLE_CHECKLIST 持续记录），AT 场景不得声称已验收。

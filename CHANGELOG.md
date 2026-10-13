# Changelog

## [未发布] Batch 37 — MCP 真实握手 / build-sandbox 沙箱 / 可售清单更新 / Batch36 独立复核

- **Batch 36 独立复核（37-1）**：三项实质声明全部成立（`gap-audit/REAUDIT_BATCH36.md`，零产品代码改动）：§81 needsHuman 发射路径（14/14 + 4/4 + 1/1 真 SIGKILL：insert-only、条件 resolve、hook 只在 OPEN 触发一次、recipient null 诚实、/resolve 永不消解）、走查第四版（1/1，复核人亲跑 2/2，F10–F13 如实）、可售清单改动与 35-4 建议逐条对上。**偏差 0 处**。
- **MCP 真实第三方服务器握手（37-2）**：关闭长期 KNOWN_LIMITATIONS（"MCP Registry 有实现，但未接入真实 MCP 服务"）。`packages/mcp` 新增 `StdioMcpConnector`（真实 stdio 传输：newline-delimited JSON-RPC 2.0 over `node:child_process`，零外部依赖）：initialize 提议客户端协议版本、只接受调用方列出的版本（否则抛协议错误不伪装可用）、server-to-client 请求回 -32601、通知读后丢弃。主线亲验：与 npm 官方 `@modelcontextprotocol/server-filesystem@1.0.0` 完成真实握手——`performHandshake` 协商出 `2025-11-25`（`secure-filesystem-server@1.0.0`），`tools/list` 14 个真实工具，`tools/call read_text_file` 读到真实文件内容（`packages/mcp/tests/real-handshake.test.ts` 2/2）。实现中抓到真缺口：真实服务器回答的 `2025-11-25` 不在客户端旧版本列表里，connector 如实拒绝伪装可用——已把该真实版本加入 `CLIENT_PROTOCOL_VERSIONS`（提议顺序不变）。诚实 skip 合同：无真实服务器（`MCP_TEST_REAL_SERVER` 未设且 npx/registry 不可达）时测试大声 skip 不伪装通过。
- **build-sandbox（37-4）**：关闭"构建 runner 不是沙箱"。本机隔离手段普查：`bwrap`/`firejail`/`docker`/`podman`/`nsjail` 均未安装；`unshare` 有但非 root 连 user namespace 的 uid_map 都写不了（VM seccomp/LSM 限制）；从 archive.ubuntu.com 直接下载 `bubblewrap_0.9.0-1ubuntu0.3_amd64.deb` 安装成功，root 下全功能亲测（文件读写隔离、网络隔离、逃逸写入失败）。实现 `apps/server/src/build-sandbox.ts`：`sandboxConfigFromEnv()`（`FACTORY_BUILD_SANDBOX` 默认开/`0` 显式关、`FACTORY_BUILD_SANDBOX_NETWORK` 默认隔离/`1` 放开、`FACTORY_BUILD_SANDBOX_RO_BINDS` 默认 `/usr,/opt`、`FACTORY_BWRAP_BIN` 测试覆盖）、`probeSandbox()` 真实 bwrap 探针（非版本号，按 binary 缓存）、`buildSandboxArgv()`（`--unshare-user/ipc/pid/uts/cgroup-try`，网络默认 `--unshare-net`，只读 `/usr`/`/opt`/`/bin`/`/lib`/`/lib64`，`--dev /dev`，`--tmpfs /tmp`，`HOME=/tmp`，唯一可写绑定工作区→`/work`，`--die-with-parent`）、`runBuildCommand()` 决策树（关闭→旧行为无审计；探针成功→沙箱执行+`BUILD_SANDBOXED` 审计；探针失败→`SANDBOX_UNAVAILABLE` 审计带探针原因+诚实回退旧行为）。`build-runner.ts` 接入（`BuildRunnerConfig.sandbox?` 可选，老字面量不受影响）。测试 `build-sandbox.test.ts` 15/15（沙箱内构建成功+文件落盘主机可见、写 `/etc` 失败且宿主 `/tmp` 不可见、宿主 loopback 不可达、回退审计+仍执行、关闭无审计）。抓到真坑：探针/argv 缺 `/lib64`→动态链接器缺失→ENOENT（已修：探针与真实 argv 共用 `sandboxRoBindArgs`）。边界：best-effort 隔离层；"只对信任仓库启用"运维姿态不变；digest/SBOM/证据逻辑未动；多机未做。
- **可售清单更新（37-3）**：36-3 实际已在 36-2 完成后落地，needsHuman 条目并非过时（"§81 其余七个触发器无发射点（'ai-disagreement' 已于 Batch 36 经 AUTHORITY_CONFLICT OPEN 发射并落库）"已如实写明）；纠偏两个事实性条目：C 测试基线→`05a19e6`（2449/2449、311/311）、独立复核→Batch 22–35（REAUDIT_BATCH3[0-5].md）。Tan 侧硬卡点一条没动。
- **测试基线（主线亲验）**：构建 0 错误；包套件 2449/2449（real-handshake 2 条在无 `MCP_TEST_REAL_SERVER` 环境大声 skip，合同如此；主线亲手用真实官方服务器验证 2/2）；服务端全套 311 → 326（+15：build-sandbox）；desktop tsc 0；smoke:boot OK。

## [未发布] Batch 36 — §81 needsHuman 发射路径 / 走查第四版 / 可售清单更新 / Batch35 独立复核（在途）

- **Batch 35 独立复核（36-1）**：三项实质声明全部成立（`gap-audit/REAUDIT_BATCH35.md`，零产品代码改动）：§8.2 任务范围（10/10：超 taskScope 被拒+审计、缺席跳过不编造、空 scope 授零、granter∩taskScope 交集）、§9.4 org 快照（10/10 + 2/2 真 SIGKILL：append-only 单调、GENESIS、原样水合）、可售复验抽查（A BLOCKED/CI scope/§81 无发射点的代码依据如实）。**偏差 0 处**。

- **§81 needsHuman 升级形状（36-2）**：关闭 34-4/35-4 如实记录的缺口（`packages/autonomy` 的 `needsHuman()` 有实现和测试，但无任何服务端发射点、无存储）。SPEC 语义：SPEC §81（"HUMAN SHOULD BE AN EXCEPTION HANDLER"）的升级条件是八个触发器（需求歧义/策略违规/重复失败/预算超限/高风险部署/安全问题/不可恢复环境错误/AI 分歧）；§8.1 要求两个同等有效且不兼容的指令进入 AUTHORITY_CONFLICT 并**升级**到严格更高等级的人工。实现：唯一确定性发射点 = AUTHORITY_CONFLICT 进入 OPEN（同级不兼容指令，§81 的 'ai-disagreement' 触发器——双方指令同等有效且不兼容，正是 AI 分歧的形状）。`AuthorityConflictRegistry` 新增可选 `onConflictOpened` hook（只在 OPEN 创建时同步触发一次；自动裁决/attach/supersede 永不触发）；服务端 `initAuthorityRoutes(fdb)` 接线：`needsHuman('ai-disagreement', …)` 构造 §81 记录 → `needs_human_upgrades` 表写透（老库自动建表，双实现对拍），写透失败审计 `NEEDS_HUMAN_PERSIST_FAILED` 不回滚冲突记录。行是终局记录：**永不自动消解**（authority /resolve 不碰本表），人工经 `POST /api/needs-human/:id/resolve` 标记 'acknowledged'/'resolved'（终端行再解 409 `NEEDS_HUMAN_ALREADY_TERMINAL`）；open 行跨重启原样水合（无可降级）。边界：其余七个 §81 触发器无发射点（本批不发明）；recipient 为 null（server 只有粗粒度 token RBAC，无具名人类账号——如实记 requiredDeciderLevel 而不编造人）；registry 内存的冲突重启丢失，未决升级行仍保留（行内带冲突快照）。测试：`packages/db/tests/needs-human-upgrades.test.ts` 14/14（双实现对拍、insert-only、条件 resolve、终端永不重写、腐坏大声、老库建表、跨 reopen）、`packages/policy/tests/authority-hook.test.ts` 4/4（只在 OPEN 创建时触发一次）、`apps/server/tests/needs-human-restart.test.ts` 1/1（真 server：OPEN→升级行+`NEEDS_HUMAN_RAISED`审计、conflict resolve 后行仍 open、真 SIGKILL 重启后存活、人工消解写透+`NEEDS_HUMAN_RESOLVED`、终端再解 409）。实现中抓到两个测试 bug（memory store 从不解析 JSON——腐坏大声是 SQLite 读契约；FactoryDatabase 旧库模拟要用全 schema+DROP 表，不能用裸 builds 表）。

## [未发布] Batch 35 — §8.2 任务范围维度 / §9.4 org 快照历史 / 可售清单增量复验 / Batch34 独立复核（在途）

- **Batch 34 独立复核（35-1）**：三项实质声明全部成立（`gap-audit/REAUDIT_BATCH34.md`，零产品代码改动）：包层 36/36（management-reports 14/14、organization-relationships 7/7、policy-versions 11/11、report-loadsnapshot 4/4）、服务端真 SIGKILL 重启 e2e 3/3、服务端全套回归 307/307。逐项亲证（saveReport 纯 INSERT + WHERE 状态条件整行替换、§9 边表权威带上 nodes 的诚实决策、registerPolicyVersion 无 update/delete API + 4 字段确实未连线）。**偏差 0 处**。

- **§9.4 org 版本快照历史落库（35-3）**：关闭 34-3 如实记录的缺口（此前只有 OrgGraphV2 的内存 `Snapshot[]`，重启丢失；CURRENT 图 34-3 已落库）。SPEC §9.4 确切要求："图变更为事务和版本…删除/退休使用引用保留与 tombstone，历史 Run 继续能解析当时的组织版本"。实现：`org_version_snapshots` 表（老库自动建表；memory/SQLite 双实现对拍）。每次持久化变更写透 append-only 快照（`NODE_ADDED`/`EDGE_ADDED`/`EDGE_REMOVED`；`graph_version` 按库单调首行 = 1，单 `BEGIN IMMEDIATE…COMMIT` 取 max+1，`UNIQUE(graph_version)` 仲裁并发写入有界重试——Batch 26 模式）；每行携带该版本的全图 JSON（nodes + edges），是 OrgGraphV2.resolveAt 的持久等价；服务端 `POST /api/org/nodes`、`POST /api/org/relationships`、`DELETE /api/org/relationships/:id` 成功后写透（失败审计 `ORG_SNAPSHOT_PERSIST_FAILED` 不回滚已落盘的变更——审计是历史缺口的记录）。`GET /api/org/snapshots`（viewer，newest-first 列表：snapshot_id/graph_version/change/actor/created_at + node/edge counts）与 `GET /api/org/snapshots/:id`（viewer，返回该版本的全图；404 缺失；腐坏行 500 `ORG_SNAPSHOT_CORRUPT`）。读面 corrupt 行逐行大声跳过（`listSnapshotIds` 永不解析 graph_json——34-3 的 listNodes 同口径）。启动水合：快照是终局记录，原样水合不降级（`ORG_SNAPSHOT_HISTORY_HYDRATED`）；pre-Batch-35 老库启动时写一行 `GENESIS` 快照记录真实当前状态（记录所见、不发明历史）。测试：`packages/db/tests/org-version-snapshots.test.ts` 10/10（双实现对拍：单调版本、newest-first、GENESIS、深拷贝、腐坏大声失败、非法输入拒绝、重复 id 拒绝、跨 reopen 续号、老库建表、双连接并发无跳号无碰撞）、`apps/server/tests/org-snapshots-restart.test.ts` 2/2（真 server：变更→快照→resolve 历史版本、真 SIGKILL 重启后历史存活、腐坏行跳过+审计、GENESIS 老库启动快照）。实现中抓到自己的测试 bug：harness 的 memory/close 删了 sqlite 连接还开着的共享目录（各实现独立目录后全绿）与 list() 首腐坏行即抛（读面改走 id 逐行降级）。
- **§8.2 任务范围维度并入相对上限（35-2）**：关闭 32-3 如实标注的缺口。`enforcePolicy` 在 §19 绝对检查（顺序不变、先行）与 granter 集合检查之外新增第 6 步任务范围检查：`CreationRequest.taskScope`（§12.2 scope-token 形式）。requested tools/permissions 必须被 taskScope 的 `tool:<name>`/`permission:<name>` tokens 覆盖；`project:`/`path:` 等 domain tokens 只记来源、不封口 capability；缺席 → 跳过（绝不编造）；存在（含空数组）→ 严格子集（空 scope 授零）。两个相对维度是串行子集检查 = §8.2 "有效权限取所有限制交集"（requested ⊆ granter ∩ taskScope）。失败抛 `grant-exceeds-task-scope`，抛之前经注入 sink 写 `TASK_SCOPE_CEILING_DENIED`（audit intent actor=granter；`GovernanceAuditSink` 成为 union）；服务端 `/api/workforce/employees` 的 sink 分动作写入哈希链审计，并接受可选 body 字段 taskScope（收紧用，不放宽）。`createEmployee` 经 `spec.taskScope` 映射。测试：`packages/employee-factory/tests/task-scope-ceiling.test.ts` 10/10（超任务范围被拒+审计 intent、权限超 scope 被拒、交集内通过、缺席跳过、granter 先行（两维皆超时报 grant-exceeds-granter）、绝对先行、空 scope 授零、domain tokens 不封口、createEmployee 两路接线）；包全套 47/47（含既有 relative-ceiling 9/9、governance/factory 零回归；32-3 老测试的 sink 类型跟随 union）。边界：taskScope 与 requestedBy 同属请求声明值（workforce 路由既有信任模型，未改）；组织上限维度仍由 §19 绝对检查承载。

- **测试基线（主线亲验）：构建 0 错误；包套件 2431 → 2449（+18：needs-human-upgrades 14、authority-hook 4）；服务端全套 309 → 311（+2：needs-human-restart、walkthrough-b36）；desktop tsc 0；smoke:boot OK。
- **可售清单增量复验（35-4）**：`gap-audit/SELLABLE_REVERIFY_BATCH35.md`（增量报告，引用 Batch 30 不重复全文）。结论口径：翻绿 5 项（B 缺口从 7 大幅收敛——pipeline 落库、/api/builds、AUTHORITY_CONFLICT、§5 相对上限、§48.2 全部落库、§6.1 记录/Clone/模板/知识 9 类）；硬卡点仍在 Tan 一侧或环境项（真实模型回路仍 BLOCKED 卡 Codex 登录；桌面分发 Linux OK、Win 无构建环境/Mac 需本机/签名零配置；许可证/定价/渠道待 Tan）；剩余真实缺口（§81 needsHuman 无服务端发射点——仅 §8.2 任务范围维度并入 enforcePolicy（本批 35-2）、真实隔离 Host、Windows 工具探测、MCP 真实握手、merge 多机、SBOM attestation null、桌面真人验收）；CI 因 workflow scope 仍从未运行。总结论：**仍是"可运行的原型 + 持续收敛"，不是可交付产品**。

## [未发布] Batch 34 — management_reports / organization_relationships / policy_versions 落库 / Batch33 独立复核（在途）

- **Batch 33 独立复核（34-1）**：六项实质声明全部成立（`gap-audit/REAUDIT_BATCH33.md`，零产品代码改动）：db 三个新测试文件 25/25、templates-registry 8/8、服务端真 SIGKILL e2e 12/12（合计 57/57）。逐项亲证（全 nullable 迁移、真 git clone argv、内置模板钉死、知识 9 类口径、escalations/proposals append-only/insert-only + 与 AUTHORITY_CONFLICT 无发明连线）。**偏差 0 处**。附注：33-3 原 worker 在交付前 runtime 中断（报告未送达），但在途文件完整落盘——收尾验证由新 agent 亲跑完成，本复核在其基础上独立重跑确认。
- **§48.2 policy_versions 落库（34-4）**：关闭扫荡的 §48.2 实体清单中的 policy_versions。审计结论（先审计后动手）：SPEC §48.2 Authorization 域的 `policy_documents`/`policy_versions` 是政策文档本身的版本化记录；代码里存在的 4 个 `policy_version` 都是独立形状（approvals 的 per-approval 字符串字段 §23.3、escalations 的 per-escalation 字符串、projects 的 §6.1 字符串字段、deployments 的 opaque policySnapshot）——**标签不是文档**，本批不改动、不连线（写明了，不发明）。实现：`policy_versions` 表（`policy_id, version` 复合主键，老库自动建表；memory/SQLite 双实现对拍）。`registerPolicyVersion` append-only：在单 `BEGIN IMMEDIATE` 事务内取 max+1（UNIQUE(policy_id, version) 仲裁并发写入，有界重试）；version 是 per-policy 单调整数（从 1 起，调用方永远不能指定版本号——API 无法重排历史）；published 版本永不可改——`CURRENT` 是派生状态（最高版本），从不回写旧行；content 对 store 不透明，contentHash = sha256(精确字节)。服务端：`POST /api/policy/versions`（operator，`POLICY_VERSION_REGISTERED` 进哈希链审计；body 错形 400）+ `GET /api/policy/versions[?policy_id=]`（viewer，newest-first，status 派生）+ `GET /api/policy/versions/:policyId/:version`（viewer，404 缺失）；读 viewer、写 operator 走默认门控。测试：`packages/db/tests/policy-versions.test.ts` 11/11（双实现对拍：从 1 递增、跨 policy 独立、v2 发布后 v1 字节不变、无 update/delete API、status 派生、newest-first、深拷贝、非法输入大声、双连接顺序写入无跳号、腐坏行大声失败、老库建表 + 跨 reopen 续号）、`apps/server/tests/policy-versions-restart.test.ts` 1/1（真 SIGKILL 重启：v1/v2 跨重启可读且字节不变、v3 续号单调、v1/v2 行不被 v3 改写、400 错形、审计链含 3 条 POLICY_VERSION_REGISTERED）。测试中抓到自己的 bug：派生 status 的快照 pin 点错（v2 发布后 v1 的 CURRENT→SUPERSEDED 是预期派生，不是改写）——pin 点改为 v2/v3 发布后的 GET 快照。边界：approvals/escalations/projects 的 policy_version 字符串字段保持原意；§48.2 剩余 management_reports、organization_relationships 未动（兄弟批次在途）。
- **organization_relationships 落库（34-3）**：关闭 31-4 扫荡的 §48.2 Organization 域缺口。`organization_nodes` + `organization_relationships` 表（老库自动建表，双实现对拍 `InMemoryOrgGraphStore` / `SqliteOrgGraphStore`；nodes 一并落库——没有端点节点的边跨重启不可解析）。saveNode/saveEdge upsert（saveEdge upsert 承载 retire 时的 valid_to 关闭语义），removeEdge 硬删除并报告；拷贝契约；腐坏 identity_json 大声失败。服务端 `/api/org/*`：`GET /api/org/nodes[?org_id=]`（读 viewer）、`POST /api/org/nodes`（409 NODE_EXISTS）、`GET /api/org/relationships`（读 viewer）、`POST /api/org/relationships`（先在从落盘行重建的 scratch OrgGraphV2 上跑 §9.2 校验——端点存在/不跨 org/无自边/单 primary/primary 无环，违规则 409 带 domain code，DB 永不见被拒边；写透失败 503 + `ORG_PERSIST_FAILED` 审计）、`DELETE /api/org/relationships/:id`（404 未知）。读 viewer、写 operator（auth gate 默认）。语义：valid_to 为 NULL 的边是**进行中的关系**不是在途进程状态——重启后原样水合，**不降级**（与 delegations 不同）；corrupt node 行启动与读取时大声跳过（`ORG_NODE_CORRUPT` 审计，一坏行不遮其余）；§9.4 版本快照历史仍在内存，只持久化 CURRENT 图。edge id 省略时服务端生成 `orgedge-<uuid>`（domain 的 `edge-<n>` 计数器每进程重置，跨重启会撞号，HTTP 面永不用）。actor 调用方断言（默认 SERVICE），记入审计。测试：`packages/db/tests/organization-relationships.test.ts` 7/7（双实现对拍、upsert/删除语义、腐坏大声、跨 reopen、老库建表、listNodeIds 容错读）；`apps/server/tests/org-graph-restart.test.ts` 1/1（真 server：节点 409、边 ENDPOINT_NOT_FOUND/MULTIPLE_PRIMARY_MANAGERS/CYCLE_DETECTED 409、删除 200/404、真 SIGKILL 重启后节点与边全在、valid_to=null 不降级、审计含 ORG_GRAPH_HYDRATED/NODE_ADDED/EDGE_ADDED/EDGE_REMOVED、corrupt 行注入后 boot 仍活且 ORG_NODE_CORRUPT 在场）。边界：`/api/org/nodes` 无 update/retire 面（tombstone 只读）；valid_to 关闭走 saveEdge upsert（DB 层能力在，HTTP 未暴露 retire）；HTTP 面无 MANAGES 投影端点（domain 纯函数，客户端可算）。

- **management_reports 落库（34-2）**：关闭 §48.2 实体清单中的 management_reports。审计结论：落盘前 `ReportLog`（`packages/comms/src/report.ts`）是纯进程内存 `Map` + per-task `lastSequence`，重启不仅丢报告、连 sequence 单调守卫也重置。`management_reports` 表（老库自动建表；`packages/db/src/management-reports.ts`，memory/SQLite 双实现对拍）：submit insert-only（重复 report_id 大声失败），decide 是条件整行替换（只重写仍为 SUBMITTED_FOR_REVIEW 的行，状态投影列与 report JSON 原子重写，否则返回 false 大声）；服务端 `initReportsPersistence` 在启动时水合（`ReportLog.loadSnapshot` 重建 per-task lastSequence = max(report_sequence)；腐坏行审计 `REPORT_ROW_CORRUPT` 大声跳过），submit/decide 每次写透（失败审计 `REPORT_PERSIST_FAILED` / `REPORT_DECISION_PERSIST_FAILED`，不回滚响应）。**重启语义如实判定**：行原样水合**不降级**——SUBMITTED_FOR_REVIEW 是待裁决记录不是执行态，"已提交、无裁决记录"重启前后同样成立（裁决只走 decideReport 且已写透；与 delegations 的 ACTIVE→INTERRUPTED、pipeline 的 RUNNING→INTERRUPTED 不同口径，原因已在代码注释写明）。测试：`packages/db/tests/management-reports.test.ts`（双实现对拍：insert/get 回环、重复 id 大声、sequence 排序、深拷贝、条件更新拒 terminal 行、腐坏 JSON 大声、老库建表、跨 reopen；`ReportLog.loadSnapshot` 重建 lastSequence——stale 仍拒、新序列仍过）、`apps/server/tests/reports-restart.test.ts`（真 server + 真 SIGKILL 重启：pending 报告原样、terminal 裁决存活、重启后 stale sequence 仍 400、新序列仍 201、pending 报告重启后仍可裁决、审计链含 REPORT_SUBMITTED/REPORT_DECIDED）。边界：decided_by 仍只存在审计链（decideReport 原有行为，本批未改 domain 类型）；服务端 refs 仍全拒绝（非空 ref → UNKNOWN_*_REF，既有行为）；读面 `/api/reports[/:id]` 不变，RBAC 走默认（GET viewer、写 operator）。
- **测试基线（主线亲验）**：根构建 0 TS 错误；包套件 2411/2411（Batch 33 基线 2375 + 本批 18：db management-reports 14、comms report-loadsnapshot 4；另 18 为 sibling 在途 org-relationships/policy-versions 测试，同树全绿）；服务端全套 307/307（Batch 33 基线 304 + 本批 reports-restart 1 + sibling 2，同树全绿）；desktop tsc 0；smoke:boot OK。

## [未发布] Batch 33 — §6.1 项目记录字段 + Clone + 模板扩展 + 项目知识 9 类（在途）

- **Batch 32 独立复核（33-1）**：三项实质声明全部成立（`gap-audit/REAUDIT_BATCH32.md`，零产品代码改动）：AUTHORITY_CONFLICT（15/15 + 6/6，独立探针复核兼容/同人/不同目标→0 冲突、SA BLOCK 自动胜、同级冲突暂停+升级）、§5 相对上限（9/9，granters 不在注册表时跳过）、gates/delegations 落库（7/7 + 20/20 + 真 SIGKILL e2e 1/1，registry 纯内存双 Map 确认重启丢暂停状态）。2 处文档/过程级偏差：32-2 报告写 §8.1 在 SPEC 第 250 行、实际第 252 行（引用内容逐字准确）；复核中途兄弟 Batch 33 在途文件写入主工作树导致主树构建一度 TS5055（Batch 33 在途瞬态，非 Batch 32 基线缺陷，干净基线 0 错误已证）。
- **§6.1 项目记录 13 字段**：projects 表新增全部 SPEC 字段（organization_id、profile_version、repository_refs、workspace_refs、instruction_refs、policy_version、default_manager_id、workflow_version、environment_refs、data_classification、lifecycle_state；ref 集合存 JSON 数组）。`migrateProjectsTable` 老库自动补列（全 nullable——升级绝不编造组织/政策版本/生命周期状态）；`rowToProject` 读时解析，腐坏 JSON 大声失败（Batch 31 同口径）。`createProject` 新增 `CreateProjectInput`（老调用方最小形状仍合法）。`POST /api/projects` 接受 §6.1 字段原文（标量 string、refs string 数组；错形 400；缺席 → null/[]）；新增 `GET /api/projects/:id` 返回完整记录（404 缺失）。测试：`packages/db/tests/project-record-fields.test.ts`（全字段写透、最小形状 null/[]、legacy 库升级、腐坏大声失败、归档不丢字段）。
- **Clone Repository 入口**：`POST /api/projects/clone` {url, name?, dir?, branch?}——真 `git clone` 到工作目录，记录项目（repository_refs=[url]，断言的来源、不编造其他）；非空目录 409 `PROJECT_DIR_NOT_EMPTY`（§6.3）；只接受 https/http/file/绝对本地路径（ssh 可能挂 auth，拒绝）；branch 做纯分支名校验；失败 502 `CLONE_FAILED` 且不写记录；成功写 `PROJECT_CLONED` 审计。测试：`apps/server/tests/project-records-clone.test.ts` 真 server e2e（本地 fixture git 仓库真 clone、409 非空守卫、400 非法来源、502 失败无记录、§6.1 字段跨真 SIGKILL 重启）。
- **§6.1 模板扩展注册（33-3）**：`ProjectTemplateRegistry`（packages/projects/src/templates.ts）：5 个内置模板钉死（register 不可覆盖、unregister 拒绝 `TEMPLATE_BUILTIN`）；register 做结构化校验（slug 格式、文件路径拒绝 `..`/绝对路径/反斜杠、文件数与总字节上限；模板是数据非代码执行）；重复注册 409 `TEMPLATE_EXISTS`。服务端：`POST /api/projects/templates`（operator，注册即落库 `project_templates` 表，`initProjectsRoutes` 在启动时重载，坏行 `TEMPLATE_RELOAD_SKIPPED` 大声跳过）、`GET /api/projects/templates[/:name]`（viewer，列表不泄漏文件内容）、`DELETE /api/projects/templates/:name`（operator）。`POST /api/projects/create` 经服务端 registry 解析模板名——注册模板可真实脚手架（e2e 验证）。`createProject` 新增 `opts.registry`（默认 defaultTemplateRegistry）；`ProjectTemplate.name` / `CreateProjectOptions.template` / `CreatedProject.template` 从 `ProjectTemplateName` 联合放宽为 string（内置字面量仍兼容）。
- **§6.4 项目知识 9 类（33-3）**：`project_knowledge` 表（老库自动建表；`packages/db/src/project-knowledge.ts`，memory/SQLite 双实现对拍）。9 类：product-requirements、architecture、tech-stack、coding-test-security-standards（规格一行，合并类）、deployment-rules、known-bugs、constraints（"Known Bugs/Constraints" 拆为两类——bug 是观测到的故障，constraint 是长期限制）、decisions、lessons。upsert 按 (project_id, category, title) 原地更新（entryId/createdAt 稳定，updatedAt 前移，返回实际 entryId）；非法 category 在 store 层抛 `ProjectKnowledgeCategoryError`、HTTP 层 400 `UNKNOWN_KNOWLEDGE_CATEGORY`；content 是索引摘要，sourcePath/sourceVersion/sourceHash 引用来源文件（§6.4）；读全深拷贝。服务端 `/api/projects/:id/knowledge`：GET 列表（?category= 过滤，非法 400）、GET 单条、PUT upsert、DELETE（读 viewer、写 operator），`PROJECT_KNOWLEDGE_UPSERTED/DELETED` 进哈希链审计。实现中抓到真 bug：upsert 复用旧 entryId 时路由用新 id 去 get 会拿到 undefined——store.upsert 改为返回实际 entryId。测试：`packages/projects/tests/templates-registry.test.ts` 8/8（注册/注销/内置保护/校验/createProject 真实落文件）、`packages/db/tests/project-knowledge.test.ts` 6/6（双实现对拍、原地更新、深拷贝、非法类大声、老库建表、跨 reopen）、`apps/server/tests/project-templates-knowledge.test.ts` 2/2（真 server：注册→脚手架→注销、知识 CRUD、非法 category 400、RBAC 接线、真 SIGKILL 重启后模板与知识双持久化）。
- **§48.2 escalations + proposals 落库（33-4）**：关闭扫荡的 §48.2 实体清单中的两项。审计结论：escalations 的真实内存结构是 `DisputeCoordinator.escalationRecords`（append-only 数组，`apps/server/src/routes/disputes.ts` 模块级 coordinator 在用）；proposals 的真实内存结构是"没有"——`proposeChange` 纯函数，决策只活在 POST 响应里。`escalations` / `proposals` 表（老库自动建表，memory/SQLite 双实现对拍）：escalation 每次 ESCALATED 裁决写透（append-only，无 update/delete API；写透失败审计 `ESCALATION_PERSIST_FAILED` 不回滚响应——升级已经发生），`GET /api/disputes/escalations` 合并 live coordinator + 落盘行（按 id 去重，live 优先）；proposal 每次 POST /api/workforce/proposals 决策写透（insert-only；写透失败审计 `PROPOSAL_PERSIST_FAILED`），`GET /api/workforce/proposals`（?status= 过滤）+ `GET /api/workforce/proposals/:id` 读决策历史（404 缺失）。两者都是终局记录——没有在途状态可降级（与 delegations 的 ACTIVE→INTERRUPTED 不同）：pending-human-actions 是人的事不是进程状态，needs-review 是给人看的旗标（系统无 review 端点）；重启后行原样水合（`initDisputesPersistence` 启动时只读加载，坏行审计 `ESCALATION_ROW_CORRUPT` 不遮掩）。**与 AUTHORITY_CONFLICT 的交集如实说明**：Batch 32 的 `AuthorityConflictRegistry` 同级冲突进入 AUTHORITY_CONFLICT(OPEN) 要求人工升级，但它既不实例化 §81 的 `EscalationRecord` 也不走 dispute 裁决路径——三者（§81 needsHuman、dispute escalation、authority conflict）是三个独立形状与生命周期，本批没有发明它们之间的连线。**§81 `needsHuman` 升级形状不在此列**：它没有任何服务端发射点、全库无存储，如实未覆盖。测试：`packages/db/tests/escalations-proposals.test.ts` 14/14（双实现对拍、append/insert-only、拷贝契约、newest-first、腐坏 JSON 大声失败、老库建表、跨 reopen、重复 id 真报错非 upsert）；`apps/server/tests/escalations-proposals-restart.test.ts` 1/1（真 SIGKILL 重启：dispute 双无证据裁决→ESCALATED 落盘、proposal denied 决策落盘；重启后 escalation 读回 reasons/pending-actions/evidence-by-side 完整、新 dispute 的 escalation 不混淆、proposal list/detail/404、SELF_MODIFICATION_PROPOSED 在审计链）。实现中抓到自己的两个测试 bug：包测试误 import dist（应为 `../src/index`，AGENTS.md 包惯例）、测试里把占位符 `Authorization: <redacted>` 字面写进去了（应为 `'Bearer ' + ADMIN`）。
- **测试基线**（主线亲验）：根构建 0 错误（注：中途一次全量构建报 29 错误，经逐个包 tsc 归因，系兄弟批次在途写文件中的瞬态状态；其文件安静后重跑全量构建 0 错误，db/projects/server 逐个包 tsc 均干净）；包套件 2375/2375（基线 2342：+5 本批 db project-record-fields、+6 project-knowledge、+8 templates-registry、+14 escalations-proposals）；服务端全套 304/304（基线 292：+9 本批 project-records-clone、+2 project-templates-knowledge、+1 escalations-proposals-restart；期间出现 1 次偶发失败，两次重跑全绿，判为 flake）；desktop tsc 0；smoke:boot OK。

## [未发布] Batch 32 — AUTHORITY_CONFLICT 仲裁 / §5 相对上限 / gates-delegations 落库 / Batch31 独立复核（在途）

- **Batch 31 独立复核（32-1）**：三项实质声明全部成立（`gap-audit/REAUDIT_BATCH31.md`，零产品代码改动）。发现 3 处文档级偏差（本批已顺手纠偏）：收敛结论计数实为已落地 27、部分 32（报告写 26/27，加总不对）；§6.1 缺口括号的 projects 表列名写错（`data_classification` 是 memory_entries 的列，projects 表实际是 id/name/description/path/status/archived_at/created_at/updated_at）；"pipeline stage 落盘"措辞松散（已落盘的是记录与定义，不可落盘的是 handler 闭包与执行恢复）→ 改为"stage 可执行恢复/可重跑"。
- **AUTHORITY_CONFLICT 仲裁（32-2）**：关闭 31-4 扫荡发现的 INV-31 缺口。SPEC_V2 §8.1 的确切要求：Authority 层检查指令者是否有权，两个同等有效且不兼容的指令进入 `AUTHORITY_CONFLICT`、暂停相关动作并升级（绝不"最后一条命令"）。新建 `AuthorityConflictRegistry`（`packages/policy/src/authority.ts`，时钟/id 可注入）：指令按 principal 登记到 run/task 目标；不兼容对（BLOCK↔ALLOW、CANCEL↔放行系、PAUSE↔RESUME/ALLOW）；等级不同 → 确定性规则自动裁决（higher-authority-wins，Security Authority BLOCK 胜 Manager ALLOW 是 rank-3-vs-2 实例，败方记 OVERRIDDEN）；同级不兼容 → AUTHORITY_CONFLICT（OPEN），目标暂停（`isPaused` 门），升级要求**严格更高等级**的人工裁决（平级/低级拒绝），全过程审计。服务端：`POST /api/authority/directives`、`GET /api/authority/conflicts[/:id]`、`POST /api/authority/conflicts/:id/resolve`、`GET /api/authority/targets/:kind/:id`（paused 标志）。测试：`packages/policy/tests/authority.test.ts` 15/15（无冲突永不触发、BLOCK 自动胜顺序无关、同级冲突暂停+升级、升级等级校验、重复裁决拒绝）、服务端 `authority-conflict.test.ts` 6/6（双 principal 冲突暂停+审计、spec 显式用例自动裁决、owner 裁决后解除暂停）。边界：registry 是内存的（与 /api/disputes 同口径），重启丢失未决冲突的暂停状态；principal 由调用方断言，未做密码学验证（server 只有粗粒度 token RBAC）；Policy/Scheduler 仍是各自引擎，本模块不冒充它们。
- **gates/delegations 落库（32-4）**：关闭 31-4 扫荡的 §48.2 实体清单中的两项（§51 可靠性优先级）。`gate_definitions` / `gate_evaluations` / `delegations` 表（老库自动建表）。DelegationManager 加 `loadSnapshot`（水合只做记忆、不重跑创建校验；坏行跳过上报）；服务端 `delegation-service.ts` 每次 mutation 写透（规则拒绝在写之前抛，DB 永不见被拒委托），启动时水合：ACTIVE 行写回降为 INTERRUPTED（`DELEGATION_INTERRUPTED_ON_RESTART` 审计，version 不动——降级是诚实戳不是委托决策），INTERRUPTED 行永不进 live manager（只读历史、不复活、mutation 409 `DELEGATION_INTERRUPTED`），DRAFT/COMPLETED/CANCELLED 原样。新建 `/api/delegations` 全套路由（创建/子委托/activate/complete/cancel/handoff/reparent，409 带 domain code）与 `/api/gates` 路由（定义 upsert/查询；`POST …/evaluate` 用确定性 evaluator 真算 verdict——body 带 verdict 直接 400，INV-04；证据来源记 `caller-supplied` 不冒充服务端验证）；全部 mutation 写哈希链审计。测试：`packages/db/tests/governance.test.ts` 7/7（双实现对拍 + 跨 reopen），`packages/orchestrator` delegation 20/20（含 loadSnapshot 2 条），真机 SIGKILL 重启 e2e `apps/server/tests/delegations-restart.test.ts` 1/1（ACTIVE→INTERRUPTED、DRAFT 可行动、定义/评估落盘、审计链验证）。边界：评估是同步终局的，无在途评估可降级；INTERRUPTED 终态不复活，重建委托用新 id；多进程共享 DB 时后启动进程会把他进程的 ACTIVE 也降级（liveness 只在 owning 进程权威，与 MCP ORPHANED 同口径）。

- **测试基线（主线亲验）**：构建 0 错误；包套件 2309 → 2342（+33：authority 15、relative-ceiling 9、db governance 7、orchestrator loadSnapshot 2）；服务端全套 285 → 292（+7：authority-conflict 6、delegations-restart 1）；desktop tsc 0；smoke:boot OK（冒烟第一次跑因端口占用抖动失败一次，重跑 OK，留观察记录）。

- **§5 相对权限上限（32-3）**：关闭 31-4 扫荡发现的缺口。`enforcePolicy` 在 §19 绝对上限检查之外新增 §8.2 相对上限检查——grant 的 tools/permissions 必须是委托者（`CreationRequest.granterAgentId`，`createEmployee` 把 `requestedBy` 映射为 granter）自身 tools/permissions 的子集。越级时抛 `grant-exceeds-granter`，并在抛之前经注入的审计 sink 写 `RELATIVE_CEILING_DENIED`（与 approvals 的 EXCEPTION_GRANT_DENIED 同模式）；服务端 `/api/workforce/employees` 把该事件写入哈希链审计。平级/降级通过；绝对检查顺序与口径不变（绝对先行，有效权限为所有限制的交集）。边界：granter 不在注册表时（如 human）无可比集合，相对检查跳过、绝不编造上限（绝对检查仍全量生效）；requestedBy 来自请求 body 声明值，相对检查只在声明值命中注册表 agent 时生效（workforce 路由既有信任模型，本批未改）；§8.2 的"任务范围"维度仍只在 scope.ts 检查，未并入本检查。测试：`packages/employee-factory/tests/relative-ceiling.test.ts` 9/9（越级工具/权限被拒 + 审计 intent、平级/降级通过、未知 granter 跳过但绝对检查仍生效、无 granter 旧行为、绝对先行口径、createEmployee 两路接线）；包全套 37/37（含既有 governance/factory 19/19 零回归）。

## [未发布] Batch 31 — Pipeline 落库 / /api/builds / SPEC 扫荡 / Batch30 独立复核（在途）

- **Batch 30 独立复核（31-1）**：三项实质声明全部成立（`gap-audit/REAUDIT_BATCH30.md`，零产品代码改动）：可售复验报告诚实性抽查（A-BLOCKED/文档翻绿均有代码依据）、走查第三版（1/1，真链路亲读确认）、扫荡三个候选（7/7、9/9、4/4）。附带两处如实记录："KNOWN_LIMITATIONS 现共 58 条目"实为 54（计数口径偏差，已纠偏）；主工作树在途的 `/api/builds` 路由是 Batch 31 后续工作、不在 Batch 30 基线内。
- **SPEC_V2 59 章覆盖扫荡（31-4）**：`gap-audit/SPEC_COVERAGE_BATCH31.md`——逐章一句话状态 + 证据指针：已落地 27 章、部分 32 章、未做 0 整章（未做的是章内子项）。补入 KNOWN_LIMITATIONS 的 7 项"规格要求但此前未记录"缺口（§8.1 AUTHORITY_CONFLICT 仲裁缺失、§5 相对权限上限、§6.1 项目记录缺字段/Clone 入口/模板不可扩展、§6.4 项目知识 9 类无结构、§48.2 实体集合未落库清单）；纠偏"文档说没做但实际已做"滞后（INV-29/§5 脱敏/§6.2 发现诊断/§6.3 非空目录守卫/§1.2 AOCR 在 2026-10-11 group-a 审计后已落地）；SELLABLE_CHECKLIST 四处滞后纠偏 + 结论口径更新到 d81857a 亲验。零产品代码改动。收敛建议：AUTHORITY_CONFLICT、相对权限上限、gates/delegations 落库是纯代码可关闭的候选。
- **/api/builds 只读面（31-3）**：关闭 walkthrough F9。`GET /api/builds`（列表：status/prId/revision 过滤，limit/offset 分页）与 `GET /api/builds/:id`（单条），只读 builds 表（不触发任何构建），viewer 可读（RBAC 中央门控，非 GET → admin）；记录拷贝原样序列化（null 不编造，note 恒存在）。真 server e2e：merge → 真实构建 → **纯 HTTP 轮询**观察到 SUCCEEDED（约 6 秒）。F9 在 FIRST_RUN_WALKTHROUGH.md 标记 CLOSED，KNOWN_LIMITATIONS 加条目。边界：记录 insert-only，状态机单向（终端行不可改写）。
- **Pipeline 记录 + stage 定义落库（31-2）**：`pipeline_records` / `pipeline_stages` 表（老库自动建表），每次 pipeline 创建与每次 stage 结束写透（记录 + 全部 12 个 stage 定义，单事务原子；写透失败不回滚内存记录，写 `PIPELINE_PERSIST_FAILED` 审计）。重启后 `GET /api/pipelines/:id` 与 `GET /api/pipelines` 从落盘行重建记录（`PIPELINE_REHYDRATED` 审计，`rehydrated: true`）。`@ai-factory/cicd` 类型新增 `INTERRUPTED` 一等生命周期状态：落盘行里 RUNNING 的 pipeline 与 stage 在水合时降为 INTERRUPTED（永不伪装仍在运行、永不可恢复执行）。边界：① 落盘的是记录不是执行——stage handler 是宿主闭包，无法落盘是设计的；重建记录是只读历史，`/run` 保持 409 `PIPELINE_NOT_REHYDRATABLE`，绝不伪装可跑；② 归档守卫重建前重校验（→ 409 + `PIPELINE_REBUILD_REFUSED`；legacy deployment-stub 路径仍审计 `DEPLOYMENT_REBUILD_REFUSED`，测试钉住）；③ 无任何痕迹的 pipeline 仍 404；④ 腐坏 stage 行大声失败。实现中抓到两个真问题：node:sqlite 没有 `.transaction()`（改显式 BEGIN IMMEDIATE/COMMIT/ROLLBACK）；新库 record 路径先命中导致旧 Batch-19 测试的审计名断言失效（旧测试按新路径名更新 + 补 legacy 路径测试）。
- KNOWN_LIMITATIONS：Batch 19 条目改写为"Pipeline 记录与 stage 定义已落库"、新增"规格扫荡发现（Batch 31）"一节、新增"构建只读面已关闭（Batch 31）"条目、结论口径更新到 d81857a 亲验。测试基线（主线亲验）：构建 0 错误；包套件 2304 → 2309（+5：db pipelines）；服务端全套 275 → 285（+10：builds-read 4、pipeline-persistence 5、legacy 路径 1）；desktop tsc 0；smoke:boot OK。

## [未发布] Batch 30 — Batch29 独立复核 / 可售清单复验 / walkthrough 第三版 / 缺口收敛扫荡

- **Batch 29 独立复核（30-1）**：四项实质声明全部成立（`gap-audit/REAUDIT_BATCH29.md`，零产品代码改动）：db-broker 服务端接线（7/7 真 server e2e）、fetched-content 隔离契约（11/11）、29-2 轮询化稳定（7/7）。附带构建稳定性观察：`npm run build` 四遍中第一遍真实失败（apps/desktop vite build 失败，exit 2），后三遍全过——桌面构建偶发抖动，留观察记录（产物可用，测试针对亲构建产物全绿）。
- **可售清单全面复验（30-2）**：上次复验是 Batch 24，中间走了 5 批。`gap-audit/SELLABLE_REVERIFY_BATCH30.md`：A（真实可用）——模型回路仍 BLOCKED（卡 Codex 登录）、桌面分发部分（Linux 验证/Win/Mac 需真机/签名待采购）、首次运行走查保持 1/1、关键数据持久保持勾选（覆盖扩大）；B（规格完整度）——Batch 24–29 新关闭高影响项列明，剩余 9 项真实缺口逐项诚实；C（质量与可信）——全量测试全绿、文档与实现一致**翻绿**（两处文档缺口已补）、独立复核追加 Batch 25–28；D（商业化）——版本 0.1.0 保持、许可证/定价仍待 Tan。零产品代码改动。
- **first-run walkthrough 第三版扩展（30-3）**：新走查脚本 `apps/server/tests/first-run-walkthrough-b30.test.ts`——B21–B29 数据面链路真实走查（真 server + 临时 DB + SIGKILL 重启）：D1–D5（db broker：无策略拒绝→无引擎 503→白名单执行/拒绝→runbook→审计链+哨兵值不在审计中）、B1（构建 SBOM：真实 digest + 落盘 CycloneDX）、R1（保留评估 dry-run：零删除）、M1/M2（MCP launch：SIGKILL 后 history 显示 ORPHANED + 信任批准保留）、A1（审计全链 verify 通过）。连续三次 1/1。`docs/FIRST_RUN_WALKTHROUGH.md` 新增第三版章节（含 F8/F9 两个 Low findings；F9：后台构建完成后纯 HTTP 消费者没有 `/api/builds` 只读端点可观察构建落地——真实读面缺口，已记录不改产品）。`package.json` 新增 `demo:e2e-v3`。
- **缺口收敛扫荡（30-4）**：按"真实使用影响"重排扫描（排除 Tan 专属项）。结论：三个最接近"可售"的候选（账号状态接线、§40→§36 构建↔证据绑定、merge queue drain 并发）**全部早已真实关闭**——问题是文档滞后于实现，已修正四处过时条目（KNOWN_LIMITATIONS + SELLABLE_CHECKLIST），零产品代码改动。真实存在的大项（按影响排序）：pipeline stage 可执行恢复/可重跑 → 真实隔离 Host → 非 Codex 模型适配器 → MCP 真实服务器握手 → 远程数据库驱动 → 桌面真人点击验收（含 Win/Mac 真机、签名证书）。`gap-audit/GAP_SWEEP_BATCH30.md`。
- 测试基线（主线亲验）：构建 0 错误；包套件 2304/2304（Batch 29 基线不变）；服务端全套 274 → 275（+1：first-run-walkthrough-b30）；desktop tsc 0；smoke:boot OK。

## [未发布] Batch 29（在途）

- **Batch 28 独立复核（29-1）**：三项实质声明全部成立（`gap-audit/REAUDIT_BATCH28.md`，零产品代码改动）：removeServer 原子化、DbBroker/Runbook、Browser Profile 均亲跑复验。诚实备注：removeServer 原子性是同进程 SQLite 事务 + `BEGIN IMMEDIATE` 写锁串行跨进程，边界仍是"同一 DB 文件多进程"。
- **孤儿清理 e2e 启动等待改为轮询（29-2）**：Batch 28 发现的测试抖动已修。`build-orphan-reconcile.test.ts` 的两个裸 sleep 启动等待（2500ms/3000ms）改为 `waitForHealthy` 轮询 `GET /api/health`（与 boot-smoke 同模式：30s 有界 deadline、超时大声失败、永不无限等待）。全仓库审计：这是 repo 内最后一处裸 sleep 启动等待，其余 spawn-server 测试本来就是轮询式。连续 3 遍 7/7。零产品代码改动。
- **「网站文本不成为指令」消费层契约（29-4）**：SPEC_V2 §33 的一句话给了规则没给机制。先审计确认：今天模型唯一的入口是 `@ai-factory/runtime` 的 `adapter.invoke`，prompt 只由可信字段组装——**今天没有任何外部文本能到达模型**。新建 `packages/tools/src/fetched-content.ts`：`FetchedProvenance`（URL/抓取时间/profile 身份，抓取时刻附带永不猜测）；`markUntrusted()` 是唯一的隔离构造函数（缺 URL 直接拒绝）；`QuarantinedContent` 运行时品牌 + `assertQuarantined()` 同时检查 instanceof 与 own-property 品牌（对抗测试钉住原型伪造）；`renderQuarantined()` 把中英双语"不是指令"横幅写进 prompt 字节；`buildPromptFromBlocks()` 是 prompt 组装的 choke point（未隔离的外部内容 fail-closed）。诚实边界：① 这是问责链不是防注入银弹——不能阻止模型执行隔离块内的注入指令；② 只覆盖网站文本来源域；③ 仍无抓取器（`browser.open` definition-only），契约是未来 driver 与组装方的硬性要求。测试：`packages/tools/tests/fetched-content.test.ts` 11/11。
- **db.query 服务端接线——Broker 上线（29-3）**：28-3 的包内 DbBroker 接入服务端 HTTP 面（`apps/server/src/routes/db.ts` 新建 + `apps/server/src/db-broker.ts` 新建宿主接线）。`POST /api/db/query`（ad-hoc）与 `POST /api/db/runbooks/run` 按 `authorizeQuery` 门 → 白名单 → 引擎链执行；连接注册（`POST /api/db/connections`，带环境身份 + credential 引用名）与白名单绑定（`PUT /api/db/connections/:name/policy`）、模板注册（`POST /api/db/runbooks`）为 admin，执行为 operator（RBAC 中央门控 `auth.ts`）。启动时注册 `factory` 连接（环境身份来自 `FACTORY_DB_ENVIRONMENT`，默认 dev，非法值拒绝启动）并注入基于本机 SQLite 的真实 `SqliteDbQueryEngine`（`:slot` 具名参数由 node:sqlite 绑定，broker 永不拼接；引擎内参数二次标量校验，防御纵深）。**默认不绑任何白名单**——执行 opt-in，未绑策略时 ad-hoc 响亮拒绝；无引擎的连接响亮拒绝（503 `NO_ENGINE`，绝不冒充）。每种结局写哈希链审计（DB_CONNECTION_REGISTERED / DB_BROKER_POLICY_SET / DB_BROKER_EXECUTED / DB_BROKER_DENIED / DB_BROKER_NO_ENGINE / DB_BROKER_EXECUTION_FAILED / DB_PROD_WRITE_ATTEMPT / DB_PROD_WRITE_DENIED / DB_RUNBOOK_*），SQL 只带占位符、绑定值永不进审计（真 server e2e 哨兵值断言）。行数上限 200、列数上限 50（截断必标注）；多语句 400 拒绝。`db.query` 工具仍 definition-only（implementationGate 未动，继续 DENY——刻意分层）。测试：`apps/server/tests/db-broker.test.ts` 7/7（真 server e2e：无策略拒绝→RBAC→白名单执行/拒绝→无引擎503→prod写确认门→runbook→审计链+哨兵值不在审计中）。测试基线（主线亲验）：构建 0 错误；包套件 2293 → 2304（+11：tools fetched-content）；服务端全套 267 → 274（+7：db-broker）；desktop tsc 0；smoke:boot OK。
- KNOWN_LIMITATIONS：Browser 条目新增网站文本隔离契约。

## [未发布] Batch 28（在途）

- **Batch 27 独立复核（28-1）**：三项实质声明全部真实（`gap-audit/REAUDIT_BATCH27.md`，零产品代码改动）。附带发现一项测试时序抖动（e2e 启动等待固定 2500ms 与 server 实际启动 2.5s 零裕量，机器稍有负载就超），产品侧无回归；建议下一批把 e2e 启动等待改为轮询 `/api/health` 直到就绪（与 boot-smoke 同模式）。
- **removeServer 两删除原子化（28-2）**：Batch 27 的理论接缝已关闭。sqlite `removeServer` 的两条 DELETE（先 server 后 install）现为一个 `BEGIN IMMEDIATE … COMMIT` 原子单元——并发的 saveInstall 不能再插进中间被静默吞掉：锁内写入随单元一起删，锁后写入成为可观测的孤儿而非静默丢失。修复没有消灭孤儿，而是改变了孤儿的命运（可观测、可扫、审计留痕）；无主 install 防御扫描 `removeOrphanInstalls()`（双实现），`/remove` 路径在删除后扫描、有孤儿时写 `MCP_INSTALL_ORPHAN_CLEANED`（点名被删键），永不静默。测试：`packages/db/tests/mcp-remove-transaction.test.ts`（6/6：故障注入回滚、交错注入、孤儿语义）与真 server e2e `apps/server/tests/mcp-remove-orphan-cleanup.test.ts`（1/1）。
- **Browser 隔离 Profile 最小诚实实现（28-4）**：规格依据 SPEC_V2 §33「Browser 在隔离 Profile/Host 中运行，下载目录受边界控制；网站文本不成为指令」。`packages/tools/src/browser.ts`（新建）：`BrowserProfileRegistry`——每个 profile 独立身份 + 独立本机 user-data 目录（真目录隔离，测试真写 cookie 文件验证不共享）；自带 downloads 有界目录，`resolveDownloadPath` 拒绝一切逃逸；生命周期 create → destroy（真删目录）+ 孤儿清理（只删命名模式匹配的未注册目录），全审计。`browser.open` 保持 definition-only（gap 注释已更新为新口径）。边界：① 这是本机目录隔离，不是 OS 沙箱/容器——隔离 Host 一半仍未做；② 无真实浏览器驱动，`driverAvailability()` 诚实返回 `available:false`；③ 「网站文本不成为指令」是消费层规则，无取回器时无物可标。测试：`packages/tools/tests/browser.test.ts` 11/11。
- **生产写 Broker/Runbook 最小闭环（28-3）**：`packages/tools/src/db-broker.ts`（新建）——`DbBroker` 是实际执行查询的代理，坐在 27-4 的 `DatabaseEnvironmentRegistry` 门后面。注册时绑定最小权限（每连接的操作桶 `read/insert/update/delete/ddl/other` + 表白名单；policy/engine 注册都要求连接已存在，无身份不绑定）。执行链：`authorizeQuery` 门 → 自身白名单（每条语句的操作桶 + 每个引用表，未列入即拒；抽不出目标表的写语句 fail-closed 拒绝）→ 宿主注入的 `DbQueryEngine`。执行结果全审计（谁/何时/什么 SQL/是否允许/行数）。无引擎的连接响亮拒绝 `NO_ENGINE`（allowed=true、executed=false），绝不冒充执行。Runbook：预置命名查询模板，`:slot` 参数槽；注册即审批（审计 `DB_RUNBOOK_REGISTERED`），校验占位符与声明 slot 精确对应、单语句、slot 名合法；运行时参数必须与声明精确匹配（缺/多都拒）且为标量；broker 永不拼接 SQL——引擎收到的永远是模板原文 + 参数对象（测试钉死模板原文含 `:id` 而无值）；Runbook 跳过 ad-hoc 白名单是设计使然，但仍过 `authorizeQuery` 门（prod 写模板仍需确认）。表名提取是常见 DML/DDL 形状的尽力解析：FROM/JOIN/INTO/UPDATE/TABLE/TRUNCATE + 逗号列表 + 子查询 + schema 限定/引号名；注释与字符串单遍状态机剥离（双遍会有顺序依赖导致漏提表名——不安全方向，已用测试钉住 `/* it's */` 与 `'/*'` 两种形状）。审计只记 SQL 文本（占位符），绑定值永不进审计。`database.ts` 加 `statementKeywords` 导出与 11 个新审计意图类型（纯加法）。边界：`db.query` 服务端仍 definition-only（broker 是包内执行面，服务端接线未做）；无物理隔离；无完整 SQL 解析器。测试：`packages/tools/tests/db-broker.test.ts` 33/33；tools 全包 111/111。
- KNOWN_LIMITATIONS：Database 条目改写为"三环境身份 + 最小权限 Broker/Runbook"、removeServer 接缝改写为"已关闭"、新增 Browser Profile 条目。测试基线（主线亲验）：构建 0 错误；包套件 2243 → 2293（+50：tools db-broker 33、tools browser 11、db remove-transaction 6）；服务端全套 266 → 267（+1：mcp-remove-orphan-cleanup）；desktop tsc 0；smoke:boot OK。

## [未发布] Batch 27 — Batch26 独立复核 / install 并发审计 / 构建孤儿清理 / Database 三环境身份

- **Batch 26 独立复核（27-1）**：三项实质声明全部成立（`gap-audit/REAUDIT_BATCH26.md`，零产品代码改动）：SBOM 保留语义、MCP launch 落库、enqueue position 碰撞均亲跑复验。
- **MCP install 表并发写语义审计（27-2）**：真跑（两真实进程各 800 次 install/uninstall 交错写入共享 DB）从未出现混合行——`saveInstall` 是单语句 UPSERT、`removeInstall` 是单语句 DELETE，语句级原子，语义即"最后一个完整写入胜出"。按规则未套用意图模式（不承诺解决不存在的问题），只补 `packages/db/tests/mcp-install-concurrency.test.ts` 钉住（5/5）。相邻观察：`removeServer` 是两条 DELETE（理论接缝，6 轮×20000 次真跑未命中），已记录 KNOWN_LIMITATIONS 建议下一批包进事务。
- **构建工作区孤儿清理（27-3）**：此前 server 在 `git worktree add` 与 finally 清理之间被 SIGKILL 会留下永久孤儿工作区（真跑复现：目录残留 + `git worktree list` 悬空注册）。现每次构建写 `.factory-build-runner.json` 归属标记（buildId、revision、owner PID + PID 启动时间），启动时 reconcile 扫描 workRoot：死 PID 孤儿（或 pre-marker 窗口兜底）先解除 git 注册再删除，审计 `BUILD_ORPHAN_CLEANED`（明注"清理非重放"），构建记录保持 `NOT_EXECUTED`；活 PID 工作区（PID 复用防护：比对 /proc 启动时间；kill EPERM 按存活）与不可归属目录一律不动；非 `build-<uuid>` 永不碰；reconcile 永不抛。边界：仅 FACTORY_BUILD_COMMAND 启用时运行；workRoot 变更后旧 root 不在扫描范围；只覆盖单机。
- **Database 三环境身份（27-4）**：规格依据 SPEC_V2 §33「Database 分开 DEV/UAT/PROD 身份；生产写仅经最小权限 Broker/Runbook」——本批只做前半句。`packages/tools/src/database.ts`（新建）：`DatabaseEnvironmentRegistry`——连接注册必须带环境身份（省略默认 `dev`，永不猜 prod；身份不可变，同名换 env 拒绝注册，防止 dev→prod 静默翻转）；prod 写必须调用时字面 `prodWriteConfirmed === true`（'yes'/1 不算），否则 DENIED；切换可审计（`DB_CONNECTION_SWITCHED`）；prod 写尝试/确认/拒绝全审计；只存 credential 引用名（secret 值永不接受、永不落盘）。语句分类保守（未知语句按写处理，fail-closed）。`db.query` 内置定义加可选 `connectionName`/`prodWriteConfirmed` 输入字段，gap 注释如实更新（身份层已存在，查询引擎与 Broker 仍缺，definition-only 不变）。边界：① 这是 fail-closed 确认门，不是最小权限 Broker/Runbook——生产写 Broker 仍未做；② 无查询引擎；③ 无物理隔离，身份是逻辑标签。
- KNOWN_LIMITATIONS：新增 install 并发审计结论、Database 三环境身份、构建孤儿清理条目；Batch 17 的"仍未做"口径已更新。测试基线（主线亲验）：构建 0 错误；包套件 2217 → 2243（+26：tools database 21、db install-concurrency 5）；服务端全套 259 → 266（+7：build-orphan-reconcile）；desktop tsc 0；smoke:boot OK。

## [未发布] Batch 26 — Batch25 独立复核 / SBOM 保留策略 / MCP launch 记录落库 / enqueue position 碰撞

- **Batch 25 独立复核（26-1）**：实质声明全部成立。审计真跑验证：MCP op 协议下过期进程的健康写不再撤销批准（旧路径对照证实 bug 真实存在且修复是实质的）、SBOM 从仓库真实 lockfile 派生 386 个真实组件、taskId-null 补线在树上。`gap-audit/REAUDIT_BATCH25.md`（零产品代码改动）。
- **SBOM 保留策略（26-2）**：`sboms` 成为 retention 策略一等分类（`PUT /api/retention/policies`），沿用 backups 的双轴语义——retentionDays（按 builds 记录的 completedAt/builtAt）与 keepCount（按记录年龄保留最新 N）取并集；sboms 专属 `deleteOrphans` 开关（默认关，落实 §47「未知引用阻止清理」）。关联先验：每次评估从 live builds 表重建 sbomRef→文件映射，只有被过期记录引用的文件、或（opt-in 时）无任何记录引用的孤儿文件才是候选；文件名不匹配 `sbom-<uuid>.json` 的一律不动（正则 + `..` 双重检查）；任一 legal hold 激活则全部豁免（与 backups 同口径）；evaluate 纯 dry-run，enforce 需确认文本并写 RETENTION_ENFORCED 审计。builds 记录 insert-only，删文件后其 sbomRef 按设计悬空（注释与报告写明读者须按"已保留清理"处理缺失文件）。边界：sbomRef 本机绝对路径，DB 搬家/跨机后关联失效的文件判为孤儿（默认保留）；构建刚写完 SBOM、markSucceeded 尚未落盘的窗口内文件判为孤儿（默认保留，opt-in 时避开构建高峰）；只处理本机目录，不覆盖多机。
- **MCP launch 记录持久化（26-3）**：`mcp_launch_records` 表（`IF NOT EXISTS`，老库自动建表；只存 server 标识、启动参数、ref 名、status/timestamps，secret 值永不落盘，测试钉住）。每次 spawn/stop/自然退出落一行：RUNNING → STOPPED（/stop，操作员决策，不被随后 exit 覆盖）/ EXITED（自然退出，记 exitCode/signal）；重启水合时其他 boot 的 RUNNING 行标 ORPHANED（"launcher 已不在，子进程死活未知，不管理"——绝不伪装仍在运行，也不声称已死）。`GET /api/mcp/launches?history=true` 查历史（默认仍是 live 表，不改变现有行为）。边界：多进程共享同一 DB 时，新 boot 也会把其他（可能还活着）进程的 RUNNING 行标 ORPHANED——liveness 只在 owning 进程的 live 表里权威；ORPHANED 终态不复活，重 launch 得新行。
- **Merge Queue enqueue position 并发碰撞（26-4）**：审计真跑复现——两进程同时 enqueue 同一 repo 会算出相同 position（两条目同落 position 2），根因是进程内计数器且无唯一约束。最小诚实修复：`(repo_path, position)` 唯一索引做仲裁者 + enqueue 碰撞重试（重读 backing 真实 max → 新 position，每次重试审计 `GIT_MERGE_QUEUE_POSITION_RETRY`，最多 8 次后大声失败，永不静默丢任务）；persist 区分两种唯一冲突——位置碰撞重试，PR 重复仍原 409 口径（此前一律谎报"PR 已在队列"）；老库迁移先确定性修复已存在的碰撞再建索引（索引故意不放 SCHEMA：脏老库必须先修后建，否则 open 直接炸）。修后：position 有序、顺序确定、任务不丢。真踩坑：SQLite UNIQUE 报错写的是被违反的列名不是索引名，按索引名匹配重试静默失效（已记入 AGENTS.md）。边界：只覆盖同一 DB 文件的多进程；无 maxPosition 的第三方 backing 退化为盲增重试。
- KNOWN_LIMITATIONS：MCP launch、SBOM 保留、enqueue position 三条目改写为"已关闭"，并注明各自边界。测试基线（主线亲验）：构建 0 错误；包套件 2205 → 2217（+12：db retention-sbom 3、mcp-launches 3、merge-queue-position 3，余为兄弟批次在途增量）；服务端全套 250 → 259（+9：sbom-retention 8、mcp-launch-records 1）；desktop tsc 0；smoke:boot OK。

## [未发布] Batch 25 — MCP 注册表跨进程写互斥 / 构建 SBOM / 桌面分发复验 / Batch 24 独立复核

- **MCP 注册表跨进程写互斥**：独立审计真跑复现了比"缺互斥"更严重的问题——双进程共享同一 DB 时，过期进程的例行健康写把另一进程的**信任批准静默撤销**（policy AUTO→BLOCKED、TRUST_ASSESSED 历史与 assessment 全丢），且无审计痕迹。根因：三条写路径全是"用过期内存做全行 upsert"（丢失更新）。实现：registry 改发变更意图（`register`/`setFields`/`appendHistory`/`setAssessment`，纯函数 `applyMcpServerOp`，内存与持久层共用合并逻辑），持久层在 `BEGIN IMMEDIATE` 写事务里对新鲜行原子应用（`mcp_servers.row_version` 逐写递增，老库原地迁移；回调抛错则 ROLLBACK 大声失败）；`register` 的"保留已有信任"合并对新鲜行跑，过期重注册不再撤销批准；腐坏行拒绝猜测、大声失败。双栈真跑：过期健康写不再动批准、双进程历史追加都存活、真冲突的信任决策后写者胜且两条都进历史。未生搬 merge queue 的租约（MCP 写是独立点更新，租约会错误串行化）。边界：install 表仍是单语句盲目 upsert；各进程内存读视图仍可能过期（只有写是竞态安全的）；op 不带快照，写路径时间戳按应用时刻重打；只覆盖同一 DB 文件的多进程。
- **构建 SBOM**：构建成功后、工作区删除前，从工作区 lockfile 派生 CycloneDX 1.5 精简 SBOM（声明/解析依赖清单，provenance 写进文档）。`packages/cicd/src/sbom.ts`（新建）：package-lock.json（v1/v2/v3）、yarn classic、pnpm-lock.yaml、Cargo.lock；其余 lockfile 大声 skip；去重 + 确定性排序 + 上限 20000；坏输入永不抛。`sbomRef` 指向 `FACTORY_SBOM_DIR`（默认 `<cwd>/data/sboms`）的落盘文件；无可用 lockfile 或生成失败时为 null 并点名原因，构建本身不受影响。`builds` 加 `sbomNote`（null 必有原因注记），老库原地迁移并回填。边界：sbomRef 为本机绝对路径（跨机不移植）；SBOM 文件无保留策略会累积；失败构建无 SBOM；attestationRef 仍 null（待 Tan 的密钥决策）。
- **桌面分发就绪复验（Linux）**：`npm run dist:linux` 在当前树上 exit 0，产物 `AI Factory-0.1.0.AppImage`（124MB）；解压验证 asar 结构完整（含编译后后端 + 42 个工作区包）；无头 `AppRun` 启动后 `/api/health`、`/api/stats` 返回真实数据，DB 真实落盘。Windows：配置就绪但本机无构建环境（wine 装不上），`release/` 里的 exe 仍是未合入载荷的模板、不可用——最短解法仍是在 Windows 机器上跑 `npm run dist:win`。macOS：需 Mac 本机 `npm run dist:mac`。代码签名：yml 与 package.json 中无任何签名配置，证书采购与配置待 Tan 决定。
- **Batch 24 独立复核**：实质声明全部成立（`gap-audit/REAUDIT_BATCH24.md`）；一处 minor 措辞偏差已修（`taskId` 为 null 的证据绑定跳过此前静默，现已补 `BUILD_EVIDENCE_BIND_SKIPPED` 审计）。
- KNOWN_LIMITATIONS：MCP 条目改写为"跨进程写互斥已关闭"、新增 SBOM 条目。测试基线：包套件 2194 → 2205（cicd sbom +6、db builds sbom 列），服务端全套 244 → 250（+6：build-runner 2、mcp ops/cross-process 4）。

## [未发布] Batch 24 — 真实构建执行 / Batch 23 独立复核 / 缺口收敛确认 / 可售清单复验

- **真实构建执行（§40 闭环）**：审计先行——"执行一次真实构建"在 merge 上下文里的五个问题全部诚实回答（报告 `gap-audit/AUDIT_BUILD_EXECUTION_24.md`）：命令唯一诚实来源是显式运维配置 `FACTORY_BUILD_COMMAND`（未配置 = 功能关闭，记录保持 `NOT_EXECUTED`；仓库内容/HTTP 输入永不作为命令来源）；`git worktree add --detach` 钉住 revision 的干净工作区（`FACTORY_BUILD_WORK_ROOT`，默认系统临时目录）；走与 `/api/exec` 完全相同的命令策略；超时默认 10 分钟杀整个进程树；成功失败都删工作区。`packages/db`：builds 状态机 `NOT_EXECUTED → SUCCEEDED | FAILED`（单向，终端行不可改写）；`definition` 改为锁定的 JSON；新增 `exit_code`/`failure_reason`/`completed_at` 列 + 老库原地迁移。`apps/server/src/build-runner.ts`（新建）：后台 FIFO 串行 runner，成功→真 digest（`lockBuild` 重算，revision/lockfile/toolchain/命令哈希/配置哈希全部真实来源，缺项点名不编造）+ `BUILD_SUCCEEDED` 审计 + digest 为真时回填 merge 证据的 `artifactDigest`；失败/超时/策略拒绝→`markFailed` + `BUILD_FAILED`。两条 merge 路径 fire-and-forget `enqueue`（merge 响应永不阻塞）。e2e：成功路径 digest 与独立 `lockBuild` 重算逐字一致、证据绑定、`'no artifact'` 移除、工作区清理；失败（exit 3）→ FAILED + 原因；策略拒绝（`rm`）→ FAILED 且未执行；未配置时保持 `NOT_EXECUTED`。关键边界：构建命令执行仓库控制的代码，**不是沙箱**，只对信任仓库启用（文档化的运维决策）；SBOM/attestation 仍 null；多机/分布式构建未做。
- **Batch 23 独立复核**：三项实质声明全部成立（`gap-audit/REAUDIT_BATCH23.md`）：builds 双实现对拍/老库迁移/merge 落记录亲跑成立；drain 租约原子性（INSERT 抢锁 + takeover CAS）与争用让路/接管/失锁中止亲验成立，双真进程测试多次稳定；23-2 与 23-4 在同一文件的并行收敛无重复实现、无冲突导出。
- **缺口收敛确认**：按"真实使用影响"排序的三个头号候选（模型路由无视 availability、工具空结果未建模、v1 迁移无生产调用）经独立重验**全部已关闭**，零代码改动——旧提案的候选在 17 个批次中被逐个关闭，缺口清单在收敛。剩余多为环境依赖（Windows 真机、真实隔离 Host、Codex 登录）、刻意设计选择或大功能项。
- **SELLABLE_CHECKLIST 全面复验**：逐项对照基线重验——A4 关键数据持久勾选（全部跨 SIGKILL 保真）；A1/A2 仍 BLOCKED（Codex 登录、桌面分发待 Tan）；A3 走查 API 层全绿但无真机桌面点验；B 高影响项关闭、剩余缺口列明；C 测试项通过、文档补两处缺口（本批已补：CHANGELOG Batch 20 小节、KNOWN_LIMITATIONS 第 41 条改写）；D 许可证/定价/署名待 Tan（备料完成，未替他定）。
- KNOWN_LIMITATIONS：builds 条目更新为"构建执行已真实落地"、MCP 条目中 merge queue 单实例假设的过时引用已改写。测试基线：包套件 2186 → 2194（db builds 状态机 + cicd 构建组装），服务端全套 237 → 244（+7 build-runner）。

## [未发布] Batch 23 — 构建记录表 / Merge Queue 跨进程互斥 / Batch 22 独立复核

- **构建记录表（§40 最小闭环第一步）**：新建 `builds` 表（digest、构建定义、revision→commit 映射、SBOM/attestation 引用；memory/SQLite 双实现对拍；老库自动建表），每次合并（直接 + 队列）经 `buildRecordInputForMerge()` 落一条记录。但合并从不执行真实构建，故 `status` 恒为 `'NOT_EXECUTED'`，digest/definition/SBOM/attestation 全为 null 且每个 null 带 pinned 原因注记（`NO_BUILD_DIGEST_NOTE` 等，测试逐字钉住）——记录缺失而非占位；candidateSha 缺失时记 `BUILD_RECORD_SKIPPED` 审计，绝不用 targetSha 冒充 revision。merge 证据的 `artifactDigest` 仍是 null + `'no artifact'`（Batch 22-3 口径不变）。边界：无真实构建执行、无新增 HTTP 端点；真正闭环还需"真实构建执行 → 状态流转 → digest 回填 → 与证据绑定"。
- **Merge Queue 跨进程 drain 互斥**：独立审计真跑复现了竞态——双进程共享同一 DB 时同一 entry 被各合并一次（4 MERGED / 2 entries），§36 串行不变量被违反；且第二进程的 hydrate 会把活着的 drainer 的 VERIFYING 行降级（偷在途工作）。实现双层互斥：① repo 级 drain 租约（`merge_queue_drain_locks` 表：原子 acquire、心跳、条件释放、takeover CAS；争用方审计 `MERGE_QUEUE_DRAIN_CONTESTED` 后明确让路；接管方诚实 re-hydrate，终态行不复活；verifier 内失锁中止合并 `MERGE_QUEUE_DRAIN_LOST`）；② per-entry `tryClaim` 原子认领（TTL 5 分钟）为纵深，无 drainLock 的旧 backing 仍受保护。修后同脚本：2 MERGED，每 entry 恰好一次，争用方返回空让路。实现中自己抓到一个真 bug（无事可做的 drain 拿了锁没放，测试抓到 lease 残留）。边界：只覆盖同一 DB 文件的多进程（不覆盖多机）；两进程同时 enqueue 的 position 可能碰撞（顺序不保证、任务不丢）。
- **Batch 22 独立复核**：四项实质声明全部成立（`gap-audit/REAUDIT_BATCH22.md`）：boot smoke 亲跑通路/注入崩溃、F7 的 eventType 投影与 DB 列逐字一致、"不接线"审计取证成立、tsconfig 修正后 desktop tsc 第一次真正跑起来且 0 错误。另确认口径：7/3/6 修正已在三处落地。
- KNOWN_LIMITATIONS 新增两条（drain 互斥、builds 表）。测试基线：包套件 2165 → 2186（db builds +3、db drain-lock +5、db claim +5、git drain +4、git claim +4），服务端全套 234 → 237（+3 build-records）。

## [未发布] Batch 22 — F6 CI 冒烟 / Batch 21 独立复核 / §40→§36 审计 / F7 收口

- **F6 的 CI 冒烟补救**：Batch 21 走查真实踩中——部分包单独构建导致 dist 跨包不一致，真 server 启动直接崩溃 exit 1，而根 `npm test` 不跑 server 套件、门禁抓不住。新增 `scripts/boot-smoke.mjs`（启动编译产物 `apps/server/dist/index.js`、轮询 `GET /api/health` 到 200；hermetic 临时 DB + 临时 `FACTORY_SECRETS_DIR`；dist 不存在直接报错），根 script `smoke:boot`，新建 `.github/workflows/ci.yml`（push/PR 到 main 跑 `npm ci` → `npm run build` → `npm run smoke:boot`）。本地验证：通路 exit 0（~2.4s）；注入崩溃模拟 F6 → 打印崩溃栈 + 大声 exit 1（dist 已恢复干净）。CI 尚未在 GitHub 上跑过一次（下次推送即触发）。`docs/release/RELEASE_CHECKLIST.md` C 组新增冒烟条目（该文件此前被 gitignore 忽略，本批强制入库）。
- **Batch 21 独立复核（沿袭 Batch 11 传统）**：四项实质声明全部成立，未发现夸大或造假（`gap-audit/REAUDIT_BATCH21.md`）。关键断言独立重验：tools-execute 11/11、implementation-gate 7/7、mcp-registry-persistence 3/3、durability+db 7/7、git evidence 5/5、走查纯净基线 1/1 + 主树 1/1。唯一修正：可达性矩阵口径 7/3/6 而非 8/3/5（shell.execute 在目录中标 definition-only 但被服务端接线因而通过门禁）——测试注释、KNOWN_LIMITATIONS、CHANGELOG 已同步修正。复核中再次证明：子批次自测数字只有稳定树复验才算数（兄弟批次在途重编 dist 曾两次让走查 404）。
- **§40 → §36 审计结论（不接线）**：产品中不存在真实可绑定的构建产物——`lockBuild()` 纯函数生产零调用、无 builds 表、合并从不触发构建、`merge_queue_entries.artifact_digest` 永远 null。`artifactDigest` 保持 null + `'no artifact'` 注记是唯一诚实状态；硬调 `lockBuild` 填 digest 等于编造，故零代码改动，仅审计报告（`gap-audit/AUDIT_BUILD_DIGEST_40_TO_36.md`）。后续路线：Batch 23+ 立项"构建记录最小闭环"（真实构建执行 → builds 表 → 绑定）。
- **F7 收口**：`GET /api/tasks/:id/outbox` HTTP 形状与 DB 列 `event_type` 词汇未对齐——审计发现该列纯写（`append` 用 `eventTypeOf(intent)` 写入，`rowToStored` 不读回，无产品代码读它）。最小诚实修复：`eventTypeOf` 导出为列写入规则单源，`outboxView` 加 `eventType: eventTypeOf(e)`（确定性投影非第二事实）；core 接口未动。测试：db 121/121（+1）、server 234/234（+1）；11 步 transition + finalize 后 HTTP 返回 11 个 `WORKFLOW_TRANSITIONED` + 1 个 `WORKFLOW_FINALIZED`，与 DB 列逐字一致。顺带补了三处路由头注释文档缺口（`/api/mcp/launch` 端点行、`/api/backups` 的 `backupId` 字段名、SSE 终端 base64 帧格式）。
- KNOWN_LIMITATIONS 新增四条。测试基线：包套件 2164 → 2165（+1），服务端全套 233 → 234（+1）。

## [未发布] Batch 20 — §46 信任流 HTTP 化 / Merge Queue 落库 / 备份调度 / Manager 页签

- **§46 MCP 信任流 HTTP 化**：`GET /api/mcp/servers/{name}@{version}/trust`（viewer：呈现信任评估或 null + 下一步）、`POST …/trust/approve`（admin，仅 BLOCKED 可批，目标策略限 AUTO/AI_REVIEW/HUMAN_APPROVAL）、`…/trust/deny`（记原因、保持 BLOCKED）、`…/trust/revoke`（信任降 LOW + 策略回 BLOCKED + 卸载 + SIGTERM 运行中的 launch，返回 `stoppedLaunches`）；非法迁移 409。`POST /api/mcp/launch` 对 BLOCKED 的 403 改为 `MCP_TRUST_NOT_APPROVED` 并指向信任端点。包层 `assessTrust` 早已存在，本批只做 HTTP 接线。边界：注册表与信任状态仍进程内（重启丢失，Batch 21 关闭）。
- **Merge Queue + PR Store 持久化**：`pull_requests` / `merge_queue_entries` 表写透；`hydrate()` 恢复 QUEUED、中断的 VERIFYING 降回 QUEUED（记 `MERGE_QUEUE_REHYDRATED`，旧验证结论只展示不信任）；同一 PR 活跃条目内存 + partial unique index 双层防重；`decisionAuditRef` 回填终端审计事件；真 SIGKILL e2e。边界：多进程同时 drain 同一 repo 的并发互斥未做（单实例假设，Batch 23 关闭）。
- **备份调度 + Retention（§47）**：`backup_schedules` 表落库；进程内调度器（自写 5 字段 cron、UTC 分钟精度、时钟可注入）到点复用同一 `createBackup`（manifest kind `scheduled`）；宕机错过记 `BACKUP_SCHEDULE_MISSED` 不补跑；失败记 failed 不自动重试。`retention_policies` 新增 `keepCount`（仅 backups，与 days 轴取并集，legal hold 最终绝对豁免）。旧库迁移有测试。
- **Manager 桌面页签**：12 阶段管理循环卡片，只用真实端点（无全局聚合数据的阶段显示"无数据"）；按 agent 分组任务/run/待审批；瓶颈提示用标注过的本地阈值（非规格公式）；零新增服务端端点。
- 主线收口修复：`backup-scheduler.ts` 的 `.ts` 后缀 import（TS5097）、桌面备份 kind 放宽到 `scheduled`。测试基线 2132 → 2146。

## [未发布] Batch 21 — 工具执行面统一 / MCP 注册表落库 / §36 证据五字段 / 走查重跑

- **工具执行面契约统一（§33）**：结论是刻意保持分层而非二合一——`@ai-factory/tools` 的 ToolExecutor 是 §33「审计直调」面（capability grant、审批门、输入 schema、幂等、退出码真相记录），`@ai-factory/runtime` 的 Harness 是 §26「智能体执行」面（name→Permission、step intent、预算、重试、trace/证据）；两套调用模型互不兼容（record-on-deny vs throw-on-deny），规格分属两章。统一的是门禁与审计接缝：`/api/tools/execute` 的原型 runner（对所有工具回 exitCode 0 的静默假成功）已替换为真 runner——runtime.echo/add 真执行，shell.execute 走与 `/api/exec` 完全相同的命令策略（deny patterns + 二进制白名单 + 控制面目录 + workspace 限制）；`ToolExecutor` 新增可选 `implementationGate` 接缝，definition-only 工具执行前被 DENIED（UNSUPPORTED_CAPABILITY）永不假成功；runner 抛 `ToolDeniedError` 转 DENIED 记录（不再是 TIMED_OUT）；DENIED/FAILED 除进 executor attempts 日志外还转发服务端审计（TOOL_EXEC_DENIED/FAILED）。16 条内置定义的可达性矩阵测试钉死（目录中 8 条 definition-only：7 条被门禁拒绝，shell.execute 虽标 definition-only 但被服务端接线因而通过门禁；3 条服务端实装全通；其余 6 条响亮失败——Batch 22-2 独立复核修正了 8/3/5 口径）。边界：shell.execute 的目录策略是 HUMAN_APPROVAL、本服务端未接 approval checker，故经此面调用仍 fail-closed DENIED（§23.4 规定行为）；git.*/test.run/ci.pipeline/deploy.run 标 implemented 但实现在各包内部、无服务端上下文无关 runner 形态——经此面调用响亮 FAILED（stderr 点名缺口）。
- **MCP 注册表 + 信任状态落库（§34/§46）**：新表 `mcp_servers`（注册全字段 + 信任等级/策略 + 评估 JSON）与 `mcp_installs` 写透；注册/握手协商/健康检查/历史追加/评估/安装/卸载全部经持久化接缝（包层保持 storage-agnostic：`McpRegistrySink` + manager 观察者 + `hydrateInstall()`/`hydrateAssessment()`，水合不产生新历史/审计事件）；服务端启动时水合，已批准服务器重启后保持信任（真 SIGKILL e2e：注册→approve→kill→重开→launch 201）。健康是时点数据：水合标 stale 且不装入 live 注册表；launches 仍进程内（Batch 19 口径）。机密防护：`credentialRefs` 只存引用名，`runtimePolicy.stdioEnvFixed` 的值落库前剥离（哨兵值全字节扫描钉住）。边界：多进程同时写同一 DB 的并发语义未做（单实例假设，与 merge queue 同口径）；腐坏行跳过并打日志不阻断启动。
- **§36 git evidence 五字段补齐（独立复核）**：复核结论——`GitRepo.merge()`/`log()` 与 MergeQueue 落库条目的五字段早就是真值，但落到 task 的 merge 证据记录在最后一公里被两条合并路由丢弃（参数显式下划线弃用）。已接通：`mergeEvidencePayload(pr, fields?)`，直接合并与队列合并的证据记录均含真值五字段（测试钉住 40/64-hex 格式与独立 `git rev-parse`/`git diff` 重算逐字一致）。边界：artifactDigest 对合并/commit 恒为 null（§40 构建 Digest 未与 git 证据面接线，记录缺失非占位）；外部工具执行的合并走无字段路径（null）；旧证据不回填；code_change 证据的 targetSha 是读取时刻 HEAD（已在代码注释写明快照语义差异）。
- **首次运行走查重跑（Batch 11 走查的第二版）**：新走查 `apps/server/tests/first-run-walkthrough-b21.test.ts`（`npm run demo:e2e-new` 可重复跑），真 server + 临时 DB、两 boot 中间一次 SIGKILL：12 步新链路（派发轴/outbox/run checkpoints/Secret Broker/交互式 PTY/备份计划/worktree/MCP 注册→信任审批→launch/PROD 部署 park→杀进程→重启→approve 真 SUCCEEDED）全绿 3/3；跨重启派发状态/outbox/备份/计划/worktree/MCP 信任/部署全保真，launch 表诚实为空；审计哈希链跨两 boot 验证通过。新发现 F6（中，基建）：部分包单独构建会导致 dist 跨包不一致——server 的 dist 调 mcp 的 dist 不存在的函数时真 server 启动直接崩溃；根 `npm test` 不跑 server 套件，门禁抓不住"编译产物能启动"的问题，建议 CI 加编译后启动冒烟。F7（低）：`GET /api/tasks/:id/outbox` 的 HTTP 形状与 DB 词汇（WORKFLOW_TRANSITIONED/FINALIZED）未对齐，暂无害。
- 主线收口修复 3 个真接缝问题：① 21-1 的 `tool-runner.ts` 无扩展名 value import 在 type-stripping 下 ERR_MODULE_NOT_FOUND；② 20-3 的 `backup-scheduler.ts` 同类问题；③ 走查测试继承开发者本地 git-ignored 的 `data/secrets/` 旧 vault 被 fail-closed 拒绝——走查现用 `FACTORY_SECRETS_DIR` 指向临时目录。教训已记入仓库级 AGENTS.md（tsc 与 type-stripping 双模式 import 规则；子批次自测数字不算数，主线必须在稳定树重跑 server 全套）。
- KNOWN_LIMITATIONS 更新三条（工具执行面、MCP 注册表落库、§36 五字段）+ 一条收口教训条目。测试基线 2146 → 2164（包套件），服务端全套 **233/233**。

## [未发布] Batch 19 — 部署持久化 / MCP 机密注入 / Worktree / 交互式 PTY 会话

- **部署持久化（§41/§77）**：deploy 经 `fdb.deployments` 写透（记录 + 可重建规格；DeploymentSpec 类型无机密值字段，值在构造上无法落盘）；重启后 `/approve` 先查注册表再按 pipelineId 重建 parked job（REHYDRATED），重建前重校验归档守卫（被归档 → 409 + `DEPLOYMENT_REBUILD_REFUSED`）与 §77 回滚能力（丢失 → 410 `DEPLOYMENT_UNRECOVERABLE`，不静默）。旧的「重启即 404」升级为重建或明确不可重建并说明原因。边界：pipeline 记录与 stage 定义仍进程内存，stub `/run` 明确 409（跑空 stage 会是假成功）。
- **MCP stdio 启动机密注入（§46.2 第二消费点）**：`POST /api/mcp/launch` 启动 stdio 服务器，`secretEnv {VAR: ref}` 的引用须先在 `credentialRefs` 中声明（未声明 403），再经 Secret Broker 短期租约解析注入子进程 env；值只在启动瞬间存在于进程内存；stdout/stderr 捕获即脱敏；缺失 ref → 403 且不启动。租约语义：rotation 只撤销 launcher 侧租约，运行中子进程保留旧值（`secretLeaseState` 标注透出）。未动 packages/mcp 内部。边界：新注册服务器默认 BLOCKED 且无信任审批 HTTP 端点，launch 对其 fail-closed 403（§46 信任流 HTTP 化为后续项）。
- **Worktree 分配器（§22.1 / G-37）**：新包 `@ai-factory/worktrees`，每个写入任务分配独立 git worktree（分支 `task/<shortid>-<slug>` 确定性命名，task id 嵌入）；记录落库（同一 (repo,task) 只允许一个 ACTIVE，partial unique index；路径全局唯一；release 只归档）；创建走 Git Broker 新增 `worktree` 动作门（task 绑定，拒绝零副作用）；release 校验记录路径（根目录内 + 命名模式）再删。非 Git 源如实降级 `dir-copy`；git 缺失而源是 git 仓库 → fail-closed。服务端 `/api/worktrees`（读 viewer/写 operator），`FACTORY_WORKTREE_ROOT` 配置。验证中抓到并修复 3 个真 bug（并发竞态/SQLite 错误分类/路由 404 口径）。边界：worktree 共享 common dir/hooks/refs，是任务级文件隔离不是 OS 安全隔离。
- **交互式 PTY 会话（§50.1）**：`@ai-factory/runtime` 新增 `PtySession`/`PtySessionManager`，内嵌 python3 监督进程持有真 PTY，控制管道（fd 3 JSON 行）实现真 resize（TIOCSWINSZ + SIGWINCH，补上 Batch 18 缺的通道）；服务端 `/api/terminal/*`（创建/列表/SSE 流/SSE 心跳/stdin/redo/resize/关闭）；Human/AI 独立 principal，AI 会话输入逐行过门（被拒行丢弃 + 审计 `AI_LINE_DENIED`，逐行近似不是防恶意模型的安全边界）；桌面 TerminalPanel 从仿真模式重接为真会话。控制端猝死时监督进程见 stdin EOF 即整树 SIGKILL 自杀（测试钉住）。
- KNOWN_LIMITATIONS 新增四条、§34 条目补 credentialRefs 消费句。测试基线 2091 → 2132。并行批次在途碰撞的主线收口：修 worktrees.test.ts 的 type-stripping 不兼容泛型写法（一行）。

## [未发布] Batch 18 — 授权轴收口 / Secret Broker / 真实 PTY / Dispatch UI

- **G-09 预授权票登记册**：`authorization_tickets` 落库 + `/api/authorization-tickets`（签发/列表/撤销）；POLICY 派发可引用票据，消费时校验状态/有效期/范围并留消费记录；票面类别维度以优先级表达（Task 无 task_type，G-06）。
- **G-11 子任务继承 + Scope Checker**（core `scope.ts`）：子任务继承 root 授权/需求版本/AC/政策上限/预算且不宽于 root；run 发起前范围校验。
- **resume 与 v2 门禁接授权轴**：§28.4 清单加 taskAuthorized；v2 transition 门禁从 Task 授权轴读真值。
- **§46.2 Secret Broker**（新包 `@ai-factory/secrets`）：引用式机密存取，env/file-vault（AES-256-GCM 机器绑定）/OS keychain（探测式）/memory 四后端，租约 + 撤销失效 + 输出脱敏；服务端仅元数据面，值永不经 HTTP 返回；`/api/exec` 新增 `secretEnv` 注入为真实消费点。验证中修复配置变量与机密前缀撞名的真 bug。
- **真实 PTY**（runtime `pty.ts`，G-11 部分）：内嵌 python3 监督进程分配真 PTY（尺寸预设、信号整树击杀），pipe/PTY 双模式对拍测试钉住 isatty/颜色/尺寸差异；`/api/exec` opt-in `pty: true` 且共用密钥脱敏，非旁路。无运行时 resize，仅 POSIX。
- **Dispatch 桌面页签**：待派发队列（POLICY 派发前端先拦缺 Rule ID）、草稿提交、授权撤销/过期二次确认、预授权票只读面；409 如实提示并刷新。
- KNOWN_LIMITATIONS 新增 Secret Broker 与 PTY 两条、§17.2 条目更新收口状态。测试基线 1999 → 2091。

本文件按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格记录
AI Factory 的变更，内容与 git 提交历史逐项对应（提交哈希附在各节标题后）。

**当前状态：尚未正式发布。** 全部条目属于 0.1.0 开发线（根 `package.json`
版本 0.1.0），版本号与分段只反映开发里程碑，不构成发布承诺。已知限制见
[docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md)；发布前剩余事项见
[docs/release/RELEASE_CHECKLIST.md](docs/release/RELEASE_CHECKLIST.md)。

## [Unreleased] — 0.1.0 开发线

### 2026-10-12 · Batch 17 — Human Dispatch / Outbox 落库 / MCP 补齐 / 工具分类

- Added：§17.2 Human Dispatch——Task 独立的 authorization_status 轴
  （DRAFT/WAITING_HUMAN_DISPATCH/AUTHORIZED/REVOKED/EXPIRED，落库），
  五个派发端点全程审计；run 发起面对非 AUTHORIZED 任务 403 且零记录。
  存量与新建默认 AUTHORIZED（兼容决定，文档在案）；POLICY 预授权记录
  via 与 Rule ID、不冒充人工。
- Added：Outbox 落库（§18.2）——outbox_events 表自始存在却无写入者，
  现经引擎 OutboxSink 接缝写入；drain 是 dispatched_at 确认戳记、
  从不删行；GET /api/tasks/:id/outbox 拉取面 + health pending 计数。
- Added：§34 MCP 补齐——真实握手保存协商版本/扩展集（工具集漂移只标
  stale 不覆写）、元数据全字段 + 追加式安装/激活历史、四级健康（执行级
  无探针如实 unknown）、熔断 + bounded retry（未知副作用不重试）+ 同
  授权替代建议、运行时策略（stdio 环境过滤真实执行、gate 执行前拒绝）。
- Added：§33 工具分类——11 类一等枚举 + 注册表分类归一化/查询 + 全字段
  校验器 + 16 条内置定义（8 已实现 / 8 仅定义，逐条在案）。
- 主线复验：构建 0 错误，测试 1999/1999，全部 demo 通过。

### 2026-10-12 · Batch 16 — 审批 resume 修复 / Git Broker+合并队列 / §21 调度 / Observatory

- Fixed：pipelines approve 的 resume 此前永远找不到 parked 部署
  （DeploymentService 每请求新建）——parked job 改存可注入的共享注册表，
  跨请求 approve 真正完成部署；重启后 parked 不可恢复但失败明确（404），
  已写入 KNOWN_LIMITATIONS。
- Added：Git Broker（§36）按动作分级管控（策略未允许即拒绝、决策进
  审计、push/merge/remote 默认必须绑定 task），服务端 git 写路由改经
  Broker；Merge Queue 串行处理 PR、合并前组装候选并验证（缺省冲突
  检测），失败出队不阻塞队列。队列状态进程内，与 PrStore 一致。
- Added：§21 调度硬约束（G-30…G-36 全数落地）：九项前门禁结构化判定、
  enqueue 权力拒绝、多因子确定性排序（本地口径已标注）、aging、P0
  安全点抢占指令与迁移保护、预留槽、策略优化器 + 带解释的人工 override
  拒绝、预算货币/CPU/RAM 维度与原子 reserve→charge→settle/release、
  超限映射 BUDGET_BLOCK/RESOURCE_BLOCK 任务条件。服务端优先级校验
  同步对齐 P0–P4。
- Added：Observatory 桌面页签——全局 run 列表（服务端 join manifest
  摘要与 live 标记，中断遗留如实标注）、全量 manifest 展开、检查点
  查看复用、从检查点恢复入口（逐项 checks 结果如实呈现）。
- 主线复验：构建 0 错误，测试 1931/1931，全部 demo 通过。

### 2026-10-12 · Batch 15 — 守卫补齐 / RBAC / Checkpoint 恢复 / Run Manifest

- Fixed+Added：归档守卫补齐 pipelines/git 执行面（commit 在发生之前拒绝、
  纯仓库操作明确不守卫）；retention tombstone 映射使被删 run 的残留
  intents/checkpoints 继续按原项目解析，不再成永久孤儿。顺带记录既有
  缺陷：pipelines approve 的 resume 因服务实例-per-请求而不可达
  （KNOWN_LIMITATIONS 在案，待修）。
- Added：服务端 RBAC——viewer/operator/admin 三档（FACTORY_API_TOKENS），
  高危面（backup/restore/retention/policy/自治等级）仅 admin；不配置时
  单 token 即 admin、行为与从前逐字一致。whoami 端点 + 桌面顶栏角色徽标。
- Added：Checkpoint 恢复流程——POST /api/runtime/runs/:id/resume 按 §28.4
  逐项重校验，全过才生成新的恢复 run（预算基线与步位承接 checkpoint，
  linkage 落证据与审计）；明确不是内存现场热迁移。
- Added：Run Manifest——每次 run 的问责清单落库（身份/驱动/授权/预算/
  上下文哈希创建快照 + 终局/模型来源/用量/intent 分桶/证据计数补全），
  GET 查询面与 Final Report 运行记录段；遗留 run 无 manifest 返回 404，
  不回填编造。
- 主线复验：构建 0 错误，测试 1853/1853，全部 demo 通过。

### 2026-10-12 · Batch 14 — 桌面呈现 / 项目归档 / Adapter 契约 / Retention

- Added：桌面 UI 呈现已有服务端能力——Final Report 页签（Report）、备份/恢复
  面板（Ops，恢复为两段确认并明示 restartRequired）、run 详情的
  checkpoints 查看。空状态一律呈现服务端原文，不补数。
- Added：项目归档生命周期——active ↔ archived 落库（旧库自动补列），归档
  不删数据、只读面全开、列表默认过滤；全部产生新事实的写路径（任务/证据/
  流转/导入/run/v2/审批/review/QA）经共享 guard 拒绝（409 PROJECT_ARCHIVED）。
  已知未守卫：pipelines/git 执行面，见 KNOWN_LIMITATIONS。
- Added：§26.2 Adapter 十方法契约（adapter-contract.ts）——Stub 与 Codex
  两实现全量落地，同一契约测试电池双跑；不支持以 UNSUPPORTED 抛出、
  答不出以 source:'none' 表达，无假成功。顺带修复服务端 router 路径四个
  能力维度从未解析、quota checker 隐私口径与 router 相悖两处。
- Added：Retention + Legal Hold（§47）——按类别配置保留期，默认永久保留；
  evaluate 纯 dry-run，enforce 需显式确认字段且执行时重新评估；audit 与
  evidence 等类别明示排除并给出条款依据；孤儿记录 fail-safe 豁免并留
  tombstone 待办。
- 主线复验：构建 0 错误，测试 1844/1844，全部 demo 通过。

### 2026-10-12 · Batch 13 — v2 状态落库 / Checkpoint 真实消费 / 备份恢复 / 发布备料

- Added：TaskV2State 整体落库（`task_v2_state` 表）——v2 引擎镜像全字段在
  每次提交变更后落盘，重启水合恢复，finalSeal 跨重启保真（Batch 12 的 F1
  残留关闭）；DB 行对 v1 的有损写回映射不变。
- Added：Checkpoint 第一个生产消费方——HTTP run 经 AgentLoop 的 onTrace
  步界逐步捕获 checkpoint（字段全部来自真实事实），
  `GET /api/runtime/runs/:id/checkpoints[/latest]` 为恢复点读取面；
  不自动 resume。顺带修复：HTTP run 的 step intents 此前全盖 'unknown-run'，
  现盖真实 run id。
- Added：备份/恢复——`POST /api/backup`（VACUUM INTO 一致性快照 +
  manifest 哈希与逐表计数）、`GET /api/backups`、`POST /api/restore`
  （校验 → 自动 pre-restore 备份 → 排队至下次重启生效，旧库改名保留）。
  范围仅工厂数据库，边界见 KNOWN_LIMITATIONS。
- Added：发布备料——本 CHANGELOG、README 按现状改写、
  `docs/release/LICENSING_OPTIONS.md`（三条许可证路线对比，待 Tan 拍板）、
  `docs/release/RELEASE_CHECKLIST.md`。
- 主线复验：构建 0 错误，测试 1826/1826，全部 demo 通过。

### 2026-10-12 · Batch 12 — 走查发现 F1–F4 修复 + intent 先于权限门（`fc894da`）

- Added：`POST /api/tasks/:id/v2-complete`——服务端从真实事实组装 §20.1 完成
  快照并调用 `finalize()`，v2 生命周期经纯 HTTP 可达 DONE，final_seal=1 落盘
  且镜像与 DB 一致（F1）。
- Added：需求落库——requirements 包抽出 `RequirementStore` 接缝，db 包提供
  `SqliteRequirementStore`（版本行只写一次、永不更新）；服务端三 boot 回归
  钉住：重启后带 pin 证据登记不再 400、STALE 门中间的任务凭已存兼容声明
  直接放行（F2）。
- Changed：v2 迁移提交后封存被消费证据（`onSealEvidence` 接线）；谓词检查型
  证据（生产审批）不封存（F3）。
- Added：run 记录落库（`RuntimeRunStore` + `runtime_runs` 表），每次变更同步
  落盘；被杀进程的 RUNNING 记录原样保留、不自动改写（F4）。
- Changed：StepIntent 改为权限检查*之前*落盘，被拒调用留 DENIED 终态 intent
  （复核观察 1）；SQLite store 的 DENIED 标签与内存实现对齐。
- 主线复验：构建 0 错误，测试 1819/1819，全部 demo 通过。

### 2026-10-12 · Batch 11 — 首次运行走查 / Checkpoint 落库 / 打包收尾 / 独立复核（`53f04c5`）

- Added：首次运行全流程走查（真实 server × 3 次启动、同一临时库、纯 HTTP），
  八步全通并存档为常驻测试 `demo:e2e` 与 docs/FIRST_RUN_WALKTHROUGH.md；
  走查发现 F1–F4（见 Batch 12 修复）。
- Added：Checkpoint 落 SQLite（`CheckpointStore` 接缝 + `CheckpointLog` +
  `SqliteCheckpointStore`，`/api/health` 可查存量）。**诚实边界：尚无生产
  消费方，检查点级恢复未生效。**
- Added：应用图标（零依赖脚本生成 SVG 源 + PNG）、根 package.json 补
  author/desktopName；Linux AppImage 带图标重建（约 124MB）并无头运行验证。
- Added：独立复核报告 gap-audit/REAUDIT_BATCH_1_10.md——未参与开发的审计员
  抽查 Batch 1–10 共 21 条已关闭项，21 条全部证实、0 假关闭，附 4 条观察。
- Known issue：Windows 安装包未能在本机定稿——Ubuntu 包源不可达导致 wine
  无法安装；配置与载荷已就绪，需在 Windows 机器执行 `npm run dist:win`。

### 2026-10-12 · Batch 10 — 干净构建顺序 / HTTP run 工具白名单 / OperationLedger 落库 / 桌面 token（`e47c797`）

- Fixed：根 build/test 脚本改为经审计的拓扑序（查出 4 处顺序违规 +
  incidents 包从未被根 build 构建）；从全 dist 清空状态实测可一次构建成功。
- Added：`FACTORY_RUNTIME_TOOLS` 工具白名单——HTTP run 放行工具的唯一路径，
  未知工具名启动 FATAL / 请求 500 并写审计，默认不设 = 全拒。
- Added：OperationLedger 经 `OperationStore` 接口落 SQLite；服务端启动
  reconcile 只分类（safe-to-retry / needs-manual-recovery）写审计，不采纳不改状态。
- Changed：桌面端全部 22 文件 / 24 个 fetch 点统一注入认证头（无 token 时
  请求与改前逐字一致）。

### 2026-10-12 · Batch 9 — 可售性：DB 持久化 / API 认证 / Final Report / 桌面打包（`4dcce5b`）

- Added：审计哈希四列落 SQLite（链跨重启可验，旧行不伪造哈希）；
  `SqliteStepIntentStore` 接进服务端 run 路径；启动扫描写
  STARTUP_INTERRUPTED_INTENTS 审计并在 `/api/health` 可见（只报告不处置）。
- Added：服务端 API 认证 `FACTORY_API_TOKEN`（Bearer 门、统一 401 +
  AUTH_DENIED 审计、非 loopback 无 token 拒绝启动）。
- Added：Final Report 生成器 `GET /api/projects/:id/final-report`（含
  `?format=md`），全部段落源自 DB 真实记录，WAIVED 单列，带 sha256。
- Added：electron-builder 按真实主进程契约重写并打通 Linux AppImage
  构建 + 无头运行验证；修复后端自拉起死循环等两个真实 bug。

### 2026-10-12 · Batch 8 — 证据版本追踪转正 / 审计哈希链 / Exception Grant / 模型能力补齐（`987754a`）

- Added：证据版本追踪——登记证据校验 requirementId+version（假版本 400），
  evidence 表加 requirement_version 列；Batch 7 的兼容白名单经真实 HTTP 全链生效。
- Added：core 审计 hash chain（summaryHash 含 prevHash、GENESIS 根、
  verifyAuditChain 检篡改/调序/删除）。
- Added：§23.4 Exception Grant（human-only、理由必填、TTL 默认 24h/上限 7d、
  BLOCKED 动作不可豁免、WAIVED 单列且永不冒充 APPROVED）。
- Added：§26.1 ModelCapabilities 补齐 7 字段（目录值标注「声明值未经实测」，
  未声明 = 不具备，路由 reason 点名排除）。

### 2026-10-12 · Batch 7 — 完整性：空结果诚实化 / 证据兼容白名单 / 策略守卫 / 租约真等待（`8938108`）

- Changed：runtime harness 对空工具结果诚实化（0/false 是真结果；证据标
  empty:true、intent 的 resultHash 独立承诺）。
- Added：GateContext.compatibleEvidenceIds 只豁免版本不一致这一处 STALE
  判定（当时 server 侧为潜伏能力，Batch 8 转正）。
- Added：PolicyStore.set() 守卫——改/删/解锁已有 locked 规则须 caller 权威
  ≥ 该层，同层 peer 隔离，原子拒绝并留痕。
- Added：leases 真实超时等待（deadline 内重试、LockTimeoutError 带 waitedMs；
  timeout 0 保持旧单次语义）。

### 2026-10-12 · Batch 6 — 接线：v1 迁移 / git 证据五字段 / EMPTY_RESULT / 通知治理（`3498c9f`）

- Added：§58 v1→v2 迁移接进生产导入路径（migrate → validate → write；
  v1 任务完成只记 legacy_completion_unverified，禁集体 VERIFIED；迁移报告
  落 `.ai/migration-report.json`）。
- Added：§36 git 证据五字段（base/candidate/target SHA、diff sha256、
  artifactDigest；无产物如实 null + artifactNote）。
- Added：§33 工具 EMPTY_RESULT 结局（退出 0 + stdout 空 + 无产物，不算错误
  也不 seal 成功证据）。
- Added：§32 通知去重合并（滑窗 5 分钟）与限流（30/60s，超限汇总不静默）。

### 2026-10-12 · Batch 5 — 接线：评审独立性强制 / StepIntent 默认接线 / fallback 兼容性（`4ec1db6`）

- Added：server review 路由强制评审独立性（缺身份 400、自审 422、拒绝写
  审计、零证据封存）。
- Added：StepIntent 默认接线进 runAgent（当时为内存 store，落库见 Batch 9）。
- Added：G-57 fallback 兼容性注入路由决策（不兼容的 fallback 跳过并在
  reason 中点名）。

### 2026-10-12 · Batch 4 — 完整性硬约束（`b3e42bf`）

- Added：§16 需求数据层门禁——newVersion 不得绕过 HUMAN 授权改完成目标或
  AC 语义（diff 判定）；VERIFIED_DELIVERY 创建强制 HUMAN 授权 + 允许的
  项目类别。
- Added：§20 进度硬约束——无证据的正完成度被拒；无 seal 的计划封顶
  99.99% 并标注 blocker；ProgressReport.currentGate。
- Added：§18 引擎租约门谓词（STALE_OWNER，fail-closed）、成功迁移 Outbox、
  FailureEvent 记录。
- Added：§6 项目 discover 诊断（detected 与 verified 分离，绝不推断 PASS）；
  createProject 拒绝非空目录（force 可覆盖）。

### 2026-10-12 · Batch 3 — 接线收口（`6b55110`）

- Added：`POST /api/requirements/:id/links`（promotion-check 409 在完整
  HTTP 链验通）。
- Changed：看板 `/api/stats` 的 AOCR 改由真实数据喂给（口径明示：authorized
  := 有 APPROVED 审批，completed := DONE；无数据时如实 null/暂无数据）。
- Added：`GET /api/router/account` 改为 live 优先——经 CodexAdapter 查询
  真实账号状态并标注来源，失败才回退 stub（标注 STUB）；demo:codex 加入
  demo 套件（第 45 个）。

### 2026-10-12 · 真实模型接入（路线 B）：Codex app-server 适配器（`18fce3c`）

- Added：CodexAdapter 真实实现——JSON-RPC over `codex app-server --stdio`
  子进程或 ws://，initialize → thread/start → turn/start 全流程；动作映射
  为 observed actions（toolCalls 恒空，避免工厂 harness 重复执行）；线程
  默认只读沙箱 + approvalPolicy never，fail-closed；`getAccountStatus()`
  真实查询账号状态。
- Verified：假 app-server 夹具测试通过；真机验到认证边界（未登录 turn 被
  真实 401 拒绝、错误原文透传）。**真 turn 待 `codex login` 后验证，未完成。**

### 2026-10-12 · Batch 2 — 缺口修复（`96ade1c`）

- Added：PromotionHold 门禁强制、进度计划锁定 + 团队聚合、AOCR 主指标、
  runtime 预算在真实调用点强制、v2 工作流引擎服务端接线（v2-transition /
  v2-state 路由）。

### 2026-10-11 · 规格审计缺口修复批（`07efce4`）与 DEF 修复（`47856d7`、`ee355f2`）

- Fixed：59 章规格审计发现的 199 条缺口中先行关闭 24 条（安全、fail-closed
  审批/工作流、注册表完整性类优先）。
- Fixed：DEF-002/DEF-003——`POST /api/watchdog/workers` 与
  `POST /api/takeovers` 缺必填字段时返回 400（此前空 body 可穿透）；
  DEF-001（审批加固）已随 v2 实现关闭。

### 2026-10-10 · SPEC v2.0 实现（`55a9613`）

- Added：以 SPEC_V2.md（59 章、35 条不变量 INV-01–35、64 个 AT 场景）为
  权威规格，在 v1 代码上就地演进（非重写）：治理（审批 §23.3 加固、策略
  限制性交集、api-contracts）、状态真相（requirements §16、工作流三态 §18
  + 五里程碑 §19、progress §20）、执行面（隔离后端 fail-closed、tools §33、
  leases §22、factory-control §24）、验证（评审独立性 §37、qa §38、cicd
  风险/canary §40–41、incidents §42）、运行时（12 态 §25、durable ops §28、
  quota §27、watchdog §30、takeover §31）、证据契约 §39、数据与组织
  （db §48、组织图 §9、v1→v2 迁移 §52）、学习闭环（memory §43、knowledge
  §44、evaluation §45）、委派与报告（§12.2/§14）、桌面 OpsPanel。
- 当时验证：40 个包构建 0 错误，1470/1470 测试，桌面 Vite 构建通过；
  AT 映射 21 covered / 26 partial / 17 blocked（blocked 均为环境性）。

### 2026-10-10 · v1 规格全量同步（`1678960` 及此前 15 个同步提交）

- v1 原型全量代码同步至 GitHub（16 个提交）；其间补回本地已有但远端缺失的
  cicd、memory、skills 包源码与 package-lock.json，远端与本地树对齐。

### 2026-10-09 · v1 原型四批（`5b8d673`、`f0929e6`、`e9878c9`、`dc14b15`、`3dccf20`）

- Added：初始提交与四批原型——核心领域层与 Electron+React IDE 壳；Git/QA/
  审批面板与引擎；安全、快照/恢复、资源预算、自治分级、并行冲突串行化、
  争议裁决；Activity 流、Dashboard、组织图、任务详情、知识中心、模型注册
  表、通知、导入/导出、打包配置。此阶段为 v1.0 规格（`AI_factory.txt`）的
  原型实现，后由 SPEC_V2 取代为权威规格（见 2026-10-10 条目）。

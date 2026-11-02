# AI Factory 进阶功能指南（0.2.0）

> 面向已经会用基本流程的用户：MCP、Plan mode、Slash 命令、Hooks、
> 权限分级、Headless CLI、会话恢复与检查点、联网搜索、多模态输入、
> 插件、PR 审查；以及加强波新增：命令面板、任务调度、代码索引、
> 通知中心、性能仪表盘、一键离线、自动备份、任务模板、审计导出、
> 多项目、质量闸门、仓库地图、会话隔离、OS 沙盒、权限规则、
> @ 上下文提供器、影子检查点、团队门禁、批量变更、实时协同、
> 覆盖率可视化、忽略文件、问题匹配器、安全扫描、配方迁移、
> 影响分析、出站防火墙、范围锁定、设计模式、DB 时间旅行、
> 自动更新、Flaky 检测、基准回归统计、Local History、devcontainer、
> 变异测试、sweep.yaml、编辑器/终端小件、预发送密钥扫描、
> 确定性重构、结构化搜索替换、TODO 追踪、依赖顾问、
> DAP 调试器、数据库浏览器、HTTP 客户端、性能剖析、终端命令历史。
> 快速上手见 [USER_GUIDE.md](USER_GUIDE.md)；
> 已知限制见 [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)。
> 英文版：[ADVANCED_FEATURES.en.md](ADVANCED_FEATURES.en.md)。

## 1. MCP：连外部工具，也把自己交出去

**是什么**：MCP（Model Context Protocol）是 AI 工具之间的通用插头。
AI Factory 既能**连别人**（把外部 MCP server 的工具拿来给自己的
Agent 用），也能**被别人连**（把自己变成一个 MCP server，供
Claude Code / Codex 这类外部 Agent 调用）。

**连外部 MCP server**（MCP 面板）：

1. 点「MCP」tab → 添加 server，填类型：
   - `stdio`：本地命令（如 `npx -y @modelcontextprotocol/server-filesystem`），
     附参数；
   - `http`：远程地址（stateless Streamable HTTP，按 2026-07-28 修订版；
     老式的 HTTP+SSE 已废弃，不再支持）。
2. 需要登录的 server 走 OAuth 2.1：按面板提示在浏览器完成授权，
   token 按"发行方隔离"存进加密 vault（不同 server 的 token 互不可见）。
3. 连上后，server 的工具会出现在 Agent 可用工具里。

**把自己暴露成 MCP server**（给外部 Agent 用）：

```bash
# 先构建服务端，再启动 stdio bridge（它只是个转发器，鉴权仍在 server 端）
node apps/server/dist/mcp-serve.js
```

外部 Agent（如 Claude Code）这样配置：

```json
{ "command": ["node", "/path/to/ai-factory/apps/server/dist/mcp-serve.js"],
  "env": { "PORT": "3100", "AI_FACTORY_TOKEN": "<你的 API token>" } }
```

暴露 6 个工具：`factory_list_tasks`、`factory_create_task`、
`factory_get_task`、`factory_knowledge_search`、`factory_read_file`、
`factory_write_file`。MCP 面板里有总开关，关掉后外部调用会被明确拒绝。

**诚实边界**：远程 MCP 的 OAuth 需要到真实服务上走一遍授权才算数；
bridge 本身不做鉴权，靠转发的 token，server 没配 token 要求时不要暴露到公网。

## 2. Plan mode：先出计划，你点头再动手

**是什么**：对标 Codex plan mode。Agent 先写计划（做什么、为什么、
每步的验收标准），你批准后它才执行；不批准，它不动手。

**怎么用**：

1. 「Plan」tab → 新建计划（或在聊天里 `/plan`，见第 3 节）。
2. 计划生成后逐条看 → 点「批准」或「驳回」（驳回可写理由）。
3. 批准后点「执行」，执行过程受第 5 节的权限分级约束。

计划批准走的是审批（Approvals）通道：批准记录带计划内容的
sha256，谁批的、批的是哪个版本，审计链里查得到，事后抵赖不了。

## 3. Slash 命令：顶栏输入 `/` 试试

顶栏有个命令输入框，输入 `/` 会自动补全：

| 命令 | 干什么 |
|---|---|
| `/help` | 列出所有可用命令 |
| `/plan …` | 快速起一个计划（进 Plan mode） |
| `/review …` | 对当前 diff 做一次审查（见第 11 节） |

自定义命令：server 的 `slash-commands.json` 里加，支持 `{args}` /
`{args:N}` 占位符。命令只是快捷入口，真正的高风险动作照样走审批。

## 4. Hooks：工具执行前后的"门卫"

**是什么**：对标 Codex/Claude hooks。在 Agent 调用工具**之前**
（PreToolUse）、**之后**（PostToolUse）以及**停止时**（Stop）运行你写
的确定性脚本（`sh -c`，参数走 stdin JSON）。

**怎么用**（Hooks 面板）：

1. 新建 hook：选事件（PreToolUse / PostToolUse / Stop）、匹配的工具、
   脚本内容。先点「dry-run」试跑，看输出对不对。
2. PreToolUse 的脚本如果"否决"，这次工具调用会被拦下（403
   `HOOK_VETO`），并且记进审计链——Agent 会收到"被 hook 否决"的
   结果，而不是静默失败。

**诚实边界**：hook 是确定性脚本，不是 AI 判断；Stop hook 目前只接了
plan finish，agent-loop 的真实停止点还没接（超范围，留待后续）。

## 5. 权限分级：四档 × 三态

**是什么**：对标 Codex/Claude 的权限模型。每个 Agent 有一档：

| 档 | 能干什么 |
|---|---|
| read | 只读：看任务、看文件、看审计 |
| write | + 写文件、改任务 |
| exec | + 跑命令、调工具 |
| admin | + 改权限、改配置 |

每条规则还有三态：`auto`（直接放行）、`ask`（先问你）、`deny`
（直接拒绝）。匹配规则是最具体的模式胜出；平局时
`deny > ask > auto`；没命中任何规则时默认 `ask`（fail-closed，
宁可多问一句也不擅自放行）。

和审批通道是"就严"组合：权限说行、审批说不行，以审批为准；
`deny` 永远不被放行。在「Permissions」tab 里配。

## 6. Headless CLI：不打开界面也能跑

**是什么**：对标 `claude -p` / `codex exec`。管道里扔一句话，
不打开界面也能跑任务，适合 CI 和脚本。

```bash
# 方式一：--prompt
npm run headless -- exec --prompt "把 README 里的错别字修了"
# 方式二：管道（stdin 不是 TTY 时自动读取）
echo "把 README 里的错别字修了" | npm run headless -- exec
# 机器可读
npm run headless -- exec --prompt "..." --json
# 带图片（见第 9 节）
npm run headless -- exec --prompt "描述这张图" --image ./shot.png
```

exit code 语义：0 成功 / 1 操作失败 / 2 用法错误·超时·中断。
token 走 `--token` 或 `FACTORY_API_TOKEN` 环境变量（和服务端同源，
CLI 绝不打印它）。

**诚实边界**：跑起来用的是服务端同一套 adapter；stub 适配器下 run
会"成功"但智能程度等于 stub（真实模型见 USER_GUIDE 的诚实边界）。

## 7. 会话恢复与检查点：随时回档

**是什么**：对标 `codex resume` 和 Claude 的 Esc-Esc rewind。
会话（session）是持久化的；检查点（checkpoint）是一键回滚。

- 「Session」tab：会话列表 → 选中 →「恢复」，拿回当时的任务状态
  和每个 run 的恢复点，接着干。
- 「创建检查点」：把**会话状态 + 代码 diff**一起快照。玩脱了点
  「回滚」：先自动建一个 `pre-restore` 安全检查点（回滚本身也可逆），
  再恢复会话、`git apply` 打回代码。`git apply` 通不过检查就**整个
  不动**（fail-closed，宁可不动也不半吊子）。

CLI 里也一样：`ai-factory sessions list|create|attach|resume <id>`、
`ai-factory checkpoint create|list|restore`。

注意：checkpoint 的代码部分只含**已跟踪文件**的 `git diff`
（未跟踪的新文件不在内），超大 diff 会截断并明确标记。

## 8. 联网搜索：Agent 也能上网查资料

**是什么**：Agent 运行时可用的 `web_search` 工具。

- 开箱即用：默认 Bing RSS，无需 key。生产环境建议配 Brave /
  Tavily 的 key（vault 里 `search.brave.key` / `search.tavily.key`，
  或 `BRAVE_SEARCH_API_KEY` / `TAVILY_API_KEY` 环境变量，vault 优先）。
- `GET /api/search/providers` 查看当前可用 provider（不暴露 key）。
- 给 Agent 开：在服务端环境变量 `FACTORY_RUNTIME_TOOLS` 里加上
  `web_search`（opt-in，默认不开；权限 `network.access`）。

**诚实边界**：搜索结果是**不可信外部内容**，入库 prompt 前会被
`sanitizeUntrusted()` 隔离标记为 DATA（防注入）；Bing RSS 只允许
personal/non-commercial 用途，商用请配 key。

## 9. 多模态输入：贴图给 Agent 看

**是什么**：建任务时可以贴图（粘贴 / 拖拽 / 文件选择都行），
缩略图预览，单张 ≤10MB、最多 8 张，失败会大声报错不静默吞掉。

图片存在服务端（`POST /api/tasks/:id/attachments`），任务和图片
绑定。Headless 见第 6 节 `--image`。

**诚实边界（重要）**：当前两个适配器都声明 `vision: false`——
prompt 里只会**具名**提到图片（"附带图片 2 张"），**不会**假装
"看懂了图"。图片 bytes 存着、随时可取，但真要让模型"看见"，
需要换一个有视觉能力的真实模型（用户侧事项）。

## 10. 插件：本地安装的能力包

**是什么**：插件 = 一个目录 + `plugin.json`（名字/版本/权限声明/
能力：skills、slash 命令、hooks、MCP servers）。「Plugins」tab 里
从**本地目录**安装：

1. 点「安装」，填插件目录路径。
2. 安装时做校验：manifest 格式、权限声明展示给你看、路径监狱
   （不许写出插件目录）、拒绝 symlink；任何一步失败**整个回滚**。
3. 装好后可启用 / 禁用 / 卸载，三者精确互逆；每步都进审计链。

插件装进来的 skill 会经过安全扫描（§74），高风险未人工批准则
安装回滚。**远程插件市场不做**（生态决策），manifest 已预留扩展位。

## 11. PR 审查：diff 里直接评论

「Git」面板 → PR 列表 → 点进一个 PR：

1. 看结构化 diff（按文件 / hunk 展开，点行号定位）。
2. 在某行直接写行内评论（评论入库前消毒，防注入）。
3. 点「批准」/「要求修改」/「仅评论」。

审查是**记录性**的：审查状态展示在 PR 详情里供人判断，**不阻塞
merge**（改 merge 语义风险大，没动）。

## 12. 命令面板 Cmd+K（加强一波）

**是什么**：全局命令面板（对标 VS Code 的 Cmd+K / Ctrl+K）。
不用鼠标翻 tab：模糊输入，一次跳到任意面板、任务、智能体，
或直接新建任务。

**怎么用**：界面任意处按 Cmd+K（Windows/Linux 上 Ctrl+K），
输入关键字，↑↓ 选择，回车执行。

**诚实边界**：只是快捷入口——跳过去之后的操作照样受权限分级
和审批约束，不绕过任何门。

## 13. 本地任务调度：自研 5 字段 cron（加强一波）

**是什么**：服务端自研调度器（零依赖）：cron 表达式
（5 字段：分 时 日 月 周）或固定间隔，定时触发 job
（备份、检查、跑测试等）。

**怎么用**：`POST /api/schedules` 建调度：
`{name, kind: 'cron'|'interval', cronExpr|intervalMs, job}`；
非法表达式直接 400 拒绝，不静默吞掉。

## 14. 代码索引 codeindex（加强一波）

**是什么**：项目的符号级搜索引擎：索引函数/类/导出符号
及其引用关系，是 @ 引用、仓库地图、影响分析的共同底座。

**怎么用**：索引增量式（mtime+size 没变的文件直接复用）；
两级忽略文件的关口直接装在索引入口（见 §33），
被忽略的文件从索引和查询两侧都不可见。

**诚实边界**：引用关系是启发式符号名匹配（同名符号会有噪声），
不是编译器级语义——影响分析的报告页会明示这一点。

## 15. 通知中心（加强一波）

**是什么**：所有异步事件的统一收件箱：hook 否决、安全扫描拦截、
出站防火墙拦截、备份完成等，按严重度分级（HIGH 置顶）。

**怎么用**：顶栏铃铛图标点进去，按类型/严重度过滤。
通知只是"发生了什么"的记录——处理动作（如放行被拦请求）
在各自面板做。

**诚实边界**：通知不是审批通道；需要你点头的动作
走「审批」tab。

## 16. 性能仪表盘（加强一波）

**是什么**：「性能」tab：服务端 `/stats` 吐出的运行指标
（任务数、智能体数、QA 失败、部署等）的实时看板，5 秒刷新。

**诚实边界**：展示的是服务端自报指标，是抽样视角，不是 APM；
指标口径见面板里每项的来源标注。

## 17. 一键离线（加强二波）

**是什么**：顶栏一键开关：打开后切断所有外部网络出口
（联网搜索、远程 MCP、webhook）——防代码外泄的"大红按钮"。

**怎么用**：顶栏开关点一下即生效；环境变量
`FACTORY_NETWORK_OFFLINE=1` 可强制离线（配置优先于开关）。

**诚实边界**：二值开关——要么全断要么全开；想要"只放行 npm"
那样的细粒度，用 §38 的出站防火墙。

## 18. 自动备份与保留策略（加强二波）

**是什么**：「运维」tab 的备份面板：手动一键备份 + 自动定时备份。
保留策略只删 `scheduled` 自动备份（留最新的 N 个），
手动备份和回滚备份永不自动删除。

**怎么用**：备份面板里开自动备份、设保留个数；恢复时先自动建
pre-restore 安全点——回滚本身可逆。

**诚实边界**：保留策略删的只是"自动备份"；手动备份不受影响。
（曾经有个 soak 抓到过误删手动备份的真 bug，已修并加了回归测试。）

## 19. 任务模板库（加强二波）

**是什么**：建任务时"从模板创建"：把常用的任务结构
（目标、验收标准、约束）存成模板，一键套用。
首次启动内置 3 个种子模板。

**怎么用**：新建任务弹窗 →「从模板创建」；模板存在
`AI_FACTORY_DATA_DIR/task-templates.json`，可增删改。

**诚实边界**：模板是"填空"不是"代办"——只预填字段，
不会自动执行。

## 20. 审计合规导出（加强二波）

**是什么**：审计链的一键导出：按时间范围导出 CSV 或 JSON，
响应头里带导出快照的元数据（格式、范围、条数），给合规/审计用。

**怎么用**：
`GET /api/audit/export?format=csv|json&from=<ISO>&to=<ISO>`；
CSV 是纯 RFC4180，可直接进 Excel。

## 21. 多项目并行（加强二波）

**是什么**：一个服务端同时管多个项目：项目列表、按项目隔离
任务/知识库/审计视图，顶栏项目切换器一键切换。

**怎么用**：左侧「项目」面板建项目、切项目；各 tab 的数据
都按当前项目过滤。

**诚实边界**：隔离是"数据归属/视图"层面的；
执行层的隔离看 §25 的 OS 沙盒。

## 22. lint/test 质量闸门（第三波一）

**是什么**：CI 式的质量门：跑 lint、跑测试、跑覆盖率，
任一步失败就拦下（blockOnFailure），结果进审计链。

**怎么用**：「质检」tab 配门禁；跑测试可产出覆盖率报告
（见 §32），支持"覆盖率下降即阻断"。

**诚实边界**：门禁跑的是项目自己的 lint/test 命令——
我们负责"跑 + 判"，不负责"写"。

## 23. AST 仓库地图 repomap（第三波一）

**是什么**：仓库的 AST 级地图：文件 → 符号 → 引用关系的
静态结构，给 Agent 做"代码导览"用。

**怎么用**：Agent 通过 @ 上下文提供器自动取用；
人和 Agent 都不用手配。

**诚实边界**：启发式解析（不是全量编译），同名符号有噪声；
动态导入/反射抓不到。

## 24. worktree 会话隔离（第三波一）

**是什么**：每个会话独占一个 git worktree：Agent 在隔离的
工作树里改代码，互不踩脚；结束时可合并、可丢弃。

**怎么用**：会话创建时自动分配 worktree；
「Git」面板可看各会话的工作树状态。

**诚实边界**：隔离的是"工作区"，不是操作系统级沙盒
（那是 §25）。

## 25. OS 沙盒三档（第三波一）

**是什么**：命令执行的三档 OS 隔离：read-only（只读）、
workspace-write（限工作区写）、关闭。用 bwrap 实现（Linux）。

**怎么用**：exec 配置里选档；**fail-closed**：
read-only / workspace-write 要求 bwrap 可用，
不可用就拒绝执行，不降级偷跑。响应里会如实报告
实际生效的档位。

**诚实边界**：bwrap 不可用时宁可拒绝也不"假装隔离"；
这是目录/系统调用层面的隔离，不是虚拟机。

## 26. allow/ask/deny 权限规则（第三波一）

**是什么**：§5 四档权限之外的"规则层"：按 glob/动作名写规则，
每条规则三态 allow/ask/deny，最具体的匹配胜出，
平局时 deny 优先。

**怎么用**：「Permissions」tab 配
`.ai-factory/permissions.json`；规则变更进审计。

**诚实边界**：规则管的是"我们的工具面"；
用户手动操作不受限。

## 27. @ 上下文提供器（第三波二）

**是什么**：聊天里 `@` 引用代码/问题/文件树：
@open（打开文件）、@tree（目录树）、@problems（问题列表）、
code_search（代码搜索）等提供器，把上下文精准喂给 Agent。

**怎么用**：聊天输入框打 `@` 即补全；两级忽略文件的硬排除
在这里同样生效——被忽略的文件引用时会被明确拒绝，不静默。

**诚实边界**：@problems 的诊断来自问题匹配器（§34）等
内部解析器，不是 LSP。

## 28. 影子 git 检查点（第三波二）

**是什么**：Cline 式 sidecar 检查点：用 bare git 对象库给工作区
做文件级快照（工作区本身不需要是 git 仓库），一键 undo。

**怎么用**：会话/任务面板「创建检查点」；恢复时先建
pre-restore 安全点；设计模式写回、DB 时间旅行都复用它
做 undo 底座。

**诚实边界**：文件级快照，不是语义快照；
超大文件/二进制按策略跳过并明确标记。

## 29. 团队质量门禁 inspections（第三波二）

**是什么**：「质检」tab：可配置的检查器集合
（风格/卫生/安全等），profiles + baseline（存量问题设为基线，
只拦新增）+ 趋势面板。

**怎么用**：质检面板选 profile、跑检查；
安全扫描（§35）就是挂在这里的一类检查器。

**诚实边界**：检查器是确定性规则，不是 AI 评审；
baseline 是"诚实债"管理，不是"债不存在"。

## 30. 批量变更（第三波二）

**是什么**：「批量变更」tab：一次改多个仓库——定义步骤
（shell/配方），在 repo registry 的多个仓里执行，
统一看板看进度和结果。

**怎么用**：批量面板新建批量任务、选仓库、写步骤、执行；
单仓是它的特例。

**诚实边界**：步骤是确定性的；配方化迁移（§36）是它的
"语义版"兄弟。

## 31. CRDT 实时协同（第三波二）

**是什么**：「协同」tab：多客户端实时同屏协作（CRDT 算法），
两个人同时看一块画布/任务板不打架。

**怎么用**：「协同」tab 进房间；共享包双格式构建（CJS+ESM），
浏览器端用 ESM。

**诚实边界**：MVP 级别：同屏状态同步有，
复杂冲突解决和权限粒度还在路上。

## 32. 测试覆盖率可视化（第二轮一）

**是什么**：对标 Coverage Gutters：质量闸门跑测试时可产出
lcov/cobertura/V8 覆盖率报告，「覆盖率」tab 做行级着色 +
文件树聚合徽标 + 趋势曲线。

**怎么用**：质检门禁里开"产出覆盖率报告"；覆盖率面板看缺口；
可配"覆盖率下降即阻断"（blockOnCoverageDrop）。

**诚实边界**：数据完全依赖项目自己的测试命令产出的报告，
我们不插桩；高覆盖 ≠ 断言强。

## 33. 两级忽略文件（第二轮一）

**是什么**：对标 Cursor：项目根 `.ai-factory/ignore`
（硬排除：对所有 AI 功能不可见）+
`.ai-factory/indexing-ignore`（不索引，但可显式引用）。

**怎么用**：项目根建这两个文件（glob 语法）；
codeindex、repomap、@ 提供器、搜索、备份五个入口
统一走一个关口；命中时 UI 明确提示"被忽略"，不静默。

**诚实边界**：忽略的是"我们控制的工具面"，不是操作系统——
别的工具照样能读到这些文件。

## 34. 问题匹配器（第二轮一）

**是什么**：对标 VS Code problemMatcher：
`.ai-factory/problems.json` 声明式正则，把任意命令输出
（构建/测试/定时任务）变成 Problems 面板的
"文件:行:列:消息"可点击条目。内置
$tsc/$eslint/$go/$node-test/$vitest。

**怎么用**：底部 Problems 面板看条目、点跳转；
面板里有"测试匹配器"干跑框，粘贴输出即时看解析效果。

**诚实边界**：正则对非标准输出会误报/漏报；
多行堆栈尽力提取；它不是 LSP。

## 35. 一体化安全扫描（第二轮一）

**是什么**：对标 Amazon Q 安全扫描：一次跑完三类——
硬编码密钥（20 模式族）、SAST（14 规则：SQL 拼接/XSS sink/
命令注入/路径遍历等高精度模式）、依赖 CVE 黑名单
（15 条，2026-10-20 快照）。

**怎么用**：「质检」tab 里作为检查器运行；严重发现可进
质量闸门阻断 + 通知中心；结果进审计链。

**诚实边界**：模式匹配有误报/漏报，不是认证级审计；
CVE 覆盖依赖数据快照新鲜度。

## 36. 确定性配方化迁移（第二轮一）

**是什么**：对标 Amazon Q /transform：npm/TS 生态 10 个内置配方
（升依赖版本、换包名、替换废弃 API 等）：
选配方 → 审计划 → 新分支上执行 → 自动构建+测试验证。

**怎么用**：「配方迁移」tab：选配方、看计划（可编辑）、
走审批、执行；中途文件被改了会 409 漂移拒绝，不硬写。

**诚实边界**：只做确定性部分；冷门框架覆盖不到的
会明确列"未处理清单"。

## 37. 变更影响分析（第二轮二）

**是什么**：对标 Augment：改代码前先看"爆炸半径"——
基于 codeindex/repomap 的反向引用图，算直接/传递下游 +
API 契约 diff（导出符号增删改）。

**怎么用**：「Git」面板 PR 审查里点「运行影响分析」；
或 `POST /api/impact/analyze`；质量闸门可配
`impact.failOnBreaking`（默认关，纯建议不阻断）。

**诚实边界**：启发式建议不是证明：同名符号有噪声，
动态分发/反射不可见；分析跑不起来时只审计、不阻断。

## 38. 出站防火墙白名单（第二轮二）

**是什么**：对标 Copilot 编码代理 allowlist：
一键离线（§17）和全开之间的中间档。
`.ai-factory/egress.json` 三层配置（全局/项目/任务），
规则 = 域名（含子域）或 URL 前缀，deny 永远优先。

**怎么用**：「项目」面板配规则；被拦的请求记审计
`EGRESS_BLOCKED` + HIGH 通知 + 可查日志；
干跑框可先测一条 URL 会不会被拦。

**诚实边界**：只在我们接管的出口生效
（联网搜索、远程 MCP）；默认关闭 = 不拦不记；
回环地址永远放行。

## 39. 任务级编辑范围锁定（第二轮二）

**是什么**：对标 bolt.new：建任务时圈定"这次只许动这些文件"
（`scope: {include, exclude}` glob），工具层硬拦截越界写入。

**怎么用**：新建任务弹窗填"允许目录/排除目录"（有预设）；
越界写入直接 403 `SCOPE_LOCKED` + 审计 `SCOPE_VIOLATION`；
任务面板可中途调整（调整进审计）；run 结束还会做 diff 复检。

**诚实边界**：约束的是任务关联的写入；
你在编辑器里手动改文件不受限（by design）。

## 40. Visual Design Mode（第二轮二）

**是什么**：对标 v0 Design Mode：「设计模式」tab 里点选预览元素，
可视化改 Tailwind 样式（背景色/文字色/字号/边距五维 + 文案），
确定性写回源码；从画面右键"Go to Code"反跳代码。

**怎么用**：设计面板点选元素 → 属性面板改 → 写回；
写前必建影子检查点（建不出就不写），
文件中途被改了 409 `DESIGN_DRIFT` 拒绝。

**诚实边界**：DOM→源码映射是启发式，映射失败明确提示不硬写；
只覆盖常见 Tailwind 约定；`dirname(DB_PATH)` 整树是控制面禁区，
写不进去。

## 41. DB 时间旅行 + dev/prod 隔离（第二轮二）

**是什么**：对标 Replit：影子检查点创建时，对项目声明的
SQLite 做 WAL-checkpoint 后原子快照，与代码检查点同 ID 绑定；
项目声明 dev/prod 两套数据源，任务默认只碰 dev。

**怎么用**：「变更」面板看快照；恢复默认只写 dev
（需二次确认，自动建 pre-restore 兜底）；
prod 唯一写入口是 promote（显式 + 确认 + 审计 `DB_PROMOTE`）；
dev==prod 的配置直接拒绝。

**诚实边界**：第一阶段只做 SQLite；快照默认 100MB 上限，
超限/过大/软链会记 skip 原因，不静默。

## 42. 自动更新 + 变更日志（第三轮一）

**是什么**：对标 VS Code 自动更新。服务端 `updates.ts` 是确定性核心：
解析更新 feed、比对版本、决定"有没有新版本"；真正的下载和安装
走桌面主进程的 `electron-updater` 6.8.9（`autoDownload=false`，
只有你点了"下载并安装"才会动）。

**怎么用**：中间栏「Updates」tab（UpdatePanel）：看版本状态、
手动检查更新；更新源由环境变量 `FACTORY_UPDATE_FEED_URL` 配置
（默认留空=不检查，界面诚实标注"未配置更新源"；
`FACTORY_UPDATE_CHECK_INTERVAL_MS` 默认 6 小时、最小 1 分钟，
`FACTORY_UPDATE_AUTO_CHECK=false` 可关闭自动检查）。
有新版本时记审计 `UPDATE_AVAILABLE` + 通知中心推送。
检查请求走出站防火墙（被拦会明确报错 `egress-blocked`）。

**诚实边界**：服务端只做"检查"，从不下载/安装二进制；
更新源的托管是 Tan 侧部署决策，默认没有，不假装能更新。

## 43. Flaky 间歇失败检测（第三轮一）

**是什么**：对标 Google Test 的 flaky 标注：`flaky.ts` 解析 TAP，
`FlakyHistoryStore`（`flaky-history.json`）按测试累积历史；
窗口内（默认看最近 10 次、最少 3 次数据）pass/fail 混合出现
就标 flaky，一直挂的就是 always-failing。

**怎么用**：`POST /api/flaky/record` 贴 TAP 文本记录；
`POST /api/flaky/runs` 让服务端直接跑指定测试文件
（走 TMPDIR wrapper + `--test-reporter=tap`，文件被 jail 限制）；
ProblemsPanel 有"间歇失败"分区；质量闸门可开 `rerunFlakyOnce`
（默认关）：开了之后失败的测试会多跑一轮做隔离标注——
但**原结论永不翻转**，flaky 测试永远不会被自动放行。

**诚实边界**：窗口太短会误标，`minRuns` 保底 3；
skip 既不算 pass 也不算 fail；门禁联动只是注解，不改结论。

## 44. 基准回归统计（第三轮一）

**是什么**：Criterion.rs 式统计判定：mean/median/近似 95% CI
（z=1.96），"样本集 vs 样本集"——两边 CI 不重叠才算显著回归
（`significantSlowdown` 保守判定）。`--runs n`（默认 1）让每个
case 重复 n 次再聚合：延迟取统计聚合，pass 要求每轮全过。

**怎么用**：`npm run benchmark -- --runs n`；回归报告里，
延迟回归只记 warning（wall-clock 时间对环境敏感），
成功率回归（pass→fail）才会 fail 掉 CI 门。

**诚实边界**：延迟判定是保守的，轻微回归可能漏报；
成功率标准是严格的——一轮失败就判回归。

## 45. Local History 每次保存快照（第三轮一）

**是什么**：对标 JetBrains Local History：`routes/files.ts` 的保存钩子
每次保存都写一个时间戳快照，落在
`AI_FACTORY_DATA_DIR/local-history/<workspace>/<file>/`。
上限可配：每文件默认 50 个快照
（`FACTORY_LOCAL_HISTORY_MAX_SNAPSHOTS_PER_FILE`）、
单快照默认 1MB（`FACTORY_LOCAL_HISTORY_MAX_SNAPSHOT_BYTES`）、
工作区默认 100MB（`FACTORY_LOCAL_HISTORY_MAX_WORKSPACE_BYTES`）；
超限显式 `skipped-*`（too-large/unchanged/disabled/error）不静默；
`FACTORY_LOCAL_HISTORY_DISABLED=1` 可整体关闭。

**怎么用**：编辑器里的历史抽屉浏览/恢复；恢复需要显式确认，
且会先把当前内容存成 `pre-restore` 快照——恢复本身可撤销。

**诚实边界**：只覆盖经文件 API 的保存；内容没变的不重复存
（`skipped-unchanged`）；被剪掉的快照会显式说明原因。

## 46. 可复现开发环境 devcontainer（第三轮一）

**是什么**：`packages/qa/src/devenv.ts` 的 `DevEnvSpec` 是单一数据源，
双渲染同源生成：`renderDevcontainer()` → `devcontainer.json`，
`renderSetupStepsYaml()` → Copilot Setup Steps 的 yml，
单测保证两者字节一致不漂移。
模板放在 `.devcontainer/` 下，不进 `.github/workflows/`
（配合 `.github/` 不进本地 commit 的现状）。

**怎么用**：`docs/dev-environment.md` 有完整说明和校验规则
（schema 形状、扩展 ID 格式、`npm run` 脚本存在性，
不可解析 fail-closed）；启用 Copilot 云端 agent 时，
把 yml 拷到 `.github/workflows/` 即可。

**诚实边界**：只验证文件正确性，没有真实容器拉起验证；
启用 Copilot Setup Steps 是 Tan 侧决策（模板已就绪，随时可用）。

## 47. 变异测试（第三轮二）

**是什么**：对标 StrykerJS：覆盖率的下一层，测"断言够不够狠"。
新包 `@ai-factory/mutation`：7 个文本级变异算子
（算术/比较/关系边界/布尔翻转/逻辑），分词器跳过字符串、
注释和模板字面量；mulberry32 种子抽样完全可复现
（默认抽 50 个、每文件上限 10、单次硬上限 200）；
变异体在 scratch 拷贝里执行，**永不碰真实树**，超时熔断；
verdict 四态 killed/survived/timeout/invalid，
得分 = killed/(killed+survived)。

**怎么用**：`POST /api/mutation/run`（后台执行，202 返回）→
`GET /api/mutation/runs/:id` 轮询 → `GET /api/mutation/latest` 看最新；
质量闸门可配 `mutation.report`（默认关）：只把报告摘要做
annotation 挂到门上，不触发运行、不阻断；
ProblemsPanel 有变异测试分区。

**诚实边界**：全仓库全量变异不支持，只做抽样；
模板字面量插值 v1 不变异；语法无效的变异计 `invalid`，
不污染得分；泛型 `<T>` 可能产出语法无效变异（正常现象）。

## 48. sweep.yaml 自动化约定（第三轮二）

**是什么**：对标 Sweep：项目里放一个 `.ai-factory/sweep.yaml`，
把外部事件（issue、告警……）声明式映射到任务模板。
`loadSweepConfig`：文件缺失≠错误；坏 YAML/坏 version 整文件
fail-closed 并带行号；单个坏规则进 `invalidRules`，其余照常工作。
`matchSweepRules`：priority 降序 + 文档顺序，完全确定性。
`buildLaunch`：事件值一律经 `sanitizeUntrusted(declared external)`。

**怎么用**：`GET /api/sweep/config` 看规则摘要+校验状态；
`POST /api/sweep/dry-run` 只匹配不建单；
`POST /api/sweep/ingest` 建单：`authorizationStatus=WAITING_HUMAN_DISPATCH`、
creator=`sweep`、审计 `SWEEP_TASK_PROPOSED`，任务落进 Dispatch 面板
等人工确认/驳回（创建者列有 sweep 徽章）。

**诚实边界**：它是约定，不是实时集成——没有 webhook 接收器，
GitHub webhook 直连是 Tan 侧网络决策，故意不做；
发起的任务永不自动执行，永远等人工拍板。

## 49. 编辑器/终端体验小件（第三轮二）

**是什么**：R3-T9 编辑器小件：Monaco 内置 stickyScroll
（`enabled` + `maxLineCount: 10`），表头 checkbox 开关
+ localStorage（`ai-factory.editor.stickyScroll`，默认开）持久化；
`FILE_NESTING_RULES` 文件嵌套（`package.json`→lock 文件、
`*.ts`→`.d.ts`/`.test.ts`/`.spec.ts`/`.stories.ts`……）
同目录分组，chevron 展开/收起。
R3-T10 终端小件：xterm 下方 DOM 状态条——
会话短 id、工作目录、退出码、连接状态；每 5 秒轮询，
断开/关闭态可一键重连。

**怎么用**：编辑器表头开关粘性滚动；文件树里展开嵌套看关联文件；
终端状态条随时看连接态，断了点重连继续用。

**诚实边界**：PTY 取不到逐命令退出码，活会话的退出码诚实显示
"—"（不伪造），只在会话结束时显示它真正的 exit code。

---

## 50. 预发送提示词密钥扫描（第四轮一）

**是什么**：修一个真漏洞——`scanForSecrets` 以前只被 MemoryStore.write 调用，
`adapter.invoke` 发给厂商的 prompt 是直发的，密钥原文会直接出境。
`packages/runtime/src/pre-send-scan.ts` 的 `assertPromptSafe` 接在
`StubAdapter.invoke` 与 `CodexAdapter.invoke` 的入口首行，
任何调用方都绕不过。扫描引擎 = 21 族共享表单
（`packages/security/src/secret-patterns.ts` 的 `SECRET_PATTERNS`，
单一真相源；`inspections.ts` 改成 import+re-export，repo 扫描行为零变化）
+ 3 个 prompt 形赋值族（`token-assignment`/`secret-assignment`/
`password-assignment`，只放在 pre-send 本地扩展，不进共享表）。
扫描用 `matchAll` 全量匹配——修掉了"占位符在前、真密钥在后"的
fail-open 漏报；redact 回调保留占位符不误伤。

**怎么用**：自动生效，无需配置。双模式经 `setPreSendScanMode` 切换
（默认 `block`）：block 命中则审计 `PROMPT_SECRET_BLOCKED` + HIGH 告警
（"Prompt blocked: …"），抛 `PreSendSecretBlockedError`
（只点名 pattern 名，永不回显密钥值）；`redact` 模式把命中替换成
`[REDACTED]` 后放行，记审计 `PROMPT_SECRET_REDACTED`。
sinks 经 `setPreSendScanSinks` 接入审计链与通知中心（best-effort：
没装 sinks 阻断照样执行，只是没有审计/通知）。

**诚实边界**：`images` 只扫 prompt 文本——`AdapterInput.images`
是描述符（无字节），vision:false 的适配器看不到字节；
redact 模式不发 HIGH 告警（算子显式选择的宽松模式），但审计照记；
纯文本扫描，零模型 key。

## 51. 确定性重构（第四轮一）

**是什么**：对标 IDE 的 Refactor 预览。新包 `@ai-factory/refactor`
（零依赖）：`tokenizer.ts`（TS/JS 分词：字符串/模板 `${}`/正则 vs 除法/
私有字段/行列+depth）、`scope.ts`（两遍作用域分析：函数/箭头/方法/类/
import/catch/for、解构、TS 类型注解、遮蔽解析）、`ops.ts`
（4 个操作：extract-method/extract-variable/inline-variable/rename）、
`diff.ts`（确定性 unified-diff 生成器）、`types.ts`。
服务端 `routes/refactor.ts`：`POST /api/refactor/analyze` 只读预览
（返回 proposalId + diff）、`POST /api/refactor/apply`
（逐项 `acceptedIds`；写前重读所有触碰文件做 sha256 漂移守卫，
变了就整批 409 `REFACTOR_DRIFT`、什么都不写）、
`GET /api/refactor/proposals/:id`。proposal 内存店，10 分钟 TTL。
桌面端 RefactorPanel：操作表单 → 预览（逐项勾选 + diff）→ 应用选中。

**怎么用**：Refactor 面板填操作参数 → 看预览 → 勾选要接受的项 →
应用；多文件重命名只跟随显式 `otherFiles`；
jail 经 `setRefactorInspectionRootResolver` 注入。审计：
`REFACTOR_ANALYZED` / `REFACTOR_APPLIED` / `REFACTOR_APPLY_REJECTED`。

**诚实边界**：preview diff 没有复用影子 git 管道——deliberate：
影子 git 需要真实 checkpoint，preview 必须 side-effect free；
extract-method 闭包式、不合成参数；
逃逸的 return/break/continue 直接拒绝；rename 按作用域生效；
apply 整批原子；proposal 重启丢失。

## 52. 结构化搜索替换（第四轮一）

**是什么**：按 AST 结构而非文本做搜索/替换。新包 `@ai-factory/ssr`：
`scanner.ts`（字符级状态机：字符串/注释/模板字面量/正则字面量感知 +
花括号配平）、`template.ts`（4 个内置模板）、`replace.ts`
（`renameInScope`/preview/apply）。服务端 `routes/ssr.ts`：
`GET/POST/DELETE /api/ssr/templates`（模板管理，写操作审计）、
`POST /api/ssr/search`、`POST /api/ssr/preview`、`POST /api/ssr/apply`
（审计）、`POST /api/ssr/quickfix`（inspection 命中一键修）。
`inspections.ts` 新增 `setExtraCheckerProvider`，
`ssr-template` checker 进默认 profile。
桌面端：InspectionsPanel 的 quick-fix 按钮 + SsrTemplatesManager。
对照实验：同名变量场景文本搜索命中 6 处，SSR 作用域重命名只改 3 处
（`beta` 的同名 `count` 与 `obj.count` 纹丝不动）。

**怎么用**：SsrTemplatesManager 选内置/自建模板 → search 看命中 →
preview 看 diff → apply；Problems 面板里 inspection 命中直接点
quick-fix。jail 经 setter 注入。

**诚实边界**：没有字面复用 repomap 解析器——codeindex 的
extractSymbols 不支持可见性修饰符/局部变量，所以自写了扩展启发式
扫描器；它是 heuristic extraction，不是编译器 AST
（局限声明写在 `packages/ssr/src/types.ts` 顶部）。

## 53. TODO 追踪（第四轮一）

**是什么**：对标 JetBrains TODO 工具窗。
`apps/server/src/todo-scan.ts`（~300 行）：确定性正则扫描内核。
`DEFAULT_TODO_PATTERNS`：FIXME→error、BUG→error、HACK→warning、
TODO→info（大小写敏感）；`validateTodoPatterns` fail-closed：
坏正则点名、拒绝匹配空串的模式、重名、坏级别、超 32 个；
文件上限 20000。服务端 `routes/todo-scan.ts`：
`GET /api/todos`（配置 + 全量扫描，viewer）、
`GET /api/todos/file`（单文件，编辑器 gutter 用）、
`PUT /api/todos`（自定义模式，operator，审计 `TODO_CONFIG_UPDATED`）、
`POST /api/todos/reset`（回默认，审计 `TODO_CONFIG_RESET`）。
桌面端：BottomPanel 新增 TODO tab（TodoPanel）、
EditorPanel gutter 圆点 + overview 条纹。

**怎么用**：底部 TODO tab 看全项目扫描；编辑器 gutter 圆点定位；
PUT 自定模式（会话级，重启回默认，UI 有诚实说明）。
只读路径不审计。

**诚实边界**：两级 ignore-gate 只读 `.ai-factory/ignore` +
`indexing-ignore`，**不读 `.gitignore`**（真实行为）；
字符串字面量里的 TODO 和真注释一视同仁（没有"字符串感知"）；
自定义配置是会话级的。

## 54. 依赖升级顾问（第四轮一）

**是什么**：离线优先的依赖升级建议。新包 `@ai-factory/depscan`：
自研 semver 子集引擎（`||`/hyphen/dist-tag 不支持时返回 null，
**永不猜**）、`advise` 生成升级计划（semver 安全分级：
major/minor/patch）、registry 双 provider（离线快照默认 + live 需
显式 opt-in 且过 egress 门禁）。快照 `registry-snapshot.json`
（2026-10-22，20 包，CVE 黑名单集 + 常见包；每份报告披露快照日期，
明确声明滞后于真实 registry、不是 live 查询的替代品）。
服务端 `routes/depscan.ts`：`POST /api/depscan/advise`
（走 egress gate）、`GET /api/depscan/snapshot`（快照元数据，viewer）；
CVE 交叉经 setter 注入复用 inspections 的 `BUILTIN_VULNERABLE`。
桌面端：ProblemsPanel 的 DepscanSection。

**怎么用**：Problems 面板的依赖分区看升级计划；
快照元数据端点随时核对滞后日期；要查 live registry 显式 opt-in
（被 egress 拦会有明确错误）。

**诚实边界**：自研 semver 只覆盖子集，不支持的写法定然返回 null；
快照是手工维护的 20 包小集合，覆盖不了长尾依赖；
live 模式走出站防火墙门禁，默认 deny 下被拦是 fail-closed 行为。

## 55. DAP 调试器（第四轮二）

**是什么**：Debug Adapter Protocol 调试器客户端。
新包 `@ai-factory/debugger`（零依赖，纯 node 内置）：
`framer.ts`（Content-Length 帧）、`ws.ts`（手写 WebSocket 客户端）、
`cdp.ts`（最小 CDP 客户端）、`launchjson.ts`
（launch.json 解析/归一化）、`client.ts`（DebugClient：spawn adapter、
DAP 请求/事件、fail-closed）、`node-adapter.ts`
（DAP↔CDP 桥子进程）。兼容 `.vscode/launch.json`，**先 Node.js**：
launch 走 `node --inspect=127.0.0.1:0`（loopback），
attach 只允许 127.0.0.1。服务端 `routes/debug.ts`：
`GET /api/debug/configs`、`POST /api/debug/sessions`（201）、
`GET` 列表/详情、`:id/output`（200 行上限）、
`:id/breakpoints`（断点/条件断点/日志点）、
`:id/{continue,next,step-in,step-out,pause}`、
`:id/{stack,scopes,variables}`、`:id/evaluate`、`DELETE :id`。
最多 8 并发会话（超了 409）；错误码 404/409/410/502/504；
审计 `DEBUG_SESSION_STARTED`/`STOPPED`/`BREAKPOINTS_SET`。
桌面端 DebugPanel：配置选择/启动/断点起草/单步/调用栈/变量/
Watch/输出轮询。

**怎么用**：Debug 面板选 launch.json 配置 → 启动 →
设断点（条件/日志点）→ 单步 → 看调用栈/变量 → evaluate 求值；
条件断点/日志点起草后发送。

**诚实边界**：只先做 Node.js；chrome/python/coreclr/compound 等配置
上报 unsupported，绝不静默 reinterpret；
evaluate 不带 frameId 时 500 dap-error（桌面端传 frameId）；
return 处的 step 停顿是 V8 标准行为（先停看返回值），
如实上报不是 bug；adapter spawn 失败/崩溃 fail-closed。

## 56. 数据库浏览器（第四轮二）

**是什么**：IDE 式数据库浏览器。**先 SQLite/Postgres**。
新包 `@ai-factory/dbbrowser`（零依赖）：`sql-guard.ts`
（危险语句守卫，fail-closed 纯函数：read=SELECT/WITH..SELECT/EXPLAIN/
只读 PRAGMA；write=INSERT/带 WHERE 的 UPDATE/DELETE/
CREATE TABLE|INDEX|VIEW/加法 ALTER；destructive=DROP/TRUNCATE/
删列改名/无 WHERE 的 DELETE/UPDATE——要票据；blocked=多语句/
ATTACH/VACUUM/事务控制/未知）、`drivers.ts`
（`SqliteDriver` 走 node:sqlite；`PostgresDriver` 手写最小 PG 线协议：
startup + simple query，trust 认证、无 SSL、无预编译、值按文本返回）、
`schema.ts`（SQLite 用 PRAGMA、PG 用 information_schema 内省；
`createTableDdl`；`diffSchemas` 加法-only——删除只报告不脚本化；
`schemaToErGraph` 关系图）、`browser.ts`
（连接 env 身份；`updateRow` 写回后复读逐列校验，非"假装成功"）。
服务端 `routes/dbbrowser.ts`：连接注册（sqlite 路径 jail 进数据目录，
`PATH_ESCAPED` 403；prod 注册要求文件已存在否则 404）、查询控制台、
表编辑器（分页/过滤/排序/行编辑）、schema 对比、DDL 生成、ER 图；
破坏性语句永不 inline：`destructive/request`（201 票据）→
`destructive/approve`（`decided_by` 显式决策人）→
`destructive/execute`（单次消费，15 分钟 TTL，
绑定 connection + 语句 sha256，执行时重分类）。审计：
`DBB_CONNECTION_REGISTERED/REMOVED/WRITE/ROW_UPDATED/
DESTRUCTIVE_REQUESTED/APPROVED/EXECUTED`（只读不审计）。
桌面端 DbBrowserPanel（BottomPanel Database tab）。

**怎么用**：Database tab 注册连接 → 查询控制台跑只读 SQL →
表编辑器分页改行（复读校验）→ schema diff 看加法 DDL →
破坏性操作走票据三态。prod 数据禁止直写
（`PROD_WRITE_REFUSED`），唯一入口走 DB 时间旅行的 promote。

**诚实边界**：PG 驱动只在 in-process 协议 stub 上验证过，
未对真实 PG 服务器验证（环境里没有 postgres）——UI/包头/报告
三处诚实声明；破坏性票据没复用 `/api/approvals`
（审批存储强制 `task_id` 外键，官方端点无 task_id 也 500），
走自有审计票据状态机；表编辑器标识符对 schema 校验、值走参数绑定。

## 57. HTTP 客户端（第四轮二）

**是什么**：`.http` 文件式 HTTP/REST 客户端。
新包 `@ai-factory/httpclient`（零依赖，node:http/https 自己写）：
`parse.ts`（`###` 多段、METHOD URL、头、空行后 body、
行首 `>` 断言、`@timeout-ms` 指令、注释；fail-closed 带行号）、
`envs.ts`（环境合并：所选环境变量 < 显式变量；
`{{var}}` 替换，未知留原文）、`client.ts`
（默认超时 10 秒，响应体 5MB 上限，**不跟随重定向**、无 cookie jar）。
6 种断言：`status == 200`、`status-class`（2xx/3xx/4xx/5xx）、
`header`（eq/contains）、`body-contains`、`json-path`（exists 或 eq）、
`max-time-ms`。服务端 `routes/httpclient.ts`：
`POST /api/http/run`（解析→环境合并→**逐 URL 过出站防火墙门禁**→
发送→断言；被拦记 `blocked:true` 其余继续；
审计 `HTTP_CLIENT_RUN`，只记 method/host/path/status）、
`GET/PUT /api/http/environments`
（`<project-root>/.ai-factory/http-env.json`，jail+校验）。
桌面端 HttpPanel（.http 编辑器、环境 JSON、逐请求状态/耗时/
断言/响应体预览、blocked 显示）。

**怎么用**：HTTP tab 写 .http 块 → 选环境 → 发送 →
看每个请求的断言与 blocked 态；
环境文件放 `.ai-factory/http-env.json`。

**诚实边界**：重定向不跟随（3xx 原样报告）；
响应体 5MB 上限（`bytes` 记真实大小）；
json-path 只支持点路径+`[n]`，无通配符；
未知 `{{var}}` 留原文；egress 判定在 route 层发送前，
包本身不做门禁；格式错的断言（如 `> status 200`）
直接 400 fail-closed。

## 58. 性能剖析（第四轮二）

**是什么**：真 V8 采样剖析。新包 `@ai-factory/profiler`
（零依赖，纯 node 内置）：`spawn.ts`（子进程跑 `node --cpu-prof`，
超时先给 SIGTERM 让 profile 落盘——SIGTERM 下不落盘则 fail-closed
报 `no-profile`，绝不返回部分数据）、`cpu.ts`
（解析 .cpuprofile → 热点 top-10（self/total）+ 折叠火焰树）、
`flame.ts`（SVG 火焰图渲染）、`heap.ts`（`--require` preload 在
exit hook 写真实 `v8.writeHeapSnapshot()`，CJS/ESM 通吃、
无需 --inspect；按构造器统计 count/self 大小 + 快照 diff
做泄漏定位）。服务端 `routes/profiler.ts`：
`POST /api/profiler/cpu`（`{script, args?, timeoutMs?, sampleIntervalUs?}`）、
`POST /api/profiler/heap`；jail：403 逃逸/404 缺失/400 非 js；
超时上限 120 秒（下限 1 秒）；
审计 `PROFILER_CPU_CAPTURED` / `PROFILER_HEAP_CAPTURED`。
桌面端 ProfilerPanel：SVG 火焰图由**真实采样数据**渲染，
不是示意图。

**怎么用**：Profiler 面板填脚本 → cpu 采样看热点/火焰图 →
heap 快照看构造器排行/两次快照 diff 找泄漏；
不存在的脚本 404 fail-closed。

**诚实边界**：堆表是 self 大小（retained 不计算，列名如实标注）；
采样是统计性的（响应带 sampleCount/totalUs）；
堆脚本必须自己退出，长驻进程会 hit 超时；超时上限 120s。

## 59. 终端命令历史（第四轮二）

**是什么**：VS Code Shell Integration 式命令历史。
新包 `@ai-factory/termhistory`（零依赖）：`markers.ts`
（标记扫描 + rcfile 生成器 + 包裹器）、`tracker.ts`
（`CommandTracker` 状态机：B→C→D→H 才记录，否则丢弃）、
`fuzzy.ts`（子序列模糊评分，连写加成 > 散点）、
`store.ts`（`HistoryStore`：
`<数据目录>/terminal-history/history.jsonl`，JSONL，
去连续重复、损坏行跳过、超限压缩）。标记协议（OSC 133）：
A=prompt 开始、B=输入开始（PS1 前缀，每 prompt 前重打补丁）、
C=命令开始执行（DEBUG trap）、D;`<code>`=真实退出码、
E;`<b64>`=BASH_COMMAND（fallback）、H;`<b64>`=精确输入行
（`fc -ln -1`）。注入方式：bash 会话经 `bash -c` 包裹器，
rc 文本走 `$AF_SHELL_INTEGRATION_RC` 环境变量
（env 穿透 bwrap），会话内 `/tmp` 落盘 `--rcfile`。
服务端 `routes/terminal.ts`：bash 会话自动包裹
（sh 跳过→`integrated:false`）、命令落盘（best-effort）、
`GET /api/terminal/history`（fuzzy/跨会话）、
`GET /api/terminal/sessions/:id/commands`
（`integrated` 标志 + 退出码）。桌面端：TerminalPanel 按段写入，
在 C 处挂 marker、D 处按退出码挂 overview-ruler 装饰（绿/红）；
状态条 ↑/↓ 命令跳转 +「历史命令」按钮；
搜索浮层（分组、↑↓/回车/Esc，回车插入不执行）；
`terminalHistory.ts` 是线协议客户端镜像。

**怎么用**：终端正常用，bash 会话自动记录；
状态条的「历史命令」按钮或搜索浮层跨会话模糊找命令，
回车插入不执行；`$?` 在 DEBUG trap 下正确保留
（实测 D;0/D;1/D;2/D;42、Ctrl+C → D;130）。

**诚实边界**：仅 bash 有历史，sh 会话 `integrated:false`，不编造；
H 为空（HISTCONTROL 丢弃）时 fallback 用 E 拼接，属近似；
桌面装饰是 overview-ruler 色条，本机无浏览器真机视觉未做
（tsc + unit 覆盖）。**收口真回归**：A8 的 OSC 标记打穿了
Batch 48 跨 chunk 脱敏器的 longest-first 判定
（标记字节隔开了长密钥两段，导致尾段泄漏）——
`packages/secrets/src/broker.ts` 新增 `buildOscView()`：
匹配决策在去掉完整 OSC 序列的视图坐标上做（控制字节零宽），
carry/holdback 逻辑不变，落盘映射回原始坐标；
`OSC_MAX_LEN=65536` 封顶 pending 增长；+3 回归测试。

## 60. 全局快捷键体系 + which-key（第五轮一）

**是什么**：给所有命令配快捷键的统一体系——每个命令一个 ID（如 `palette.toggle`、`language.switch`、`go.tab.*`、`bookmark.toggle`），默认键与用户自定义层合并生效。按组合键序列时，前缀等待会自动弹出 which-key 弹窗，列出可接的按键，不用背键位。

**怎么用**：设置里的快捷键面板可搜索、重绑、删除、按命令重置；冲突时后绑定的胜出，被覆盖的在冲突告警区具名列出，不静默丢弃。多键序列超时默认 1 秒（可调 200–5000 毫秒）。配置经服务端持久化（`GET/PUT/DELETE /api/keybindings`，另有 `/api/keybindings/schema`）。

**诚实边界**：快捷键只在桌面端生效，服务端只存配置、无键盘上下文；Monaco 编辑器内置键不接管；输入框内无修饰键永不拦截；`mod` 按平台解析（Mac 上是 ⌘，Windows/Linux 上是 Ctrl）。

## 61. 声明式任务运行器（第五轮一）

**是什么**：VS Code tasks.json 兼容的任务运行器——在 `.ai-factory/tasks.json` 里声明构建/测试/监听任务，用 `dependsOn` 写链式依赖。规划失败、未知依赖或有环时整份拒绝、什么都不跑；运行输出经已注册的问题匹配器解析成诊断，进 Problems 面板。

**怎么用**：`GET /api/tasks/list` 看解析后的任务；`POST /api/tasks/run` 跑一条链（任一任务失败/被拒/超时则 fail-closed 中断，依赖方不执行）；`GET /api/tasks/runs` 看最近 20 条运行记录；`PUT /api/tasks` 写 tasks.json。

**诚实边界**：任务命令走现有 exec 安全策略（白名单/deny pattern/控制目录守卫），不另开执行通道；`type:"shell"` 是引号感知分词后直跑，不是 `/bin/sh`；单任务超时默认 60 秒（可配 1–300 秒）、输出 2MB 上限。注意：`GET /api/tasks`（bare）是旧的项目任务端点，运行器列表是 `GET /api/tasks/list`。

## 62. 三路合并冲突编辑器（第五轮一）

**是什么**：git 合并冲突的三栏解决器——ours/base/theirs 对齐展示（自研 diff3），逐块选 ours/theirs/both/自定义文本；复杂冲突如实标"需人工"；写回前先做影子检查点，可回滚。

**怎么用**：Merge 面板选仓库 → 看冲突文件列表 → analyze 看对齐 → 逐块解决 → resolve 写回（可选 stage，即 `git add`）。若文件在 analyze 之后被改动过，`409 MERGE_DRIFT` 拒绝写入，先重新 analyze。

**诚实边界**：diff3 对齐是启发式行对齐，不冒充权威；diff3 风格标记（`|||||||`）明确拒绝、不误读；stage 只做 `git add`，永不 commit/push；二进制/超 512KB/符号链接/路径逃逸/非 git 仓库全部拒绝。

## 63. Git blame 行内标注 + Timeline（第五轮一）

**是什么**：编辑器当前行的内联 blame 标注（短 hash · 作者 · 日期），外加 Timeline 中心面板——git log 与 Local History 快照融合的时间线，可点选两个时间点做 unified diff 对比。

**怎么用**：打开文件即见行标注；Timeline 面板点选两个时间点 → `/api/timeline/diff` 看 diff；非 git 目录的 timeline 只显示快照。

**诚实边界**：blame/时间线是请求时刻快照；未提交行标注"未提交"，不归因；非 git 目录 `/api/blame` 返回 `409 NOT_A_GIT_REPO`；大文件 blame 上限 2000 行（`truncated` 标记），diff 上限 6000 行/512KB；快照时间来自文件名 epoch，git 时间是 author-time。

## 64. Unicode 混淆/不可见字符高亮（第五轮一）

**是什么**：Trojan Source 防护——扫描文件里的双向控制字符（9 种）、零宽字符（4 种）和形近混淆字符（53 项手维护子集，覆盖拉丁/西里尔/希腊），编辑器内联三类高亮 + 悬停显示码点与字符名；同时作为 `unicode-trojan` 检查器接入 inspections。

**怎么用**：打开文件自动标注；`POST /api/trojan/scan` 可扫内联文本或 jail 路径；`trojan-scan-ignore` 可整文件抑制。

**诚实边界**：confusables 是 53 项手维护子集，不是 Unicode 全量；形近只在混合脚本 token 内触发；U+FEFF 仅文件首字符豁免；只标注、不自动改写。

## 65. 代码片段库（第五轮二）

**是什么**：触发词 + Tab 展开的代码片段——支持 `$1`/`${1:default}`/`$0` 占位符与 Tab 跳转、`${DATE}`/`${TIME}`/`${FILENAME}` 内置变量；按语言分组，7 个内置片段只读，插件可通过注册表贡献。

**怎么用**：编辑器输入触发词 → Monaco 补全出现片段 → Tab 展开、Tab 在占位符间跳转；Snippets 面板增删改自己的片段（存 `.ai-factory/snippets.json`）；`GET /api/snippets/schema` 看格式。

**诚实边界**：展开是纯文本替换，绝不执行代码；嵌套占位符校验拒绝；未知 `${NAME}` 展开为空、不猜；Tab 永不拦截（只通过补全出现）；manifest 级 `contributes.snippets` 不在 v1。

## 66. 拼写检查（第五轮二）

**是什么**：标识符拼写检查——按驼峰/下划线分词，查人工维护的英文词典子集；波浪线标注 + 悬停给编辑距离建议；InspectionsPanel 里可一键"加入词典"。

**怎么用**：打开文件自动标注；项目词典 `.ai-factory/spell-dictionary.txt` 经 `GET/POST/DELETE /api/spell/dictionary` 管理；`spell-check-ignore` 整文件抑制。

**诚实边界**：词典是人工维护子集，不是完整英语词典；v1 只做英文，中文分词明确不做；全大写 token 按缩略词跳过（未知缩略词是已知漏报类）；只标注、不改写；项目级检查不带修改建议。

## 67. 搜索编辑器（第五轮二）

**是什么**：把全项目搜索结果开成可保存的 `.code-search` 文件——查询头（query/regex/大小写/glob）+ 按文件分组的结果，可折叠、点击跳转；文件存盘后可重新打开复现搜索、重新运行刷新。

**怎么用**：搜索面板填条件 → "在编辑器中打开" 保存到 `.ai-factory/searches/`；`POST /api/codesearch/search` 可直调搜索（字面/正则/glob 三种模式）。

**诚实边界**：结果是查询时刻快照，文件改动后必须显式重新运行；无索引、按需 walk（大树比索引引擎慢）；默认 2000 命中、硬上限 10000，超限 `truncated` 标记；二进制/symlink/超大文件跳过或诚实标记。

## 68. 书签（第五轮二）

**是什么**：行/文件/目录三级书签 + 数字字母助记直达——0-9 默认绑 `ctrl+数字`，a-z 可绑；书签面板按目录分组，可重命名/删除；行书签存 5 行上下文，文件变更后在 ±300 行内按上下文重定位。

**怎么用**：`bookmark.toggle` 开关光标行书签（走快捷键体系，可重绑）；面板设助记、跳转；`POST /api/bookmarks/toggle` 幂等；服务端持久化到 `AI_FACTORY_DATA_DIR/bookmarks.json`，按项目 root 隔离。

**诚实边界**：找不到上下文时标"已漂移"且不跳转；改名/删除文件后书签不跟随（resolve 404，须手动删）；助记每项目 root 全局唯一，`ctrl+数字` 冲突走快捷键冲突告警；每 root 上限 500；v1 无跨机同步。

## 69. 草稿文件（第五轮二）

**是什么**：独立于项目的临时草稿区——选语言新建草稿，按语言享完整高亮；typescript/javascript 可一键运行（走共享 exec 安全通道），json/markdown/plaintext 仅编辑。

**怎么用**：Scratches 面板新建/重命名/删除/按语言过滤；`POST /api/scratches/:id/run` 运行；草稿存 `AI_FACTORY_DATA_DIR/scratches/`，关闭 IDE 不丢失。

**诚实边界**：草稿永不进项目树（不进 git/索引/快照）；不审计；运行=执行任意代码，仅用户明确触发；草稿内容不受 pre-send 密钥扫描保护（面板有警示，勿粘贴密钥）；只有 node 白名单语言可运行；无云同步。

## 70. 插件系统与扩展 API（第六轮一）

**是什么**：VS Code 扩展 API 的本地子集——本地扩展安装/管理，不自建云端市场。扩展装到 `<root>/.ai-factory/extensions/<name>/`，可贡献四类：命令、面板、检查器、上下文提供器。扩展代码跑在 node:vm 受限沙盒里（禁用代码生成、无 require/process/Buffer/eval，参数与结果只以 JSON 字符串进出），权限白名单只有 4 项：commands.execute、panels.contribute、checkers.contribute、providers.contribute。

**怎么用**：Extensions 面板安装/启用/停用/卸载；`GET /api/extensions` 列出已装扩展（含损坏目录），`POST /api/extensions/install`（内联）与 `install-from-dir`（目录安装，jail 内、拒绝符号链接）两种安装方式；命令经 `POST /api/extensions/:name/commands/:cmd/run` 执行，提供器经 `providers/:id/resolve` 解析。内置三类示例扩展：hello-command（命令）、info-panel（面板）、marker-checker（检查器）。

**诚实边界**：v1 只实现 API 子集，不兼容完整 VS Code 扩展 API；无云端市场、无自动更新；vm 沙盒挡朴素逃逸，但不是多租户安全边界，安装本身需操作员权限；上限：main 256KB、命令 50 个、面板/检查器/提供器各 20 个。

## 71. Git rebase 编辑器 + stash 管理（第六轮一）

**是什么**：`git rebase -i` 的可视化 porcelain 封装 + stash 可视化管理。rebase todo 支持 pick/reword/squash/fixup/drop 拖拽排序；stash 支持查看/应用/删除/按名管理。任何改写操作前必做影子检查点快照，失败可回滚；语义冲突不由本功能解决，仍走三路合并编辑器。

**怎么用**：Rebase 面板改 todo 顺序后提交；`GET /api/rebase/todos?repo=&base=` 取 base..HEAD 的 pick 行，`POST /api/rebase/start`（返回 checkpointId）、abort/continue/skip、`POST /api/rebase/restore` 从影子检查点还原；stash 经 `GET /api/stash`、`POST /api/stash/push|apply|pop|drop` 管理。

**诚实边界**：只做 porcelain 级操作，不做 filter-branch/filter-repo 级历史改写；reword v1 只接受单行；冲突的 stash pop 保留条目；影子检查点不可用时变基请求以 503 拒绝，绝不裸写历史。

## 72. 文件监听联动（第六轮一）

**是什么**：文件变化触发器——监听目录树，变化经防抖与合并后触发 tasks.json 声明式任务链。规则存 `<root>/.ai-factory/watch.json`（tmp+rename 原子写），触发走与手动运行完全相同的任务通道；触发记录是进程内 ring（50 条），规则本身持久化。

**怎么用**：Watch 面板（底部栏）新建规则（glob 匹配、目标链 label、防抖毫秒）、启用/停用、`POST /api/watch/activate` 全部启动；`GET /api/watch/rules`、`GET /api/watch/triggers`（触发历史）、`GET /api/watch/status` 查看监听状态。

**诚实边界**：仅触发器，不做增量编译，每次触发完整跑一遍链；同规则链运行串行化（运行中再触发只排队一个，后续合并进它）；监听活在服务端进程内，重启后需点"全部启动"恢复；监听上限 5000 目录 fail-closed；单窗口超 200 文件合并为 burst 触发并标注；配方 apply 永不自动触发（审批门控）。

## 73. 多任务并行队列（第六轮一）

**是什么**：后台任务队列——多任务并行/排队执行，状态（排队/运行中/成功/失败/已取消）实时可见，单个任务可取消。复用第五轮任务运行器（tasks.json）执行通道与 exec 安全策略，不另开执行通道；输出复用问题匹配器解析。

**怎么用**：Queue 面板（底部栏）提交任务、看队列、取消、查输出；`POST /api/taskqueue/submit`、`GET /api/taskqueue/jobs`、`GET /api/taskqueue/jobs/:id/log`、`POST /api/taskqueue/jobs/:id/cancel`、`PUT /api/taskqueue/config` 调并发上限。

**诚实边界**：作业只存在于服务端进程内，重启后排队/运行中作业丢失，无持久化恢复；同一作业内的链任务按依赖拓扑顺序串行执行，并行只发生在作业之间；默认并发上限 4（CPU 数封顶逻辑内），可配 1–32，超限 FIFO 排队；作业日志是 512KB 滑动窗口（丢最旧字节并标记），不是完整 transcript；作业诊断每作业封顶 200 条；取消杀整个 POSIX 进程组，Windows 上退化为只杀直接子进程。

## 74. 任务计划 / 定时任务（第六轮一）

**是什么**：在既有调度器上的增量——可调度 tasks.json 声明式任务链，新增 task-runner 任务类型、once 单次调度、防重叠跳过。调度持久化在 `AI_FACTORY_DATA_DIR/schedules.json`，重启恢复；每调度 recentRuns 执行记录上限 50 条；cron 按 UTC 解析，API 与 UI 双重明示 `cronTimezone: 'UTC'`。

**怎么用**：Schedules 面板新建 cron/interval/once 调度（四种 job 类型）、暂停/恢复/立即触发/删除/查看执行记录；`POST /api/schedules` 创建，`GET /api/schedules/:id/runs` 查记录（最新在前）；once 调度触发后自动停放，过去时间创建即拒绝。

**诚实边界**：仅服务端运行时触发，无系统级守护进程；错过不补跑（只记 missed）；cron 最小粒度 1 分钟，interval 最小 60 秒，秒级间隔不在 v1；上一轮未跑完时本次记 skipped（审计 SCHEDULE_SKIPPED + 执行记录），不排队、不堆积；坏 root 或不存在的 label 只记失败不崩溃；未接线时 task-runner 任务 fail-closed，绝不执行。

## 75. 规则文件分级管理 UI（第六轮二）

**是什么**：规则文件的两级管理——全局级 `~/.ai-factory/rules/rules.json` 与项目级 `<root>/.ai-factory/rules.json`，优先级与合并关系明确展示；项目级同名规则覆盖全局级，覆盖关系双向标注（全局列表标 overriddenBy、生效条目标 overrides）。AGENTS.md / .cursorrules / .clinerules 在项目 root 只读展示，绝不改写。

**怎么用**：规则面板增删改/启用停用/整级重排（ids 须为该级全排列，否则 400）；`GET /api/rules?root=` 看四段视图（全局/项目/兼容/生效），`POST /api/rules`、`PATCH /api/rules`、`DELETE /api/rules`、`POST /api/rules/order` 管理。

**诚实边界**：兼容文件 v1 只读，面板无编辑入口；规则内容不做语义校验；每级上限 200 条、单条 64KB、兼容文件截断 512KB；规则变更记审计（RULE_ADDED/UPDATED/DELETED/REORDERED）；规则本身不驱动任何执行通道。

## 76. 自定义斜杠命令（第六轮二）

**是什么**：在 W-B 斜杠命令机制上的扩展，不另起解析器。三种绑定：template（W-B 既有行为，`{args}` / `{args:N}` 确定性展开）、command（命令面板命令 id 的别名）、task（tasks.json 链 label 的别名，执行走与手动运行完全相同的策略/审计/记录通道）。用户级 `AI_FACTORY_DATA_DIR/slash-commands.json`（W-B 文件原样兼容）与项目级 `<root>/.ai-factory/slash-commands.json` 两级，解析顺序 project > user > builtin。

**怎么用**：斜杠命令面板新增/编辑/启用/停用/删除/试运行；`GET /api/commands`（合并列表 + 告警）、`POST /api/commands` 管理、`POST /api/commands/execute` 执行；命令面板新增 slash 分组（打开时拉取，跳过停用项）；task 绑定的参数只追加到被请求的任务，依赖任务保持声明参数。

**诚实边界**：斜杠命令只是别名 + 参数模板，不做自然语言解析；内置名冲突默认仍 409，显式 `override: true` 才允许覆盖，且列表与执行响应都带 warning；停用命令照常列出、执行 409；task 绑定不改 tasks.json、不改依赖任务参数；command 绑定在服务端只返回描述符，由桌面端分发，服务端不执行桌面命令。

## 77. .env 可视化管理（第六轮二）

**是什么**：.env 文件的可视化编辑器——解析（注释/空行/`export ` 前缀/单双引号/行内注释/重复键 last-wins）与往返写（只改动 set/delete 的行，其余字节级保留）。安全红线在代码层 enforced：列表响应值全部脱敏，明文只走 `/reveal`；密钥告警复用与 pre-send 门同一张 SECRET_PATTERNS 表。

**怎么用**：.env 面板看键值表、逐行揭示/隐藏、疑似密钥徽标、新增/编辑/删除、缺失校验、加载到任务、gitignore 提示；`GET /api/env` 列表、`GET /api/env/reveal` 揭示、`POST /api/env` 写；加载到任务环境只做单次运行的内存覆盖，绝不写入 tasks.json，任务自身 options.env 优先于覆盖值。

**诚实边界**：只做编辑器，不做密钥保险库（值明文存 .env）；揭示钉为 operator 角色（GET 也不给 viewer），审计只记键名不记值；写/加载审计只记键名；告警是建议性的，不阻止保存（.env 本就是密钥的合法居所）；v1 不支持多行引号值与无 `=` 的行（解析为 invalid 行并告警，写时原样保留）；文件上限 512KB；.env 未进 .gitignore 时只提示，不自动改写。

## 78. Vim 模式（第六轮二）

**是什么**：编辑器的 Vim 键位层——normal/insert/visual/visual-line/命令行五种模式，走第五轮快捷键体系注册表（`vim.toggle` 命令，无默认键，用户自绑），不另起一套键绑定。默认关闭，localStorage 持久化，模式显示在编辑器工具栏 pill 里。

**怎么用**：编辑器工具栏开关或 `vim.toggle` 命令开启；motion（h j k l、w W b B e E、0 ^ $、gg G、f F t T、%）、operator（d c y 含 dd cc yy）+ count、编辑（x X r p P i a A I o O J D C Y）、visual 下 d x y c、o 换锚点；u 走 Monaco undo、Ctrl+R 走 Monaco redo；命令行 `:w` 保存。

**诚实边界**：v1 不含宏、命名寄存器、搜索（/ ? n N）、`.` 重复、marks、文本对象、visual-block、`:q` 及其他 Ex 命令（命令行仅 `:w`，其它报 E492）；Vim 开启且编辑器聚焦时，无修饰键先由 Vim 层消费，不触发全局 which-key 序列，Ctrl/Cmd/Alt 组合键仍走快捷键注册表。

## 79. 数据文件预览（第六轮二）

**是什么**：数据文件的表格只读预览——JSONL/NDJSON 逐行解析 JSON 对象，CSV 按 RFC 4180 形状解析（引号字段、双引号转义、引号内逗号/换行，首记录为表头）。列为首次出现顺序的键并集；排序数值感知、null 排最后且稳定；过滤为任意列子串（不区分大小写）；分页默认 100、上限 500。

**怎么用**：DataPreview 面板输相对路径加载、列头点击排序、过滤、分页、每页条数；`POST /api/datapreview/preview`（inspection-root jail 越狱 403、文件 64MB 上限 413、目录/缺失/格式错误 fail-closed）。

**诚实边界**：只读预览，无编辑、无写回；这是文件预览，不是数据库浏览器（不连数据库）；行数上限 100,000、列数上限 200、文件上限 64MB、单格上限 4096 字符，超了截断并标注；畸形行只跳过并计数，不猜格式；预览是快照语义，文件变化需重新加载。

## 80. 桌面默认 per-install API token（V3.0 一）

**是什么**：V3.0 审计 P0-4 的修复——桌面默认不再开放无鉴权 loopback API。每次安装生成独立 token，存 0600 模式的 token 文件；服务端启动时无凭证（且未显式 opt-in）拒绝启动，fail-closed；Electron 渲染进程经 preload 桥取 token 发请求，桌面提供轮换入口。

**怎么用**：首次启动自动生成并落盘 token；`GET /api/auth/whoami` 查看模式与角色；`POST /api/auth/rotate` 轮换（旧 token 立即失效，无单独吊销端点）；显式开放本地模式（`FACTORY_ALLOW_OPEN_LOCAL=1`）时桌面顶部渲染警告横幅，顶栏同时标“本地模式（无令牌）”。

**诚实边界**：仅 loopback 默认鉴权，非 loopback 绑定无凭证同样拒绝启动（既有行为）；Vite dev（无桥）下轮换后的新 token 只存 localStorage fallback 与服务端内存，服务端重启后回到启动时 env token，Electron 路径无此问题；裸跑 `node --test`（不走 wrapper）时 token-less 测试启动会被新默认拒绝，属预期语义，`npm run test:server` 的 wrapper 已显式 opt-in。

## 81. 打包后真机冒烟 + 跨平台验证流水线（V3.0 一）

**是什么**：打包产物本身的冒烟脚本 + Win/mac 验证流水线定义。`scripts/packaged-smoke.mjs` 对 `release/linux-unpacked` 或 AppImage 解包目录跑 14 项检查（布局、启动、健康、token、面板 tab 数、退出后后端清零）；`scripts/cross-platform-check.mjs` 输出 6 行平台差异矩阵（沙盒、进程组 kill、路径、换行、签名/公证、安装包格式），非当前平台一律标 NOT_RUN 并给出精确重跑命令。

**怎么用**：`npm run smoke:packaged`（Linux 打包后）与 `npm run verify:platform`；Win/mac 上用同一脚本重跑，不得用 Linux 结果代替。平台差异清单见 `docs/verification/platform-matrix.md`。

**诚实边界**：Linux x64 冒烟 14/14（Electron 44.8.0，57 tab，0 页错误）；Win/mac 打包产物、签名/公证、沙盒降级路径、安装流程全部未验证——三平台目前全部未签名是脚本实测事实，证书采购为 Tan 侧动作；本 VM 无 bwrap，沙盒只能验证“探针不可用 + 降级可审计”，不能验证“沙盒内构建”。

## 82. 黄金路径向导 + 面板分层导航（V3.0 一）

**是什么**：57 个中心 tab 的三层划分（常用层 12 个、进阶、专家）+ 4 步黄金路径向导（选项目 → 跑检查 → 建任务 → 看审批）+ 20 个面板空态引导。分层工具栏在 `.center-tabs` 之外，e2e tab 索引顺序不变；折叠层仅 CSS 隐藏按钮，不删功能、不改路由语义。

**怎么用**：分层工具栏切换常用/进阶/专家/全部，折叠层经导航进入时自动展开；向导可跳过、可重开，每步跳转到现有流程、由用户手动标记完成；空态指南 Top 20 覆盖各面板的下一步操作。

**诚实边界**：向导是引导清单而非自动执行器；V3 报告要求的“2–3 名真人用户走黄金路径并记录卡点”未做，向导成功率 100% 的标准因此尚未验证；冒烟未起 server（本任务为纯桌面 UI 改动）。

## 83. IDE 性能基准套件 + CI 门禁（V3.0 一）

**是什么**：`packages/perfbench/` + `scripts/perfbench.mjs` + `scripts/perf-gate.mjs`：11 项实测任务（server-boot、index、repomap、search、SQLite 写入、large-file-scan、并发任务 P95、unit-sample）+ canonical 基线 `packages/perfbench/baselines/baseline.json` + 门禁（自比 warn PASS、回归 +50% 时 warn 通过带告警、block 失败 exit 1、缺基线 block 亦通过并标 noBaseline）。

**怎么用**：跑基线后以 `scripts/perf-gate.mjs` 比对；基线 run2：server-boot 2760ms、index-small 653ms、repomap-medium 109367ms、search-medium 508ms、SQLite 2000 次 autocommit 108344ms（20000 次 batched 仅 121ms）、并发任务 p95 650.73ms。

**诚实边界**：门禁保持 warn——本 VM 仅 2 核共享负载下同档观测差 18–23 倍，20% 阈值必误报，block 须等同一机器 3 轮稳定后才可收紧；SQLite autocommit 瓶颈在每次 fsync、repomap medium 档超线性增长是两条已记录未展开修的性能线索；large-file-scan 只是读 + 分词 proxy，不是 Monaco 真实大文件渲染；Win/mac 实测、large 档（100k 文件）、vite-build 均为 opt-in 未跑。

## 84. 出站防火墙默认收紧 + 首次启用向导（V3.0 一）

**是什么**：缺文件默认 = enabled + deny + factoryDefault，不再是旧默认全放行；首次启用向导带 8 个模板（npm、pypi 等，含收口补的 `web-search` 模板 `www.bing.com`），每项含说明与风险提示；存量无 policyVersion 的旧文件判 legacy、规则原样保留，向导完成时 note-stamped 合并；开发态显式 OFF 记审计，关闭向导不建文件（仅记 dismissed 时间戳）。

**怎么用**：EgressWizard 面板完成/关闭/重开向导；`GET /api/egress/wizard`、`POST /api/egress/wizard/complete|dev-mode|dismiss`；策略变更全量审计（EGRESS_CONFIG_UPDATED / WIZARD_COMPLETED / DEV_MODE / DISMISSED）。

**诚实边界**：防火墙只管域名规则，不防 DNS rebinding，UI 与代码注释均明示；开发态全放行是显式 operator 选择且记审计，不是静默回退；默认收紧后内置搜索 Bing RSS 新装即 403，须向导显式放行 `web-search` 模板后才通（收口已修此回归）。

## 85. LSP 代码智能（V3.0 二）

**是什么**：新包 `packages/langsrv/`（零新依赖）：TypeScript compiler API 精确引擎（定义跳转、引用、hover、大纲、重命名预览，只算 edits、永不写文件）+ 零依赖 LSP 客户端（外部语言服务器只做客户端、不捆绑，`FACTORY_LANGSRV_LSP_COMMAND` 配置即优先）+ codeindex 启发式第三级回退。优先级 LSP → 语义引擎 → 启发式；重命名预览仅语义层，语义不可用时 409。

**怎么用**：LangSrv 面板（新中心 tab，advanced 层）；`GET /api/langsrv/status`，`POST /api/langsrv/{definition,references,hover,outline,rename-preview}`；回退响应恒带 `source: 'heuristic'` + warning，不静默降级。

**诚实边界**：仅 TS/JS 及其方言精确，其他语言走启发式；单 root 作用域，文件数上限 3000、超限 409；tree-sitter 已拒绝（native/wasm 外部依赖，破零依赖策略）；准确率抽查（langsrv/src + server routes 前 50 个 call 形标识符）：语义 49/50，启发式基线 21/50，唯一语义失败为文档注释行样本伪影。

## 86. Cascade 式任务时间线 UI（V3.0 二）

**是什么**：tasks.json 任务链运行记录升级为完整时间线：执行顺序卡片 + 未跑步骤显式 skipped + 未知命令 partial；`GET /api/tasks/runs/:id`（完整卡片 + 按运行根目录匹配的影子检查点）、`POST .../rollback`（审计 TIMELINE_ROLLBACK）、`POST .../rerun`（同一 executeChain，新运行以 rerunOf/rerunFrom 链接）。桌面 CascadeTimelinePanel 嵌 TasksPanel 底部，不新增中心 tab。

**怎么用**：时间线面板看步骤卡片（命令/状态/退出码/耗时/诊断/输出折叠/记录摘要）、回退（confirm）、重跑、检查点恢复（调既有影子检查点恢复端点）；列表视图剥离步骤输出与服务端 root 绝对路径。

**诚实边界**：时间线为进程内记录（ring 上限 20 条），服务端重启清空；回退只标记后续步骤 superseded、不删历史、不改文件（文件恢复走影子检查点端点），且不停止队列中同名在途作业，面板以警告明示；检查点跳转依赖影子工作区配置，无配置时明示原因。

## 87. 模型侧成本治理策略层（V3.0 二）

**是什么**：并入 `packages/quota`（不新开包）：三级预算（task/person/project）× 三单位（usd-estimate/calls/tokens-estimate）× 四周期（daily/weekly/monthly/all-time）；80% 警告一次 → 100% 熔断（`checkAllowed` 拒绝新调用）→ 一键放行（理由必填、否则 400，只清本窗口、永不提高上限、记审计）；默认新项目月预算 10 美元估算（AI Factory 自有政策默认值，非厂商价格）；熔断时项目级预算 best-effort 进影子检查点（label `budget-breaker:<id>`）。持久化 `<DATA_DIR>/budgets.json` 原子写，未知形状 fail-closed。桌面 BudgetPanel 挂 Ops 页签内，不新增中心 tab。

**怎么用**：Budget 面板看板/放行；`GET /api/quota/budgets/*` 11 个端点；apply-defaults 幂等（已存在同 scope+key+unit+period 的预算原样保留，重复创建 409）。

**诚实边界**：零真实模型 key——全部用量为模拟/手动记录，费用与 token 均为估算；换算表 3 行全部 `measured: false`，未知单位估算返回 null、不编造数字；真实计量（provider 实际 token/账单接入）按审计结论暂缓至模型接通后；预算账本只保留当前窗口，跨窗口历史查审计链。

## 88. 扩展信任模型（V3.0 二）

**是什么**：落点 `packages/extensions`（不新开包）：`trust.ts`（API 版本检查、Ed25519 签名/验签、信任裁决、trust.json 决定存储）。宿主 API v1 冻结，缺 `apiVersion` = 遗留按 v1 计并警告，声明主版本非 1 硬拒绝；签名有效 + 官方密钥 = official 自动信任，签名有效 + 其他密钥 = 自动信任，签名无效 = 安装拒绝（fail-closed），未签名 = 需显式信任（内联安装缺 `{ trust: true }` → 409 trust-required）；审核声明无有效签名降级 unreviewed；信任决定按 bundle 哈希键控，bundle 一改即失效。

**怎么用**：Extensions 面板信任徽标行（审核/签名/信任来源/API 版本）、警告行、未签名安装 409 时的“信任并安装”、逐项信任/撤销信任按钮；审计 EXT_TRUST_GRANTED/REVOKED；4 个官方示例（新增 demo-notes）均含 `apiVersion: "1"` + `review: "official"` + 官方密钥签署的 `signature.json`，重签工具 `demo/sign-demo.mjs`（私钥作参数传入，永不进仓库）。

**诚实边界**：vm 沙盒不是安全边界——信任模型只解决来源可审计 + 用户显式决定，README、schema、桌面警告三处均明示，不宣称“安全运行不受信扩展”；官方私钥不在仓库，密钥轮换需换 `OFFICIAL_PUBLIC_KEY_B64` 并重签示例。

## 89. 诊断包导出 + 隐私合规明示（V3.0 二）

**是什么**：新包 `packages/diagpack/`（服务端专用 CJS 单格式）：`GET /api/diagnostics/preview`（viewer，预览不生成包）、`POST /api/diagnostics/export`（operator，须 `{ confirm: true }` 否则 400；审计 `DIAGNOSTICS_EXPORTED` 只记包 ID 与章节计数）。包内只有计数与 stripped 字段：审计 details 不读入包、任务证据只有计数、配置只有模式与计数、环境变量名与值一律不进包；脱敏全用 `@ai-factory/security` 的 SECRET_PATTERNS + `maskSecret`；`buildBundle` 对序列化包自检，任一命中即抛错、路由转 409 不发货；不上传，包只返回给调用方下载。新中心 tab DiagnosticsPanel；隐私政策 `docs/PRIVACY_POLICY.md` / `.en.md`。

**怎么用**：Diagnostics 面板预览清单 → 确认导出 → 下载 JSON/HTML；预览先看 excludes 清单（含 secret 类）与中英 notice。

**诚实边界**：错误摘录为启发式（审计日志无 severity 列）；性能基线摘要依赖 `FACTORY_PERFBENCH_BASELINE`，未设置时章节标注 unavailable；诊断包不含用户文件内容与任务标题，远程定位需原文时须用户另外提供；模型出境一节为占位文案（除 Codex 外适配器仍是 stub），面板与政策文档均明示。

## 90. 远程开发实时接入（第七轮一）

**是什么**：新包 `packages/remote/`：ssh/wsl/container/local 四传输（argv 无 shell、路径监狱、超时与输出上限）、连接 CRUD（12 端点）、探通、策略检查命令执行（经 `setRemoteExecPolicy(checkCommandPolicy)` 接既有 exec 通道）、文件往返、ssh `-N -L` 隧道（进程内跟踪，重启即消失）。新中心 tab RemotePanel（advanced 层）。

**怎么用**：Remote 面板建连 → 探通在线 → 目录/读/写/执行往返 → 转发启动/列表/删除；`GET /api/remote/*` 12 端点；密钥只存路径，服务器不打开密钥文件；审计 details 只有 id/kind/outcome。

**诚实边界**：无真实 sshd/docker/WSL 环境——ssh 路径经 PATH 垫片验证，真实远端主机/容器/WSL 未验证；`local` 是显式回环传输，未探通/已断开一律 409，绝不静默走本机；远程调试/远程 LSP 不在范围。

## 91. Notebook 交互式运行（第七轮一）

**是什么**：新包 `packages/notebook/`：版本化 JSON（`<DATA_DIR>/notebooks/`），代码格 + Markdown 格、单格 run、run-all、clear-outputs、export（`?stripOutputs=1`）。新中心 tab（advanced 层）。

**怎么用**：Notebook 面板建本 → 加代码格 → 运行出结果 → 移动/清空输出/导出去输出对照；单格 30s 超时，输出每流上限 64K 字符（超限 truncated: true）；仅 TS/JS 可运行，Markdown 格运行返回 400 not-code。

**诚实边界**：与清单的诚实偏差——清单说“Jupyter 内核接入”，按 brief 走既有共享 exec 安全通道落地，无 Jupyter 内核 wire protocol；每格独立 node 进程，格间不共享变量，run-all 只是顺序；笔记本不进审计、不受 pre-send 密钥扫描保护，面板页脚警示。

## 92. 测试资源管理器 UI（第七轮一）

**是什么**：新包 `packages/testexplorer/`：静态发现 `*.test.*`，包 > 文件 > 用例三级树；运行复用 node:test 程序化 `run()` API（子进程 fd 3 JSON 行上报）；spawn 剥离 `NODE_TEST_CONTEXT` + `NODE_TEST_WORKER_ID`（防嵌套 node:test 静默降级）；超时杀进程组；输出 512KB cap、单用例失败文本 8KB cap；`POST /api/testexplorer/rerun-failed`（进程内 last-run）。新中心 tab（advanced 层，追加末尾）。

**怎么用**：TestExplorer 面板发现树 + 单用例/单文件/单包/全部运行 + 失败输出展开 + 重跑失败；`GET /api/testexplorer/discover`、`POST /api/testexplorer/run`（case/file/package/all/cases 五种 scope）。

**诚实边界**：`*.spec.*` 与 `test.each` 不在 v1；同文件重名叶用例会全部跑（响应注明）；含 deny 词的测试路径会被 exec 策略 fail-closed 拒绝；服务端重启后重跑失败无据（409 NO_FAILED_RUN）。

## 93. 任务依赖 DAG（第七轮一）

**是什么**：在第五轮 S2 dependsOn 规划与 V3-#7 时间线 skipped 补记之上补三块真缺口：(1) `packages/tasks/src/graph.ts` 新增 `detectCycle()` + `dagLevels()`，PUT 保存成环 → 400 `cycle-detected` 且文件不写入（运行时 plan-failed 纵深防御保留）；(2) 依赖失败时依赖方记 `skipped` 且 error 点名根因失败方（透传原始失败方），审计 `TASK_SKIPPED`；(3) `GET /api/tasks/graph` + 桌面 DagGraphPanel（嵌 TasksPanel，不新增中心 tab）。

**怎么用**：DagGraphPanel 选 label 看层级分列节点（状态着色）与边列表、运行；线性链行为不变、菱形只跑一次、stoppedAt 语义不变。

**诚实边界**：图状态来自进程内时间线 ring，重启清空报 null；图是规划形状，不是实时执行追踪（单步输出与历史看 Cascade 时间线）；保存时环检测只管环，未知依赖仍在运行时 plan 拒绝。

## 94. Webhook 事件触发（第七轮一）

**是什么**：新包 `packages/webhooks/`：HMAC-SHA256 + 300 秒时间戳窗口 + nonce ring + 事件 id 去重；共享密钥来自环境（`FACTORY_WEBHOOK_SECRET` 或 `FACTORY_WEBHOOK_SECRET_FILE`），绝不进 webhooks.json/响应/日志/审计。接收端 `POST /api/webhooks/receive` 在 `index.ts` 于 API token 门禁前仅精确放行这一路（HMAC 鉴权）；事件绝不选链、绝不传参（body 里的 `chainLabel` 被忽略，冒烟实证），链取自端点配置，经 `runTaskChainByLabel` 跑。新中心 tab（advanced 层）。

**怎么用**：Webhooks 面板管理端点（CRUD + 投递历史走正常门禁）；合法签名触发、重放 401、未签名 401、过期时间戳 401、未知事件 404。

**诚实边界**：投递/去重/nonce 为进程内 ring，重启清空，去重保证在重启后弱化（README 明示）；每发送方独立密钥未做；不做公网暴露/GitHub 应用对接。

## 95. PR 评审与 Issue 联动（第七轮二）

**是什么**：只读联动为主：新包 `packages/prlink/`（refs 解析 `#123` / `owner/repo#123`、只读本地 git 联动、GitHub REST 客户端零依赖 + 离线 fixture provider、本地评审存档 `<data>/prlink/reviews.json` 原子写）；服务端路由 status / local / linked / linked/:number / reviews/local / issues/import / write/comment；新中心 tab PrLinkPanel（advanced 层）。写操作默认关闭，需服务端 `FACTORY_PRLINK_WRITES_ENABLED=1` + body `confirm: true` + 已配置 provider 三者齐全，fixture provider 的发布返回 501。

**怎么用**：PrLink 面板看关联 PR/Issue、评审摘录、CI 状态摘要；本地分支与提交信息中的编号解析；Issue 导入为 DRAFT，永不自动派发；本地评审存档只存本地，永不发远端；token 值永不离开 provider 闭包、不进日志/审计/响应。

**诚实边界**：零真实 token 默认——无 provider 时 linked 返回 configured:false + 空数组，绝不伪造数据；裸 `#123` 在 provider 解析前既不是 issue 也不是 PR；GitHub 客户端未对真实 GitHub 验证，live 语义（reviews/checks 端点）待 Tan 侧 token 后复核；远程 diff 拉取不在 v1（评审视图用本地 `base...head` stat + 远端评审摘录 500 字）。

## 96. 调试深化：多语言 DAP + 条件断点/日志点（第七轮二）

**是什么**：在第四轮 S2 DAP 之上补多语言 DAP + 条件断点/日志点：适配器静态注册（node 内置已实现；python 外部 debugpy，探针 `python3 -m debugpy --version` 回退 `python -m debugpy --version`，安装提示 `pip install debugpy`；go 外部 delve，探针 `dlv version`，安装提示 `go install github.com/go-delve/delve/cmd/dlv@latest`；探针 10 秒超时）；条件断点条件命中才停、日志点只记不停（logMessage 优先于 condition，两者都有时为 logpoint，经 CDP condition 实现、不改源码文件）；条件语法只做解析检查（`new Function` 解析、绝不执行），启动时语法非法 400 `bad-breakpoint`；命中时求值错误记诊断并继续、不断链。

**怎么用**：Debug 面板适配器区（静态列表 + 按需探针）、断点草稿日志点输入框与列表 `log:` 显示、配置下拉显示 `(request, adapter)`；`GET /api/debug/adapters`（静态注册不 spawn）、`POST /api/debug/adapters/:kind/probe`（未知 kind 400 `unknown-adapter`）；非 node 会话启动时 spawn 前返回 501 `adapter-not-implemented`，绝不静默回退 node。

**诚实边界**：仅 TS/JS 精确；python/go 仅注册与探针，未驱动；探针只报告二进制是否存在，不等于可用会话；Node 会话不自动 terminate（round-4 前置缺口，冒烟以显式 DELETE 为会话结束语义）；数据断点与反向调试明确后置。

## 97. 数据库多连接 + 查询历史 + ER 图（第七轮二）

**是什么**：在第四轮 A5 数据库浏览器之上深化：`multiconn.ts`（驱动目录：sqlite/postgres 可用，mysql/mariadb/mssql/oracle 诚实标注无驱动；连接元数据 active 切换；写模式门禁：默认关、开启需 confirm、prod 与驱动只读永不可开；`stripSecretFields` 审计脱敏）+ `history.ts`（查询历史 `<dataDir>/db-history.json` 原子写、上限 500 条、SQL 截断 4000 字符、损坏文件 fail-closed 永不覆盖、重跑记新条目不覆盖旧条目）；服务端路由 `GET /drivers`、`GET /connections/meta`、`GET/POST /active`、`POST /connections/:name/write-mode`、`GET/DELETE /history`、`POST /history/:id/rerun|favorite`、`DELETE /history/:id`；桌面扩展既有 DbBrowserPanel（不新增中心 tab）：当前连接切换、写模式开关（开启前 `window.confirm`）、驱动提示、历史子 tab、ER 子 tab 新增 SVG 关系图（被引用表在左、外键持有表在右，按引用深度分列，环保护）。

**怎么用**：DbBrowser 面板切换连接、开写模式（先 confirm）、历史重跑/收藏/删除/清空、ER 图看外键关系；`/api/db-browser/query` 与 `PUT /api/db-browser/row` 的写路径默认拒绝（`WRITE_MODE_DISABLED`），需先 `POST /connections/:name/write-mode {enabled: true, confirm: true}`；破坏性语句仍走原票据路径，不受写模式门禁影响；prod 写拒绝语义不变（`PROD_WRITE_REFUSED`，门禁顺序 prod 优先）。

**诚实边界**：多连接为服务端会话级，重启后连接丢失需重新注册；历史文件跨重启保留，但旧条目重跑可能 404；Postgres 仍为最小线协议驱动（trust 认证、无 SSL），未对真实服务器验证；mysql 等无驱动注册直接拒绝；历史存 SQL 文本本身（重跑必需），只落在服务端数据目录，审计事件只含条目 id 与计数、永不含 SQL，密码字段永不被读取、存储、记录；ER 图由外键只读推导、不改库，桌面 ER SVG 为确定性分列布局、非交互式画布。

## 98. API 客户端深化（第七轮二）

**是什么**：在第四轮 A6 HTTP/REST 客户端之上补集合、环境、鉴权、GraphQL、WebSocket：`packages/httpclient/` 扩展 `auth.ts`（Bearer/Basic/ApiKey，OAuth2 占位）、`collections.ts`（集合/环境/鉴权配置/历史，密钥分离存储）、`graphql.ts`（查询 + 变量，errors 原样 surfacing）、`ws.ts`（RFC 6455 客户端，帧上限、close 握手、断线语义 explicit）、`envs.ts` 严格替换；服务端集合 CRUD、鉴权配置 CRUD、环境 PUT/GET、`/send`、`/graphql`、`/ws/*`、`/history` + rerun；密钥存 `http-api-secrets.json`（0600），读侧一律 redacted；桌面 HttpPanel 内新增子 tab（文件/集合/GraphQL/WebSocket/历史），不新增中心 tab。

**怎么用**：Http 面板建集合、配三种鉴权、存环境、发 GraphQL、连 WebSocket（连接/发送/echo 回包/关闭）、历史重跑；环境变量替换失败明确报错（400 `unresolved-variable`），不静默发空值；历史存变量替换前的 URL 模板与 redacted 头，不存任何密钥原文。

**诚实边界**：OAuth2 只是占位：kind 'oauth2' 接受建档，应用时 fail-closed（`oauth2-placeholder`），不跑任何 token 流程，面板边界文案已明示；WebSocket 二进制帧拒绝 fail-closed，关后发送 409，出站检查按等价 http(s) 地址执行；桌面面板路径经 tsc + 单测覆盖，未单独走 Electron e2e（收口 e2e 为准）。

## 99. 设置同步（第七轮二）

**是什么**：设置导出/导入（JSON + 版本戳）、导入前预览 diff（新增/修改/冲突三类，另有删除类）、冲突逐项确认不静默覆盖、应用后记审计（只记键名不记值）；可选私有远端（token 只存安全通道），无远端时本地导出/导入照常可用。新中心 tab SettingsSyncPanel（advanced 层末尾）。

**怎么用**：SettingsSync 面板导出下载、导入粘贴、预览表、冲突/删除逐项裁决、应用、远端配置/推送/拉取；`GET /api/settingsync/export`、`POST /api/settingsync/preview`、`POST /api/settingsync/apply`（未裁决的 conflict/removed 整体 409 且不写任何文件）、`GET/PUT /api/settingsync/remote`（只返回 URL 与 `tokenConfigured` 布尔值）、`POST /api/settingsync/remote/push|pull`（pull 只预览不应用）；基线 `<dataDir>/settingsync-baseline.json`；RBAC 走默认门禁（GET viewer，POST/PUT operator）。

**诚实边界**：同步分区仅 keybindings 与 rules-global；桌面 localStorage 偏好（Vim、分层导航、金路径进度）v1 不同步；规则 diff 为 store 级（`rules` 数组整体比较）；远端为用户自有单文档 HTTP 端点，无账号体系、无发现、无重试；导出时设置文件本身含密钥特征则整体拒绝（fail-closed）；文档上限 1MB、32 section、每 section 1000 键，文档缺失的 section 一律不 diff、不写。

---

*版本 0.2.0（2026-10-18）。2026-10-21 补录：加强波（一/二）、
第三波（一/二）、第二轮（一/二）功能（§12–§41）；
2026-10-21 补录：第三轮（一/二）功能（§42–§49）；
2026-10-22 补录：第四轮（一/二）功能（§50–§59）；
2026-10-23 补录：第五轮（一/二）功能（§60–§69）。
2026-10-27 补录：第六轮（一/二）功能（§70–§79）。
2026-11-02 补录：V3.0（一/二）功能（§80–§89）；第七轮（一/二）功能（§90–§99）。
英文版见 ADVANCED_FEATURES.en.md。*

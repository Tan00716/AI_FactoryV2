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

---

*版本 0.2.0（2026-10-18）。2026-10-21 补录：加强波（一/二）、
第三波（一/二）、第二轮（一/二）功能（§12–§41）；
2026-10-21 补录：第三轮（一/二）功能（§42–§49）；
2026-10-22 补录：第四轮（一/二）功能（§50–§59）；
2026-10-23 补录：第五轮（一/二）功能（§60–§69）。
英文版见 ADVANCED_FEATURES.en.md。*

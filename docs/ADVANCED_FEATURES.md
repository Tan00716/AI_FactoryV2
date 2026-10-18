# AI Factory 进阶功能指南（0.2.0）

> 面向已经会用基本流程的用户：MCP、Plan mode、Slash 命令、Hooks、
> 权限分级、Headless CLI、会话恢复与检查点、联网搜索、多模态输入、
> 插件、PR 审查。快速上手见 [USER_GUIDE.md](USER_GUIDE.md)；
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

---

*版本 0.2.0（2026-10-18）。英文版见 ADVANCED_FEATURES.en.md。*

# @ai-factory/extensions — 本地扩展 API 子集（R6-S1）

VS Code 扩展 API 的本地子集：扩展以项目为单位安装在
`<root>/.ai-factory/extensions/<name>/`（`extension.json` + `main.js`），
不自建云端市场、不自动更新扩展。

## 贡献点（四类）

| 贡献点 | 声明方式 | 执行方式 |
|---|---|---|
| 命令 commands | manifest `contributes.commands[]`（id/title/description） | `main.js` 里 `api.registerCommand(id, fn)`，经 `POST /api/extensions/:name/commands/:cmd/run` 调用 |
| 面板 panels | manifest `contributes.panels[]`（id/title/sections 纯文本） | 纯声明，无代码；经 `GET /api/extensions/panels` 只读渲染 |
| 检查器 checkers | manifest `contributes.checkers[]`（id/pattern/filePattern/severity/message） | 纯声明，正则匹配；接入 inspections 的 `extensionCheckerProvider` |
| 上下文提供器 providers | manifest `contributes.providers[]`（id/prefix/description） | `main.js` 里 `api.registerContextProvider(id, fn)`，经 `POST /api/extensions/:name/providers/:id/resolve` 调用 |

## 沙盒内 `api` 对象（仅有的全局对象）

- `api.log(msg)`：写日志（单条截断 2000 字符，最多保留 100 条，随调用结果返回）。
- `api.registerCommand(id, fn)`：注册命令处理函数。
- `api.registerContextProvider(id, fn)`：注册提供器处理函数。

处理函数必须是同步的、返回 JSON 值；返回 thenable 会被拒绝。
参数与结果以 JSON 字符串进出沙盒，宿主对象永不跨边界。

## 沙盒限制（诚实边界）

- 沙盒是 `node:vm` 上下文：代码生成已禁用（无 eval、无 Function 构造器、无 WebAssembly），
  加载超时 2000ms、调用超时 5000ms，参数/结果各 64KB 上限，提供器最多 50 项。
- 沙盒内没有 `require` / `process` / `Buffer` / `eval`；`main.js` 顶层出现 `require` 会在安装时被拒绝，
  处理函数体内逃逸会在运行时被拒绝。
- 沙盒**不是**多租户安全边界：安装本身就需要操作员权限，有安装权的作者本就可以换 bundle。
  沙盒限制的是 API 表面、挡住朴素逃逸，不是防有决心的攻击者。
- v1 不兼容完整 VS Code 扩展 API（无 activationEvents、无工作区 API、无 webview）。

## 服务端路由（见 apps/server/src/routes/extensions.ts）

- `GET /api/extensions?root=`：已安装列表 + 损坏目录（跳过不隐藏其余）。
- `GET /api/extensions/schema`：manifest schema 文档（运行时版的本表）。
- `GET /api/extensions/panels?root=` / `GET /api/extensions/providers?root=`：已启用扩展的面板/提供器。
- `POST /api/extensions/install`（{root, manifest, main}）/ `install-from-dir`（{root, sourceDir}，jail 内、无符号链接）。
- `POST /api/extensions/:name/enable|disable`、`DELETE /api/extensions/:name`。
- `POST /api/extensions/:name/commands/:cmd/run`、`POST /api/extensions/:name/providers/:id/resolve`。

## 示例扩展（packages/extensions/demo/）

- `hello-command`：命令贡献（`hello.echo`）。
- `info-panel`：面板贡献（纯文本 sections）。
- `marker-checker`：检查器贡献（正则 `SAMPLE-MARKER`）。
- 提供器贡献见包单测 `sandbox.test.ts`（`demo.notes` 解析）。

## 权限

manifest `permissions[]` 目前只接受已知的四类贡献权限
（`commands.execute`、`panels.contribute`、`checkers.contribute`、`providers.contribute`），
未知权限（如 `network.access`）在安装时 fail-closed 拒绝。

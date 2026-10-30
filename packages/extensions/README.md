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
- `demo-notes`：提供器贡献（`@notes`，解析查询为一条 note）。
- 四个示例均为**官方示例**：manifest 含 `apiVersion: "1"` + `review: "official"`，
  并附 `signature.json`（官方密钥签署，见下）。从目录安装时签名被一并读取，
  列表中显示 review `official`、来源 `official`。

## 信任模型（V3-#9）：API 版本化 + 签名 + 审核 + 显式信任

信任不是安全声明：vm 沙盒不是安全边界（见上），本节只解决“这个 bundle
是不是当初那个 bundle、是谁为它背书、用户有没有明确点头”。

### API 版本化：宿主 API v1 冻结

- 宿主扩展 API 版本为 `1`（`EXTENSION_API_VERSION`）。manifest 可声明
  `apiVersion`（`"1"`、`"1.x"` 均兼容）；缺失 = 历史遗留 bundle，按 v1 计
  并在信任裁决里打 `legacy` 警告（已安装的老扩展不断线）。
- 声明的主版本不是 1（如 `"2"`）时，安装与加载均硬拒绝并明示
  “宿主 API 为 v1”，绝不静默运行。后续 v2 以并行期方式引入，不会
  用“承诺过死”锁住演进；签名验证可降级为警告，但版本不兼容不可降级。

### 签名：Ed25519，本地密钥，零外部依赖

- 签名对象是规范 bundle 字符串（`trust.ts`：`extension-trust-v1` 前缀 +
  名称 + 版本 + 规范化 manifest 的 sha256 + main.js 的 sha256），
  存为扩展目录下的 `signature.json`（`{ algorithm: "ed25519", publicKey,
  signature }`，publicKey 为 base64 SPKI DER）。
- 安装时验签：签名有效 → 直接安装（已签名即直接装，见审计报告验证方法）；
  签名无效 → 安装拒绝（fail-closed：被篡改的 bundle 比未签名更危险，
  不走“询问”流程）；未签名 → 见下“显式信任”。
- 官方示例用仓库外持有的官方私钥签署，公钥硬编码为
  `OFFICIAL_PUBLIC_KEY_B64`；重签工具见 `demo/sign-demo.mjs`
 （私钥文件路径作参数传入，永不进仓库）。密钥轮换 = 换公钥常量 +
  重签示例，旧签名随即验签失败（预期中的 fail-closed）。

### 审核状态：声明只是声明，证据才算数

- manifest 的 `review` 字段（`unreviewed`/`reviewed`/`official`）只是声明：
  只有签名有效时才采信（`reviewed` 需有效签名，`official` 需官方密钥签名），
  否则一律降级为 `unreviewed` 并打警告。UI 徽标显示的是裁决结果，
  不是 manifest 自称。
- 扩展列表的 `trust` 字段即裁决：`{ apiVersion, legacyApi, signature
  (valid/invalid/absent), review, trusted, trustSource
  (official/signature/user/local-dev), bundleSha256, warnings[] }`。

### 显式信任：未签名必须点头，bundle 一改就失效

- 未签名内联安装缺 `{ trust: true }` 时返回 409 `trust-required`
 （附信任裁决）；桌面端此时出现“信任并安装”按钮。
- 从项目内目录安装（本地开发，作者在场）直接安装，但仍记录一条
  `local-dev` 信任决定——不是免信任，而是“在场作者的决定”也被记录。
- 信任决定存在项目内 `<root>/.ai-factory/extensions/trust.json`，
  按 bundle 哈希键控：manifest 或 main.js 一改，旧决定即失效，
  启用/运行/解析均回 409，直到重新信任（`POST /api/extensions/:name/trust`，
  撤销用 `/untrust`；两项均记审计 `EXT_TRUST_GRANTED`/`EXT_TRUST_REVOKED`）。
- 高风险默认拦截（不询问）：签名无效、沙盒加载失败、未知权限
  均直接拒绝安装——“询问”只留给“未签名但完好”的情形。

## 权限

manifest `permissions[]` 目前只接受已知的四类贡献权限
（`commands.execute`、`panels.contribute`、`checkers.contribute`、`providers.contribute`），
未知权限（如 `network.access`）在安装时 fail-closed 拒绝。

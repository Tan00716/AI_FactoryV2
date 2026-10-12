# 桌面打包（electron-builder）

配置在仓库根 `electron-builder.yml`；依赖为根 `devDependencies` 的
`electron` + `electron-builder`（`npm install` 后若 electron 二进制未下载，
执行 `node node_modules/electron/install.js`）。

## 构建命令

| 平台 | 命令 | 在哪台机器构建 |
|---|---|---|
| Linux AppImage | `npm run dist:linux` | Linux x64（本机已验证） |
| Windows NSIS + portable | `npm run dist:win` | **Windows**（Linux 上需 wine，见下） |
| macOS DMG | `npm run dist:mac` | **macOS**（DMG 工具链仅 macOS 有） |
| 当前平台 | `npm run dist` | 任意 |

每个 `dist*` 脚本都会先跑全量 `npm run build` + `build:electron` 再打包。
产物落在 `release/`（已 gitignore，不要把二进制产物提交进仓库）。

## 打包布局（与主进程代码的契约，改路径先改这里）

- 应用入口：根 package.json `main` → `apps/desktop/dist-electron/main.js`。
- 生产渲染层：主进程 `loadFile(<app>/apps/desktop/renderer/index.html)`，
  配置把 Vite 产出 `apps/desktop/dist` 映射到 `apps/desktop/renderer`；
  Vite `base: './'` 保证 file:// 下资源可达。
- 生产后端：主进程从 `process.resourcesPath/server/index.js` 拉起后端
  （`extraResources` 放入 `apps/server/dist`），其 `require('@ai-factory/*')`
  由同目录 `server/node_modules/@ai-factory/<pkg>`（各包 package.json + dist）
  解析，与开发时单仓解析一致；各包零外部运行时依赖（DB 为 node:sqlite）。
- 后端子进程带 `ELECTRON_RUN_AS_NODE=1` 拉起——打包后的 Electron 二进制会
  忽略脚本路径参数、直接重开整个应用，不带这个变量会无限自拉起。
- 未打包判断走 `app.isPackaged`（打包应用没人给它设 NODE_ENV）。
- 后端数据库默认 `./data/factory.db`（相对**启动时的工作目录**），
  可用 `DB_PATH` 环境变量覆盖。

## 本机实测状态（2026-10-12，Linux x64 / Electron 44.7.0 / builder 26.15.3）

- **Linux：构建成功且运行验证通过（含图标/桌面元数据）。**
  `release/AI Factory-0.1.0.AppImage`（129,516,201 字节，约 124MB）。
  `--appimage-extract` 后结构完整（asar 内主进程入口 + renderer，
  resources/server + 40 个工作区包）；图标已进入产物：
  `usr/share/icons/hicolor/512x512/apps/ai-factory.png` 与根目录
  `ai-factory.png` 均在，解码抽查像素与源图逐点一致；桌面条目为
  `AI Factory.desktop`，含 `Icon=ai-factory` 与
  `StartupWMClass=AI Factory`（来自 package.json 的 `desktopName` +
  yml 的 `linux.syncDesktopName`），可执行文件名为 `ai-factory`
  （`linux.executableName`）。xvfb 无头启动复验：后端在
  127.0.0.1:3100 监听、`/api/health` 与 `/api/stats` 返回真实数据、
  数据库真实落盘、后端恰好一个进程。
- **Windows：本机仍未定稿（卡点在 wine 安装之前）。** 载荷
  `ai-factory-0.1.0-x64.nsis.7z`（113,497,943 字节）已打包，但最后
  一步 NSIS/portable 的 exe 定稿（rcedit）需要 wine。2026-10-12
  Batch 11 再次尝试安装 wine：本机以 root 运行、sudo 免密，均无问题，
  但 `apt-get update` 14 分钟未完成被终止——Ubuntu 源
  （azure.archive.ubuntu.com / mirror.cogentco.com）从本机网络
  无响应，只有 github/cloudflared/nodesource 的源拉到了列表，
  `wine64` 包根本查不到，安装无从谈起；`dist:win` 因此未重跑
  （重跑也只会停在同一步）。`release/` 里 189,788 字节的
  `AI Factory Setup 0.1.0.exe` 仍是未合入载荷的模板，**不可用**。
  给 Tan 的最短解法：**在 Windows 机器上跑 `npm run dist:win`**
  （配置与图标均已就绪，预期产出百兆量级的 Setup exe + portable
  exe）；次选是给本机换一个可达的 Ubuntu 镜像后
  `dpkg --add-architecture i386 && apt-get update && apt-get install -y wine`
  再重跑 `dist:win`。
- **macOS：本机不可构建。** DMG 制作调用 macOS 独占的 `sips` 等工具，
  Linux 上直接失败；配置已就绪，请在 Mac 上 `npm run dist:mac`。

## 代码签名：未做（如实声明）

三个平台目前**全部未签名**，也没有配置任何证书：

- Windows：未签名安装包会触发 SmartScreen 警告；商业分发前需购买
  代码签名证书（OV/EV）并配置 `win.certificateFile` 等选项。
- macOS：未签名/未公证的 DMG 会被 Gatekeeper 拦截；商业分发前需
  Apple Developer ID 证书 + notarization。
- Linux：AppImage 无签名要求，可直接分发。

## 图标与元数据（2026-10-12 已补）

- 应用图标：`apps/desktop/build/icon.png`（512×512），几何齿轮造型
  （琥珀色齿轮 + 深蓝圆角方底）；同目录有矢量源 `icon.svg`、
  256×256 的 `icon-256.png`，以及零依赖的生成脚本
  `generate-icon.mjs`（同一组几何参数同时生成 SVG 与 PNG，
  `node apps/desktop/build/generate-icon.mjs` 可重跑）。yml 已给
  win/mac/linux 三平台都指定该图标，builder 自动派生各尺寸
  （.ico/.icns/AppImage 图标集）。
- 根 package.json 已填 `author: "Tan"` 与
  `desktopName: "AI Factory"`（后者是 builder 26 的实际机制：
  Electron 以它作 app_id / WM_CLASS，yml 里没有 `desktopName` 键，
  对应的是 `linux.syncDesktopName: true`）。

## 已知粗糙点（不影响运行，商业打磨项）

- 图标只有单一 512 源图，靠 builder 派生小尺寸；要极致锐利可再补
  一套手工修过的小尺寸图。
- Windows/macOS 安装包仍未签名、未公证（见上节，等证书采购）。

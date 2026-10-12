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

- **Linux：构建成功且运行验证通过。** `release/AI Factory-0.1.0.AppImage`
  （约 124MB）。`--appimage-extract` 后结构完整（asar 内主进程入口 +
  renderer，resources/server + 40 个工作区包）；xvfb 无头启动实测：
  渲染页从 asar 加载、后端在 127.0.0.1:3100 监听、`/api/stats`、
  `/api/tasks` 返回真实数据、后端恰好一个进程。
- **Windows：本机构建失败（预期卡点）。** 打包进行到 NSIS 载荷
  （`ai-factory-0.1.0-x64.nsis.7z`，约 113MB）后，electron-builder 需要
  wine 完成 NSIS/portable 的 exe 定稿（rcedit），本机未装 wine 而中止；
  残留的 190KB `AI Factory Setup 0.1.0.exe` 只是未合入载荷的模板，
  **不可用**。解决：`apt install wine64` 后在 Linux 重跑，或直接在
  Windows 机器上 `npm run dist:win`。
- **macOS：本机不可构建。** DMG 制作调用 macOS 独占的 `sips` 等工具，
  Linux 上直接失败；配置已就绪，请在 Mac 上 `npm run dist:mac`。

## 代码签名：未做（如实声明）

三个平台目前**全部未签名**，也没有配置任何证书：

- Windows：未签名安装包会触发 SmartScreen 警告；商业分发前需购买
  代码签名证书（OV/EV）并配置 `win.certificateFile` 等选项。
- macOS：未签名/未公证的 DMG 会被 Gatekeeper 拦截；商业分发前需
  Apple Developer ID 证书 + notarization。
- Linux：AppImage 无签名要求，可直接分发。

## 已知粗糙点（不影响运行，商业打磨项）

- 暂无应用图标，打包用的是 Electron 默认图标；补 `build/` 图标后
  在配置里指定 `linux/win/mac.icon`。
- 未设 `desktopName`：Linux 桌面环境下窗口与启动器图标的关联可能不准。
- 根 package.json 未填 `author`，builder 每次会提示。

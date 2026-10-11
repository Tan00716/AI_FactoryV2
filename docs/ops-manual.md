# 运维手册（Ops Manual）大纲

> 对应 SPEC_V2 §55.10：安装包、升级/备份/恢复、Secrets、审计、操作手册完整。
> 本手册为骨架大纲；标注 `TODO(roadmap)` 的是尚未实现、正式发布前必须补的。

## 1. 启动

- 前置：Node ≥ 22（`engines` 已声明；使用 Node 内置 `node:sqlite`，无需编译工具）。
- `git clone https://github.com/Tan00716/AI_FactoryV2.git && cd AI_FactoryV2`
- `npm install`
- `npm run dev`：构建全部包，启动 API（`:3100`）+ Vite UI（`:5173`），打开 http://localhost:5173。
- 首次启动自动 seed 演示项目与 SQLite 库（`./data/factory.db`）。
- 桌面版：`npm i -D electron` 后 `npm run electron`。
- TODO(roadmap)：提供 `.exe` 安装包后，改为"双击安装 → 首次启动向导"。

## 2. 备份

- 备份目标：`./data/factory.db`（SQLite 单文件，任务/证据/审批/审计全在里面）。
- 建议：停服后复制 db 文件；或用 SQLite `.backup` 在线备份。
- TODO(roadmap)：自动定时备份、备份保留策略、备份完整性校验（hash）。

## 3. 恢复

- 用备份的 db 文件替换 `./data/factory.db` 后重启。
- 证据链含 hash chain：恢复后核对审计链连续性，断裂即告警。
- TODO(roadmap)：一键恢复命令、灾难恢复演练手册。

## 4. 升级

- 源码部署：`git pull && npm install && npm run build`，重启服务。
- 注意 v1→v2 的 DB migration（见 SPEC §52）：升级前先备份。
- TODO(roadmap)：安装包的自动更新通道、版本兼容矩阵。

## 5. Secrets 管理

- 凭据只存引用（`secret://`），不落明文；日志统一脱敏（见 security 包 `redactSecrets`）。
- TODO(roadmap)：对接系统钥匙串 / 外部 secret manager。

## 6. 审计

- 审计事件经 API 写入 `audit_logs`；高影响操作（授权、部署、审批、接管）必留记录。
- TODO(roadmap)：审计日志外部锚定（不可篡改存储）、审计查看 UI。

## 7. 故障处理

| 现象 | 处理 |
|---|---|
| API 起不来 | 检查 `:3100` 端口占用、`./data` 目录写权限、Node 版本 |
| 页面空白 | 确认 `npm run build` 成功、Vite `:5173` 正常 |
| 任务卡住 | 查 watchdog 状态、run 状态机（12 状态），必要时 Human Takeover |
| 证据校验失败 | 不要手动改库；走 invalidation append 流程（§39.4） |

- TODO(roadmap)：健康检查端点、告警通知、故障注入演练。

## 8. 已知限制

见 [KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md)。

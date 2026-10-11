# 已知限制（Known Limitations）

> 对应 SPEC_V2 §55.10：未实现能力明确标记，版本发布说明不把最终产品目标当当前能力。
> 本文档基于 2026-10-11 v2 轮全面测试的真实审计情况编写，不夸大、不隐瞒。

## 运行环境

- **当前仅在 Linux 上验证过**。规格要求的目标环境是 Windows（ENV-L），本机是 Linux，未在 Windows 真机上跑过。
- **没有打过安装包**。electron-builder 配置存在，但从未执行过，没有 `.exe` / `.dmg` 可分发安装包，只能从源码 `npm run dev` / `npm run electron` 启动。
- **Electron 桌面壳从未在真机上点开过**。测试环境无显示器，只验证了 Vite 构建成功，界面交互未做真机冒烟。

## AI 能力

- **模型适配器是 stub**。未接入任何真实 LLM（Anthropic / OpenAI 等），"AI 员工"不会真的干活，所有 AI 行为都是占位。
- **MCP Registry 有实现，但未接入真实 MCP 服务**。Unknown MCP 默认 BLOCK 的逻辑在，但没有连过真实服务器做握手验证。

## 隔离与安全

- **无真实隔离 Host**。在 Linux 本机直跑，非合规隔离后端；`CONFINEMENT_UNAVAILABLE` 的 fail-closed 路径有单测，但真实 Host 隔离未验证。
- Windows 工具探测（PowerShell / .NET 等）未在 Windows 上验证。

## 数据与团队

- **单机 SQLite**，无团队 PostgreSQL、无远程 Host、无 50+ 并发 Run 验证。
- 无测试生产环境：canary 发布、灰度、故障注入、24h 稳态均未跑过。
- **无真人 UAT / Outcome 验收**：AT-001–AT-064 没有一条达到端到端验收。

## 测试资产

- 计划宣称的 275 条正式用例集（`docs/testing/v2/`）不存在，记为 NOT_RUN，不是"通过"。
- 发现的 DEF-002 / DEF-003（API 空 body 校验）已在 `47856d7` 修复并推送；DEF-001 已关闭。

## 结论

当前是**可运行的原型**（构建 0 错误、1470/1470 单测、44/44 demo），不是可交付产品。上面每一条都是正式验收前必须补的。

# ADR-0002：v2 架构关键决策

## 标题

SPEC v2.0 采用 in-place 演进（而非重写）、whitelist 防御、SQLite 单机存储。

## 状态

已接受（2026-10-10，v2 开发完成时确立）

## 背景

- v1 已有 30 个包、993 个测试通过，全部推倒重写成本高、风险大。
- SPEC_V2 本身提供了 §58 v1.0 逐章节迁移对照，说明规格作者预期演进而非重写。
- 目标用户首先是个人本地开发者（Windows 单机优先），团队模式是后续阶段。

## 决定

1. **In-place 演进**：在 v1 代码基础上按 §58 迁移映射逐包改造，新增 10 个包（requirements、progress、api-contracts、tools、leases、factory-control、incidents、quota、watchdog、takeover 等），40 个包全部构建通过、1470/1470 测试通过后提交。
2. **Whitelist 防御**：MCP / Skill / 工具走"默认拒绝"——Unknown MCP 默认 BLOCK（§34）、技能安装先过安全检查清单（§74）、隔离之外的完整 Shell 禁止（§33）。黑名单补不完，whitelist 才兜得住。
3. **SQLite 单机**：沿用 `node:sqlite`（Node 22+ 内置，无 native 依赖），单文件 `./data/factory.db`，本地优先、零运维。团队 PostgreSQL 留到团队模式阶段（见 KNOWN_LIMITATIONS）。

## 后果

- 好的后果：v2 一次提交完成（`55a9613`），无回归（1470 测试全过）；新包与旧包通过 workspace 依赖自然集成；用户本地 `npm run dev` 即可跑。
- 坏的后果 / 代价：历史包袱仍在（如 cicd 的 8 阶段是按旧理解写的，本轮才对齐 §40 的 12 阶段）；单机 SQLite 未来切 PostgreSQL 需要迁移层。
- 后续必须跟进：团队模式的数据层抽象、真实隔离 Host、真实模型接入（见 KNOWN_LIMITATIONS）。

## 相关

- SPEC 章节：§58（迁移对照）、§34（MCP 安全）、§74（Skill 安全）、§33（工具边界）、§48（DB）
- 相关 ADR：0001-template.md
- 提交：`55a9613`（v2 实现）、`47856d7`（DEF-002/DEF-003 修复）

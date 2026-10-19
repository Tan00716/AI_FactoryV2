# Release 回滚手册

> 目标读者：负责部署 AI Factory 的人。备份语义详见
> [../backup-restore-guide.md](../backup-restore-guide.md)；
> 英文版：[ROLLBACK.en.md](ROLLBACK.en.md)。

## 1. 版本钉选：先知道自己在用哪一版

三个地方互相印证，必须一致：

1. 桌面侧栏最下方的 `AI Factory vX.Y.Z`；
2. 安装包文件名（`AI Factory-0.2.0.AppImage`）；
3. 服务端 `GET /health` 返回的版本字段（如有；以安装包为准）。

升级前把这三样记下来（截图或记到变更记录里），回滚时才知道"回哪去"。

## 2. 回滚前：先备份，再动刀

**铁律：任何升级/回滚操作之前，先做一次完整备份。**

```bash
# server 运行时打备份（需要 operator token）
curl -s -X POST http://127.0.0.1:3100/api/backup \
  -H "Authorization: Bearer $FACTORY_API_TOKEN"
# → {"backupId": "20261018-…", ...}
```

备份是自包含目录：`factory.db` 的 `VACUUM INTO` 一致性快照 +
`manifest.json`（文件 sha256、逐表计数、应用版本）。备份目录由
`FACTORY_BACKUP_DIR` 配置（默认库文件旁 `backups/`）。
**备份无加密**——文件系统权限即其保护，拷贝到安全位置。

升级前也打一个，命名/记录好 backupId：这是你的"后悔药"。

## 3. 标准回滚步骤（Linux AppImage）

假设从 0.2.0 回滚到 0.1.0：

1. **停应用**：退出 AI Factory（确认进程已结束）。
2. **备份当前数据**（第 2 节命令；这次备份是"0.2.0 时代"的现场，
   万一回滚后想回去还有据可查）。
3. **换回旧安装包**：用存档的 `AI Factory-0.1.0.AppImage`
   替换当前版本（保留好各版本安装包，不要删）。
4. **恢复数据**（二选一）：
   - 数据没坏、只是想降版本：旧版一般能直接打开新版 DB
     （0.2.0 的数据变更是**加法**：新增表/字段，不改旧表语义），
     可直接启动；启动后抽查任务/审批/审计链。
   - 数据已损坏或不确定：`POST /api/restore` 指定升级前打的
     backupId（恢复是 staged 语义：校验 → 先自动给当前状态打
     pre-restore 备份 → 下次启动时应用），重启后验证。
5. **启动验证**：打开应用 → 侧栏版本显示 `v0.1.0` → 建一个测试任务
   走完创建→删除 → 查审计链 `verify` 通过。

## 审计链尾锚定（restore 后必读）

每次 `verify` 通过后，服务端会在数据目录保存一个"尾锚定"水位
（`audit-tail-anchor.json`，最高链记录数 + 链头 hash），用于检出
**尾记录被删除**这种哈希链本身看不见的篡改。

`POST /api/restore` 恢复旧备份会**合法地**让链变短——下一次
`verify` 会报 `TAIL_TRUNCATED`。这是正确的 fail-closed 行为
（从链的角度看，restore 就是一次尾截断），不是数据损坏。
恢复方法：确认 restore 是你自己做的之后，删除与 DB 文件同目录的
`audit-tail-anchor.json`（默认就是 `data/audit-tail-anchor.json`，或
`AI_FACTORY_AUDIT_TAIL_ANCHOR_FILE` 指定的文件），下一次 verify 会
重新初始化基线并报告 ok。

## 4. 数据兼容性说明（0.2.0 → 0.1.0）

| 0.2.0 新增 | 0.1.0 打开时的行为 |
|---|---|
| `permission_tiers` / `agent_tiers` 表 | 旧版不认识，直接忽略（权限配置丢失，降级后需重配） |
| sessions / plans / hooks / reviews / plugins 的 JSON 文件 | 旧版不读，文件保留在原地，升回去后仍在 |
| 附件目录 `data/attachments/` | 旧版不读，文件保留 |
| 审计链新增事件类型 | 旧版 verify 只校验哈希链，事件类型未知不影响校验 |

**结论**：降级是"功能降级"，不是"数据丢失"。但权限/计划等新功能
的配置在旧版下不可见——回滚前用备份留底。

## 5. 配置回滚

随版本引入的新环境变量（如 `FACTORY_RUNTIME_TOOLS=web_search`、
`BRAVE_SEARCH_API_KEY`），回滚后旧版不认识，会被忽略——无害，
但建议把变更记录里的 env  diff 也 revert，保持干净。

## 6. 回滚演练记录

2026-10-18 在隔离测试环境实演（独立 PORT/DB/密钥目录，真实构建产物
`apps/server/dist/index.js`），脚本 `/tmp/wg-rollback-drill.mjs`：

1. 起 server → 建项目/任务（201）→ `POST /api/backup`（201，backupId 记录）。
2. 模拟"升级损坏"：直连 SQLite 删掉该任务。
3. `POST /api/restore` 指定 backupId → 200 + `restartRequired: true`。
4. 重启 server → 恢复在启动时应用：任务回来（200），审计链
   `GET /api/audit/verify` → `{"ok":true,"verifiedCount":26}`。
5. pre-restore 自动备份生效（backups/ 下 2 个目录，坏状态有留底）。
6. **结论：9/9 PASS，DRILL PASS**——备份→恢复链路可用。

## 7. 签名与平台（Tan 侧待办，不在本次范围）

- Windows（nsis/portable）与 macOS（dmg）安装包需在对应平台打包，
  本机未做。
- 所有平台安装包**均未签名/公证**：分发前需要 Tan 侧准备证书并
  执行签名流程，之后重跑本手册第 5 步的"启动验证"。

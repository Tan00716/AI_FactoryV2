# 备份与恢复操作手册

面向运维的操作指南。实现细节见 `apps/server/src/routes/backup.ts` 头注释；
诚实边界总览见 `docs/KNOWN_LIMITATIONS.md` 的备份条目。

## 1. 备份范围

`POST /api/backup` 生成一个自包含目录 `<backupId>/`（`factory.db` 快照 + `manifest.json`）：

- **工厂数据库**：`DB_PATH` 指向的单个 SQLite 文件，`VACUUM INTO` 一致性快照；
  manifest 记录每个文件的 size + sha256、逐表计数、应用版本。
- **项目工作文件**（Batch 45 起）：每个**活跃**且**工作目录存在**的项目，其整棵树
  （含 `.ai/`）收进 `<backupId>/projects/<projectId>/`，manifest 逐文件记
  sha256（`projects/<pid>/<rel>` 条目）。
- **符号链接永不跟随**；默认排除 node_modules、dist、build、.git/.hg/.svn、
  coverage、__pycache__、.venv/venv、.next/.nuxt、*.log、*.tmp、.DS_Store
  （可再生或机器本地，无恢复价值；`FACTORY_BACKUP_EXCLUDE_DIRS/SUFFIXES` 可追加）。
- 大小上限：单文件默认 25MiB、单次备份默认 512MiB（`FACTORY_BACKUP_MAX_FILE_BYTES`
  / `FACTORY_BACKUP_MAX_TOTAL_BYTES` 可调）。超限的文件**记入 skipped**（原因码
  `symlink` / `excluded-dir` / `excluded-suffix` / `over-file-limit` /
  `over-total-limit` / `unreadable`）——**跳过永远记录在案，从不静默丢弃**。
- `FACTORY_BACKUP_PROJECT_FILES=0` 可整体关闭项目文件收集。
- **备份目录由 `FACTORY_BACKUP_DIR` 配置**（默认库文件旁 `backups/`）。
- 仍不备份：已归档项目、工作目录不存在的项目（记为跳过）。
- **备份无加密**：文件系统权限即其保护。

## 2. scope 语义（诚实）

manifest 的 `scope` 字段只有两种取值：

- `'factory-database'`：只有数据库快照（老备份、或关闭了项目文件收集、或没有
  任何项目实际被收录时）；
- `'factory-database+project-files'`：**实际收录了至少 1 个项目的工作文件**。

没有第三种。备份列表 `GET /api/backups` 同步返回 `scope` 与项目文件摘要。

## 3. 恢复：两条不对称的路径（设计使然，不是疏漏）

### 3.1 数据库恢复 —— `POST /api/restore`（排队，重启生效）

1. **校验先行**：manifest 可解析、每个文件 size + sha256 命中、快照能打开且
   `PRAGMA integrity_check` 通过。**任一失败 → 422，live 数据库毫发无损。**
2. **pre-restore 备份**：先自动备份**当前** live 数据库（`kind: 'pre-restore'`）
   ——误操作永远有回退路。
3. **排队**：校验过的快照拷贝为 `<db>.restore-pending`（+ JSON sidecar）。
   **运行中的进程没有任何变化**；响应明示 `restartRequired: true`。
4. **应用**：下一次启动时、在数据库打开**之前**，`applyPendingRestore()` 把
   live 文件（含 `-wal`/`-shm` sidecar——陈旧 WAL 重放到替换过的文件上会
   损坏恢复）改名为 `<db>.superseded-<ts>`，把排队文件移入位置，启动时写
   `RESTORE_APPLIED` 审计。旧库写 `RESTORE_STAGED`、新库写 `RESTORE_APPLIED`，
   完整审计链不断。

**为什么必须重启**：进程持有一整套建在同一个 DB 连接上的 store/manager，
在它们脚下热换文件不安全。所以数据库恢复诚实地排队，绝不假装热恢复。

### 3.2 项目文件恢复 —— `POST /api/restore/project-files`（立即生效）

与数据库路径**不对称**：项目树没有被进程长期持有，所以恢复**立即生效**，
不等重启。但安全顺序不变：

1. **全量校验先行**：每个项目文件的 size + sha256 全部通过才继续。
   **任一失败 → 422，现树不动，不会部分写入。**
2. **pre-restore 拷贝**：先把**当前**项目文件复制到备份目录下的
   `preRestoreDir`——恢复本身可再回滚（响应返回 `preRestoreDir`）。
3. 逐文件恢复，**恢复后重算哈希**，不匹配则抛错中止。
4. 写 `PROJECT_FILES_RESTORED` 审计。

如果备份的 `scope` 不是 `'factory-database+project-files'`（即该备份没有
项目文件）→ 422。

### 3.3 篡改拒收

`validateBackupFiles` 对 DB 快照和项目文件条目**同等校验**（size + sha256），
拒绝 `..` 路径穿透。备份目录里任何文件被篡改 → 422，live 树和 live 库都
不被触碰。

## 4. F22 项目根策略（Batch 47）

备份 collector 和 restore 写入都不信任 project 记录的 `path` 字段的裸值：

- **建记录门控**：`POST /api/projects` 的非空 `path` 必须为绝对路径、存在、
  是目录、且收敛于运维配置的项目根（`FACTORY_PROJECTS_ROOT`，默认库文件旁
  `projects/`）；不过 → 400（`PROJECT_PATH_NOT_ABSOLUTE` /
  `PROJECT_PATH_NOT_FOUND` / `PROJECT_PATH_NOT_DIRECTORY` /
  `PROJECT_PATH_OUTSIDE_ROOT`）。收敛性检查在存在性之前，避免成为存在性预言。
  空 path 仍合法（无本地工作目录）。
- **纵深防御**：即使某条记录绕过门控（早于门控、或直写入库），`createBackup`
  对越界路径的记录跳过并记入 `manifest.skippedProjects`
  （`reason: 'path-outside-root'`），`POST /api/restore/project-files`
  对越界的现目录同样拒绝写入——带不走也写不进无关目录。

## 5. 桌面端的两个恢复入口（BackupPanel）

| 入口 | 行为 | 确认区讲清 |
|---|---|---|
| 「恢复数据库…」 | `POST /api/restore`：校验 + pre-restore 备份 + **排队**，重启生效 | 不会立即生效（`restartRequired`）；只恢复数据库，项目文件不受影响；现库改名保留为 `.superseded` 文件 |
| 「恢复项目文件…」 | `POST /api/restore/project-files`：校验 + pre-restore 拷贝 + **立即生效** | 不排队不等重启（与数据库恢复不对称）；回滚点 `preRestoreDir`；422 时现树不动 |

备份表新增「范围」列（`仅数据库` / `数据库+项目文件` + 文件数），
`BackupSummary` 的 `scope` / `projectFiles` 字段与服务端逐字对应。

## 6. 权限与审计

- backup / restore / 备份清单 / retention 均为 **admin** 角色面
  （`FACTORY_API_TOKENS` 的 `role:token`；不设时单 `FACTORY_API_TOKEN` 即 admin）。
- 审计事件：`BACKUP_CREATED`（载荷含 scope + 项目文件摘要）、
  `PROJECT_FILES_RESTORED`、`RESTORE_STAGED`、`RESTORE_APPLIED`、
  备份计划的 `MISSED`、retention 的 `RETENTION_ENFORCED`。
- 备份计划（Batch 20）：`/api/backup/schedules`（interval/cron）落库 +
  进程内调度器；宕机错过的执行记 MISSED、不补跑。
- retention：`backups` 类别新增 `keepCount` 轴（保留最新 N 个，与天数轴取并集）；
  过期备份只在显式 `POST /api/retention/enforce`（确认字段 + hold 重评估）
  时整目录删除；已 staged 待恢复的备份无条件豁免。

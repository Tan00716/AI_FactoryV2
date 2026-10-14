# Batch 47 独立复核报告（REAUDIT_BATCH47）

> 复核基线：`8004764`（Batch 47，已推送，`git ls-remote` 远端一致）。
> 复核方式：隔离 worktree（detached HEAD `8004764`，`node_modules` 软链主树），亲读代码 + 亲跑测试，主树零干扰。worktree 已删。

## 结论

**Batch 47 的实质声明全部成立，未发现夸大或造假。偏差 0 处。**

## (a) F22 修复：成立

- 亲读 `apps/server/src/routes/backup.ts`：`resolveProjectsRoot`（`FACTORY_PROJECTS_ROOT` 非空即用，否则 `<db 目录>/projects`；注释诚实说明 root 不要求存在——缺失的 root 下词法收敛自然失败，是安全方向）；`validateProjectPath` 顺序确为 **绝对路径 → 词法收敛 → 存在性 → 是目录 → realpath 符号链接检查**，收敛检查在存在性之前（注释明示"no existence oracle for paths outside the root"）。
- 双检查确为词法（`lexicallyInside`）+ realpath（`derefPath`，root 本身也 deref）。`isPathInsideProjectsRoot`（collector/restore 纵深防御用）同样双检查，一致。
- 亲读 `apps/server/src/index.ts` 的 `POST /api/projects` 门控：非空 path 不过校验 → `400 + {error, code}`（四码 `PROJECT_PATH_NOT_ABSOLUTE/_NOT_FOUND/_NOT_DIRECTORY/_OUTSIDE_ROOT`），记录不写入。空 path 仍合法。
- 纵深防御在位：`createBackup` 对越界行跳过并记 `manifest.skippedProjects`（`reason: 'path-outside-root'`）；`restoreProjectFilesFromBackup` 对越界的 live 现目录拒绝写入（同 reason）。
- dual-mode 取舍亲读成立：canonical 策略在 `backup.ts` 内（注释写明原因），测试用 `.ts` 后缀直引 src；`backup.ts` 的 value import 全为 node builtins（crypto/fs/path/sqlite），无 extensionless 相邻值 import，type-stripping 可解析。
- 亲跑：`project-path-validation.test.ts` **6/6**，0 fail；`git-merge-queue-drain-switch.test.ts` **2/2**，0 fail（合计 8/8）。
- 脏数据走查结论（worker 上报，现库只有 1 条种子 demo 记录 `MyApp`/`C:\AIProjects\MyApp`，无被 plant 的脏数据）是针对开发者本地开发库的一次性动作，非仓库状态，本复核未独立重验——不计为产品声明偏差。

## (b) M1 单写者开关：成立

- 亲读 `apps/server/src/routes/git.ts` diff：`FACTORY_MERGE_DRAIN === '0'` 时在 `enqueue()` 后、`processAll()` 前返回 `202 + {ok, entry, drainPending: true}`，审计 `MERGE_QUEUE_ENQUEUED`（`entryId/prId/taskId/drainPending/reason`）；env 在请求时读取，无需重启。默认（非 `'0'`）路径逐行未动，直接 fall-through 到原 `processAll`。
- `docs/merge-queue-multimachine.md` 的 M1 小节亲验为"已落地"口径 + 部署建议；KNOWN_LIMITATIONS merge queue 条目（line 34 起）已含 M1 说明；"只解决 drain 互斥不解决状态共享"的诚实限定在文档与 commit message 中均在位。
- 亲跑：drain-switch **2/2**；老 merge-queue 测试在全套 432/432 中全绿（无回归）。

## (c) 可售清单复验报告（`gap-audit/SELLABLE_REVERIFY_BATCH46.md`）：成立

- "翻绿 5 项"逐项亲读证据：F19（`runtime.ts` 单文件 10 处 narrative，`authority.ts`/`cicd.ts` 诚实限定语 verbatim 在位）；备份扩展（KNOWN_LIMITATIONS 的"Backup 只覆盖 SQLite DB"旧条目已关闭——grep 无残留；line 64 为项目文件新口径）；F21（`index.ts:1603–1605` 正式契约注释 + `audit-list-contract.test.ts` 在位）；走查 v7（测试文件 + `package.json` 的 `demo:e2e-v7` 在位）；多机界定（`docs/merge-queue-multimachine.md` 在位）。
- REAUDIT_BATCH44/45 在位；"仍是可运行的原型 + 持续收敛"的总结论与 Batch 46 收口口径一致，无美化。
- 该报告是 Batch 46 的增量复验，把 F22 列为新增缺口——Batch 47 本批已修，链条诚实。

## 真实验证数字（隔离 worktree @8004764，亲跑）

- 构建：**0 TS 错误**（`npm run build` exit 0）
- 服务端全套：**432/432**，0 fail（= 424 基线 + 6 F22 + 2 M1）
- 新测试：project-path-validation 6/6 + drain-switch 2/2，0 fail

## 偏差：0 处

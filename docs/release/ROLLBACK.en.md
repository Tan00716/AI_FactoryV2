# Release Rollback Handbook

> Audience: whoever deploys AI Factory. Backup semantics:
> [../backup-restore-guide.md](../backup-restore-guide.md);
> 中文版：[ROLLBACK.md](ROLLBACK.md).

## 1. Pin the version: know what you're running

Three places must agree:

1. `AI Factory vX.Y.Z` at the bottom of the desktop sidebar;
2. the installer filename (`AI Factory-0.2.0.AppImage`);
3. the version field of the server's `GET /health` (if present; the
   installer filename is authoritative).

Write these down (screenshot or change log) before upgrading — that's
how you know where "back" is.

## 2. Before rollback: back up first, then touch anything

**Iron rule: take a full backup before any upgrade/rollback.**

```bash
# Back up while the server is running (operator token required)
curl -s -X POST http://127.0.0.1:3100/api/backup \
  -H "Authorization: Bearer $FACTORY_API_TOKEN"
# → {"backupId": "20261018-…", ...}
```

A backup is a self-contained directory: a `VACUUM INTO` consistent
snapshot of `factory.db` + `manifest.json` (file sha256, per-table
counts, app version). The backup directory is configured by
`FACTORY_BACKUP_DIR` (default `backups/` next to the DB file).
**Backups are not encrypted** — filesystem permissions are their
protection; copy them somewhere safe.

Also back up before upgrading and record the backupId: that's your
undo button.

## 3. Standard rollback (Linux AppImage)

Rolling back from 0.2.0 to 0.1.0 as an example:

1. **Stop the app**: quit AI Factory (confirm the process is gone).
2. **Back up current data** (command in §2; this backup is the
   "0.2.0-era" scene, so you can go back again if needed).
3. **Swap the installer**: replace the current one with the archived
   `AI Factory-0.1.0.AppImage` (keep every version's installer —
   don't delete them).
4. **Restore data** (either):
   - Data is fine, you just want the older version: the old version
     can usually open the new DB directly (0.2.0's data changes are
     **additive**: new tables/columns, old table semantics untouched).
     Start it and spot-check tasks / approvals / audit chain.
   - Data is damaged or you're unsure: `POST /api/restore` with the
     pre-upgrade backupId (restore is staged: validate → auto
     pre-restore backup of the current state → applied at next boot),
     then restart and verify.
5. **Verify**: open the app → sidebar shows `v0.1.0` → create and
   delete a test task → audit chain `verify` passes.

## 4. Data compatibility (0.2.0 → 0.1.0)

| Added in 0.2.0 | How 0.1.0 treats it |
|---|---|
| `permission_tiers` / `agent_tiers` tables | Unknown to the old version, ignored (permission config lost — reconfigure after downgrade) |
| sessions / plans / hooks / reviews / plugins JSON files | Not read by the old version; files stay in place and are still there if you upgrade again |
| attachment dir `data/attachments/` | Not read; files stay |
| new audit-chain event types | old `verify` only checks the hash chain; unknown event types don't break verification |

**Bottom line**: downgrade is a *feature* downgrade, not data loss. But
new-feature config (permissions, plans, …) is invisible under the old
version — keep a backup before rolling back.

## 5. Config rollback

New env vars introduced with a version (e.g.
`FACTORY_RUNTIME_TOOLS=web_search`, `BRAVE_SEARCH_API_KEY`) are simply
ignored by the old version — harmless, but revert the env diff in your
change log anyway to stay clean.

## 6. Rollback drill record

Drilled 2026-10-18 in an isolated test environment (separate
PORT/DB/secrets dir, real built artifact `apps/server/dist/index.js`),
script `/tmp/wg-rollback-drill.mjs`:

1. Started server → created project/task (201) → `POST /api/backup`
   (201, backupId recorded).
2. Simulated "upgrade damage": deleted the task directly in SQLite.
3. `POST /api/restore` with the backupId → 200 + `restartRequired: true`.
4. Restarted server → restore applied at boot: the task was back (200),
   audit chain `GET /api/audit/verify` → `{"ok":true,"verifiedCount":26}`.
5. Automatic pre-restore backup fired (2 dirs under backups/ — the
   damaged state was preserved).
6. **Conclusion: 9/9 PASS, DRILL PASS** — the backup→restore chain works.

## 7. Signing & platforms (Tan-side TODO, out of scope here)

- Windows (nsis/portable) and macOS (dmg) installers must be built on
  those platforms; not done on this machine.
- No installer is **signed/notarized** on any platform: before
  distribution, Tan's side needs certificates and a signing run, then
  re-run the "verify on start" step of §5.

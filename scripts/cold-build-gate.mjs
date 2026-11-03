// Cold-build gate (V3.0 audit round 6, item #4; landing point fixed here:
// LOCAL gate script, not CI wiring -- see docs/verification/cold-build-gate.md).
//
// What "cold" means: a checkout with NO dist/ (dist/ is gitignored, so a
// fresh clone or a deleted dist/ is cold). node_modules is NOT part of
// coldness: npm install (or a copy of an existing node_modules tree)
// produces workspace symlinks that resolve inside the checkout, and the
// build only fails cold when a dependency's dist/ has not been built yet.
// That is exactly what this gate protects: the build order must be
// dependency-safe, so a cold tree builds on the first run.
//
// Modes:
//   node scripts/cold-build-gate.mjs
//     Static order check only (fast, deterministic, CI-safe): recompute
//     the topological order from declared dependencies and fail if any
//     edge is inverted, any member lacks a build script, any member is
//     missing from the order, or a dependency cycle exists.
//     Exit 0 PASS, 2 FAIL (order violation).
//   node scripts/cold-build-gate.mjs --cold [--ref <git ref>] [--keep]
//     Full isolated-worktree cold build: create a worktree at <ref>
//     (default HEAD) under $HOME/wt-gate-<timestamp>, copy node_modules
//     from the current checkout (cp -a; ownership warnings are tolerated
//     -- the copy is accepted only if .bin/tsc exists and the
//     @ai-factory/runhistory symlink resolves inside the worktree),
//     verify zero dist/ dirs, run `npm run build` there, then remove the
//     worktree (unless --keep). Exit 0 PASS, 1 build failed, 2 setup failed.
//     NEVER run this against the shared main tree: it only ever builds
//     inside its own worktree, and it never runs git checkout/stash.
//
// Failure judgement: any nonzero exit is a gate failure. A static FAIL
// means the build order rotted again (a manual list came back, an edge
// was deleted, a member lost its build script). A --cold build failure
// names the failing member (FAILED: <name>); if that member is the
// server and the error is a missing @ai-factory/runhistory module, the
// runhistory guarantee (path (a) declaration) has regressed.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyOrder, findUndeclaredImports } from './topo-build.mjs';

function sh(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf8' });
}

function staticCheck(root) {
  let checked;
  try {
    checked = verifyOrder(root);
  } catch (e) {
    console.log('[cold-build-gate] FAIL: ' + e.message);
    return 2;
  }
  if (checked.problems.length > 0) {
    for (const p of checked.problems) console.log('[cold-build-gate] FAIL: ' + p);
    return 2;
  }
  const undeclared = findUndeclaredImports(root);
  if (undeclared.length > 0) {
    for (const u of undeclared) console.log('[cold-build-gate] FAIL: undeclared import: ' + u);
    return 2;
  }
  console.log(`[cold-build-gate] PASS: order verified, ${checked.order.length} members, ` +
    `${[...checked.edges.values()].reduce((n, d) => n + d.length, 0)} edges, ` +
    'audit pairs (employee-factory<qa, security<runtime, codesearch<perfbench, runhistory<server) ok, ' +
    'undeclared imports: 0');
  return 0;
}

function coldBuild(root, ref, keep) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 14);
  const wt = join(process.env.HOME || tmpdir(), 'wt-gate-' + stamp);
  // NOTE: $HOME, never /tmp: /tmp is a small tmpfs and a 90-member build
  // tree plus a node_modules copy does not belong there.
  console.log('[cold-build-gate] worktree: ' + wt + ' @ ' + ref);
  let r = sh('git', ['worktree', 'add', wt, ref], root);
  if (r.status !== 0) {
    console.log('[cold-build-gate] FAIL: worktree add failed');
    console.log((r.stdout || '') + (r.stderr || ''));
    return 2;
  }
  try {
    // Copy node_modules (workspace symlinks are relative, so they resolve
    // inside the worktree). Ownership warnings under cp -a are expected
    // when the source tree is root-owned; accept the copy only on the
    // verification below, never on cp's exit code.
    sh('cp', ['-a', join(root, 'node_modules'), join(wt, 'node_modules')], root);
    const tsc = join(wt, 'node_modules', '.bin', 'tsc');
    let linkOk = false;
    try {
      const target = resolve(join(wt, 'node_modules', '@ai-factory'), readlinkSync(join(wt, 'node_modules', '@ai-factory', 'runhistory')));
      linkOk = target.startsWith(wt + '/');
    } catch { linkOk = false; }
    if (!existsSync(tsc) || !linkOk) {
      console.log('[cold-build-gate] FAIL: node_modules copy did not verify (tsc or workspace symlink)');
      return 2;
    }
    const distDirs = [];
    const scan = (dir) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (d.name === 'node_modules' || d.name === '.git') continue;
        if (d.isDirectory()) {
          if (d.name === 'dist') distDirs.push(join(dir, d.name));
          else scan(join(dir, d.name));
        }
      }
    };
    scan(join(wt, 'packages'));
    scan(join(wt, 'apps'));
    if (distDirs.length > 0) {
      console.log('[cold-build-gate] FAIL: worktree is not cold, dist/ present: ' + distDirs.slice(0, 5).join(', '));
      return 2;
    }
    console.log('[cold-build-gate] worktree verified cold (0 dist/ dirs), running npm run build ...');
    r = sh('npm', ['run', 'build'], wt);
    if (r.status !== 0) {
      console.log('[cold-build-gate] FAIL: cold build failed');
      console.log((r.stdout || '').slice(-3000));
      console.log((r.stderr || '').slice(-3000));
      return 1;
    }
    const ok = (r.stdout || '').match(/TOPO BUILD ALL OK \((\d+) members/);
    console.log('[cold-build-gate] PASS: cold build all ok' + (ok ? ' (' + ok[1] + ' members)' : ''));
    return 0;
  } finally {
    if (keep) {
      console.log('[cold-build-gate] --keep: worktree left at ' + wt);
    } else {
      sh('git', ['worktree', 'remove', '--force', wt], root);
      if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const root = resolve(process.cwd());
  if (!args.includes('--cold')) {
    process.exit(staticCheck(root));
  }
  const refIdx = args.indexOf('--ref');
  const ref = refIdx >= 0 && args[refIdx + 1] ? args[refIdx + 1] : 'HEAD';
  process.exit(coldBuild(root, ref, args.includes('--keep')));
}

main();

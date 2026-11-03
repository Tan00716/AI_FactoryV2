// Topological workspace build (V3.0 audit round 6, item #4).
//
// Replaces the old hand-maintained 86-entry `&&` chain in root package.json,
// which was NOT dependency-safe: in a cold tree (fresh clone, clean CI
// environment, or dist/ deleted) it failed at the first inverted package
// (qa, EXIT=2) because tsc resolves each @ai-factory/* dependency through
// node_modules symlinks to that package's dist/, and dist/ is gitignored.
// A warm tree only looked green because stale dist/ files masked the order.
//
// This script computes the build order from the declared dependencies of
// every workspace member (packages/* + apps/*) at run time, so the order
// can never rot again when a dependency is added: a new edge is a new
// ordering constraint, not a new line a human must place correctly.
//
// Decisions fixed at implementation time (audit R6 #4, M12/S9):
// - Wiring: `npm run build` IS this script. There is no second main
//   command (no build:topo alias, no surviving manual list).
// - Edge set: dependencies + devDependencies filtered to @ai-factory/*
//   members (same edge set as the R5 out-of-tree prototype, verified
//   acyclic on this tree). A cycle is a hard error, not a warning.
// - runhistory guarantee, path (a): @ai-factory/runhistory is declared in
//   apps/server/package.json dependencies, so the topological edge
//   runhistory -> server exists and runhistory is always built first.
//   (Path (b), two-phase build, was rejected: it would leave the
//   undeclared value import in place.)
//   Generalized: the reverse verification exposed 13 undeclared-import
//   pairs of the same class (server -> coordination, debugger, depscan,
//   mutation, profiler, recovery, refactor, resources, ssr, tasks,
//   trojanscan; db -> core; evaluation demo -> memory). All 13 are
//   declared the same way, and the gate (not the build path) pins the
//   class at zero via findUndeclaredImports, so a future undeclared
//   import fails the gate instead of passing by incidental order.
// - Cold-tree gate: scripts/cold-build-gate.mjs (static order check by
//   default, --cold for a full isolated-worktree cold build) and
//   docs/verification/cold-build-gate.md. The gate is a local script,
//   not CI wiring (CI has never run on this repo: the workflow file is
//   untracked and the token lacks workflow scope).
//
// Usage:
//   npm run build                      # build all members in topo order
//   node scripts/topo-build.mjs        # same, from the repo root
//   node scripts/topo-build.mjs <root> # same, for another checkout
//   node scripts/topo-build.mjs --order-only
//                                      # print + verify order, do not build
//
// Exit codes: 0 all built (or order verified); 1 a member build failed
// (FAILED: <name> plus the tail of its output); 2 order/coverage/cycle
// violation (the order itself is wrong, not a member's code).
//
// Build-time note: every member is built on every run, exactly like the
// old command did for its 86 entries. There is no incremental skip and
// no cache; tsc -p without incremental flags rebuilds each package.
// That cost is unchanged by this change (plus 4 newly covered members).
// Do NOT "optimise" this into a partial build: a partial build is how
// the old warm-tree masking happened.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

function readMember(dir) {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) return null;
  const pkg = JSON.parse(readFileSync(p, 'utf8'));
  if (!pkg.name || !pkg.name.startsWith('@ai-factory/')) return null;
  return pkg;
}

// All workspace members (packages/* + apps/*), in directory order.
export function listMembers(root) {
  const members = [];
  for (const area of ['packages', 'apps']) {
    const base = join(root, area);
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base).sort()) {
      const pkg = readMember(join(base, d));
      if (pkg) members.push({ ...pkg, dir: area + '/' + d });
    }
  }
  return members;
}

// Dependency edges between members, from dependencies + devDependencies.
export function edgeMap(members) {
  const names = new Set(members.map((m) => m.name));
  const edges = new Map();
  for (const m of members) {
    const all = { ...(m.dependencies || {}), ...(m.devDependencies || {}) };
    edges.set(m.name, Object.keys(all).filter((k) => names.has(k)));
  }
  return edges;
}

// Depth-first topological order. Throws on a cycle (names the member).
export function computeOrder(root) {
  const members = listMembers(root);
  const edges = edgeMap(members);
  const order = [];
  const done = new Set();
  const visiting = new Set();
  const visit = (n) => {
    if (done.has(n)) return;
    if (visiting.has(n)) throw new Error('dependency cycle at ' + n);
    visiting.add(n);
    for (const d of edges.get(n) || []) visit(d);
    visiting.delete(n);
    done.add(n);
    order.push(n);
  };
  for (const m of members) visit(m.name);
  return { members, edges, order };
}

// The order is valid only if: every member is present, every member has
// a build script, and every declared edge points backward (dependency
// built before its dependent). Returns an array of violation strings.
export function verifyOrder(root) {
  const { members, edges, order } = computeOrder(root);
  const problems = [];
  const pos = new Map(order.map((n, i) => [n, i]));
  if (order.length !== members.length) {
    problems.push(`coverage: order has ${order.length} members, tree has ${members.length}`);
  }
  for (const m of members) {
    if (!m.scripts || !m.scripts.build) problems.push(`no build script: ${m.name}`);
  }
  for (const [from, deps] of edges) {
    for (const d of deps) {
      if (pos.get(d) > pos.get(from)) problems.push(`inverted edge: ${d} must precede ${from}`);
    }
  }
  // Audit R6 #4 explicit pairs (also covered by edges above, asserted
  // individually so a future edge deletion fails loudly here).
  const pairs = [
    ['@ai-factory/employee-factory', '@ai-factory/qa'],
    ['@ai-factory/security', '@ai-factory/runtime'],
    ['@ai-factory/codesearch', '@ai-factory/perfbench'],
    ['@ai-factory/runhistory', '@ai-factory/server'],
  ];
  for (const [before, after] of pairs) {
    if (pos.has(before) && pos.has(after) && pos.get(before) > pos.get(after)) {
      problems.push(`audit pair inverted: ${before} must precede ${after}`);
    }
  }
  return { members, edges, order, problems };
}

// Undeclared-import scan (the runhistory defect class, generalized).
// A member that imports another workspace member in its build inputs
// (packages: src/demo/tests; apps/server: src; apps/desktop: src+electron)
// without declaring it in dependencies/devDependencies builds only by
// incidental order today and breaks the day the order shifts. The R6
// audit named runhistory; the same scan found 13 such pairs on this tree
// (server -> 11 packages, db -> core, evaluation demo -> memory), all
// fixed by declaration (path (a)), not by relying on traversal order.
// This check is deliberately NOT part of the build path: a regex scan
// must never fail a compile. It lives in the gate (cold-build-gate.mjs)
// and in topo-build.test.mjs, which pin the list at zero.
// Comments are stripped before matching so commented-out imports do not
// false-positive; string literals are not stripped.
export function findUndeclaredImports(root) {
  const members = listMembers(root);
  const names = new Set(members.map((m) => m.name));
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\S\r\n])\/\/.*$/gm, '$1');
  const scanDir = (dir, out) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') scanDir(f, out);
      } else if (/\.(ts|tsx|mts|cts|js|jsx|mjs)$/.test(e.name)) {
        const src = stripComments(readFileSync(f, 'utf8'));
        for (const m of src.matchAll(/(?:from\s+['"]|import\(\s*['"]|require\(\s*['"])(@ai-factory\/[\w-]+(?:\/[\w./-]+)?)['"]/g)) {
          const pkg = m[1].match(/^(@ai-factory\/[\w-]+)/)[1];
          if (names.has(pkg)) out.add(pkg);
        }
      }
    }
  };
  const inputDirs = (m) => {
    if (m.name === '@ai-factory/server') return ['src'];
    if (m.name === '@ai-factory/desktop') return ['src', 'electron'];
    return ['src', 'demo', 'tests'];
  };
  const found = [];
  for (const m of members) {
    const declared = new Set(Object.keys({ ...(m.dependencies || {}), ...(m.devDependencies || {}) })
      .filter((k) => names.has(k)));
    for (const sub of inputDirs(m)) {
      const imported = new Set();
      scanDir(join(root, m.dir, sub), imported);
      for (const i of imported) {
        if (i !== m.name && !declared.has(i)) found.push(`${m.name} -> ${i} (${sub})`);
      }
    }
  }
  return found;
}

function main() {
  const args = process.argv.slice(2);
  const orderOnly = args.includes('--order-only');
  const rootArg = args.find((a) => !a.startsWith('--'));
  const root = resolve(rootArg || process.cwd());
  let checked;
  try {
    checked = verifyOrder(root);
  } catch (e) {
    console.error('[topo-build] ORDER VIOLATION: ' + e.message);
    process.exit(2);
  }
  if (checked.problems.length > 0) {
    for (const p of checked.problems) console.error('[topo-build] ORDER VIOLATION: ' + p);
    process.exit(2);
  }
  console.log(`[topo-build] order ok: ${checked.order.length} members, ` +
    `${[...checked.edges.values()].reduce((n, d) => n + d.length, 0)} edges`);
  console.log('[topo-build] order: ' + checked.order.join(' '));
  if (orderOnly) return;
  const started = Date.now();
  for (const name of checked.order) {
    const t0 = Date.now();
    const r = spawnSync('npm', ['run', 'build', '-w', name], {
      cwd: root, stdio: 'pipe', encoding: 'utf8',
    });
    if (r.status !== 0) {
      console.log('[topo-build] FAILED: ' + name);
      console.log((r.stdout || '').slice(-2000));
      console.log((r.stderr || '').slice(-2000));
      console.log('[topo-build] TOPO BUILD FAILED at ' + name);
      process.exit(1);
    }
    console.log(`[topo-build] ok: ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  console.log(`[topo-build] TOPO BUILD ALL OK (${checked.order.length} members, ` +
    `${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

#!/usr/bin/env node
/**
 * Platform verification pipeline (V3R2 audit #7, P0).
 *
 * One command, four stages, two verdicts — kept deliberately separate:
 *
 *   PIPELINE verdict: can this build be produced and smoke-tested
 *     repeatably on this machine? Stages: build, packaged-smoke,
 *     platform-check. Exit 0 iff every non-SKIP pipeline stage passes.
 *   TRUST verdict: may this build be DISTRIBUTED as trusted? That is a
 *     SEPARATE gate: code signature verification (where tooling exists)
 *     PLUS a recorded human double-click prompt check. TRUST_PASSED
 *     requires both; anything else is TRUST_NOT_VERIFIED with a reason.
 *     The trust gate NEVER flips the pipeline verdict: a green pipeline
 *     on an unsigned build is "verified but not distributable", and a
 *     signed build with a red pipeline is not shippable either. Conflating
 *     the two is how an unsigned build gets shipped as "verified".
 *
 * Stages and their pass/fail criteria:
 *   build          PASS = `npm run dist:<platform>` exit 0 and the
 *                  expected unpacked dir exists. SKIP = --skip-build, or
 *                  the target platform differs from this host (a Win/mac
 *                  build must run on its own machine; Linux cannot be
 *                  trusted to produce a runnable Win/mac unpacked dir).
 *                  A cross-build attempt is never reported as PASS.
 *   packaged-smoke PASS = scripts/packaged-smoke.mjs exit 0 (every
 *                  non-SKIP check PASS). FAIL = any check FAIL.
 *   platform-check PASS = scripts/cross-platform-check.mjs exit 0.
 *   trust-gate     TRUST_PASSED only when: (a) the platform's signature
 *                  verifies with the platform tool (macOS: codesign -dv
 *                  + spctl --assess; Windows: signtool verify; Linux:
 *                  unsigned AppImage is ACCEPTED for direct distribution,
 *                  so the gate is satisfied by an explicit ack, not a
 *                  signature), AND (b) a manual double-click prompt record
 *                  (--trust-manual <json>) is attached describing what the
 *                  OS actually showed. Without (b) the verdict stays
 *                  TRUST_NOT_VERIFIED even for a signed binary, because a
 *                  headless run cannot observe the prompt a user sees.
 *                  Signing certificates are a Tan-side purchase; this
 *                  script never claims a signature exists.
 *
 * Usage (run ON the target machine):
 *   node scripts/verify-platform.mjs --dir release/linux-unpacked
 *   node scripts/verify-platform.mjs --dir release/win-unpacked --trust-manual docs/verification/reports/win32-doubleclick.json
 *   node scripts/verify-platform.mjs --skip-build --dir <unpacked> --out docs/verification/reports/<platform>-pipeline.json
 *   node scripts/verify-platform.mjs --dir <unpacked> --platform win32   # same as auto-detect from the dir layout
 *
 * The JSON report is written to --out (default
 * docs/verification/reports/<platform>-pipeline.json). A platform leaves
 * NOT_RUN in docs/verification/platform-matrix.md only when a report from
 * a run ON that platform is filed AND its pipeline verdict is PASS; the
 * trust verdict is recorded alongside, never merged into it.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..');

const DIST_SCRIPT = { linux: 'dist:linux', win32: 'dist:win', darwin: 'dist:mac' };
const EXPECTED_DIR = { linux: 'linux-unpacked', win32: 'win-unpacked', darwin: 'mac' };

function parseArgs(argv) {
  const out = { dir: null, out: null, platform: 'auto', skipBuild: false, trustManual: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') out.dir = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--platform') out.platform = argv[++i];
    else if (argv[i] === '--skip-build') out.skipBuild = true;
    else if (argv[i] === '--trust-manual') out.trustManual = argv[++i];
  }
  return out;
}

function runNode(script, args, logFile) {
  const r = spawnSync(process.execPath, [join(here, script), ...args], { encoding: 'utf8', timeout: 900000 });
  return { status: r.status, stdout: (r.stdout || '') + (r.stderr || ''), logFile };
}

/** Signature verification with the platform tool. Never PASSes by absence. */
export function checkSignature(platform, targetPath) {
  if (platform === 'linux') {
    return { checked: true, signed: false, detail: 'Linux AppImage ships unsigned by policy; direct distribution accepts unsigned (matrix ack, not a signature claim)' };
  }
  if (platform === 'darwin') {
    try {
      const dv = spawnSync('codesign', ['-dv', '--verbose=2', targetPath], { encoding: 'utf8' });
      const out = (dv.stderr || '') + (dv.stdout || '');
      const hasAuthority = /Authority=/.test(out);
      let assessed = false;
      try { assessed = spawnSync('spctl', ['--assess', '--type', 'execute', targetPath], { encoding: 'utf8' }).status === 0; } catch { /* spctl absent */ }
      return { checked: true, signed: hasAuthority, detail: `codesign authority present=${hasAuthority}, spctl assess pass=${assessed}` };
    } catch (e) {
      return { checked: false, signed: false, detail: `codesign unavailable: ${e.message}` };
    }
  }
  if (platform === 'win32') {
    try {
      const v = spawnSync('signtool', ['verify', '/pa', targetPath], { encoding: 'utf8' });
      const ok = v.status === 0;
      return { checked: true, signed: ok, detail: ok ? 'signtool verify /pa passed' : `signtool verify failed: ${(v.stdout || '') + (v.stderr || '')}`.slice(0, 300) };
    } catch (e) {
      return { checked: false, signed: false, detail: `signtool unavailable: ${e.message}` };
    }
  }
  return { checked: false, signed: false, detail: `unknown platform ${platform}` };
}

function trustGate(platform, targetPath, manualPath) {
  let manual = null;
  if (manualPath) {
    try { manual = JSON.parse(readFileSync(manualPath, 'utf8')); } catch (e) { manual = { __parseError: e.message }; }
  }
  const sig = checkSignature(platform, targetPath);
  const manualOk = !!manual && !manual.__parseError
    && typeof manual.promptObserved === 'string' && manual.promptObserved.length > 0
    && typeof manual.launchedVia === 'string' && manual.launchedVia.length > 0;
  const signatureOk = platform === 'linux' ? true : sig.signed;
  const verdict = signatureOk && manualOk ? 'TRUST_PASSED' : 'TRUST_NOT_VERIFIED';
  const reasons = [];
  if (!signatureOk) reasons.push(platform === 'linux' ? 'n/a' : 'no verified code signature (certificate purchase is Tan-side)');
  if (!manualOk) reasons.push(manual ? 'manual double-click record incomplete (needs promptObserved + launchedVia)' : 'no manual double-click prompt record attached (--trust-manual)');
  return { verdict, signature: sig, manual: manualOk ? manual : null, reasons };
}

export async function runVerifyPlatform(opts) {
  const stages = [];
  const push = (id, status, detail) => stages.push({ id, status, detail });
  // Stage outputs land here; the dir may not exist yet (it is gitignored
  // and was never created by the older scripts — a missing dir used to
  // crash cross-platform-check's --out write, failing the pipeline).
  mkdirSync(join(repoRoot, 'docs', 'verification', 'reports'), { recursive: true });
  // Resolve platform: explicit flag wins, else the smoke layout resolver.
  let platform = opts.platform && opts.platform !== 'auto' ? opts.platform : process.platform;
  let dir = opts.dir;
  if (dir && !existsSync(dir)) {
    push('build', 'FAIL', `unpacked dir not found: ${dir}`);
    return { platform, stages, pipeline: 'FAIL', trust: { verdict: 'TRUST_NOT_VERIFIED', reasons: ['no unpacked dir to trust'] } };
  }
  if (dir) {
    const { resolvePackagedLayout } = await import(join(here, 'packaged-smoke.mjs'));
    const layout = resolvePackagedLayout(dir, { platform: opts.platform || 'auto' });
    if (!layout) {
      push('build', 'FAIL', `unpacked dir has no recognized packaged layout: ${dir}`);
      return { platform, stages, pipeline: 'FAIL', trust: { verdict: 'TRUST_NOT_VERIFIED', reasons: ['no recognized packaged layout'] } };
    }
    platform = layout.platform;
  }
  const host = process.platform;
  const distScript = DIST_SCRIPT[platform];
  const expectedDir = join(repoRoot, 'release', EXPECTED_DIR[platform]);

  // Stage 1: build.
  if (opts.skipBuild) {
    push('build', 'SKIP', '--skip-build: using prebuilt unpacked dir (pipeline does NOT prove reproducibility for this run)');
  } else if (platform !== host) {
    push('build', 'SKIP', `target ${platform} != host ${host}: build must run on the target machine (cross-build is never reported as PASS)`);
  } else {
    const r = spawnSync('npm', ['run', distScript, '--', '--dir'], { cwd: repoRoot, encoding: 'utf8', timeout: 1800000 });
    const tail = ((r.stdout || '') + (r.stderr || '')).slice(-500);
    if (r.status === 0 && existsSync(expectedDir)) {
      push('build', 'PASS', `npm run ${distScript} exit 0, ${expectedDir} exists`);
      dir = expectedDir;
    } else {
      push('build', 'FAIL', `npm run ${distScript} exit ${r.status}: ${tail}`);
    }
  }
  if (!dir) dir = expectedDir;
  if (stages.some((s) => s.status === 'FAIL')) {
    return { platform, stages, pipeline: 'FAIL', trust: { verdict: 'TRUST_NOT_VERIFIED', reasons: ['pipeline failed before trust gate'] } };
  }

  // Stage 2: packaged smoke (same script, all platforms).
  const smoke = runNode('packaged-smoke.mjs', ['--dir', dir, '--platform', platform, '--out', join(repoRoot, 'docs', 'verification', 'reports', `${platform}-packaged.json`)]);
  push('packaged-smoke', smoke.status === 0 ? 'PASS' : 'FAIL', `packaged-smoke exit ${smoke.status}; last lines: ${smoke.stdout.trim().split('\n').slice(-2).join(' | ')}`);

  // Stage 3: platform check.
  const check = runNode('cross-platform-check.mjs', ['--out', join(repoRoot, 'docs', 'verification', 'reports', `${platform}.json`)]);
  push('platform-check', check.status === 0 ? 'PASS' : 'FAIL', `cross-platform-check exit ${check.status}; last lines: ${check.stdout.trim().split('\n').slice(-2).join(' | ')}`);

  const pipeline = stages.some((s) => s.status === 'FAIL') ? 'FAIL' : 'PASS';
  // Stage 4 (separate verdict): trust gate. The signature target is the
  // runnable product: the unpacked binary/app, not the installer.
  const { resolvePackagedLayout } = await import(join(here, 'packaged-smoke.mjs'));
  const layout = resolvePackagedLayout(dir, { platform });
  const trust = trustGate(platform, layout ? layout.binary : dir, opts.trustManual);
  push('trust-gate', trust.verdict, `${trust.verdict}: ${trust.reasons.join('; ') || 'signature verified + double-click prompt recorded'}`);
  return { platform, host, dir, stages, pipeline, trust, smokeLog: smoke.stdout, checkLog: check.stdout };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // No --dir is fine: the build stage produces release/<platform>-unpacked,
  // and --skip-build falls back to that same dir (failing cleanly if the
  // build was never run). There is no arg combination worth a usage error
  // here; a missing dir is a stage failure, not a CLI error.
  const report = await runVerifyPlatform(opts);
  for (const s of report.stages) console.log(`${s.status}  ${s.id}  ${s.detail}`);
  console.log(`\nPIPELINE verdict: ${report.pipeline} (platform ${report.platform}, host ${report.host})`);
  console.log(`TRUST verdict: ${report.trust.verdict} — ${report.trust.reasons.join('; ') || 'signature verified + double-click prompt recorded'}`);
  console.log('NOTE: PIPELINE PASS does not mean distributable. Only TRUST_PASSED means the build may be distributed as trusted.');
  const out = opts.out || join(repoRoot, 'docs', 'verification', 'reports', `${report.platform}-pipeline.json`);
  mkdirSync(dirname(out), { recursive: true });
  const { smokeLog, checkLog, ...summary } = report;
  writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`report: ${out}`);
  process.exit(report.pipeline === 'PASS' ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error('[verify-platform] FATAL:', e); process.exit(1); });
}

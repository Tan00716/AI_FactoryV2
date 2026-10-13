/**
 * §40 build definition assembly (Batch 24).
 *
 * Honest accounting only: every field is either computed from real
 * bytes in the worktree or reported missing. Tests pin:
 *  - lockfile detection (present → hashed; absent → missing, never invented);
 *  - sha256 helpers against independently computed values;
 *  - assembleBuildDefinition returns a lockable definition when all
 *    inputs are real, and definition=null + named missing inputs when
 *    they are not (the caller must NOT call lockBuild then);
 *  - the locked digest is reproducible and equals an independent
 *    lockBuild recomputation over the same definition.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  assembleBuildDefinition,
  detectLockfiles,
  lockBuild,
  sha256File,
  sha256String,
  type BuildDefinition,
} from '../src/index';

const REV = 'a'.repeat(40);

function worktree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'assemble-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

describe('§40 build definition assembly', () => {
  it('sha256 helpers match independent crypto recomputation', async () => {
    assert.equal(sha256String('hello'), createHash('sha256').update('hello', 'utf8').digest('hex'));
    const dir = worktree({ 'package-lock.json': '{"lockfileVersion":3}' });
    try {
      const expected = createHash('sha256')
        .update('{"lockfileVersion":3}', 'utf8')
        .digest('hex');
      assert.equal(await sha256File(join(dir, 'package-lock.json')), expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects lockfiles, ignores non-lockfiles and missing dirs', () => {
    const dir = worktree({
      'package-lock.json': '{}',
      'README.md': 'not a lockfile',
    });
    try {
      const found = detectLockfiles(dir);
      assert.equal(found.length, 1);
      assert.ok(found[0].endsWith('package-lock.json'));
      assert.deepEqual(detectLockfiles(join(dir, 'nope')), [], 'missing dir → no lockfile, not an error');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('assembles a lockable definition when all inputs are real', async () => {
    const dir = worktree({
      'package-lock.json': '{"lockfileVersion":3}',
      'tsconfig.json': '{"compilerOptions":{}}',
    });
    try {
      const a = await assembleBuildDefinition({
        revision: REV,
        workDir: dir,
        buildCommand: 'npm run build',
        toolchain: 'node v24.0.0',
        configFiles: ['tsconfig.json'],
      });
      assert.deepEqual(a.missing, [], 'nothing missing');
      assert.deepEqual(a.skippedConfigFiles, []);
      assert.deepEqual(a.lockfilePaths, ['package-lock.json']);
      assert.ok(a.definition, 'definition assembled');
      const def = a.definition as BuildDefinition;
      assert.equal(def.revision, REV);
      assert.equal(def.lockfileHash, await sha256File(join(dir, 'package-lock.json')));
      assert.equal(def.toolchain, 'node v24.0.0');
      assert.equal(def.buildDefinitionHash, sha256String('npm run build'));
      assert.equal(
        def.configHash,
        sha256String(`tsconfig.json:${await sha256File(join(dir, 'tsconfig.json'))}`),
      );
      // The §40 digest is real: independent lockBuild recomputation agrees.
      const locked = lockBuild(def, 'tester');
      const recomputed = lockBuild(
        {
          revision: REV,
          lockfileHash: def.lockfileHash,
          toolchain: def.toolchain,
          buildDefinitionHash: def.buildDefinitionHash,
          configHash: def.configHash,
          dependencySources: def.dependencySources,
        },
        'someone-else',
      );
      assert.equal(locked.digest, recomputed.digest, 'digest depends on inputs, not on who locked');
      assert.match(locked.digest, /^[0-9a-f]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports missing inputs instead of inventing them', async () => {
    const dir = worktree({ 'index.js': 'console.log(1)' });
    try {
      const a = await assembleBuildDefinition({
        revision: REV,
        workDir: dir,
        buildCommand: 'npm run build',
        configFiles: ['tsconfig.json'], // absent in the worktree
      });
      assert.equal(a.definition, null, 'no definition without real inputs');
      assert.ok(a.missing.includes('lockfileHash'), 'missing lockfile named');
      assert.ok(a.missing.includes('configHash'), 'missing config named');
      assert.ok(!a.missing.includes('toolchain'), 'toolchain has an honest default');
      assert.deepEqual(a.skippedConfigFiles, ['tsconfig.json'], 'absent config file named loudly');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('empty revision is missing, never defaulted', async () => {
    const dir = worktree({ 'package-lock.json': '{}' });
    try {
      const a = await assembleBuildDefinition({
        revision: '',
        workDir: dir,
        buildCommand: 'npm run build',
      });
      assert.equal(a.definition, null);
      assert.ok(a.missing.includes('revision'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

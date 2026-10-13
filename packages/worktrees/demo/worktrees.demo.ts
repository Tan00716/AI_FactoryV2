/**
 * Worktree allocator demo (§22.1) — a task gets its own git worktree,
 * a second allocate for the same task reuses it, and release cleans
 * up and archives the record. Skips itself when git is unavailable.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitBroker, GIT_ACTIONS } from '@ai-factory/git';
import { MemoryWorktreeStore } from '@ai-factory/db';
import { WorktreeAllocator } from '../src/index';

async function main(): Promise<void> {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    console.log('demo:worktrees skipped (git unavailable)');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'worktrees-demo-'));
  try {
    const repo = join(dir, 'repo');
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'd@d'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'd'], { cwd: repo });
    writeFileSync(join(repo, 'app.txt'), 'v1');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });

    const alloc = new WorktreeAllocator({
      broker: new GitBroker(
        { allowedActions: [...GIT_ACTIONS], taskRequiredActions: ['worktree'] },
        { audit: (d) => console.log('broker:', d.action, d.allowed ? 'ALLOWED' : 'DENIED') },
      ),
      store: new MemoryWorktreeStore(),
      rootDir: join(dir, 'wt-root'),
      audit: (e, d) => console.log('audit:', e, JSON.stringify(d)),
    });

    const first = await alloc.allocate({
      repoPath: repo,
      taskId: 'demo-task-1',
      title: 'Demo feature',
      actor: 'demo',
    });
    console.log('allocated:', first.record.branch, '→', first.record.worktreePath);
    const again = await alloc.allocate({ repoPath: repo, taskId: 'demo-task-1' });
    console.log('re-allocate reused:', again.reused, again.record.id === first.record.id);

    const released = await alloc.release(first.record.id, { actor: 'demo' });
    console.log('released:', released.status, '| path gone:', !existsSync(first.record.worktreePath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('demo:worktrees failed:', e);
  process.exit(1);
});

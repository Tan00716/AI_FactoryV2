/**
 * Task branches — spec §34 ("AI should normally work through: task branch →
 * changes → commit → PR").
 *
 * Naming convention: `task/<shortid>-<slug>`
 */

import type { GitAuditHook, GitRepo } from './git';

const SLUG_MAX = 40;

/**
 * Short, stable identifier for a task id.
 * UUIDs → first 8 hex chars; anything else → first 8 alphanumerics.
 */
function shortId(taskId: string): string {
  const alnum = taskId.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (alnum.slice(0, 8) || 'task').padEnd(4, '0');
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (slug || 'task').slice(0, SLUG_MAX).replace(/-+$/, '');
}

/** `task/<shortid>-<slug>`, e.g. `task/3f2a1b4c-fix-payment-bug`. */
export function taskBranchName(taskId: string, title: string): string {
  return `task/${shortId(taskId)}-${slugify(title)}`;
}

export interface EnsureTaskBranchOptions {
  audit?: GitAuditHook;
}

/**
 * Ensure the branch for this task exists and is checked out:
 * checkout `base`, create the task branch if missing, then checkout it.
 * Returns the branch name.
 */
export async function ensureTaskBranch(
  repo: GitRepo,
  taskId: string,
  title: string,
  base = 'main',
  opts: EnsureTaskBranchOptions = {},
): Promise<string> {
  const name = taskBranchName(taskId, title);
  const { all } = await repo.branches();
  if (all.includes(base)) {
    await repo.checkout(base, { audit: opts.audit });
  }
  if (!all.includes(name)) {
    await repo.createBranch(name, { audit: opts.audit });
  }
  await repo.checkout(name, { audit: opts.audit });
  opts.audit?.('GIT_TASK_BRANCH', { repo: repo.path, taskId, branch: name });
  return name;
}

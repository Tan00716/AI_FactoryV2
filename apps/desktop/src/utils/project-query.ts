/**
 * Multi-project window binding: which projectId a renderer window starts with.
 *
 * The Electron main process passes `?project=<id>` when opening a new
 * window (see electron/main.ts `ai-factory:open-window`). This module is a
 * pure function so desktop unit tests can import it directly (same pattern
 * as utils/cmdk.ts).
 */

export const DEFAULT_PROJECT_ID = 'proj-myapp';

/** Allowlist for project ids coming from the URL: fail closed on junk. */
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Resolve the initial projectId from a URL query string (e.g.
 * window.location.search). Returns the sanitized `project` param, or the
 * fallback when absent/invalid.
 */
export function initialProjectId(search: string, fallback: string = DEFAULT_PROJECT_ID): string {
  let raw = '';
  try {
    raw = new URLSearchParams(search).get('project') ?? '';
  } catch {
    raw = '';
  }
  raw = raw.trim();
  return PROJECT_ID_RE.test(raw) ? raw : fallback;
}

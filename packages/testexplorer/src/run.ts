/**
 * Spawn wrapper for the node:test runner child (Round 7 #3).
 *
 * The route layer gates the command through the server's exec safety
 * policy first (binary allowlist + deny patterns, no inline eval); this
 * module only spawns `node <runner>` with a fixed argv shape, so no
 * caller input ever becomes a shell string: argv is passed directly to
 * spawn, never through a shell.
 *
 * Environment hygiene (see AGENTS.md: test-spawn env leak): the child
 * must NOT inherit NODE_TEST_CONTEXT / NODE_TEST_WORKER_ID, or the
 * nested `node --test` silently downgrades and reports nothing.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import type { CaseResult, RunOutcome, RunSummary } from './types';

/** Absolute path of the compiled runner child script. */
export function getRunnerPath(): string {
  return path.join(__dirname, 'runner.js');
}

export interface RunRequest {
  /** Project root: the child's cwd. Must already be resolved + jailed by the caller. */
  root: string;
  /** Absolute test-file paths, all inside root. */
  files: string[];
  /** node:test name patterns (leaf names only, see runner.ts). */
  patterns?: string[];
  timeoutMs: number;
}

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
/** Per-case failure text cap; total stdout/stderr capture cap. */
export const CASE_ERROR_CAP = 8000;
export const OUTPUT_CAP = 512 * 1024;

function cap(text: string, limit: number): { text: string; hit: boolean } {
  if (text.length <= limit) return { text, hit: false };
  return { text: text.slice(0, limit), hit: true };
}

export async function runTests(req: RunRequest): Promise<RunOutcome> {
  const runnerPath = getRunnerPath();
  const args = [runnerPath];
  for (const f of req.files) args.push('--file', f);
  for (const p of req.patterns ?? []) args.push('--pattern', p);

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['NODE_TEST_CONTEXT'];
  delete env['NODE_TEST_WORKER_ID'];

  return new Promise<RunOutcome>((resolve) => {
    const child: ChildProcess = spawn(process.execPath, args, {
      cwd: req.root,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    const fdStream = child.stdio[3] as NodeJS.ReadableStream | null;

    let resultText = '';
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const onData = (buf: Buffer, target: 'out' | 'err'): void => {
      const text = buf.toString('utf8');
      if (target === 'out') stdout += text;
      else stderr += text;
      if (stdout.length > OUTPUT_CAP || stderr.length > OUTPUT_CAP) truncated = true;
    };
    child.stdout?.on('data', (b: Buffer) => onData(b, 'out'));
    child.stderr?.on('data', (b: Buffer) => onData(b, 'err'));
    fdStream?.on('data', (b: Buffer) => {
      resultText += b.toString('utf8');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined && process.platform !== 'win32') {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        child.kill('SIGKILL');
      }
    }, req.timeoutMs);

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const results: CaseResult[] = [];
      let summary: RunSummary | null = null;
      let summaryError: string | undefined;
      const fileErrors: Array<{ file: string; error: string }> = [];
      for (const line of resultText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (typeof obj['__file'] === 'string') {
          if (obj['failed'] === true) {
            fileErrors.push({
              file: obj['__file'] as string,
              error: typeof obj['error'] === 'string' && obj['error']
                ? (obj['error'] as string)
                : 'file failed to load (no cases reported)',
            });
          }
          continue;
        }
        if (obj['__summary'] && typeof obj['__summary'] === 'object') {
          const s = obj['__summary'] as Record<string, unknown>;
          summary = {
            pass: Number(s['pass'] ?? 0),
            fail: Number(s['fail'] ?? 0),
            skip: Number(s['skip'] ?? 0),
            todo: Number(s['todo'] ?? 0),
            total: Number(s['total'] ?? 0),
            durationMs: 0,
          };
          if (typeof s['error'] === 'string' && s['error']) summaryError = s['error'];
          continue;
        }
        if (typeof obj['file'] === 'string' && typeof obj['name'] === 'string') {
          const r: CaseResult = {
            file: obj['file'] as string,
            name: obj['name'] as string,
            fullName: typeof obj['fullName'] === 'string' ? (obj['fullName'] as string) : (obj['name'] as string),
            status: (obj['status'] as CaseResult['status']) ?? 'fail',
            durationMs: typeof obj['durationMs'] === 'number' ? (obj['durationMs'] as number) : 0,
          };
          if (typeof obj['error'] === 'string' && obj['error']) {
            r.error = cap(obj['error'] as string, CASE_ERROR_CAP).text;
          }
          results.push(r);
        }
      }
      const computed: RunSummary = summary ?? {
        pass: results.filter((r) => r.status === 'pass').length,
        fail: results.filter((r) => r.status === 'fail').length,
        skip: results.filter((r) => r.status === 'skip').length,
        todo: results.filter((r) => r.status === 'todo').length,
        total: results.length,
        durationMs: 0,
      };
      computed.durationMs = results.reduce((n, r) => n + r.durationMs, 0);
      const outCapped = cap(stdout, OUTPUT_CAP);
      const errCapped = cap(stderr, OUTPUT_CAP);
      if (outCapped.hit || errCapped.hit) truncated = true;
      let runError: string | undefined;
      if (summaryError) runError = summaryError;
      else if (timedOut) runError = `run timed out after ${req.timeoutMs}ms`;
      else if (fileErrors.length > 0) {
        runError = fileErrors.map((f) => `${f.file}: ${f.error}`).join('; ').slice(0, 2000);
      } else if (results.length === 0 && exitCode !== 0) {
        const tail = (errCapped.text.trim() || outCapped.text.trim()).slice(-2000);
        runError = tail ? `runner exited ${exitCode}: ${tail}` : `runner exited ${exitCode} with no results`;
      }
      resolve({
        results,
        summary: computed,
        stdout: outCapped.text,
        stderr: errCapped.text,
        truncated,
        timedOut,
        exitCode,
        runError,
        fileErrors: fileErrors.length > 0 ? fileErrors : undefined,
      });
    };

    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}

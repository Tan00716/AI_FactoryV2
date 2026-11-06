/**
 * @ai-factory/debugger — debug adapter registry (round-7 task R7-#7).
 *
 * The round-4 debugger shipped exactly one adapter (Node.js, driven over
 * CDP). This module registers the multi-language adapter surface without
 * pretending the extra languages are driven yet:
 *
 *   - node   — builtin, implemented: the compiled node-adapter script.
 *   - python — external debugpy (`python3 -m debugpy`), REGISTERED ONLY.
 *   - go     — external delve (`dlv dap`), REGISTERED ONLY.
 *
 * Python/Go are placeholders by design (round-7 brief: "node/python/go
 * 占位"): the registry knows their probe commands and install hints, the
 * probe reports honestly whether the binary exists, and any attempt to
 * actually launch a session through them fails closed with
 * ADAPTER_NOT_IMPLEMENTED — never silently reinterpreted as Node.
 *
 * Probing spawns a short-lived process (10s timeout, loopback-free, no
 * shell). Child env is the scrubbed server env: credential vars are
 * stripped via scrubCredentialEnv (same table as the pty childEnv), and
 * NODE_TEST_CONTEXT / NODE_TEST_WORKER_ID are stripped as well, matching
 * the DebugClient contract.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scrubCredentialEnv } from '@ai-factory/runtime';
import { DebugError } from './client';

/**
 * Absolute path of the compiled node adapter entry script. Same dist/src
 * layout as index.resolveNodeAdapterScript (duplicated here on purpose:
 * adapters.ts must not import ./index, which re-exports this module).
 */
function resolveNodeAdapterScript(): string {
  const dir = typeof __dirname === 'string' ? __dirname : dirname(__filename);
  return join(dir, 'node-adapter.js');
}

export type AdapterKind = 'node' | 'python' | 'go';

export interface AdapterProbeCandidate {
  command: string;
  args: string[];
}

export interface AdapterInfo {
  kind: AdapterKind;
  displayName: string;
  /** 'builtin' = shipped in this repo; 'external' = user-installed binary. */
  driver: 'builtin' | 'external';
  /** Whether the server can actually drive sessions for this adapter. */
  implemented: boolean;
  probeCandidates: AdapterProbeCandidate[];
  installHint: string;
}

export interface AdapterProbe {
  kind: AdapterKind;
  available: boolean;
  version?: string;
  detail: string;
}

export const ADAPTERS: AdapterInfo[] = [
  {
    kind: 'node',
    displayName: 'Node.js',
    driver: 'builtin',
    implemented: true,
    probeCandidates: [],
    installHint: 'Built in — no installation needed.',
  },
  {
    kind: 'python',
    displayName: 'Python (debugpy)',
    driver: 'external',
    implemented: false,
    probeCandidates: [
      { command: 'python3', args: ['-m', 'debugpy', '--version'] },
      { command: 'python', args: ['-m', 'debugpy', '--version'] },
    ],
    installHint: 'pip install debugpy, then re-probe.',
  },
  {
    kind: 'go',
    displayName: 'Go (delve)',
    driver: 'external',
    implemented: false,
    probeCandidates: [{ command: 'dlv', args: ['version'] }],
    installHint: 'go install github.com/go-delve/delve/cmd/dlv@latest, then re-probe.',
  },
];

/** Static registry (no process spawned). */
export function listAdapters(): AdapterInfo[] {
  return ADAPTERS.map((a) => ({ ...a, probeCandidates: a.probeCandidates.map((c) => ({ ...c })) }));
}

export function getAdapterInfo(kind: string): AdapterInfo {
  const found = ADAPTERS.find((a) => a.kind === kind);
  if (!found) {
    throw new DebugError('UNKNOWN_ADAPTER', `unknown debug adapter kind: ${kind}`);
  }
  return found;
}

/**
 * Env for a probe child: the server env with credentials scrubbed
 * (scrubCredentialEnv — same table as the pty childEnv, R17 #6(j)
 * hygiene fix; the old name `scrubbedEnv` was a misnomer, it copied the
 * full env and only deleted the two NODE_TEST_* vars), then the two
 * NODE_TEST_* vars deleted as well so a spawned `node --test`
 * grandchild does not silently degrade to zero outcomes.
 */
function probeChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(scrubCredentialEnv(process.env))) {
    if (v !== undefined) env[k] = v;
  }
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0);
  return line ? line.trim().slice(0, 120) : '';
}

/**
 * Probe one adapter. `override` replaces the probe candidates (test seam:
 * point it at a fake binary script instead of relying on PATH).
 * Never throws for a missing binary — that is a normal "unavailable" result.
 */
export function probeAdapter(
  kind: AdapterKind,
  override?: AdapterProbeCandidate,
): AdapterProbe {
  const info = getAdapterInfo(kind);
  if (kind === 'node') {
    const script = resolveNodeAdapterScript();
    if (existsSync(script)) {
      return { kind, available: true, version: 'builtin', detail: `node adapter script found: ${script}` };
    }
    return { kind, available: false, detail: `node adapter script missing (build first): ${script}` };
  }
  const candidates = override ? [override] : info.probeCandidates;
  const tried: string[] = [];
  for (const c of candidates) {
    tried.push(`${c.command} ${c.args.join(' ')}`);
    try {
      const r = spawnSync(c.command, c.args, { timeout: 10000, encoding: 'utf8', env: probeChildEnv() });
      if (r.error) {
        const code = (r.error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue;
        if (code === 'ETIMEDOUT') {
          return { kind, available: false, detail: `probe timed out: ${c.command}` };
        }
        continue;
      }
      if (r.status === 0) {
        const version = firstLine(`${r.stdout ?? ''}\n${r.stderr ?? ''}`) || undefined;
        return { kind, available: true, version, detail: `probe ok: ${c.command} ${c.args.join(' ')}` };
      }
      // Non-zero exit: binary exists but the probe invocation failed — the
      // adapter is not usable as probed; keep trying other candidates.
    } catch {
      continue;
    }
  }
  return { kind, available: false, detail: `no working probe command (${tried.join('; ')})` };
}

/**
 * Resolve how a session would be launched for an adapter.
 * Node returns the builtin script; python/go fail closed — registered but
 * not driven, so a launch must never fall back to Node silently.
 */
export function resolveAdapterLaunch(kind: AdapterKind): { kind: AdapterKind; script: string } {
  const info = getAdapterInfo(kind);
  if (!info.implemented) {
    throw new DebugError(
      'ADAPTER_NOT_IMPLEMENTED',
      `${info.displayName} is registered but not yet driven by this server (${info.installHint})`,
    );
  }
  return { kind, script: resolveNodeAdapterScript() };
}

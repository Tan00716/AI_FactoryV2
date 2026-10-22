/**
 * R4-S1 — pre-send prompt secret scanning (G9 wiring).
 *
 * The gap: the secret guard (`scanForSecrets`, §43.4) only ran on memory
 * writes and on the runtime StepFn's ACT phase. Any prompt handed to
 * `adapter.invoke` by another path would leave the process unexamined — a
 * prompt containing `AKIA…` / `sk-…` / a bot token would be sent to the
 * model vendor verbatim. "A prompt that contains a secret has already
 * leaked even if the log is redacted afterwards" (INV-26 / §46.2).
 *
 * This module is the choke point: `assertPromptSafe` runs at the top of
 * every `RuntimeAdapter.invoke()` implementation (adapters.ts), so no
 * caller can bypass the scan. It reuses the canonical ~20-family pattern
 * table from @ai-factory/security (the same engine as the repo
 * secret-scan), applies the placeholder discipline for generic families,
 * and never echoes secret values — errors, audit and notifications name
 * only the matched pattern families.
 *
 * Modes (setter-injectable, default 'block'):
 *  - 'block'  — a match blocks the invoke: audit PROMPT_SECRET_BLOCKED +
 *    HIGH notification, then PreSendSecretBlockedError is thrown. The
 *    adapter is never invoked.
 *  - 'redact' — matches are replaced with [REDACTED] and the (sanitized)
 *    prompt is released; audit PROMPT_SECRET_REDACTED. No HIGH alert —
 *    redact mode is the operator's explicit leniency choice.
 * The mode is deployment configuration (set once at startup via
 * setPreSendScanMode); it is not read from the environment, so a prompt
 * can never silently downgrade the gate by smuggling env vars.
 *
 * Sinks are best-effort (a sink failure never unblocks a secret): with no
 * sinks installed the gate still blocks; it just doesn't audit/notify.
 */
import { SECRET_PATTERNS, isPlaceholderValue, type SecretPattern } from '@ai-factory/security';

export type PreSendScanMode = 'block' | 'redact';

/**
 * Prompt-shaped assignments the repo-focused table misses. A bare
 * `token = "..."` in a prompt is a real leak the pre-send gate must catch;
 * these live here (not in the shared table) so the repo secret-scan's
 * finding behavior stays exactly as it was.
 */
const PROMPT_EXTRA_PATTERNS: SecretPattern[] = [
  { name: 'token-assignment', kind: 'generic', re: /\btoken\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}["']?/i },
  { name: 'secret-assignment', kind: 'generic', re: /\bsecret\s*[:=]\s*["']?[A-Za-z0-9_\-]{8,}["']?/i },
  { name: 'password-assignment', kind: 'generic', re: /\bpassword\s*[:=]\s*["']?\S{6,}["']?/i },
];

/** Full pre-send engine: shared 21 families + 3 prompt-shaped extras. */
export const PRE_SEND_PATTERNS: SecretPattern[] = [...SECRET_PATTERNS, ...PROMPT_EXTRA_PATTERNS];

/** Best-effort sinks, installed by the coordinator (server index.ts). */
export interface PreSendScanSinks {
  audit?: (action: string, detail: Record<string, unknown>) => void;
  notify?: (event: {
    type: 'PROMPT_SECRET_BLOCKED';
    actor?: string;
    entity?: { kind: string; id: string; label?: string };
    detail?: Record<string, unknown>;
  }) => void;
}

/** Thrown when block mode refuses a prompt. Names patterns, never values. */
export class PreSendSecretBlockedError extends Error {
  readonly code = 'PROMPT_SECRET_BLOCKED';
  readonly patterns: string[];
  constructor(patterns: string[]) {
    super(`suspected raw secret in prompt (patterns: ${patterns.join(', ')})`);
    this.name = 'PreSendSecretBlockedError';
    this.patterns = [...patterns];
  }
}

let modeOverride: PreSendScanMode | null = null;
let sinks: PreSendScanSinks = {};

/** Override the scan mode (default 'block'). */
export function setPreSendScanMode(mode: PreSendScanMode): void {
  modeOverride = mode;
}

export function getPreSendScanMode(): PreSendScanMode {
  return modeOverride ?? 'block';
}

/** Install audit/notification sinks (coordinator wiring). */
export function setPreSendScanSinks(next: PreSendScanSinks): void {
  sinks = { ...next };
}

/**
 * Pure scan: names of matched pattern families, [] when clean.
 * Generic families skip placeholder-looking values (docs, not secrets).
 * ALL matches are examined — a placeholder-looking first match must not
 * mask a real secret later in the text (no false negatives by ordering).
 */
export function scanPromptForSecrets(text: string): string[] {
  const src = text ?? '';
  const out: string[] = [];
  for (const p of PRE_SEND_PATTERNS) {
    let hit = false;
    for (const m of src.matchAll(globalize(p.re))) {
      if (p.kind === 'generic' && isPlaceholderValue(m[0])) continue;
      hit = true;
      break;
    }
    if (hit) out.push(p.name);
  }
  return out;
}

function globalize(re: RegExp): RegExp {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  return new RegExp(re.source, flags);
}

/**
 * Replace every matched secret span with [REDACTED]. Placeholder-looking
 * values are left alone (same discipline as detection).
 */
export function redactPromptSecrets(text: string): { text: string; patterns: string[] } {
  const patterns = scanPromptForSecrets(text);
  let out = text ?? '';
  for (const name of patterns) {
    const pat = PRE_SEND_PATTERNS.find((p) => p.name === name);
    if (!pat) continue;
    out = out.replace(globalize(pat.re), (m) =>
      pat.kind === 'generic' && isPlaceholderValue(m) ? m : '[REDACTED]',
    );
  }
  return { text: out, patterns };
}

function report(
  outcome: 'blocked' | 'redacted',
  info: { adapter: string; patterns: string[] },
): void {
  const mode = getPreSendScanMode();
  const action = outcome === 'blocked' ? 'PROMPT_SECRET_BLOCKED' : 'PROMPT_SECRET_REDACTED';
  try {
    sinks.audit?.(action, { adapter: info.adapter, patterns: info.patterns, mode });
  } catch {
    /* audit is best-effort; the block/throw below is the enforcement */
  }
  if (outcome === 'blocked') {
    try {
      sinks.notify?.({
        type: 'PROMPT_SECRET_BLOCKED',
        actor: 'system',
        entity: {
          kind: 'prompt',
          id: 'pre-send-scan',
          label: `pre-send prompt scan (${info.adapter})`,
        },
        detail: {
          adapter: info.adapter,
          patterns: info.patterns.join(', '),
          mode,
        },
      });
    } catch {
      /* notification delivery is best-effort */
    }
  }
}

/**
 * The choke point. Returns the prompt to send (redacted in redact mode);
 * throws PreSendSecretBlockedError in block mode. Call at the top of every
 * adapter.invoke() — before any byte leaves the process.
 */
export function assertPromptSafe(prompt: string, ctx: { adapter: string }): string {
  const patterns = scanPromptForSecrets(prompt);
  if (patterns.length === 0) return prompt;
  if (getPreSendScanMode() === 'redact') {
    const redacted = redactPromptSecrets(prompt);
    report('redacted', { adapter: ctx.adapter, patterns: redacted.patterns });
    return redacted.text;
  }
  report('blocked', { adapter: ctx.adapter, patterns });
  throw new PreSendSecretBlockedError(patterns);
}

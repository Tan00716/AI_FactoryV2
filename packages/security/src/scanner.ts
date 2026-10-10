/**
 * MCP / skill security scanner — spec §73, §74, §75.
 *
 * Install-time checklist: review instructions → scan scripts → inspect
 * network behavior → inspect file-access scope → evaluate → verdict.
 *
 * Verdicts: ALLOW (safe), REVIEW (needs human approval), BLOCK (unsafe —
 * unknown/untrusted by default, §73 "Unknown MCP = BLOCK").
 */

export type Severity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type Verdict = 'ALLOW' | 'REVIEW' | 'BLOCK';
export type FindingCategory = 'instructions' | 'scripts' | 'network' | 'file-access' | 'trust';

export interface ScanManifest {
  name: string;
  version?: string;
  provider?: string;
  /** SKILL.md text, MCP description, etc. */
  instructions: string;
  /** Shell script contents / commands the package may run. */
  scripts: string[];
  declared: {
    network: boolean;
    fileAccess: 'none' | 'read' | 'write';
    shell: boolean;
  };
  trustLevel?: 'OFFICIAL' | 'VERIFIED' | 'COMMUNITY' | 'UNKNOWN';
}

export interface Finding {
  severity: Severity;
  category: FindingCategory;
  message: string;
  pattern?: string;
}

export interface ScanResult {
  name: string;
  score: number; // 0–100
  findings: Finding[];
  verdict: Verdict;
  requiresHumanApproval: boolean;
}

const DEDUCT: Record<Severity, number> = {
  INFO: 0,
  LOW: 3,
  MEDIUM: 10,
  HIGH: 25,
  CRITICAL: 60,
};

/** HIGH/CRITICAL — destructive or self-replicating commands. */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*|--recursive)\s+(\/\s*(--no-preserve-root)?\s*$|\/\*)/,
  /\brm\s+-rf?\s+~?\/?\s*$/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\s+if=\S+\s+of=\/dev\//,
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;?\s*:/, // fork bomb
  /\bshutdown\b|\breboot\s+-/,
  />\s*\/dev\/sd[a-z]/,
];

/** CRITICAL — classic pipe-to-shell and reverse-shell idioms. */
const PIPE_SHELL_PATTERNS: RegExp[] = [
  /\bcurl\b[^|&;]*\|\s*(ba)?sh\b/,
  /\bwget\b[^|&;]*\|\s*(ba)?sh\b/,
  /\bcurl\b[^|&;]*\|\s*bash\s+-c/,
  /\bnc(\.exe)?\b[^|&;]*-e\s+\S/,
  /\bnetcat\b[^|&;]*-e\s+\S/,
  /\/dev\/tcp\//,
  /\beval\s*\(\s*\$\(/,
];

/** HIGH — credential harvesting / exfiltration phrasing. */
const EXFIL_PATTERNS: RegExp[] = [
  /(send|upload|post|transmit|exfiltrate|steal|harvest|collect|include|embed|paste)\b.{0,80}\b(api[-_ ]?key|secret([-_ ]?(key|token))?|password|passwd|credential|token)\b/i,
  /\b(api[-_ ]?key|secret([-_ ]?(key|token))?|password|credential)\b.{0,80}\b(send|upload|post|transmit|external|remote|third[- ]?party|attacker)\b/i,
  /\benv\b.*\|\s*(curl|wget|nc)\b/i,
  /\b\.ssh\b|\b\.aws\/credentials\b/i,
];

/** MEDIUM — policy/safety subversion language in instructions. */
const SUBVERSION_PATTERNS: RegExp[] = [
  /\bdisable\s+(safety|security|guardrails?|policy|policies)\b/i,
  /\bignore\s+(safety|security|policy)\b/i,
  /\bbypass\s+(approval|review|auth|sandbox)\b/i,
  /\bno\s+questions?\s+asked\b/i,
];

/** Undeclared network use mentioned in text while declared.network === false. */
const NETWORK_MENTION_PATTERNS: RegExp[] = [
  /\bcurl\b/,
  /\bwget\b/,
  /\bfetch\s*\(/,
  /\bhttps?:\/\/[a-z0-9.-]+\//i,
  /\bsocket\b/,
  /\bwebsocket\b/i,
];

/** Sensitive absolute paths / traversal in scripts. */
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /\/etc\/(passwd|shadow|hosts|sudoers)/,
  /\/root\//,
  /~\/.ssh/,
  /\.\.[\/\\]\.\.[\/\\]/,
];

function push(
  findings: Finding[],
  severity: Severity,
  category: FindingCategory,
  message: string,
  pattern?: string,
) {
  findings.push({ severity, category, message, pattern });
}

export function scanManifest(manifest: ScanManifest): ScanResult {
  const findings: Finding[] = [];
  const text = `${manifest.instructions}\n${manifest.scripts.join('\n')}`;

  // 1. Instructions review
  for (const p of DESTRUCTIVE_PATTERNS) {
    if (p.test(manifest.instructions)) {
      push(findings, 'CRITICAL', 'instructions', `instructions contain destructive command matching ${p}`, String(p));
    }
  }
  for (const p of EXFIL_PATTERNS) {
    if (p.test(manifest.instructions)) {
      push(findings, 'HIGH', 'instructions', `instructions suggest credential collection/exfiltration (${p})`, String(p));
    }
  }
  for (const p of SUBVERSION_PATTERNS) {
    if (p.test(manifest.instructions)) {
      push(findings, 'HIGH', 'instructions', `instructions attempt to subvert safety policy (${p})`, String(p));
    }
  }

  // 2. Script content scan
  manifest.scripts.forEach((script, i) => {
    for (const p of PIPE_SHELL_PATTERNS) {
      if (p.test(script)) {
        push(findings, 'CRITICAL', 'scripts', `script[${i}] pipes remote content to a shell (${p})`, String(p));
      }
    }
    for (const p of DESTRUCTIVE_PATTERNS) {
      if (p.test(script)) {
        push(findings, 'CRITICAL', 'scripts', `script[${i}] contains destructive command (${p})`, String(p));
      }
    }
    for (const p of EXFIL_PATTERNS) {
      if (p.test(script)) {
        push(findings, 'HIGH', 'scripts', `script[${i}] touches credentials or exfiltration paths (${p})`, String(p));
      }
    }
    for (const p of SENSITIVE_PATH_PATTERNS) {
      if (p.test(script)) {
        push(findings, 'CRITICAL', 'file-access', `script[${i}] reaches sensitive path/traversal (${p})`, String(p));
      }
    }
    if (!manifest.declared.shell && /\b(bash|sh|powershell|cmd\.exe)\b/.test(script)) {
      push(findings, 'MEDIUM', 'scripts', `script[${i}] invokes a shell without declared shell capability`);
    }
  });

  // 3. Network behavior
  if (manifest.declared.network) {
    push(
      findings,
      manifest.trustLevel === 'UNKNOWN' ? 'HIGH' : 'MEDIUM',
      'network',
      'declares network access — outbound traffic must be allow-listed',
    );
  } else if (NETWORK_MENTION_PATTERNS.some((p) => p.test(text))) {
    push(findings, 'HIGH', 'network', 'uses network without declaring the network capability');
  }

  // 4. File-access scope
  if (manifest.declared.fileAccess === 'write') {
    push(findings, 'HIGH', 'file-access', 'declares WRITE file access — can mutate workspace/machine');
  } else if (manifest.declared.fileAccess === 'read') {
    push(findings, 'LOW', 'file-access', 'declares read-only file access');
  }
  if (manifest.declared.shell) {
    push(findings, 'HIGH', 'scripts', 'declares shell execution capability');
  }

  // 5. Trust level (spec §73: unknown MCP = BLOCK)
  const trust = manifest.trustLevel ?? 'UNKNOWN';
  if (trust === 'UNKNOWN') {
    push(findings, 'CRITICAL', 'trust', 'unknown/untrusted origin — default policy is BLOCK (§73)');
  } else if (trust === 'COMMUNITY') {
    push(findings, 'MEDIUM', 'trust', 'community origin — treat as unreviewed');
  } else {
    push(findings, 'INFO', 'trust', `${trust.toLowerCase()} origin`);
  }

  // 6. Evaluate → score & verdict
  let score = 100;
  for (const f of findings) score -= DEDUCT[f.severity];
  score = Math.max(0, Math.min(100, score));

  const hasCritical = findings.some((f) => f.severity === 'CRITICAL');
  const hasHigh = findings.some((f) => f.severity === 'HIGH');
  const verdict: Verdict = hasCritical || score < 50 ? 'BLOCK' : hasHigh || score < 85 ? 'REVIEW' : 'ALLOW';

  return {
    name: manifest.name,
    score,
    findings,
    verdict,
    requiresHumanApproval: verdict !== 'ALLOW',
  };
}

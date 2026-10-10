/**
 * Install-time security checklist — spec §74 (SKILL SECURITY).
 *
 * Pipeline: Scan → Inspect instructions → Inspect scripts → Inspect network
 * behavior → Inspect file access → Evaluate → Approve.
 *
 * Rules (heuristic, text-based):
 *  - INSTRUCTIONS: risky phrases in the SKILL.md text — shell execution
 *    helpers (MEDIUM), credential/exfiltration phrasing (HIGH), destructive
 *    commands (HIGH).
 *  - SCRIPTS: scripts/ entries that were not backed by a declared shell
 *    capability (MEDIUM); suspicious script names (HIGH).
 *  - NETWORK: declared.network === true (HIGH). Undeclared network mentions
 *    in instructions without a declared network capability (MEDIUM).
 *  - FILE_ACCESS: declared WRITE (HIGH — it can mutate the workspace/machine),
 *    declared READ (LOW), NONE (INFO).
 *  - SHELL: declared.shell === true (HIGH).
 *  - TRUST: UNREVIEWED (MEDIUM), COMMUNITY (LOW), VERIFIED/OFFICIAL (INFO).
 *
 * Any HIGH finding → checklist.requiresHumanApproval = true.
 */
import {
  InstallSkillDef,
  SecurityCheck,
  SecurityChecklist,
  SecurityFinding,
  SecuritySeverity,
} from './types';

const SEVERITY_RANK: Record<SecuritySeverity, number> = {
  INFO: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

/** MEDIUM — mentions of executing commands from instructions. */
const SHELL_PHRASE_PATTERNS: RegExp[] = [
  /\b(eval|exec)\s*\(/,
  /\bos\.system\s*\(/,
  /\bsubprocess\.(run|call|Popen)\s*\(/,
  /\bchild_process\b/,
  /\brun\s+(a\s+)?shell\b/i,
  /\bexecute\s+(shell\s+)?commands?\b/i,
];

/** HIGH — destructive commands. */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+-rf?\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /:\(\)\s*\{/,
  /shutdown|reboot\s+-/i,
];

/** HIGH — credential / exfiltration phrasing (action + secret, or secret + external sink). */
const EXFIL_PATTERNS: RegExp[] = [
  /(send|upload|post|transmit|exfiltrate|include|embed|paste|hardcode).{0,60}(api[-_ ]?key|secret[-_ ]?(key|token)?|password|bearer token)/i,
  /(api[-_ ]?key|secret[-_ ]?(key|token)?|password|bearer token).{0,60}(send|upload|post|transmit|dashboard|to\s+(an?\s+)?(external|remote|third[- ]?party))/i,
];

/** MEDIUM/HIGH — network activity hints in instruction text. */
const NETWORK_PHRASE_PATTERNS: RegExp[] = [
  /\bcurl\b/,
  /\bwget\b/,
  /\bfetch\s*\(\s*['"]https?:/i,
  /https?:\/\/[a-z0-9.-]+\//i,
  /\bPOST\b.{0,40}\bhttp/i,
];

/** HIGH — suspicious script names under scripts/. */
const SUSPICIOUS_SCRIPT_PATTERNS: RegExp[] = [
  /install/i,
  /setup/i,
  /payload/i,
  /exfil/i,
  /remote/i,
  /mine/i,
];

function add(
  out: SecurityFinding[],
  check: SecurityCheck,
  severity: SecuritySeverity,
  message: string,
): void {
  out.push({ check, severity, message });
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function inspectInstructions(def: InstallSkillDef, out: SecurityFinding[]): void {
  const text = def.content.instructions;
  if (!text.trim()) {
    add(out, 'INSTRUCTIONS', 'MEDIUM', 'SKILL.md is empty — instructions not inspectable.');
    return;
  }
  if (matchesAny(text, DESTRUCTIVE_PATTERNS)) {
    add(out, 'INSTRUCTIONS', 'HIGH', 'Instructions reference destructive commands (rm -rf, mkfs, shutdown, …).');
  }
  if (matchesAny(text, EXFIL_PATTERNS)) {
    add(out, 'INSTRUCTIONS', 'HIGH', 'Instructions mention credentials/secrets in an exfiltration context (api keys, passwords, uploads).');
  }
  if (matchesAny(text, SHELL_PHRASE_PATTERNS)) {
    add(
      out,
      'INSTRUCTIONS',
      def.declared.shell ? 'LOW' : 'MEDIUM',
      def.declared.shell
        ? 'Instructions describe command execution; covered by the declared shell capability.'
        : 'Instructions describe executing commands but no shell capability was declared.',
    );
  }
  if (matchesAny(text, NETWORK_PHRASE_PATTERNS)) {
    add(
      out,
      'INSTRUCTIONS',
      def.declared.network ? 'LOW' : 'MEDIUM',
      def.declared.network
        ? 'Instructions reference network calls; covered by the declared network capability.'
        : 'Instructions reference network calls (curl, fetch, http URLs) but no network capability was declared.',
    );
  }
  if (out.filter((f) => f.check === 'INSTRUCTIONS').length === 0) {
    add(out, 'INSTRUCTIONS', 'INFO', 'Instructions contain no risky phrases.');
  }
}

function inspectScripts(def: InstallSkillDef, out: SecurityFinding[]): void {
  const scripts = def.content.scripts;
  if (scripts.length === 0) {
    add(out, 'SCRIPTS', 'INFO', 'No scripts/ entries to inspect.');
    return;
  }
  if (scripts.some((s) => SUSPICIOUS_SCRIPT_PATTERNS.some((p) => p.test(s)))) {
    add(out, 'SCRIPTS', 'HIGH', `Suspicious script name(s) under scripts/: ${scripts.join(', ')}.`);
  }
  if (!def.declared.shell) {
    add(out, 'SCRIPTS', 'MEDIUM', `scripts/ present (${scripts.length} file(s)) but no shell capability was declared.`);
  } else {
    add(out, 'SCRIPTS', 'INFO', `${scripts.length} script(s) covered by the declared shell capability.`);
  }
}

function inspectNetwork(def: InstallSkillDef, out: SecurityFinding[]): void {
  if (def.declared.network) {
    add(out, 'NETWORK', 'HIGH', 'Skill declares outbound network access — needs stronger policy (HUMAN_APPROVAL).');
  } else {
    add(out, 'NETWORK', 'INFO', 'No network capability declared.');
  }
}

function inspectFileAccess(def: InstallSkillDef, out: SecurityFinding[]): void {
  switch (def.declared.fileAccess) {
    case 'WRITE':
      add(out, 'FILE_ACCESS', 'HIGH', 'Skill declares WRITE file access — can mutate the workspace/machine.');
      break;
    case 'READ':
      add(out, 'FILE_ACCESS', 'LOW', 'Skill declares READ-only file access.');
      break;
    default:
      add(out, 'FILE_ACCESS', 'INFO', 'No file access declared.');
  }
}

function inspectShell(def: InstallSkillDef, out: SecurityFinding[]): void {
  if (def.declared.shell) {
    add(out, 'SHELL', 'HIGH', 'Skill declares shell/process execution — needs stronger policy (HUMAN_APPROVAL).');
  } else {
    add(out, 'SHELL', 'INFO', 'No shell capability declared.');
  }
}

function inspectTrust(def: InstallSkillDef, out: SecurityFinding[]): void {
  switch (def.trustLevel) {
    case 'UNREVIEWED':
      add(out, 'TRUST', 'MEDIUM', 'Skill is UNREVIEWED — treat findings with extra suspicion.');
      break;
    case 'COMMUNITY':
      add(out, 'TRUST', 'LOW', 'Community-sourced skill — no official review.');
      break;
    default:
      add(out, 'TRUST', 'INFO', `${def.trustLevel} skill.`);
  }
}

/**
 * Run the §74 install-time security checklist for a skill definition.
 * Returns the checklist; the caller decides whether to block on HIGH.
 */
export function scanSkill(def: InstallSkillDef): SecurityChecklist {
  const checks: SecurityFinding[] = [];
  inspectInstructions(def, checks);
  inspectScripts(def, checks);
  inspectNetwork(def, checks);
  inspectFileAccess(def, checks);
  inspectShell(def, checks);
  inspectTrust(def, checks);
  const overall = checks.reduce<SecuritySeverity>(
    (max, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[max] ? f.severity : max),
    'INFO',
  );
  return {
    skillId: def.id,
    version: def.version,
    checks,
    overall,
    requiresHumanApproval: overall === 'HIGH',
    checkedAt: new Date().toISOString(),
  };
}

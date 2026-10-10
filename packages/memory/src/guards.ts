/**
 * Memory write guards — SPEC v2 §43.4 (prohibited scope) + §43.3 contradiction source authority.
 *
 * §43.4 forbids:
 *  1. storing raw secrets / tokens / irrelevant copies of personal sensitive data;
 *  2. concluding from a successful deploy that "next time we can skip approval";
 *  3. writing a Manager's claim as an actual test result;
 *  4. memory that grants permissions, changes AC, or overrides Policy.
 *
 * Every guard throws MemoryError; `MemoryStore.write` runs all of them
 * before any dedup/merge or persistence, so a prohibited write never lands.
 */
import { MemoryType } from './types';

export type MemoryErrorCode =
  | 'SECRET_DETECTED'
  | 'PROHIBITED_CONCLUSION'
  | 'MANAGER_CLAIM_NEEDS_EVIDENCE'
  | 'AUTHORIZATION_FORBIDDEN'
  | 'ENTRY_NOT_FOUND'
  | 'INVALID_INPUT';

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;
  constructor(code: MemoryErrorCode, message: string) {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
  }
}

// ---------------------------------------------------------------- secrets --

/**
 * Patterns that indicate a raw secret/token in title or content (§43.4.1).
 * Kept deliberately narrow to avoid false positives on ordinary prose:
 * every pattern requires either a well-known secret prefix or an explicit
 * key/password/token assignment with a high-entropy value.
 */
const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'openai-key', re: /\bsk-(?:live|test)-[A-Za-z0-9]{16,}\b/ },
  { name: 'openai-key-short', re: /\bsk-[A-Za-z0-9]{24,}\b/ },
  { name: 'github-pat', re: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { name: 'github-oauth', re: /\bgho_[A-Za-z0-9]{20,}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{25,}\b/ },
  { name: 'stripe-live-key', re: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  { name: 'api-key-assignment', re: /api[_-]?key\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}["']?/i },
  { name: 'secret-assignment', re: /\bsecret\s*[:=]\s*["']?[A-Za-z0-9_\-]{8,}["']?/i },
  { name: 'token-assignment', re: /\btoken\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}["']?/i },
  { name: 'password-assignment', re: /password\s*[:=]\s*["']?\S{6,}["']?/i },
];

/**
 * Scan text for raw-secret patterns. Throws SECRET_DETECTED naming the
 * matched pattern (never echoing the secret value itself).
 */
export function scanForSecrets(text: string): void {
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) {
      throw new MemoryError(
        'SECRET_DETECTED',
        `refusing to store suspected raw secret (pattern: ${name}); ` +
          `memory must never hold raw secrets or tokens (§43.4)`,
      );
    }
  }
}

// ------------------------------------------------- prohibited conclusions --

/**
 * Blacklisted "skip approval" style conclusions (§43.4.2): a successful
 * deploy must never be summarized into permission to skip approval.
 */
const PROHIBITED_PHRASES: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'zh-skip-approval', re: /跳过审批/ },
  { name: 'zh-no-approval-needed', re: /下次?不(再|用|需要)审批/ },
  { name: 'zh-approval-unnecessary', re: /审批(可以|可)?(省略|免除|绕过)/ },
  { name: 'en-skip-approval', re: /skip(ped|ping)?\s+(the\s+)?approval/i },
  { name: 'en-bypass-approval', re: /bypass\s+(the\s+)?approval/i },
  { name: 'en-no-approval-needed', re: /no\s+(longer|more)\s+(need|needs)\s+approval/i },
  { name: 'en-approval-unnecessary', re: /approval\s+(is\s+|can\s+be\s+)?(unnecessary|not\s+required|waived)/i },
];

/** Reject "next time we can skip approval" conclusions (§43.4.2). */
export function checkProhibitedConclusion(title: string, content: string): void {
  const text = `${title}\n${content}`;
  for (const { name, re } of PROHIBITED_PHRASES) {
    if (re.test(text)) {
      throw new MemoryError(
        'PROHIBITED_CONCLUSION',
        `refusing to store prohibited conclusion (matched: ${name}); ` +
          `successful deploys never imply approval can be skipped (§43.4)`,
      );
    }
  }
}

// ------------------------------------------------------- manager claims ----

/** Entry types that count as "test results" for the manager-claim rule. */
const TEST_RESULT_TYPES: ReadonlyArray<MemoryType> = ['Fact', 'Lesson', 'Failure', 'Solution'];

/**
 * A Manager's claim is not an actual test result (§43.4.3): entries whose
 * source is `manager-claim` and which carry no evidence are rejected
 * outright. (The spec allows "throw or force PROPOSED"; this
 * implementation throws, so unevidenced manager claims never enter the
 * store at all.)
 */
export function checkManagerClaim(
  source: string,
  evidenceIds: string[],
  type: MemoryType,
): void {
  const isManagerClaim = source === 'manager-claim' || source.startsWith('manager-claim:');
  if (isManagerClaim && evidenceIds.length === 0 && TEST_RESULT_TYPES.includes(type)) {
    throw new MemoryError(
      'MANAGER_CLAIM_NEEDS_EVIDENCE',
      `refusing to store manager-claim '${type}' without evidence; ` +
        `a Manager's claim is not an actual test result (§43.4)`,
    );
  }
}

// --------------------------------------------- authorization assertions -----

/**
 * Patterns that indicate an entry claims to grant permissions, change AC,
 * or override Policy (§43.4.4). Memory can never do any of these.
 */
const AUTHORIZATION_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'grant-permission', re: /grant(s|ed|ing)?\s+(the\s+|a\s+)?(permission|access|admin|privilege|role)/i },
  { name: 'grant-zh', re: /授予(权限|访问权|管理权|管理员)/ },
  { name: 'change-ac', re: /(chang|modif)(e|es|y|ying)\s+(the\s+)?(AC|access control|ACL)/i },
  { name: 'change-ac-zh', re: /(修改|变更|更改)\s*(AC|访问控制|权限模型)/ },
  { name: 'override-policy', re: /override\s+(the\s+)?policy/i },
  { name: 'override-policy-zh', re: /覆盖\s*(策略|policy)/i },
  { name: 'self-approve', re: /self[- ]approv/i },
  { name: 'privilege-escalation', re: /(privilege|permission)\s+escalation|提权/i },
];

/**
 * §43.4.4 guard: memory must never authorize. Throws
 * AUTHORIZATION_FORBIDDEN when the entry's title/content claims to grant
 * permissions, modify AC, or override Policy. Exported standalone so
 * callers (routes, coordinators) can pre-check; `MemoryStore.write` runs
 * it on every write.
 */
export function assertMemoryNeverAuthorizes(entry: {
  title: string;
  content: string;
  type: MemoryType;
}): void {
  const text = `${entry.title}\n${entry.content}`;
  for (const { name, re } of AUTHORIZATION_PATTERNS) {
    if (re.test(text)) {
      throw new MemoryError(
        'AUTHORIZATION_FORBIDDEN',
        `refusing to store entry that claims to authorize (matched: ${name}); ` +
          `memory can never grant permissions, change AC, or override Policy (§43.4)`,
      );
    }
  }
}

// ------------------------------------------------- source authority --------

/**
 * §43.3: contradictory records are resolved by returning to the
 * authoritative source — not by newest date or highest score. Higher score
 * = more authoritative. Prefix-matched; anything unlisted scores 10.
 */
export const SOURCE_AUTHORITY: ReadonlyArray<{ prefix: string; score: number }> = [
  { prefix: 'human', score: 100 },
  { prefix: 'spec', score: 90 },
  { prefix: 'evaluation:', score: 70 },
  { prefix: 'skill:', score: 60 },
  { prefix: 'system', score: 50 },
  { prefix: 'manager-claim', score: 20 },
];

/** Authority score of a source label (§43.3 contradiction resolution). */
export function sourceAuthorityScore(source: string): number {
  for (const { prefix, score } of SOURCE_AUTHORITY) {
    if (source === prefix || source.startsWith(prefix)) return score;
  }
  return 10;
}

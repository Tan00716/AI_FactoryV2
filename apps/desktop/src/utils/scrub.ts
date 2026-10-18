/**
 * 错误文本密钥脱敏（H2 P3 修）。
 * 纯函数、零依赖：错误消息/堆栈里可能夹带 token/密钥，导出日志前先脱敏。
 * 注意这是启发式 regex，不是安全边界——调用方只在"导出/展示"层使用，
 * 不要把它当成"可以安全记录密钥"的理由。
 */

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Authorization: Bearer <token> / Bearer <token>
  [/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]'],
  // token=xxx / apiKey: "xxx" / client_secret='xxx' / password=xxx
  [
    /((?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|[a-z_]*token|secret|password|passwd|pwd)\s*[:=]\s*['"]?)[^\s'"`,;}]+/gi,
    '$1[REDACTED]',
  ],
  // OpenAI / OpenAI-compatible: sk-...
  [/\bsk-[A-Za-z0-9]{20,}/g, 'sk-[REDACTED]'],
  // GitHub: ghp_/gho_/ghu_/ghs_/ghr_...
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '$1_[REDACTED]'],
  // Slack: xoxb- / xoxp- / xoxa- / xoxr- / xoxs-...
  [/\bxox[bpars]-[A-Za-z0-9-]{10,}/gi, 'xox-[REDACTED]'],
  // AWS access key id: AKIA...
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA[REDACTED]'],
];

/** 纯函数：对一段文本做密钥模式脱敏。 */
export function scrubErrorText(text: string): string {
  let out = text;
  for (const [re, replacement] of SECRET_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

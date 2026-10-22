import type { LanguageDef } from './types.js';

/**
 * Language registry (round-5 task R5-B10).
 *
 * Honest boundary: only node-whitelisted languages are runnable. The exec
 * safety policy (checkCommandPolicy) allows 'node' but not python3, bash,
 * or other interpreters, so python/shell drafts are edit-only. This is a
 * property of the shared policy, not a scratch limitation — adding a
 * runner means whitelisting a binary in the policy, not touching scratch
 * code.
 */
export const LANGUAGES: readonly LanguageDef[] = [
  { id: 'typescript', label: 'TypeScript', extension: 'ts', monacoLanguage: 'typescript', runnable: true },
  { id: 'javascript', label: 'JavaScript', extension: 'js', monacoLanguage: 'javascript', runnable: true },
  { id: 'json', label: 'JSON', extension: 'json', monacoLanguage: 'json', runnable: false },
  { id: 'markdown', label: 'Markdown', extension: 'md', monacoLanguage: 'markdown', runnable: false },
  { id: 'plaintext', label: 'Plain text', extension: 'txt', monacoLanguage: 'plaintext', runnable: false },
] as const;

export function languageById(id: string): LanguageDef | null {
  return LANGUAGES.find((l) => l.id === id) ?? null;
}

export function languageIds(): string[] {
  return LANGUAGES.map((l) => l.id);
}

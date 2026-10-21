/**
 * Shared "current editor location" state for the Design panel's
 * code→preview reverse lookup (task ⑨ item 3). EditorPanel writes here
 * on file open / cursor move (module-level, no React re-render); the
 * Design panel reads it when the operator clicks "locate preview".
 */
export const editorCursor: { path: string | null; line: number } = {
  path: null,
  line: 0,
};

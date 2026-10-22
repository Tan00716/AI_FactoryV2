/**
 * @ai-factory/ssr — structural search and replace (JetBrains-SSR style).
 *
 * Search by AST *shape* (kind, modifiers, type annotations, arity, size,
 * enclosing scope) instead of text; replace with deterministic text edits
 * (rename / replaceRange / addModifier). Zero model keys, zero native
 * dependencies, pure node builtins.
 *
 * Scanner lineage: the heuristic regex pass of @ai-factory/codeindex
 * (which @ai-factory/repomap reuses), extended with the fields SSR
 * needs — visibility/static/async modifiers, variable type annotations,
 * parameter lists, and start..end ranges via brace matching. TS/JS only.
 * See types.ts for the documented honest limitations.
 */
export type {
  StructNode,
  StructNodeKind,
  SsrSearchSpec,
  SsrReplaceSpec,
  SsrTemplate,
  SsrMatch,
  FileEdit,
  ApplyResult,
} from './types.js';
export { extractStructNodes, codeMask, ssrSupportedExtensions } from './scanner.js';
export {
  validateTemplate,
  nodeMatches,
  findMatches,
  builtinTemplates,
  builtinTemplateById,
  TEMPLATE_ID_RE,
} from './template.js';
export {
  resolveMatch,
  renameInScope,
  replaceRangeEdit,
  addModifierEdit,
  renderDiff,
  previewEdits,
  applyEdits,
} from './replace.js';
export type { ResolvedMatch } from './replace.js';
export type { ScannedInput } from './template.js';

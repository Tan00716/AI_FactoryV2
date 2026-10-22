/**
 * @ai-factory/snippets — snippet library (live templates).
 *
 * Pure-text template engine + fail-closed validation + provider registry +
 * builtin defaults. Expanding a snippet never executes code.
 */
export type {
  SnippetDef,
  SnippetProvider,
  TemplateSegment,
  ExpandedSnippet,
} from './types.js';
export type { VariableValues } from './template.js';
export { MAX_SNIPPET_BODY_BYTES, MAX_SNIPPETS_PER_FILE, MAX_PLACEHOLDER_INDEX, BUILTIN_VARIABLES } from './types.js';
export {
  parseTemplate,
  expandSnippet,
  previewSnippet,
  scopeMatches,
  SnippetTemplateError,
} from './template.js';
export { validateSnippets } from './validate.js';
export type { ValidatedSnippets } from './validate.js';
export { BUILTIN_SNIPPETS } from './defaults.js';
export { SnippetProviderRegistry } from './providers.js';

/**
 * Desktop snippet integration (round-5 task R5-A6).
 *
 * - Loads user snippets from the server (.ai-factory/snippets.json of the
 *   current project root) and merges them with builtin defaults plus any
 *   plugin-registered providers (user snippets win on id collision).
 * - Registers ONE Monaco CompletionItemProvider (selector language '*') that
 *   filters by snippet scope and offers trigger-word completion. Actual Tab
 *   expansion and placeholder Tab-navigation are handled by Monaco's own
 *   snippet support (InsertAsSnippet) — we never intercept Tab, so input
 *   boxes and the suggest widget keep their native behavior (fail-closed).
 * - Builtin ${DATE}/${TIME}/${FILENAME} variables are resolved at completion
 *   time; $1/${1:x}/$0 pass through verbatim for Monaco.
 * - Pure text substitution: expansion never executes code.
 */
import monaco from '../monacoSetup';
import {
  BUILTIN_SNIPPETS,
  expandSnippet,
  scopeMatches,
  SnippetProviderRegistry,
  validateSnippets,
} from '@ai-factory/snippets';
import type { SnippetDef, SnippetProvider } from '@ai-factory/snippets';
import { api } from '../api';

export const SNIPPET_INSERT_COMMAND = 'snippet.insert';

const registry = new SnippetProviderRegistry();
let builtinRegistered = false;

export function registerSnippetProvider(provider: SnippetProvider): void {
  registry.register(provider);
}

/** User snippets loaded from the server (current project root). */
let userSnippets: SnippetDef[] = [];
let userRoot: string | null = null;

export function getUserSnippets(): SnippetDef[] {
  return [...userSnippets];
}

export function getUserSnippetRoot(): string | null {
  return userRoot;
}

export function setUserSnippets(root: string, snippets: SnippetDef[]): void {
  userRoot = root;
  userSnippets = [...snippets];
}

/** Merged view: user snippets override provider snippets on id collision. */
export function getMergedSnippets(): SnippetDef[] {
  const byId = new Map<string, SnippetDef>();
  for (const s of registry.getAll()) byId.set(s.id, s);
  for (const s of userSnippets) byId.set(s.id, s);
  return [...byId.values()];
}

/** All validation issues for the current user set (empty = clean). */
export function validateUserSnippets(snippets: unknown): string[] {
  return validateSnippets(snippets).issues;
}

async function loadFromServer(root: string): Promise<void> {
  try {
    const res = await api.snippetsGet(root);
    const { snippets } = validateSnippets(res.snippets);
    setUserSnippets(root, snippets);
  } catch {
    // Offline or missing project root: keep whatever we had.
  }
}

function filenameOf(model: monaco.editor.ITextModel | null): string {
  const uri = model?.uri?.toString() ?? '';
  const slash = Math.max(uri.lastIndexOf('/'), uri.lastIndexOf('\\'));
  return slash >= 0 ? uri.slice(slash + 1) : uri || 'untitled';
}

let providerDisposable: monaco.IDisposable | null = null;

/**
 * Register the Monaco snippet completion provider (idempotent).
 * Call `refreshSnippets(root)` when the project changes.
 */
export function initSnippets(): void {
  if (!builtinRegistered) {
    builtinRegistered = true;
    registry.register({ id: 'builtin', getSnippets: () => BUILTIN_SNIPPETS });
  }
  if (providerDisposable) return;
  providerDisposable = monaco.languages.registerCompletionItemProvider(
    { scheme: 'file', language: '*' },
    {
      triggerCharacters: [],
      provideCompletionItems(model, position) {
        const lang = model.getLanguageId();
        const word = model.getWordUntilPosition(position);
        const typed = word.word.toLowerCase();
        const range = new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn,
        );
        const suggestions: monaco.languages.CompletionItem[] = [];
        for (const s of getMergedSnippets()) {
          if (!scopeMatches(s.scope, lang)) continue;
          if (typed && !s.trigger.toLowerCase().startsWith(typed)) continue;
          const expanded = expandSnippet(s, { FILENAME: filenameOf(model) });
          suggestions.push({
            label: { label: s.trigger, description: s.description ?? 'snippet' },
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: expanded.text,
            insertTextRules:
              monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
            detail: s.description,
            documentation: { value: '```\n' + expanded.preview + '\n```' },
            filterText: s.trigger,
            sortText: `0-${s.trigger}`,
          });
        }
        return { suggestions };
      },
    },
  );
}

/** Reload user snippets for a project root (call on project switch / after save). */
export async function refreshSnippets(root: string): Promise<void> {
  await loadFromServer(root);
}

/** Persist user snippets for a project root (server fail-closed-validates). */
export async function saveUserSnippets(root: string, snippets: SnippetDef[]): Promise<void> {
  await api.snippetsSave(root, snippets);
  setUserSnippets(root, snippets);
}

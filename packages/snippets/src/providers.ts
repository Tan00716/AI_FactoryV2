/**
 * Snippet provider registry — the plugin contribution point.
 *
 * Builtin defaults register through this same interface on desktop startup.
 * Plugins (W-F plugin system) can call registerSnippetProvider() at runtime
 * to contribute snippet sets; user snippets from .ai-factory/snippets.json
 * always win over provider snippets when ids collide.
 */
import type { SnippetDef, SnippetProvider } from './types.js';

export class SnippetProviderRegistry {
  private readonly providers = new Map<string, SnippetProvider>();

  register(provider: SnippetProvider): void {
    if (!provider || typeof provider.id !== 'string' || provider.id.trim().length === 0) {
      throw new Error('provider id is required');
    }
    this.providers.set(provider.id, provider);
  }

  unregister(id: string): boolean {
    return this.providers.delete(id);
  }

  ids(): string[] {
    return [...this.providers.keys()];
  }

  /** All contributed snippets, in registration order (never throws). */
  getAll(): SnippetDef[] {
    const out: SnippetDef[] = [];
    for (const p of this.providers.values()) {
      try {
        const list = p.getSnippets();
        if (Array.isArray(list)) out.push(...list);
      } catch {
        // A failing provider must not break snippet listing.
      }
    }
    return out;
  }
}

/**
 * Command registry for the keybinding system (round-5 R5-S1). Pure,
 * zero-dependency, UI-agnostic.
 *
 * Layers (low → high precedence):
 *   1. defaults from registerCommand (builtin / plugin contributions)
 *   2. user layer from setUserKeybindings (keybindings.json content)
 *
 * Conflict policy (honest, never silent): when two commands share one
 * normalized sequence, the later-registered / higher-precedence binding
 * wins dispatch, and detectConflicts() + the resolution's `overridden`
 * list name the shadowed commands so the UI can warn.
 */
import type {
  BindingConflict,
  CommandRegistration,
  CommandSource,
  EffectiveBinding,
  KeybindingPlatform,
  KeyChord,
  KeySequence,
  PrefixCandidate,
  SequenceResolution,
  UserKeybinding,
  ValidationIssue,
} from './types.js';
import {
  canonicalSequence,
  chordEquals,
  parseKeybinding,
  KeybindingParseError,
} from './parse.js';
import { formatSequence, platformFromNode } from './platform.js';

interface StoredCommand {
  id: string;
  title: string;
  source: CommandSource;
  defaultKeys: string[];
}

export class KeybindingRegistry {
  private readonly platform: KeybindingPlatform;
  private readonly commands = new Map<string, StoredCommand>();
  private readonly registrationOrder: string[] = [];
  private userEntries: UserKeybinding[] = [];

  constructor(platform?: KeybindingPlatform) {
    this.platform = platform ?? platformFromNode();
  }

  getPlatform(): KeybindingPlatform {
    return this.platform;
  }

  /** Register a command; duplicate ids throw (fail-closed). */
  registerCommand(reg: CommandRegistration): void {
    if (typeof reg.id !== 'string' || reg.id.trim() === '') {
      throw new Error('registerCommand: id must be a non-empty string');
    }
    if (this.commands.has(reg.id)) {
      throw new Error(`registerCommand: duplicate command id ${JSON.stringify(reg.id)}`);
    }
    const defaultKeys = reg.defaultKeys ?? [];
    for (const k of defaultKeys) {
      try {
        parseKeybinding(k, this.platform);
      } catch (err) {
        throw new Error(
          `registerCommand ${JSON.stringify(reg.id)}: default key invalid: ${(err as Error).message}`,
        );
      }
    }
    this.commands.set(reg.id, {
      id: reg.id,
      title: reg.title ?? reg.id,
      source: reg.source ?? 'builtin',
      defaultKeys,
    });
    this.registrationOrder.push(reg.id);
  }

  registerCommands(regs: CommandRegistration[]): void {
    for (const r of regs) this.registerCommand(r);
  }

  unregisterCommand(id: string): void {
    this.commands.delete(id);
    const i = this.registrationOrder.indexOf(id);
    if (i >= 0) this.registrationOrder.splice(i, 1);
  }

  hasCommand(id: string): boolean {
    return this.commands.has(id);
  }

  commandIds(): string[] {
    return [...this.registrationOrder];
  }

  /**
   * Replace the user layer. Invalid entries are rejected individually
   * (fail-closed) and reported; valid entries are applied. Returns the
   * issues found (empty = all applied).
   */
  setUserKeybindings(entries: unknown): ValidationIssue[] {
    const issues = validateUserKeybindings(entries);
    if (issues.length > 0) return issues;
    this.userEntries = (entries as UserKeybinding[]).map((e) => ({
      command: e.command.startsWith('-') ? e.command.slice(1) : e.command,
      key: e.key,
      ...(e.when !== undefined ? { when: e.when } : {}),
    }));
    return [];
  }

  getUserKeybindings(): UserKeybinding[] {
    return this.userEntries.map((e) => ({ ...e }));
  }

  /** Merged effective bindings for every registered command. */
  effectiveBindings(): EffectiveBinding[] {
    const out: EffectiveBinding[] = [];
    for (const id of this.registrationOrder) {
      const cmd = this.commands.get(id)!;
      const defaultSeqs: KeySequence[] = cmd.defaultKeys.map((k) =>
        parseKeybinding(k, this.platform),
      );
      const userSeqs: KeySequence[] = [];
      let unboundByUser = false;
      for (const e of this.userEntries) {
        if (e.command !== id) continue;
        if (e.key === null) {
          unboundByUser = true;
        } else {
          userSeqs.push(parseKeybinding(e.key, this.platform));
        }
      }
      const sequences = unboundByUser ? userSeqs : [...defaultSeqs, ...userSeqs];
      const bindingSource =
        sequences.length === 0
          ? 'unbound'
          : unboundByUser || (userSeqs.length > 0 && defaultSeqs.length === 0)
            ? 'user'
            : userSeqs.length > 0
              ? 'mixed'
              : 'default';
      out.push({
        command: id,
        title: cmd.title,
        source: cmd.source,
        sequences,
        bindingSource,
        display: sequences.map((s) => formatSequence(s, this.platform)),
      });
    }
    return out;
  }

  /**
   * All normalized sequences claimed by more than one command.
   * Later registration / user layer wins dispatch; every loser is listed.
   */
  detectConflicts(): BindingConflict[] {
    const bySeq = new Map<string, Array<{ id: string; title: string; source: string }>>();
    for (const b of this.effectiveBindings()) {
      for (const seq of b.sequences) {
        const key = canonicalSequence(seq);
        const list = bySeq.get(key) ?? [];
        list.push({ id: b.command, title: b.title, source: `${b.source}/${b.bindingSource}` });
        bySeq.set(key, list);
      }
    }
    const conflicts: BindingConflict[] = [];
    for (const [key, cmds] of bySeq) {
      const unique = [...new Map(cmds.map((c) => [c.id, c])).values()];
      if (unique.length > 1) {
        const seq = this.effectiveBindings()
          .flatMap((b) => b.sequences)
          .find((s) => canonicalSequence(s) === key)!;
        conflicts.push({ sequence: formatSequence(seq, this.platform), commands: unique });
      }
    }
    return conflicts;
  }

  /**
   * Dispatch a completed sequence. User-layer bindings take precedence over
   * defaults; within a layer the latest entry wins. The returned
   * `overridden` names every shadowed command (never silent).
   */
  resolveSequence(seq: KeySequence): SequenceResolution | null {
    const key = canonicalSequence(seq);
    const eff = this.effectiveBindings();
    const order: Array<{ command: string; title: string; layer: number }> = [];
    for (const b of eff) {
      for (const s of b.sequences) {
        if (canonicalSequence(s) === key) {
          // Defaults first, user bindings after: later entries win.
          const layer = b.bindingSource === 'default' || b.bindingSource === 'unbound' ? 0 : 1;
          order.push({ command: b.command, title: b.title, layer });
        }
      }
    }
    if (order.length === 0) return null;
    // Stable: within the same layer, the later effective entry wins; the
    // effective list follows registration order, so the last wins.
    const topLayer = Math.max(...order.map((o) => o.layer));
    const top = order.filter((o) => o.layer === topLayer);
    const winner = top[top.length - 1];
    const overridden = order
      .filter((o) => o.command !== winner.command)
      .map((o) => o.command)
      .filter((c, i, arr) => arr.indexOf(c) === i);
    return { command: winner.command, title: winner.title, overridden };
  }

  /**
   * which-key: given a pressed prefix, list every possible next chord with
   * the commands each chord can lead to.
   */
  prefixCandidates(prefix: KeySequence): PrefixCandidate[] {
    const grouped = new Map<string, { next: KeyChord; commands: Array<{ id: string; title: string }> }>();
    for (const b of this.effectiveBindings()) {
      for (const seq of b.sequences) {
        if (seq.length <= prefix.length) continue;
        let ok = true;
        for (let i = 0; i < prefix.length; i++) {
          if (!chordEquals(seq[i], prefix[i])) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        const next = seq[prefix.length];
        const key = canonicalSequence([next]);
        const g = grouped.get(key) ?? { next, commands: [] };
        if (!g.commands.some((c) => c.id === b.command)) {
          g.commands.push({ id: b.command, title: b.title });
        }
        grouped.set(key, g);
      }
    }
    return [...grouped.values()].map((g) => ({
      next: g.next,
      display: formatSequence([g.next], this.platform),
      commands: g.commands,
    }));
  }
}

/**
 * Fail-closed validation of a keybindings.json payload. Returns issues;
 * empty means the payload is safe to apply. Platform-agnostic (syntax
 * only) — conflicts are detected client-side where the platform is known.
 */
export function validateUserKeybindings(entries: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!Array.isArray(entries)) {
    return [{ index: -1, message: 'keybindings must be a JSON array' }];
  }
  entries.forEach((raw, index) => {
    const fail = (message: string) => issues.push({ index, message });
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      fail('entry must be an object');
      return;
    }
    const e = raw as Record<string, unknown>;
    if (typeof e['command'] !== 'string' || (e['command'] as string).trim() === '') {
      fail('entry.command must be a non-empty string');
    }
    const key = e['key'];
    if (key !== null && typeof key !== 'string') {
      fail('entry.key must be a string or null');
    } else if (typeof key === 'string') {
      // Syntax-check against all platforms: a key valid on one platform
      // must not be rejected just because the server runs another.
      const platforms: Array<'mac' | 'windows' | 'linux'> = ['mac', 'windows', 'linux'];
      const errors: string[] = [];
      for (const p of platforms) {
        try {
          parseKeybinding(key, p);
        } catch (err) {
          errors.push((err as KeybindingParseError).message);
        }
      }
      if (errors.length === platforms.length) fail(`entry.key invalid: ${errors[0]}`);
    }
    if (e['when'] !== undefined && typeof e['when'] !== 'string') {
      fail('entry.when must be a string when present');
    }
    for (const k of Object.keys(e)) {
      if (k !== 'command' && k !== 'key' && k !== 'when') {
        fail(`unknown field ${JSON.stringify(k)}`);
      }
    }
  });
  return issues;
}

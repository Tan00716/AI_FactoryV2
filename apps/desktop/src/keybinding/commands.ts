/**
 * Builtin command definitions for the keybinding system (round-5 R5-S1).
 *
 * Commands are the single source of truth for "what can be bound": the
 * command palette's tab jumps, the palette toggle itself, and language
 * switching. Dispatch is a window CustomEvent ('ai-factory:command') so
 * panels stay decoupled from the manager.
 */
import { COMMAND_EVENT } from './manager';

/** Center-tab names, mirrors the union in App.tsx. */
export const BUILTIN_TABS = [
  'Dashboard', 'Ops', 'Report', 'Board', 'Git', 'QA', 'Approvals', 'Permissions',
  'NeedsHuman', 'Dispatch', 'CI/CD', 'Skills', 'Memory', 'MCP', 'Knowledge',
  'Evaluation', 'Agents', 'Orchestrate', 'Observatory', 'Manager', 'Editor',
  'Terminal', 'Changes', 'Stability', 'Project', 'Activity', 'Events', 'Models',
  'Plan', 'Hooks', 'Session', 'Plugins', 'Metrics', 'Inspections', 'Batch',
  'Collab', 'Coverage', 'Recipes', 'Design', 'Updates', 'Refactor', 'Profiler',
  'HTTP', 'Debug', 'Timeline',
] as const;

/** Same key derivation as the tab buttons in App.tsx / CommandPalette.tsx. */
export function tabCommandId(tab: string): string {
  return `go.tab.${tab.toLowerCase().replace('/', '')}`;
}

/** Inverse of tabCommandId: command id -> tab display name (or null). */
export function tabNameForCommand(commandId: string): string | null {
  const m = /^go\.tab\.(.+)$/.exec(commandId);
  if (!m) return null;
  const found = (BUILTIN_TABS as readonly string[]).find(
    (t) => t.toLowerCase().replace('/', '') === m[1],
  );
  return found ?? null;
}

export const PALETTE_TOGGLE_COMMAND = 'palette.toggle';
export const LANGUAGE_SWITCH_COMMAND = 'language.switch';

/** i18n key for a command title, or null when the caller should fall back. */
export function commandTitleKey(commandId: string): string | null {
  if (commandId === PALETTE_TOGGLE_COMMAND) return 'keybinding.cmd.palette.toggle';
  if (commandId === LANGUAGE_SWITCH_COMMAND) return 'keybinding.cmd.language.switch';
  const tab = tabNameForCommand(commandId);
  if (tab) return `tab.${tab.toLowerCase().replace('/', '')}`;
  return null;
}

/** Fire a command id on the decoupled event bus. */
export function dispatchCommand(commandId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail: { commandId } }));
}

export type CommandEventHandler = (commandId: string) => void;

/** Subscribe to dispatched commands; returns an unsubscribe function. */
export function onCommand(handler: CommandEventHandler): () => void {
  const listener = (e: Event) => {
    const id = (e as CustomEvent<{ commandId: string }>).detail?.commandId;
    if (typeof id === 'string') handler(id);
  };
  window.addEventListener(COMMAND_EVENT, listener);
  return () => window.removeEventListener(COMMAND_EVENT, listener);
}

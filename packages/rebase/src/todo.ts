/**
 * Rebase todo file parsing and serialization (pure functions).
 *
 * The git todo format is one `action hash subject` line per commit.
 * Parsing is fail-closed: unknown actions (including git's own
 * `exec`/`label`/`reset`/`merge`/`update-ref`), malformed hashes,
 * duplicate hashes, and empty todos are all rejected — the UI only
 * offers the five supported actions, so anything else means the file
 * was hand-edited or came from another tool.
 */
import { RebaseError, TODO_ACTIONS, type TodoAction, type TodoLine } from './types.js';

const FULL_HASH = /^[0-9a-f]{40}$/;
const SHORT_HASH = /^[0-9a-f]{7,39}$/;

/** Parse todo text into lines. Comments (#) and blank lines are skipped. */
export function parseTodo(text: string): TodoLine[] {
  const lines: TodoLine[] = [];
  const seen = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+)(?:\s+(.*))?$/.exec(line);
    if (!m) {
      throw new RebaseError(`cannot parse todo line: ${line.slice(0, 80)}`, 'TODO_PARSE_ERROR');
    }
    const [, action, rest] = m;
    if (!TODO_ACTIONS.has(action)) {
      throw new RebaseError(`unsupported todo action: ${action}`, 'TODO_UNSUPPORTED_ACTION');
    }
    const hm = /^([0-9a-f]+)(?:\s+(.*))?$/.exec(rest ?? '');
    if (!hm) {
      throw new RebaseError(`malformed commit hash in todo line: ${line.slice(0, 80)}`, 'TODO_BAD_HASH');
    }
    const [, hash, subject] = hm;
    if (!FULL_HASH.test(hash) && !SHORT_HASH.test(hash)) {
      throw new RebaseError(`malformed commit hash in todo: ${hash}`, 'TODO_BAD_HASH');
    }
    if (seen.has(hash)) {
      throw new RebaseError(`duplicate commit in todo: ${hash}`, 'TODO_DUPLICATE');
    }
    seen.add(hash);
    lines.push({ action: action as TodoAction, hash, subject: subject ?? '' });
  }
  if (lines.length === 0) {
    throw new RebaseError('todo is empty: refusing to run a no-op rebase', 'TODO_EMPTY');
  }
  return lines;
}

/** Serialize lines back to git todo format (subject is informational). */
export function serializeTodo(lines: TodoLine[]): string {
  return lines.map((l) => `${l.action} ${l.hash} ${l.subject}`.trimEnd()).join('\n') + '\n';
}

/**
 * Validate a planned todo against the repo's actual range: every hash
 * must resolve to a commit in `base..HEAD`, in any order (the user may
 * reorder), and every range commit must appear exactly once — dropping
 * is expressed with the `drop` action, not by omitting a line, so a
 * missing line is a user error, not a silent drop.
 */
export function validateTodoAgainstRange(
  todos: TodoLine[],
  rangeHashes: string[],
): void {
  const range = new Set(rangeHashes);
  const todoHashes = new Set<string>();
  for (const t of todos) {
    const full = rangeHashes.find((h) => h.startsWith(t.hash));
    if (!full) {
      throw new RebaseError(`todo commit not in range: ${t.hash}`, 'TODO_OUT_OF_RANGE');
    }
    if (todoHashes.has(full)) {
      throw new RebaseError(`duplicate commit in todo: ${t.hash}`, 'TODO_DUPLICATE');
    }
    todoHashes.add(full);
  }
  for (const h of rangeHashes) {
    if (!todoHashes.has(h)) {
      throw new RebaseError(`range commit missing from todo: ${h.slice(0, 12)}`, 'TODO_MISSING_COMMIT');
    }
  }
}

/** Normalize short hashes in a todo to full hashes using the range. */
export function expandTodoHashes(todos: TodoLine[], rangeHashes: string[]): TodoLine[] {
  return todos.map((t) => {
    if (FULL_HASH.test(t.hash)) return t;
    const full = rangeHashes.find((h) => h.startsWith(t.hash));
    if (!full) throw new RebaseError(`todo commit not in range: ${t.hash}`, 'TODO_OUT_OF_RANGE');
    return { ...t, hash: full };
  });
}

/** Reorder helper for the UI: move line at `from` to position `to`. */
export function moveTodoLine(lines: TodoLine[], from: number, to: number): TodoLine[] {
  if (from < 0 || from >= lines.length || to < 0 || to >= lines.length) {
    throw new RebaseError(`move out of range: ${from} -> ${to}`, 'TODO_MOVE_RANGE');
  }
  const out = [...lines];
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

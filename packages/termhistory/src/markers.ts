/**
 * Shell-integration markers (R4-A8) — OSC 133 sequences, VS Code style.
 *
 * The server injects a generated bash rcfile into interactive bash
 * sessions (see generateBashIntegrationRc). The shell then emits:
 *
 *   OSC 133;A ST            prompt shown
 *   OSC 133;B ST            prompt end / command-input start (in $PS1)
 *   OSC 133;C ST            a command started executing (DEBUG trap)
 *   OSC 133;D;<code> ST    command finished, <code> = exit status
 *   OSC 133;E;<b64> ST     BASH_COMMAND of a simple command (fallback text)
 *   OSC 133;H;<b64> ST     exact typed line via `fc -ln -1`
 *                          (empty payload when history did not advance,
 *                          e.g. HISTCONTROL=ignorespace)
 *
 * Markers travel inside the normal pty output stream; xterm.js consumes
 * OSC sequences without rendering them, so they are invisible in the
 * terminal. The CommandTracker (tracker.ts) parses them back out.
 *
 * Honest boundaries:
 *   - bash only. /bin/sh (and any non-bash shell) gets no markers and
 *     therefore no command history — reported as integrated:false.
 *   - The H line comes from the shell's history (fc); when the user's
 *     HISTCONTROL drops a command (e.g. ignorespace), H is empty and
 *     the tracker falls back to joining the E payloads with newlines
 *     (a best-effort approximation, documented on the entry path).
 *   - H entries are stored without leading whitespace (the fc output
 *     prefix is stripped); trailing whitespace is preserved as typed.
 *   - Markers are best-effort: a user rc that fights the DEBUG trap or
 *     rewrites $PS1 every keystroke can degrade them. The tracker only
 *     records a command when it saw C (execution) + D (exit) + H/E.
 */

export type ShellMarkerKind = 'A' | 'B' | 'C' | 'D' | 'E' | 'H';

export interface ShellMarker {
  kind: ShellMarkerKind;
  /** Raw payload after the `;<kind>;` prefix ('' when absent). */
  payload: string;
  /** Offset of the marker start in the scanned text. */
  index: number;
  /** Full marker length including OSC open and ST/BEL terminator. */
  length: number;
}

const ESC = '\x1b';
const BEL = '\x07';

/**
 * Matches one complete marker. The terminator (ST or BEL) is required,
 * so a marker split across output chunks simply does not match until
 * its tail arrives — the tracker keeps the tail buffered.
 */
const MARKER_RE = new RegExp(
  `${ESC}\\]133;([A-Z])(?:;([^${ESC}${BEL}]*))?(?:${ESC}\\\\|${BEL})`,
  'g',
);

/** Scan text for complete shell-integration markers (in order). */
export function findMarkers(text: string): ShellMarker[] {
  const out: ShellMarker[] = [];
  MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(text)) !== null) {
    const kind = m[1] as ShellMarkerKind;
    if (kind !== 'A' && kind !== 'B' && kind !== 'C' && kind !== 'D' && kind !== 'E' && kind !== 'H') {
      continue;
    }
    out.push({ kind, payload: m[2] ?? '', index: m.index, length: m[0].length });
    // Guard against zero-length matches looping forever.
    if (m[0].length === 0) MARKER_RE.lastIndex++;
  }
  return out;
}

/** Env var carrying the generated rcfile text into the session. */
export const INTEGRATION_ENV_VAR = 'AF_SHELL_INTEGRATION_RC';

/** Fixed path (inside the session, /tmp is always writable) for the rcfile. */
export const INTEGRATION_RC_PATH = '/tmp/.af-bash-integration-rc';

/**
 * The bash integration script. Installed via --rcfile (see
 * bashIntegrationWrapper). Sources the user's ~/.bashrc first, then:
 *   - wraps $PROMPT_COMMAND (ours runs first, so $? is captured before
 *     user hooks run) to emit D;<exit>, H;<typed line>, A;
 *   - re-applies the B emitter to $PS1 before every prompt (survives
 *     later $PS1 rewrites by frameworks);
 *   - installs a guarded DEBUG trap emitting C + E;<BASH_COMMAND>.
 *
 * Verified against real bash: $? survives the DEBUG trap, exit codes
 * D;0/D;1/D;2/D;42 all correct, Ctrl+C at prompt yields D;130 with no
 * C (aborted line discarded), empty lines yield no C.
 */
export function generateBashIntegrationRc(): string {
  return [
    '# ai-factory shell integration (R4-A8) — generated, do not edit.',
    '# OSC 133 markers: A prompt, B input-start, C exec-start,',
    '# D;<code> exec-end, E;<b64> BASH_COMMAND (fallback),',
    '# H;<b64> exact typed line via fc (empty when history stalls).',
    '# Best-effort: never fatal to the interactive shell.',
    '__AF_IN_PRECMD=1',
    'if [ -f "$HOME/.bashrc" ]; then',
    '  . "$HOME/.bashrc"',
    'fi',
    "__af_osc() { printf '\\033]133;%s\\033\\\\' \"$1\"; }",
    '__af_precmd() {',
    '  local ec=$?',
    '  __AF_IN_PRECMD=1',
    '  case "$PS1" in',
    "    *'__af_osc B'*) ;;",
    '    *) PS1=\'\\[$(__af_osc B)\\]\'"$PS1" ;;',
    '  esac',
    '  __af_osc "D;$ec"',
    '  local _num _cmd',
    "  _num=$(HISTTIMEFORMAT= history 1 2>/dev/null | awk '{print $1}')",
    '  if [ -n "$_num" ] && [ "$_num" = "$__AF_LAST_HISTNO" ]; then',
    '    __af_osc "H;"',
    '  else',
    "    _cmd=$(fc -ln -1 2>/dev/null | sed 's/^[[:space:]]*//')",
    '    __af_osc "H;$(printf \'%s\' "$_cmd" | base64 | tr -d \'\\n\')"',
    '  fi',
    '  __AF_LAST_HISTNO=$_num',
    '  __af_osc "A"',
    '  __AF_IN_PRECMD=',
    '}',
    '__af_debug() {',
    '  [ -n "$__AF_IN_PRECMD" ] && return 0',
    '  case "$BASH_COMMAND" in __af_*) return 0;; esac',
    '  __af_osc "C"',
    '  __af_osc "E;$(printf \'%s\' "$BASH_COMMAND" | base64 | tr -d \'\\n\')"',
    '}',
    'PROMPT_COMMAND="__af_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"',
    "if [ -z \"$PS1\" ]; then PS1='\\s-\\v\\$ '; fi",
    "trap '__af_debug' DEBUG",
    '__AF_LAST_HISTNO=$(HISTTIMEFORMAT= history 1 2>/dev/null | awk \'{print $1}\')',
    '__AF_IN_PRECMD=',
  ].join('\n') + '\n';
}

/**
 * Wrap a bash argv so the session runs with shell integration.
 * The rc text travels in $AF_SHELL_INTEGRATION_RC (env survives bwrap;
 * file paths do not) and is materialized to /tmp inside the session —
 * /tmp is a writable tmpfs in the sandbox and the real /tmp outside it.
 *
 * Result: [bash, '-c', '<write rc> && exec <bash> --rcfile /tmp/... -i'].
 * bashPath must be one of the server-allowed shells (no user input).
 */
export function bashIntegrationWrapper(bashPath: string): string[] {
  const inner =
    `printf '%s' "$${INTEGRATION_ENV_VAR}" > ${INTEGRATION_RC_PATH}` +
    ` && exec ${bashPath} --rcfile ${INTEGRATION_RC_PATH} -i`;
  return [bashPath, '-c', inner];
}

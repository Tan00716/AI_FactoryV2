/**
 * Ambient-credential value redaction + control-plane pointer stripping
 * (V3.0 audit round 17, item #6 sub-items (h) and (k)).
 *
 * Two different problems, two different mechanisms — do not conflate them:
 *
 *  (h) VALUE-AWARE REDACTION. diagpack `redactText` matches secret
 *  SHAPES (key=value patterns, generic API-key shapes). It is blind to a
 *  bare credential VALUE printed on its own line — e.g. a script that
 *  prints `FACTORY_API_TOKEN=<the real value>` verbatim, or a value read
 *  back through /proc/<pid>/environ. `ambientCredentialValues()` closes
 *  that gap: it returns the values of exactly the keys
 *  `scrubCredentialEnv` drops, so the set stays in sync with the scrub
 *  table (including the R17 #6(j) additions) without copying the regex.
 *  `redactAmbientCredentialValues()` replaces those exact values with
 *  `***` (via @ai-factory/secrets `redactSecretValues`: exact-substring,
 *  longest first). This is a SECOND line of defence only — the primary
 *  fix is always the scrub (the child never receives the values) and,
 *  for vault reads, the OS sandbox. Redaction must never be read as
 *  proof that a read-back channel is closed.
 *
 *  A value shorter than 8 characters is never redacted: short values
 *  (e.g. `1`, `on`) would corrupt ordinary output, and 8 is the same
 *  minimum the SECRET_PATTERNS generic shape uses. Regression tests
 *  must use realistic 16+ character values.
 *
 *  (k) POINTER STRIPPING. `FACTORY_SECRETS_DIR`, `FACTORY_API_TOKEN_FILE`,
 *  `DB_PATH`, `AI_FACTORY_DATA_DIR`, `FACTORY_PRLINK_TOKEN_FILE` and
 *  `FACTORY_WEBHOOK_SECRET_FILE` are not credentials — their VALUES are
 *  filesystem paths. They are nevertheless dangerous in a child env:
 *  they tell an unprivileged child exactly where the vault, the admin
 *  token file and the control-plane data dir live, and the child runs
 *  as the same uid so it can read them. `stripControlPlanePointerEnv()`
 *  removes them from the ambient env passed to a child. This is
 *  deliberately SEPARATE from `scrubCredentialEnv`: the scrub table is
 *  about credential VALUES (the R17 #6(j) decision was that *_FILE
 *  vars do NOT belong there — their values are paths, not secrets),
 *  while this strip is about POINTERS (the values locate secrets).
 *  Only the ambient part is stripped: an operator-supplied explicit env
 *  overlay applied afterwards (e.g. a task's own `options.env`) is
 *  untouched, so an operator who deliberately passes a path still can.
 */
import { scrubCredentialEnv } from './pty';
import { redactSecretValues } from '@ai-factory/secrets';

/** Minimum credential-value length for value-aware redaction (see header). */
export const AMBIENT_CREDENTIAL_MIN_VALUE_LENGTH = 8;

/**
 * The ambient credential values a child must never be able to echo
 * back: the values of exactly the env keys `scrubCredentialEnv`
 * removes. Keys that survive the scrub (benign ambient vars) and
 * values shorter than AMBIENT_CREDENTIAL_MIN_VALUE_LENGTH are excluded.
 */
export function ambientCredentialValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const scrubbed = scrubCredentialEnv(env);
  const values: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value.length < AMBIENT_CREDENTIAL_MIN_VALUE_LENGTH) continue;
    if (!(key in scrubbed)) values.push(value);
  }
  return values;
}

/**
 * Replace every ambient credential value in `text` with `***`
 * (exact-substring, longest first). Returns `text` unchanged when
 * there is nothing to redact.
 */
export function redactAmbientCredentialValues(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const values = ambientCredentialValues(env);
  return values.length === 0 ? text : redactSecretValues(text, values);
}

/**
 * Control-plane pointer variables: env keys whose values are
 * filesystem paths locating credentials or control-plane data.
 * All six are read by the server itself at boot; none is needed by a
 * child process to run its command.
 */
export const CONTROL_PLANE_POINTER_ENV_VARS: readonly string[] = [
  'FACTORY_SECRETS_DIR',
  'FACTORY_API_TOKEN_FILE',
  'DB_PATH',
  'AI_FACTORY_DATA_DIR',
  'FACTORY_PRLINK_TOKEN_FILE',
  'FACTORY_WEBHOOK_SECRET_FILE',
];

/**
 * Return a copy of `env` with the control-plane pointer variables
 * removed. The server's own reads of these vars are unaffected (the
 * server never runs through a child env); only children lose the
 * pointers. Explicit operator overlays are applied by the caller
 * AFTER this strip, so a deliberate operator-supplied value survives.
 */
export function stripControlPlanePointerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of CONTROL_PLANE_POINTER_ENV_VARS) delete out[key];
  return out;
}

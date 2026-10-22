/**
 * Environment variable merging (round-4 task A6).
 *
 * Precedence (low → high): selected environment vars → explicit variables.
 */
import type { HttpEnvironment, HttpRunOptions } from './types';
import { HttpClientError } from './types';

/** Merge the selected environment's vars with explicit overrides. */
export function mergeVariables(options: HttpRunOptions = {}): Record<string, string> {
  const { environments, environment, variables } = options;
  const merged: Record<string, string> = {};
  if (environment !== undefined) {
    if (!environments || !environments[environment]) {
      throw new HttpClientError(
        `unknown environment ${JSON.stringify(environment)}`,
        'unknown-environment',
      );
    }
    const env: HttpEnvironment = environments[environment];
    for (const [k, v] of Object.entries(env.vars ?? {})) merged[k] = String(v);
  }
  for (const [k, v] of Object.entries(variables ?? {})) merged[k] = String(v);
  return merged;
}

/** Substitute `{{name}}` placeholders. Unknown names are left literal (documented). */
export function substituteVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_\-.]+)\s*\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole,
  );
}

/** Validate an environments map (from the env file or request body). Fail-closed. */
export function validateEnvironments(value: unknown): Record<string, HttpEnvironment> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpClientError('environments must be an object of { vars }', 'bad-environments');
  }
  const out: Record<string, HttpEnvironment> = {};
  for (const [name, env] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_\-.]{1,64}$/.test(name)) {
      throw new HttpClientError(`bad environment name ${JSON.stringify(name)}`, 'bad-environments');
    }
    if (typeof env !== 'object' || env === null || Array.isArray(env)) {
      throw new HttpClientError(`environment ${JSON.stringify(name)} must be { vars }`, 'bad-environments');
    }
    const rawVars = (env as { vars?: unknown }).vars ?? {};
    if (typeof rawVars !== 'object' || rawVars === null || Array.isArray(rawVars)) {
      throw new HttpClientError(`environment ${JSON.stringify(name)} vars must be an object`, 'bad-environments');
    }
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawVars as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9_\-.]{1,64}$/.test(k)) {
        throw new HttpClientError(`bad variable name ${JSON.stringify(k)}`, 'bad-environments');
      }
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
        throw new HttpClientError(`variable ${JSON.stringify(k)} must be a string/number/boolean`, 'bad-environments');
      }
      const s = String(v);
      if (s.length > 10_000) throw new HttpClientError(`variable ${JSON.stringify(k)} too long`, 'bad-environments');
      vars[k] = s;
    }
    const names = Object.keys(out);
    if (names.length >= 32) throw new HttpClientError('too many environments (cap 32)', 'bad-environments');
    out[name] = { vars };
  }
  return out;
}

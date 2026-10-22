/**
 * Dangerous-statement guard for the DB browser query console.
 *
 * Pure function, fail-closed: anything not positively recognized as
 * read or write is BLOCKED (never silently downgraded).
 *
 * Verdicts:
 *  - read:        SELECT / WITH..SELECT / EXPLAIN / read-only PRAGMA
 *  - write:       INSERT / UPDATE..WHERE / DELETE..WHERE / CREATE TABLE|INDEX|VIEW
 *                 / ALTER..ADD COLUMN / PRAGMA with '=' (mode changes)
 *  - destructive: DROP / TRUNCATE / ALTER..DROP COLUMN|RENAME / DELETE|UPDATE
 *                 without WHERE — requires the approval flow, never runs inline.
 *  - blocked:     multi-statement, ATTACH/DETACH, VACUUM/REINDEX/ANALYZE,
 *                 BEGIN/COMMIT/ROLLBACK, empty, unknown.
 *
 * WHERE detection is top-level only (ignores parenthesized subqueries),
 * so `DELETE FROM t WHERE x IN (SELECT ...)` keeps its write verdict.
 */

import type { GuardResult, SqlVerdict } from './types.js';

/** Strip line/block comments and string literals for structural analysis. */
export function maskSql(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      out += ' ';
      i++;
      while (i < n) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function fail(keyword: string, reason: string, message: string): GuardResult {
  return { verdict: 'blocked', reason, keyword, message };
}

/** True when a WHERE keyword appears at paren depth 0. */
function hasTopLevelWhere(masked: string): boolean {
  let depth = 0;
  const words = masked.match(/[A-Za-z_][A-Za-z0-9_]*|[()]/g) ?? [];
  for (const w of words) {
    if (w === '(') depth++;
    else if (w === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && w.toUpperCase() === 'WHERE') return true;
  }
  return false;
}

/** True when the masked body contains a statement-terminating ';'. */
function hasMultipleStatements(masked: string): boolean {
  const t = masked.trim().replace(/;+\s*$/, '');
  return t.includes(';');
}

/**
 * First top-level (paren depth 0) DML keyword. CTE bodies and subqueries
 * sit at depth >= 1, so `WITH a AS (SELECT 1) INSERT INTO t SELECT *`
 * correctly reports INSERT, not the trailing SELECT.
 */
function firstTopLevelDml(masked: string): string | null {
  let depth = 0;
  const words = masked.match(/[A-Za-z_][A-Za-z0-9_]*|[()]/g) ?? [];
  for (const w of words) {
    if (w === '(') depth++;
    else if (w === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      const up = w.toUpperCase();
      if (up === 'SELECT' || up === 'INSERT' || up === 'UPDATE' || up === 'DELETE' || up === 'REPLACE') return up;
    }
  }
  return null;
}

export function classifySql(raw: string): GuardResult {
  const trimmed = raw.trim();
  if (!trimmed) return fail('', 'EMPTY_SQL', 'Empty SQL is refused.');
  const masked = maskSql(trimmed);
  if (hasMultipleStatements(masked)) {
    return fail('', 'MULTIPLE_STATEMENTS', 'Only one statement per execution; split them and run separately.');
  }
  const m = masked.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)/);
  const keyword = (m?.[1] ?? '').toUpperCase();
  if (!keyword) return fail('', 'UNKNOWN_STATEMENT', 'Could not identify the statement keyword; refused.');

  const ok = (verdict: SqlVerdict, reason: string, message: string): GuardResult => ({
    verdict,
    reason,
    keyword,
    message,
  });

  switch (keyword) {
    case 'SELECT':
      return ok('read', 'READ_SELECT', 'Read-only SELECT.');
    case 'EXPLAIN':
      return ok('read', 'READ_EXPLAIN', 'Read-only EXPLAIN.');
    case 'WITH': {
      // The main statement keyword is the first top-level (depth 0)
      // SELECT|INSERT|UPDATE|DELETE after the WITH clause — CTE bodies
      // live inside parens at depth >= 1, so they cannot shadow it.
      const main = firstTopLevelDml(masked);
      if (main === 'SELECT') return ok('read', 'READ_CTE', 'Read-only WITH..SELECT.');
      return fail(keyword, 'CTE_NON_SELECT', 'WITH wrapping a non-SELECT statement is refused in the console.');
    }
    case 'PRAGMA':
      return /=/.test(masked)
        ? ok('write', 'WRITE_PRAGMA_MODE', 'PRAGMA with "=" changes database mode; treated as a write.')
        : ok('read', 'READ_PRAGMA', 'Read-only PRAGMA.');
    case 'INSERT':
    case 'REPLACE':
      return ok('write', 'WRITE_INSERT', 'Row insert; runs on dev/test connections only.');
    case 'UPDATE':
      return hasTopLevelWhere(masked)
        ? ok('write', 'WRITE_UPDATE', 'Scoped UPDATE with WHERE.')
        : ok('destructive', 'UPDATE_WITHOUT_WHERE', 'UPDATE without WHERE touches every row; needs approval.');
    case 'DELETE':
      return hasTopLevelWhere(masked)
        ? ok('write', 'WRITE_DELETE', 'Scoped DELETE with WHERE.')
        : ok('destructive', 'DELETE_WITHOUT_WHERE', 'DELETE without WHERE wipes the table; needs approval.');
    case 'CREATE':
      return ok('write', 'WRITE_CREATE', 'CREATE (table/index/view); runs on dev/test connections only.');
    case 'ALTER': {
      const up = masked.toUpperCase();
      if (/\bDROP\s+(COLUMN|CONSTRAINT)\b/.test(up) || /\bRENAME\b/.test(up)) {
        return ok('destructive', 'ALTER_DESTRUCTIVE', 'ALTER that drops/renames structure; needs approval.');
      }
      return ok('write', 'WRITE_ALTER_ADD', 'ALTER (additive); runs on dev/test connections only.');
    }
    case 'DROP':
    case 'TRUNCATE':
      return ok('destructive', 'DESTRUCTIVE_DDL', `${keyword} is destructive; needs approval.`);
    case 'ATTACH':
    case 'DETACH':
      return fail(keyword, 'FILE_SIDEEFFECT', 'ATTACH/DETACH touches the file system; refused in the browser.');
    case 'VACUUM':
    case 'REINDEX':
    case 'ANALYZE':
      return fail(keyword, 'MAINTENANCE_BLOCKED', `${keyword} is a maintenance operation; use the backup tooling instead.`);
    case 'BEGIN':
    case 'COMMIT':
    case 'ROLLBACK':
    case 'SAVEPOINT':
      return fail(keyword, 'TXN_BLOCKED', 'The browser manages its own transactions; explicit transaction control is refused.');
    default:
      return fail(keyword, 'UNKNOWN_STATEMENT', `Unrecognized statement "${keyword}"; refused fail-closed.`);
  }
}

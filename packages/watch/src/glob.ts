/**
 * Minimal glob matcher for watch rules (R6-S3). Dialect, kept small on
 * purpose and documented here (no minimatch dependency):
 *   `*`  matches any run of characters except `/`
 *   `**` matches any run of characters including `/`
 *   `?`  matches one character except `/`
 *   `**\/` at the start also matches zero directories (so `**\/*.ts`
 *   matches a top-level `a.ts` as well as `src/a.ts`)
 *   a trailing `/**` matches everything under the directory
 * Patterns are matched against the project-root-relative posix path
 * (backslashes normalized to `/`). A pattern without any `/` matches
 * the basename at any depth (like a bare `*.ts`).
 */

export function toPosixPath(p: string): string {
  return p.split('\\').join('/').replace(/^\.\//, '');
}

/** Compile one glob pattern into a RegExp. Throws on unbalanced `[`. */
export function globToRegExp(pattern: string): RegExp {
  const pat = toPosixPath(pattern);
  if (pat.length === 0) throw new Error('glob pattern must not be empty');
  let re = '^';
  let i = 0;
  const hasSlash = pat.includes('/');
  // Bare-name patterns (no slash) match the basename at any depth.
  if (!hasSlash) re += '(?:.*/)?';
  while (i < pat.length) {
    const c = pat[i];
    if (c === '*') {
      if (pat[i + 1] === '*') {
        // `**/` matches zero or more directories.
        if (pat[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else if (c === '[') {
      const close = pat.indexOf(']', i + 1);
      if (close === -1) throw new Error(`unbalanced [ in glob pattern: ${pattern}`);
      let cls = pat.slice(i + 1, close);
      // `[]...]` is a literal ] first; keep it simple: reject it.
      if (cls.startsWith(']')) throw new Error(`unsupported [] in glob pattern: ${pattern}`);
      if (cls.startsWith('!')) cls = '^' + cls.slice(1);
      re += `[${cls.replace(/\\/g, '\\\\')}]`;
      i = close + 1;
    } else {
      re += c.replace(/[.+^${}()|]/g, '\\$&');
      i += 1;
    }
  }
  re += '$';
  return new RegExp(re);
}

/** True when the relative path matches any of the patterns. */
export function matchGlobs(patterns: string[], relPath: string): boolean {
  const posix = toPosixPath(relPath);
  return patterns.some((p) => {
    try {
      return globToRegExp(p).test(posix);
    } catch {
      return false;
    }
  });
}

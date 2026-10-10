/**
 * Project discovery (spec §32): analyze a directory and detect language,
 * framework, package manager, test framework, Git, CI config, AGENTS.md,
 * skills/ and MCP configuration, then emit a ProjectProfile.
 *
 * The scanner only inspects well-known marker files/dirs at bounded
 * depth (root and depth-1) — it never walks node_modules or the whole
 * tree.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ProjectProfile } from './types';

const MAX_SCAN_DEPTH = 2;

function exists(dir: string, name: string): boolean {
  try {
    return existsSync(join(dir, name));
  } catch {
    return false;
  }
}

function isDir(dir: string, name: string): boolean {
  try {
    return statSync(join(dir, name)).isDirectory();
  } catch {
    return false;
  }
}

function readJson(dir: string, name: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(join(dir, name), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readText(dir: string, name: string, limit = 200_000): string | null {
  try {
    const raw = readFileSync(join(dir, name), 'utf8');
    return raw.length > limit ? raw.slice(0, limit) : raw;
  } catch {
    return null;
  }
}

function allDeps(pkg: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const bucket = pkg[key];
    if (typeof bucket === 'object' && bucket !== null) {
      for (const [k, v] of Object.entries(bucket as Record<string, unknown>)) {
        out[k] = String(v);
      }
    }
  }
  return out;
}

/** Non-recursive list of file names at a directory (bounded helper). */
function namesAt(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function detectLanguage(dir: string): string | null {
  const top = new Set(namesAt(dir));
  const has = (n: string): boolean => top.has(n);

  if (has('package.json')) {
    if (has('tsconfig.json')) return 'typescript';
    for (const n of top) {
      if (n.endsWith('.ts') || n.endsWith('.tsx')) return 'typescript';
    }
    return 'javascript';
  }
  if (has('pyproject.toml') || has('setup.py') || has('setup.cfg') || has('requirements.txt')) {
    return 'python';
  }
  if (has('go.mod')) return 'go';
  if (has('Cargo.toml')) return 'rust';
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) return 'java';
  if (has('composer.json')) return 'php';
  if (has('Gemfile')) return 'ruby';
  for (const n of top) {
    if (n.endsWith('.csproj') || n.endsWith('.sln')) return 'csharp';
  }
  // Depth-1 check for marker files inside subdirs (e.g. packages/foo/package.json)
  if (MAX_SCAN_DEPTH >= 2) {
    for (const n of top) {
      const sub = join(dir, n);
      let st: { isDirectory(): boolean } | null = null;
      try {
        st = statSync(sub);
      } catch {
        continue;
      }
      if (!st.isDirectory() || n === 'node_modules' || n.startsWith('.')) continue;
      if (exists(sub, 'package.json')) return has('tsconfig.json') || exists(sub, 'tsconfig.json') ? 'typescript' : 'javascript';
      if (exists(sub, 'pyproject.toml')) return 'python';
      if (exists(sub, 'go.mod')) return 'go';
      if (exists(sub, 'Cargo.toml')) return 'rust';
    }
  }
  return null;
}

const FRAMEWORK_BY_NODE_DEP: ReadonlyArray<[RegExp, string]> = [
  [/^next$/, 'next'],
  [/^nuxt$/, 'nuxt'],
  [/^@angular\/core$/, 'angular'],
  [/^vue$/, 'vue'],
  [/^svelte$/, 'svelte'],
  [/^react$/, 'react'],
  [/^express$/, 'express'],
  [/^fastify$/, 'fastify'],
  [/^koa$/, 'koa'],
  [/^@nestjs\/core$/, 'nestjs'],
  [/^electron$/, 'electron'],
];

function detectNodeFramework(pkg: Record<string, unknown>): string | null {
  const deps = allDeps(pkg);
  for (const [re, name] of FRAMEWORK_BY_NODE_DEP) {
    for (const dep of Object.keys(deps)) {
      if (re.test(dep)) return name;
    }
  }
  return null;
}

function detectFramework(dir: string, language: string | null): string | null {
  if (language === 'javascript' || language === 'typescript') {
    const pkg = readJson(dir, 'package.json');
    if (pkg) {
      const fw = detectNodeFramework(pkg);
      if (fw) return fw;
    }
    // Electron main-process marker even without the dep (e.g. demo fixture).
    const pkgRaw = readText(dir, 'package.json');
    if (pkgRaw && /"main"\s*:\s*"(main\.js|dist\/main\.js|src\/main\.js)"/.test(pkgRaw)) {
      return 'electron';
    }
  }
  if (language === 'python') {
    const pyproject = readText(dir, 'pyproject.toml') ?? '';
    const requirements = readText(dir, 'requirements.txt') ?? '';
    const hay = `${pyproject}\n${requirements}`.toLowerCase();
    if (/\bfastapi\b/.test(hay)) return 'fastapi';
    if (/\bdjango\b/.test(hay)) return 'django';
    if (/\bflask\b/.test(hay)) return 'flask';
  }
  if (language === 'go') {
    const gomod = readText(dir, 'go.mod') ?? '';
    if (/\bgin-gonic\/gin\b/.test(gomod)) return 'gin';
    if (/\blabstack\/echo\b/.test(gomod)) return 'echo';
    if (/\bgofiber\/fiber\b/.test(gomod)) return 'fiber';
  }
  if (language === 'java') {
    const pom = readText(dir, 'pom.xml') ?? '';
    const gradle = (readText(dir, 'build.gradle') ?? '') + (readText(dir, 'build.gradle.kts') ?? '');
    const hay = `${pom}\n${gradle}`;
    if (/spring-boot|org\.springframework/.test(hay)) return 'spring';
    if (/quarkus/.test(hay)) return 'quarkus';
  }
  return null;
}

function detectPackageManager(dir: string, language: string | null): string | null {
  if (exists(dir, 'pnpm-lock.yaml') || exists(dir, 'pnpm-workspace.yaml')) return 'pnpm';
  if (exists(dir, 'yarn.lock')) return 'yarn';
  if (exists(dir, 'bun.lockb') || exists(dir, 'bun.lock')) return 'bun';
  if (exists(dir, 'package-lock.json')) return 'npm';
  if (language === 'javascript' || language === 'typescript') return 'npm';
  if (exists(dir, 'poetry.lock') || exists(dir, 'pyproject.toml')) return 'poetry';
  if (exists(dir, 'Pipfile')) return 'pipenv';
  if (exists(dir, 'requirements.txt') || exists(dir, 'setup.py')) return 'pip';
  if (language === 'python') return 'pip';
  if (exists(dir, 'go.mod')) return 'go';
  if (exists(dir, 'Cargo.toml') || exists(dir, 'Cargo.lock')) return 'cargo';
  if (exists(dir, 'build.gradle') || exists(dir, 'build.gradle.kts')) return 'gradle';
  if (exists(dir, 'pom.xml')) return 'maven';
  if (exists(dir, 'composer.json')) return 'composer';
  if (exists(dir, 'Gemfile')) return 'bundler';
  return null;
}

function detectTestFramework(dir: string, language: string | null): string | null {
  if (language === 'javascript' || language === 'typescript') {
    const pkg = readJson(dir, 'package.json');
    if (pkg) {
      const deps = allDeps(pkg);
      if ('vitest' in deps) return 'vitest';
      if ('jest' in deps) return 'jest';
      if ('mocha' in deps) return 'mocha';
      if ('playwright' in deps || '@playwright/test' in deps) return 'playwright';
      if ('cypress' in deps) return 'cypress';
      const scripts = pkg['scripts'];
      if (typeof scripts === 'object' && scripts !== null) {
        const joined = JSON.stringify(scripts);
        if (/\bvitest\b/.test(joined)) return 'vitest';
        if (/\bjest\b/.test(joined)) return 'jest';
      }
    }
    // node:test convention — any *.test.js/ts file at shallow depth.
    const shallowTest = (d: string, depth: number): boolean => {
      if (depth > 1) return false;
      for (const n of namesAt(d)) {
        if (/\.test\.(js|ts|jsx|tsx|mjs|cjs)$/.test(n)) return true;
      }
      if (depth < 1) {
        for (const n of namesAt(d)) {
          const sub = join(d, n);
          let ok = false;
          try {
            ok = statSync(sub).isDirectory();
          } catch {
            continue;
          }
          if (ok && n !== 'node_modules' && !n.startsWith('.') && shallowTest(sub, depth + 1)) {
            return true;
          }
        }
      }
      return false;
    };
    if (shallowTest(dir, 0)) return 'node:test';
    return null;
  }
  if (language === 'python') {
    if (exists(dir, 'pytest.ini') || exists(dir, 'tox.ini') || exists(dir, 'tests')) return 'pytest';
    const pyproject = readText(dir, 'pyproject.toml') ?? '';
    if (/\bpytest\b/.test(pyproject)) return 'pytest';
    return 'unittest';
  }
  if (language === 'go') return 'go test';
  if (language === 'rust') return 'cargo test';
  if (language === 'java') {
    const hay = (readText(dir, 'pom.xml') ?? '') + (readText(dir, 'build.gradle') ?? '');
    if (/\bjunit\b/.test(hay.toLowerCase())) return 'junit';
    return null;
  }
  return null;
}

function detectCi(dir: string): string[] {
  const ci: string[] = [];
  if (isDir(dir, '.github') && isDir(join(dir, '.github'), 'workflows')) {
    ci.push('github-actions');
  }
  if (exists(dir, '.gitlab-ci.yml')) ci.push('gitlab');
  if (exists(dir, 'Jenkinsfile')) ci.push('jenkins');
  if (isDir(dir, '.circleci')) ci.push('circleci');
  if (exists(dir, 'azure-pipelines.yml')) ci.push('azure-pipelines');
  return ci;
}

function detectMcpConfig(dir: string): string | null {
  const candidates = ['.ai/mcp.json', 'mcp.json', '.mcp.json', '.ai/mcp/servers.json'];
  for (const c of candidates) {
    if (exists(dir, c)) return c;
  }
  // Any *.json under .ai/mcp/ or .mcp/
  for (const mcpDir of ['.ai/mcp', '.mcp']) {
    const full = join(dir, mcpDir);
    if (isDir(dir, mcpDir)) {
      for (const n of namesAt(full)) {
        if (n.endsWith('.json')) return `${mcpDir}/${n}`;
      }
    }
  }
  return null;
}

/**
 * Analyze `dir` and build a ProjectProfile (spec §32).
 * Throws when `dir` does not exist or is not a directory.
 */
export function discoverProject(dir: string): ProjectProfile {
  const abs = resolve(dir);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch {
    throw new Error(`project dir not found: ${abs}`);
  }
  if (!st.isDirectory()) throw new Error(`not a directory: ${abs}`);

  const language = detectLanguage(abs);
  return {
    path: abs,
    language,
    framework: detectFramework(abs, language),
    packageManager: detectPackageManager(abs, language),
    testFramework: detectTestFramework(abs, language),
    git: isDir(abs, '.git'),
    ci: detectCi(abs),
    hasAgentsMd: exists(abs, 'AGENTS.md'),
    skillsDir: isDir(abs, 'skills'),
    mcpConfig: detectMcpConfig(abs),
  };
}

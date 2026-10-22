/**
 * Builtin snippet defaults, shipped with the package.
 *
 * These are registered by the desktop on startup through the same provider
 * interface plugins use (see providers.ts); user snippets from
 * .ai-factory/snippets.json always take precedence by id.
 */
import type { SnippetDef } from './types.js';

export const BUILTIN_SNIPPETS: SnippetDef[] = [
  {
    id: 'builtin:for-ts',
    trigger: 'for',
    description: 'for loop over an array',
    scope: ['typescript', 'javascript'],
    body: 'for (const ${1:item} of ${2:items}) {\n\t$0\n}',
  },
  {
    id: 'builtin:log',
    trigger: 'log',
    description: 'console.log',
    scope: ['typescript', 'javascript'],
    body: 'console.log(${1:value});$0',
  },
  {
    id: 'builtin:try',
    trigger: 'try',
    description: 'try/catch block',
    scope: ['typescript', 'javascript', 'python'],
    body: 'try {\n\t$1\n} catch (${2:err}) {\n\t$0\n}',
  },
  {
    id: 'builtin:fn',
    trigger: 'fn',
    description: 'arrow function',
    scope: ['typescript', 'javascript'],
    body: 'const ${1:name} = (${2:args}) => {\n\t$0\n};',
  },
  {
    id: 'builtin:def',
    trigger: 'def',
    description: 'function definition',
    scope: ['python'],
    body: 'def ${1:name}(${2:args}):\n    $0',
  },
  {
    id: 'builtin:ifmain',
    trigger: 'ifmain',
    description: 'if __name__ == "__main__" guard',
    scope: ['python'],
    body: 'if __name__ == "__main__":\n    $0',
  },
  {
    id: 'builtin:date',
    trigger: 'date',
    description: 'insert current date (variable demo)',
    scope: ['*'],
    body: '${DATE}$0',
  },
];

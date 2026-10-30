/**
 * @ai-factory/prlink — PR review and Issue linkage (round-7 task R7-#6).
 *
 * Modules:
 *  - types     local/remote shapes, PrLinkError
 *  - refs      `#123` / `owner/repo#123` parsing from branch + messages
 *  - local     read-only local git linkage (argv git, no network)
 *  - provider  GitHub REST client + offline fixture provider
 *  - store     local review archive (atomic JSON, fail-closed corrupt)
 */
export * from './types';
export * from './refs';
export * from './local';
export * from './provider';
export * from './store';

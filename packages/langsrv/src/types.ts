/**
 * Shared types for @ai-factory/langsrv.
 *
 * Positions are LSP-style: 0-based line and 0-based character in UTF-16
 * code units — the same units the TypeScript compiler API uses, so no
 * conversion loss happens between engine results and editor display.
 * `file` is always root-relative (posix) in results served over HTTP;
 * the engine itself works in absolute paths and the route layer converts.
 */

/** Where a result came from — always surfaced, never hidden. */
export type LangSrvSource = 'lsp' | 'semantic' | 'heuristic';

export interface LangSrvLocation {
  file: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  /** Identifier text at the span, when the engine knows it. */
  name?: string;
}

export interface LangSrvReference extends LangSrvLocation {
  isDefinition: boolean;
  isWriteAccess: boolean;
}

export interface LangSrvHover {
  /** Quick-info display parts joined (signature + type). */
  display: string;
  documentation?: string;
}

export interface LangSrvOutlineSymbol {
  name: string;
  kind: string;
  file: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
}

export interface LangSrvRenameEdit extends LangSrvLocation {
  oldText: string;
  newText: string;
}

export type LangSrvErrorCode =
  | 'TS_UNAVAILABLE'
  | 'LSP_UNAVAILABLE'
  | 'ROOT_NOT_FOUND'
  | 'FILE_OUTSIDE_ROOT'
  | 'UNSUPPORTED_EXT'
  | 'POSITION_OUT_OF_RANGE'
  | 'TOO_MANY_FILES'
  | 'INVALID_IDENTIFIER'
  | 'LSP_TIMEOUT';

export class LangSrvError extends Error {
  code: LangSrvErrorCode;
  constructor(code: LangSrvErrorCode, message: string) {
    super(message);
    this.name = 'LangSrvError';
    this.code = code;
  }
}

/** One entry of the auditable query log (stats ring, no file contents). */
export interface LangSrvQueryStat {
  at: number;
  kind: 'definition' | 'references' | 'hover' | 'outline' | 'renamePreview';
  source: LangSrvSource;
  file: string;
  ms: number;
  results: number;
}

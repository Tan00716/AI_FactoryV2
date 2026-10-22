/**
 * Scratch file types (round-5 task R5-B10).
 *
 * A scratch is a temporary draft buffer that lives in the user's data
 * directory (AI_FACTORY_DATA_DIR/scratches/), never inside a project tree.
 * It is not versioned, not indexed, and not audited (declared).
 */
export interface LanguageDef {
  /** Stable id used in the API and in file metadata. */
  id: string;
  /** Human label shown in the create dialog. */
  label: string;
  /** File extension (without the dot) used for the on-disk file. */
  extension: string;
  /** Monaco language id for full syntax highlighting. */
  monacoLanguage: string;
  /**
   * Whether the server can run this language via the shared exec safety
   * policy. Only whitelisted binaries are allowed, so this is honest:
   * node-based languages run, everything else is edit-only.
   */
  runnable: boolean;
}

export interface ScratchMeta {
  id: string;
  name: string;
  language: string;
  createdAt: string;
  updatedAt: string;
  sizeBytes: number;
}

export interface Scratch extends ScratchMeta {
  content: string;
}

export class ScratchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ScratchError';
    this.code = code;
  }
}

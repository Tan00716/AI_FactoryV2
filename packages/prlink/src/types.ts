/**
 * PR / Issue linkage types (round-7 task R7-#6).
 *
 * Two planes, kept separate on purpose:
 *  - Local plane: branch names and commit subjects parsed for `#123`
 *    references. A bare number is neither an issue nor a PR until a
 *    provider resolves it — the local plane never guesses.
 *  - Remote plane: provider-resolved items. The provider is honest
 *    about its source ('github' | 'fixture'); when no provider is
 *    configured the route answers configured:false with no items,
 *    never fabricated data.
 *
 * Secrets: a provider token is held only by the server process that
 * constructs the provider (see routes/prlink.ts wiring in index.ts).
 * Nothing in this package logs, audits, or serializes a token.
 */

/** `owner/repo`, validated by validateRepoSlug. */
export type RepoSlug = string;

/** One `#number` reference found in local text. */
export interface LinkedReference {
  number: number;
  /** Present only for the `owner/repo#number` form. */
  repo?: string;
  /** Where the reference was found. */
  source: 'branch' | 'message';
}

export interface LocalCommit {
  hash: string;
  subject: string;
  author: string;
  date: string;
  references: LinkedReference[];
}

/** Local linkage for one working tree. */
export interface LocalLink {
  branch: string | null;
  commits: LocalCommit[];
  /** Deduplicated references across branch + commits, in first-seen order. */
  references: LinkedReference[];
}

export type RemoteItemKind = 'issue' | 'pull';

export interface RemoteItem {
  kind: RemoteItemKind;
  number: number;
  repo: RepoSlug;
  title: string;
  state: string;
  author: string;
  url: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  bodyExcerpt: string;
  /** PR head SHA, when the provider knows it (drives check lookup). */
  headSha?: string;
}

export interface RemoteReview {
  author: string;
  state: string;
  submittedAt: string;
  bodyExcerpt: string;
}

export interface RemoteCheck {
  name: string;
  status: string;
  conclusion: string;
  url: string;
}

export interface RemoteDetail {
  item: RemoteItem;
  reviews: RemoteReview[];
  checks: RemoteCheck[];
}

/** A review comment archived LOCALLY (never sent anywhere). */
export interface LocalReview {
  id: string;
  repo: RepoSlug;
  number: number;
  file?: string;
  line?: number;
  body: string;
  author: string;
  createdAt: number;
}

export interface PrLinkStatus {
  configured: boolean;
  provider: 'github' | 'fixture' | null;
  writesEnabled: boolean;
}

export class PrLinkError extends Error {
  constructor(
    public readonly code:
      | 'not-a-repo'
      | 'git-failed'
      | 'bad-repo'
      | 'bad-number'
      | 'bad-reference'
      | 'corrupt-store'
      | 'too-many'
      | 'too-large'
      | 'provider-failed'
      | 'not-found',
    message: string,
  ) {
    super(message);
    this.name = 'PrLinkError';
  }
}

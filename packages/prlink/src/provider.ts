/**
 * Remote provider abstraction (round-7 task R7-#6).
 *
 * The provider is the ONLY place a token exists: it is handed to the
 * constructor, used as a Bearer <redacted> header, and never logged, audited,
 * or returned. Two implementations:
 *  - GitHubProvider: node:https against api.github.com, no dependencies.
 *  - FixtureProvider: reads a JSON file (operator-configured, for tests
 *    and offline demos). Its items carry source:'fixture' so a reader
 *    can never mistake fixture data for live GitHub data.
 *
 * Write surface is exactly one method (postComment). The route gates it
 * behind FACTORY_PRLINK_WRITES_ENABLED + explicit confirm; the provider
 * itself does not decide policy.
 */
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { PrLinkError, type RemoteCheck, type RemoteDetail, type RemoteItem, type RemoteReview } from './types';

export interface PrLinkProvider {
  readonly name: 'github' | 'fixture';
  listLinked(repo: string, numbers: number[]): Promise<RemoteItem[]>;
  getDetail(repo: string, number: number): Promise<RemoteDetail>;
  postComment(repo: string, number: number, body: string): Promise<{ id: number; url: string }>;
}

function excerpt(text: string, limit = 500): string {
  const t = (text ?? '').trim();
  return t.length > limit ? t.slice(0, limit) + '...' : t;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Minimal GitHub REST client over node:https. */
export class GitHubProvider implements PrLinkProvider {
  readonly name = 'github' as const;

  constructor(private readonly token: string) {}

  private request(path: string, method: string, body?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = https.request(
        {
          hostname: 'api.github.com',
          path,
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'ai-factory-prlink',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
          timeout: 15000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode === 404) {
              reject(new PrLinkError('not-found', `GitHub resource not found: ${method} ${path}`));
              return;
            }
            if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
              reject(new PrLinkError('provider-failed', `GitHub ${method} ${path} -> ${res.statusCode}`));
              return;
            }
            try {
              resolve(text ? JSON.parse(text) : null);
            } catch {
              reject(new PrLinkError('provider-failed', `GitHub ${method} ${path} returned non-JSON`));
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new PrLinkError('provider-failed', 'GitHub request timed out')));
      req.on('error', (e) => reject(new PrLinkError('provider-failed', `GitHub request failed: ${e.message}`)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  private toItem(repo: string, raw: Record<string, unknown>): RemoteItem {
    const isPull = isRecord(raw.pull_request);
    return {
      kind: isPull ? 'pull' : 'issue',
      number: Number(raw.number),
      repo,
      title: asString(raw.title),
      state: asString(raw.state),
      author: asString((raw.user as Record<string, unknown> | undefined)?.login),
      url: asString(raw.html_url),
      labels: asStringArray(raw.labels).map((l) => (isRecord(l) ? asString(l.name) : l)),
      createdAt: asString(raw.created_at),
      updatedAt: asString(raw.updated_at),
      bodyExcerpt: excerpt(asString(raw.body)),
    };
  }

  async listLinked(repo: string, numbers: number[]): Promise<RemoteItem[]> {
    const items: RemoteItem[] = [];
    for (const n of numbers) {
      try {
        const raw = await this.request(`/repos/${repo}/issues/${n}`, 'GET');
        if (isRecord(raw)) items.push(this.toItem(repo, raw));
      } catch (e) {
        // One missing number must not sink the whole linkage view; the
        // detail endpoint still surfaces the miss as 404.
        if (e instanceof PrLinkError && e.code === 'not-found') continue;
        throw e;
      }
    }
    return items;
  }

  async getDetail(repo: string, number: number): Promise<RemoteDetail> {
    const raw = await this.request(`/repos/${repo}/issues/${number}`, 'GET');
    if (!isRecord(raw)) throw new PrLinkError('provider-failed', 'GitHub returned a non-object issue');
    const item = this.toItem(repo, raw);
    let reviews: RemoteReview[] = [];
    let checks: RemoteCheck[] = [];
    if (item.kind === 'pull') {
      const pull = await this.request(`/repos/${repo}/pulls/${number}`, 'GET');
      if (isRecord(pull)) {
        item.headSha = asString((pull.head as Record<string, unknown> | undefined)?.sha) || undefined;
      }
      const revRaw = await this.request(`/repos/${repo}/pulls/${number}/reviews`, 'GET');
      if (Array.isArray(revRaw)) {
        reviews = revRaw
          .filter(isRecord)
          .map((r) => ({
            author: asString((r.user as Record<string, unknown> | undefined)?.login),
            state: asString(r.state),
            submittedAt: asString(r.submitted_at),
            bodyExcerpt: excerpt(asString(r.body)),
          }));
      }
      if (item.headSha) {
        const chkRaw = await this.request(`/repos/${repo}/commits/${item.headSha}/check-runs`, 'GET');
        const runs = isRecord(chkRaw) ? chkRaw.check_runs : undefined;
        if (Array.isArray(runs)) {
          checks = runs.filter(isRecord).map((c) => ({
            name: asString(c.name),
            status: asString(c.status),
            conclusion: asString(c.conclusion),
            url: asString(c.html_url),
          }));
        }
      }
    }
    return { item, reviews, checks };
  }

  async postComment(repo: string, number: number, body: string): Promise<{ id: number; url: string }> {
    const raw = await this.request(`/repos/${repo}/issues/${number}/comments`, 'POST', { body });
    if (!isRecord(raw)) throw new PrLinkError('provider-failed', 'GitHub returned a non-object comment');
    return { id: Number(raw.id), url: asString(raw.html_url) };
  }
}

interface FixtureFile {
  items?: Record<string, unknown>[];
  reviews?: Record<string, RemoteReview[]>;
  checks?: Record<string, RemoteCheck[]>;
}

/**
 * Offline fixture provider. The file is operator-configured (env
 * FACTORY_PRLINK_FIXTURE_FILE); every item it returns is still shaped
 * like a RemoteItem, but the route labels the provider 'fixture' so
 * fixture data is never mistaken for live data.
 */
export class FixtureProvider implements PrLinkProvider {
  readonly name = 'fixture' as const;
  private readonly file: FixtureFile;

  constructor(fixturePath: string) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'));
      if (!isRecord(parsed)) throw new Error('fixture root is not an object');
      this.file = parsed as FixtureFile;
    } catch (e) {
      throw new PrLinkError('provider-failed', `cannot load prlink fixture: ${(e as Error).message}`);
    }
  }

  private items(): RemoteItem[] {
    return (this.file.items ?? []).filter(isRecord).map((r) => ({
      kind: (r.kind === 'pull' ? 'pull' : 'issue') as RemoteItem['kind'],
      number: Number(r.number),
      repo: asString(r.repo),
      title: asString(r.title),
      state: asString(r.state),
      author: asString(r.author),
      url: asString(r.url),
      labels: asStringArray(r.labels),
      createdAt: asString(r.createdAt),
      updatedAt: asString(r.updatedAt),
      bodyExcerpt: excerpt(asString(r.bodyExcerpt ?? r.body)),
      ...(asString(r.headSha) ? { headSha: asString(r.headSha) } : {}),
    }));
  }

  async listLinked(repo: string, numbers: number[]): Promise<RemoteItem[]> {
    return this.items().filter((i) => i.repo === repo && numbers.includes(i.number));
  }

  async getDetail(repo: string, number: number): Promise<RemoteDetail> {
    const item = this.items().find((i) => i.repo === repo && i.number === number);
    if (!item) throw new PrLinkError('not-found', `fixture has no ${repo}#${number}`);
    const key = `${repo}#${number}`;
    return {
      item,
      reviews: this.file.reviews?.[key] ?? [],
      checks: this.file.checks?.[key] ?? [],
    };
  }

  async postComment(_repo: string, _number: number, _body: string): Promise<{ id: number; url: string }> {
    // A fixture cannot post anywhere. The route surfaces this as 501
    // when writes are enabled against a fixture provider.
    throw new PrLinkError('provider-failed', 'fixture provider cannot post comments');
  }
}

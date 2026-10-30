/**
 * PR review and Issue linkage panel (R7-#6).
 *
 * Read-first: local branch/commit references, provider-resolved items,
 * review excerpts, check summaries. Two write paths, labeled apart:
 *  - Local review archive: stored locally only, never sent anywhere.
 *  - Remote comment post: DEFAULT OFF on the server. The panel shows
 *    the gate state and, when enabled, requires an explicit confirm
 *    checkbox before it even sends the request.
 * Issue import creates a DRAFT task (never auto-dispatched).
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useLang } from '../i18n';

interface Ref {
  number: number;
  repo?: string;
  source: string;
}

interface LocalCommit {
  hash: string;
  subject: string;
  author: string;
  date: string;
  references: Ref[];
}

interface RemoteItem {
  kind: string;
  number: number;
  repo: string;
  title: string;
  state: string;
  author: string;
  url: string;
  labels: string[];
}

interface LocalReview {
  id: string;
  repo: string;
  number: number;
  file?: string;
  line?: number;
  body: string;
  author: string;
  createdAt: number;
}

function refLabel(r: Ref): string {
  return `${r.repo ?? ''}#${r.number}`;
}

export function PrLinkPanel({ projectRoot, projectId }: { projectRoot: string; projectId: string }) {
  const { t } = useLang();
  const [status, setStatus] = useState<{ configured: boolean; provider: string | null; writesEnabled: boolean } | null>(null);
  const [root, setRoot] = useState(projectRoot);
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState<string | null>(null);
  const [commits, setCommits] = useState<LocalCommit[]>([]);
  const [items, setItems] = useState<RemoteItem[]>([]);
  const [detail, setDetail] = useState<{ item: RemoteItem; reviews: Array<{ author: string; state: string; bodyExcerpt: string }>; checks: Array<{ name: string; status: string; conclusion: string }> } | null>(null);
  const [reviews, setReviews] = useState<LocalReview[]>([]);
  const [reviewBody, setReviewBody] = useState('');
  const [reviewFile, setReviewFile] = useState('');
  const [commentBody, setCommentBody] = useState('');
  const [commentConfirm, setCommentConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.prlinkStatus());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const loadLocal = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const local = await api.prlinkLocal(root.trim() || projectRoot);
      setBranch(local.branch);
      setCommits(local.commits);
      if (repo.trim()) {
        const linked = await api.prlinkLinked(root.trim() || projectRoot, repo.trim());
        setItems(linked.items);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [root, repo, projectRoot]);

  const openDetail = useCallback(
    async (item: RemoteItem) => {
      setError(null);
      try {
        const d = await api.prlinkDetail(item.repo, item.number);
        setDetail({ item: d.item as RemoteItem, reviews: d.reviews, checks: d.checks });
        const lr = await api.prlinkLocalReviews(item.repo, item.number);
        setReviews(lr.reviews);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [],
  );

  const addLocalReview = useCallback(async () => {
    if (!detail) return;
    setError(null);
    try {
      await api.prlinkAddLocalReview({
        repo: detail.item.repo,
        number: detail.item.number,
        file: reviewFile.trim() || undefined,
        body: reviewBody.trim(),
      });
      setReviewBody('');
      setReviewFile('');
      const lr = await api.prlinkLocalReviews(detail.item.repo, detail.item.number);
      setReviews(lr.reviews);
      setNotice(t('prlink.localSaved'));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [detail, reviewBody, reviewFile, t]);

  const importIssue = useCallback(async () => {
    if (!detail || detail.item.kind !== 'issue') return;
    setError(null);
    try {
      const r = await api.prlinkImportIssue({
        projectId,
        repo: detail.item.repo,
        number: detail.item.number,
        title: detail.item.title,
      });
      setNotice(`${t('prlink.imported')} ${r.task.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [detail, projectId, t]);

  const postComment = useCallback(async () => {
    if (!detail || !commentConfirm) return;
    setError(null);
    try {
      const r = await api.prlinkPostComment({
        repo: detail.item.repo,
        number: detail.item.number,
        body: commentBody.trim(),
        confirm: true,
      });
      setNotice(`${t('prlink.posted')} ${r.posted.url}`);
      setCommentBody('');
      setCommentConfirm(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [detail, commentBody, commentConfirm, t]);

  return (
    <div>
      <h2>{t('prlink.title')}</h2>
      <p className="muted">{t('prlink.subtitle')}</p>
      <p className="muted">{t('prlink.honest')}</p>
      {status && (
        <p>
          {status.configured
            ? t('prlink.configured', { provider: status.provider ?? '' })
            : t('prlink.notConfigured')}
          {' · '}
          {status.writesEnabled ? t('prlink.writesOn') : t('prlink.writesOff')}
        </p>
      )}
      <div>
        <input value={root} onChange={(e) => setRoot(e.target.value)} placeholder={t('prlink.rootPlaceholder')} />
        <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder={t('prlink.repoPlaceholder')} />
        <button onClick={loadLocal} disabled={loading}>{t('prlink.load')}</button>
      </div>
      {branch !== null && <p>{t('prlink.branch', { branch: branch ?? '' })}</p>}
      {commits.length > 0 && (
        <ul>
          {commits.map((c) => (
            <li key={c.hash}>
              {c.subject} <span className="muted">({c.hash.slice(0, 8)} · {c.references.map(refLabel).join(', ') || '—'})</span>
            </li>
          ))}
        </ul>
      )}
      {items.length > 0 && (
        <ul>
          {items.map((item) => (
            <li key={`${item.repo}#${item.number}`}>
              <button onClick={() => openDetail(item)}>
                {item.kind} #{item.number}: {item.title} ({item.state})
              </button>
            </li>
          ))}
        </ul>
      )}
      {detail && (
        <div>
          <h3>{detail.item.kind} #{detail.item.number}: {detail.item.title}</h3>
          <p className="muted">{detail.item.author} · {detail.item.state}</p>
          <h4>{t('prlink.reviews')}</h4>
          {detail.reviews.length === 0 ? <p className="muted">{t('prlink.noReviews')}</p> : (
            <ul>
              {detail.reviews.map((r, i) => (
                <li key={i}>{r.author} · {r.state}: {r.bodyExcerpt}</li>
              ))}
            </ul>
          )}
          <h4>{t('prlink.checks')}</h4>
          {detail.checks.length === 0 ? <p className="muted">{t('prlink.noChecks')}</p> : (
            <ul>
              {detail.checks.map((c, i) => (
                <li key={i}>{c.name}: {c.status}/{c.conclusion}</li>
              ))}
            </ul>
          )}
          <h4>{t('prlink.localReviews')}</h4>
          {reviews.length === 0 ? <p className="muted">{t('prlink.noLocalReviews')}</p> : (
            <ul>
              {reviews.map((r) => (
                <li key={r.id}>{r.file ? `${r.file}:${r.line ?? ''} ` : ''}{r.body} <span className="muted">({r.author})</span></li>
              ))}
            </ul>
          )}
          <div>
            <input value={reviewFile} onChange={(e) => setReviewFile(e.target.value)} placeholder={t('prlink.filePlaceholder')} />
            <input value={reviewBody} onChange={(e) => setReviewBody(e.target.value)} placeholder={t('prlink.reviewPlaceholder')} />
            <button onClick={addLocalReview} disabled={!reviewBody.trim()}>{t('prlink.saveLocal')}</button>
          </div>
          {detail.item.kind === 'issue' && (
            <button onClick={importIssue}>{t('prlink.importAsTask')}</button>
          )}
          <div>
            <input value={commentBody} onChange={(e) => setCommentBody(e.target.value)} placeholder={t('prlink.commentPlaceholder')} />
            <label>
              <input type="checkbox" checked={commentConfirm} onChange={(e) => setCommentConfirm(e.target.checked)} />
              {t('prlink.confirmRemote')}
            </label>
            <button onClick={postComment} disabled={!commentConfirm || !commentBody.trim() || !status?.writesEnabled}>
              {t('prlink.postRemote')}
            </button>
          </div>
        </div>
      )}
      {notice && <p>{notice}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

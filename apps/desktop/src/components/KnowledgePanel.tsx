import { useCallback, useEffect, useMemo, useState } from 'react';

/** Typed client for the knowledge endpoints. */
export interface KnowledgeHit {
  item: {
    id: string;
    title: string;
    content: string;
    state: string;
    version: number;
    scope: Record<string, string>;
    source: { kind: string };
    tags?: string[];
  };
  scopeLevel: string;
}

/** §88 Knowledge Center categories. */
export const KNOWLEDGE_CATEGORIES = [
  'Models', 'Agents', 'Skills', 'MCP', 'Harness Engineering', 'Loop Engineering',
  'Coding', 'Testing', 'Security', 'DevOps', 'Research',
] as const;

/** §89 Update Feed card. */
export interface FeedCard {
  id: string;
  category: string;
  kind: 'NEW' | 'UPDATED' | 'VERIFIED' | 'DEPRECATED';
  title: string;
  whyRelevant: string;
  evidence: string[];
  affectedAgents: string[];
  risk: string;
  recommendedAction: string;
  evaluationResult?: string;
  publishedAt: string;
}

export interface KnowledgeApi {
  query(q?: string, scope?: Record<string, string>): Promise<{ hits: KnowledgeHit[] }>;
  add(input: Record<string, unknown>): Promise<{ item: { id: string } }>;
  get(id: string): Promise<{ item: unknown; history: unknown[] }>;
  transition(id: string, to: string, actor?: string, note?: string): Promise<unknown>;
  scout(candidate: Record<string, unknown>): Promise<unknown>;
  publish(id: string, actor?: string, skillId?: string): Promise<{ proposal: unknown; notice: unknown }>;
  feed(): Promise<{ cards: FeedCard[]; source: string }>;
  decide(cardId: string, decision: 'adopt' | 'ignore'): Promise<{ ok: boolean }>;
}

const DEFAULT_BASE = 'http://localhost:3100/api';

async function req<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as T;
  if (!res.ok) {
    const err = body as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return body;
}

export function createKnowledgeApi(base: string = DEFAULT_BASE): KnowledgeApi {
  return {
    query: (q, scope) => {
      const p = new URLSearchParams();
      if (q) p.set('q', q);
      for (const [k, v] of Object.entries(scope ?? {})) if (v) p.set(k, v);
      return req(base, `/knowledge?${p.toString()}`);
    },
    add: (input) => req(base, '/knowledge', { method: 'POST', body: JSON.stringify(input) }),
    get: (id) => req(base, `/knowledge/${encodeURIComponent(id)}`),
    transition: (id, to, actor, note) =>
      req(base, `/knowledge/${encodeURIComponent(id)}/transition`, {
        method: 'POST',
        body: JSON.stringify({ to, actor, note }),
      }),
    scout: (candidate) => req(base, '/knowledge/scout', { method: 'POST', body: JSON.stringify({ candidate }) }),
    publish: (id, actor, skillId) =>
      req(base, `/knowledge/${encodeURIComponent(id)}/publish`, {
        method: 'POST',
        body: JSON.stringify({ actor, skillId }),
      }),
    feed: () => req(base, '/knowledge/feed'),
    decide: (cardId, decision) =>
      req(base, '/knowledge/feed/decision', {
        method: 'POST',
        body: JSON.stringify({ cardId, decision }),
      }),
  };
}

const LIFECYCLE = ['DISCOVERED', 'UNVERIFIED', 'VALIDATED', 'EVALUATED', 'APPROVED', 'ACTIVE', 'DEPRECATED', 'RETIRED'];

function stateClass(s: string): string {
  if (s === 'ACTIVE') return 'st-active';
  if (s === 'DEPRECATED' || s === 'RETIRED') return 'st-idle';
  return 'st-working';
}

/** Heuristic: match a knowledge item to a §88 category via tags/title/content. */
function hitCategory(h: KnowledgeHit): string {
  const hay = `${(h.item.tags ?? []).join(' ')} ${h.item.title} ${h.item.content}`.toLowerCase();
  const match: [string, RegExp][] = [
    ['Models', /\b(model|llm|gpt|claude|codex|gemini|token|context window)\b/],
    ['Agents', /\b(agent|orchestrat|workforce|employee)\b/],
    ['Skills', /\b(skill|methodology|practice)\b/],
    ['MCP', /\b(mcp|tool server|capability negotiation)\b/],
    ['Harness Engineering', /\b(harness|retry|budget|tool-?call)\b/],
    ['Loop Engineering', /\b(loop|iteration|self-?correct)\b/],
    ['Testing', /\b(test|qa|benchmark|eval)\b/],
    ['Security', /\b(secur|vuln|typosquat|supply-?chain|malicious)\b/],
    ['DevOps', /\b(deploy|ci|cd|pipeline|release|devops)\b/],
    ['Research', /\b(research|paper|pattern|study)\b/],
    ['Coding', /\b(cod|review|diff|refactor)\b/],
  ];
  for (const [cat, re] of match) if (re.test(hay)) return cat;
  return 'Coding';
}

function FeedCardView({ card, onDecide }: { card: FeedCard; onDecide: (d: 'adopt' | 'ignore') => void }) {
  return (
    <div className="feed-card">
      <div className="row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <h5>{card.title}</h5>
        <span className="pill">{card.kind}</span>
        <span className="pill">{card.category}</span>
        <span style={{ flex: 1 }} />
        <span className="muted">{new Date(card.publishedAt).toLocaleDateString()}</span>
      </div>
      <div className="feed-field"><span className="lbl">Why relevant:</span>{card.whyRelevant}</div>
      <div className="feed-field">
        <span className="lbl">Evidence:</span>
        <ul style={{ margin: '4px 0', paddingLeft: 18 }}>{card.evidence.map((e) => <li key={e}>{e}</li>)}</ul>
      </div>
      <div className="feed-field"><span className="lbl">Affected agents:</span>{card.affectedAgents.join(', ')}</div>
      <div className="feed-field"><span className="lbl">Risk:</span>{card.risk}</div>
      {card.evaluationResult && (
        <div className="feed-field"><span className="lbl">Evaluation result:</span>{card.evaluationResult}</div>
      )}
      <div className="feed-field"><span className="lbl">Recommended action:</span>{card.recommendedAction}</div>
      <div className="feed-actions">
        <button onClick={() => onDecide('adopt')}>Adopt</button>
        <button onClick={() => onDecide('ignore')}>Ignore</button>
      </div>
    </div>
  );
}

/**
 * Knowledge Center (§88–§89): category browse + lifecycle management,
 * plus the Update Feed sub-tab (adopt/ignore only writes audit — agents
 * are never modified automatically, §53 policy).
 */
export function KnowledgePanel(props: { knowledge?: KnowledgeApi }) {
  const [api] = useState<KnowledgeApi>(() => props.knowledge ?? createKnowledgeApi());
  const [subtab, setSubtab] = useState<'browse' | 'feed'>('browse');
  const [hits, setHits] = useState<KnowledgeHit[]>([]);
  const [category, setCategory] = useState<string>('All');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [projectId, setProjectId] = useState('proj-myapp');
  const [detail, setDetail] = useState<{ item: any; history: any[] } | null>(null);
  const [scoutOut, setScoutOut] = useState<unknown>(null);
  const [nTitle, setNTitle] = useState('Harness retry budget guideline');
  const [nContent, setNContent] = useState('Cap agent tool-call retries at 3 per step; escalate on the third identical failure.');
  const [cards, setCards] = useState<FeedCard[]>([]);
  const [decided, setDecided] = useState<Record<string, 'adopt' | 'ignore'>>({});

  const refresh = useCallback(async () => {
    try {
      const scope: Record<string, string> = {};
      if (projectId) scope.projectId = projectId;
      const { hits: h } = await api.query(q || undefined, scope);
      setHits(h);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, q, projectId]);

  const refreshFeed = useCallback(async () => {
    try {
      const { cards: c } = await api.feed();
      setCards(c);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (subtab === 'feed') refreshFeed(); }, [subtab, refreshFeed]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (subtab === 'feed') await refreshFeed();
      else await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const filtered = useMemo(
    () => (category === 'All' ? hits : hits.filter((h) => hitCategory(h) === category)),
    [hits, category],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = { All: hits.length };
    for (const cat of KNOWLEDGE_CATEGORIES) c[cat] = 0;
    for (const h of hits) {
      const cat = hitCategory(h);
      c[cat] = (c[cat] ?? 0) + 1;
    }
    return c;
  }, [hits]);

  const viewDetail = (id: string) =>
    run(async () => {
      const d = await api.get(id);
      setDetail(d as { item: any; history: any[] });
    });

  const decide = (cardId: string, decision: 'adopt' | 'ignore') =>
    run(async () => {
      await api.decide(cardId, decision);
      setDecided((prev) => ({ ...prev, [cardId]: decision }));
    });

  return (
    <div className="knowledge-panel">
      {error && <div className="banner err">{error}</div>}
      <div className="subtabs">
        <button className={subtab === 'browse' ? 'sel' : ''} onClick={() => setSubtab('browse')}>Browse</button>
        <button className={subtab === 'feed' ? 'sel' : ''} onClick={() => setSubtab('feed')}>Update Feed</button>
      </div>

      {subtab === 'feed' ? (
        <div>
          <p className="muted">
            New knowledge from the scout pipeline (§89). Adopting only records an audit entry —
            agents are never modified automatically.
          </p>
          {cards.map((c) => (
            decided[c.id] ? (
              <div key={c.id} className="feed-card feed-decided">
                <b>{c.title}</b> — {decided[c.id] === 'adopt' ? 'adopted' : 'ignored'} (audit logged).
              </div>
            ) : (
              <FeedCardView key={c.id} card={c} onDecide={(d) => decide(c.id, d)} />
            )
          ))}
          {cards.length === 0 && <div className="muted">No feed cards.</div>}
        </div>
      ) : (
        <>
          <div className="row" style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search knowledge…" style={{ flex: 2 }} />
            <input value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="projectId" style={{ flex: 1 }} />
            <button disabled={busy} onClick={() => run(async () => {})}>Search</button>
          </div>
          <div className="knowledge-layout">
            <div className="knowledge-cats">
              {['All', ...KNOWLEDGE_CATEGORIES].map((cat) => (
                <button key={cat} className={category === cat ? 'sel' : ''} onClick={() => setCategory(cat)}>
                  {cat}
                  <span className="count">{counts[cat] ?? 0}</span>
                </button>
              ))}
            </div>
            <div className="knowledge-list">
              <h4 style={{ margin: '4px 0' }}>Knowledge <span className="muted">({filtered.length})</span></h4>
              <ul className="ev-list">
                {filtered.map((h) => (
                  <li key={h.item.id} style={{ marginBottom: 6 }}>
                    <span className={`status-dot ${stateClass(h.item.state)}`} style={{ display: 'inline-block', marginRight: 6 }} />
                    <b>{h.item.title}</b>{' '}
                    <span className="pill">{h.item.state}</span>{' '}
                    <span className="pill">{h.scopeLevel}</span>{' '}
                    <span className="pill">{hitCategory(h)}</span>{' '}
                    <span className="muted">v{h.item.version} · {h.item.source.kind}</span>
                    <button disabled={busy} style={{ marginLeft: 8 }} onClick={() => viewDetail(h.item.id)}>Detail</button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          {detail && (
            <div className="card" style={{ marginTop: 8 }}>
              <div className="row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <b>{detail.item.title}</b>
                <span className="pill">{detail.item.state}</span>
                <span style={{ flex: 1 }} />
                <button onClick={() => setDetail(null)}>Close</button>
              </div>
              <p className="muted">{detail.item.content}</p>
              <div className="muted" style={{ marginBottom: 6 }}>Lifecycle history: {detail.history.length} transitions</div>
              <div className="row" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {LIFECYCLE.filter((s) => s !== detail.item.state).map((s) => (
                  <button
                    key={s}
                    disabled={busy}
                    onClick={() => run(() => api.transition(detail.item.id, s).then(() => viewDetail(detail.item.id)))}
                  >
                    → {s}
                  </button>
                ))}
              </div>
              <div style={{ marginTop: 8 }}>
                <button
                  disabled={busy}
                  onClick={() => run(() => api.publish(detail.item.id).then((r) => setScoutOut(r)))}
                  title="Publishing returns a proposal + notice only — agents are never modified (§53)"
                >
                  Publish proposal
                </button>
              </div>
            </div>
          )}
          <h4 style={{ margin: '12px 0 4px' }}>Add candidate / Scout <span className="muted">(§52)</span></h4>
          <div className="row" style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input value={nTitle} onChange={(e) => setNTitle(e.target.value)} placeholder="title" style={{ flex: 1 }} />
            <input value={nContent} onChange={(e) => setNContent(e.target.value)} placeholder="content" style={{ flex: 2 }} />
            <button disabled={busy} onClick={() => run(() => api.add({
              title: nTitle,
              content: nContent,
              tags: [],
              scope: { projectId },
              source: { kind: 'official_docs', ref: 'harness-guide' },
            }))}>Add</button>
            <button disabled={busy} onClick={() => run(async () => {
              const r = await api.scout({
                title: nTitle,
                rawContent: nContent,
                topic: 'harness',
                source: { kind: 'official_docs' },
                scope: { level: 'PROJECT', projectId },
              });
              setScoutOut(r);
            })}>Run scout</button>
          </div>
          {!!scoutOut && (
            <pre className="code-sample" style={{ maxHeight: 260, overflow: 'auto' }}>
              {JSON.stringify(scoutOut, null, 2)}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

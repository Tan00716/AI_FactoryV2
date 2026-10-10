import { useCallback, useEffect, useState } from 'react';

/** Typed client for the skills endpoints (mirrors the req pattern in api.ts). */
export interface SkillSummary {
  id: string;
  versions: string[];
  latest: string | null;
  description: string;
  trustLevel: string;
  status: string;
  evaluationScore: number;
}

export interface SkillCandidate {
  skillId: string;
  version: string;
  score: number;
  reasons: string[];
}

export interface SkillsApi {
  list(): Promise<{ skills: SkillSummary[] }>;
  get(id: string): Promise<{ skill: unknown }>;
  install(skill: Record<string, unknown>, requestedBy?: string): Promise<{ ok: boolean; skill?: SkillSummary; approval?: unknown }>;
  discover(profile: { title: string; goal?: string; keywords?: string[]; taskType?: string }, select?: string[]): Promise<{
    candidates: SkillCandidate[];
    discovery: unknown;
  }>;
  instructions(id: string, version?: string): Promise<{ id: string; version: string; instructions: string }>;
  use(id: string, taskId: string, version?: string): Promise<{ usage: unknown }>;
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

export function createSkillsApi(base: string = DEFAULT_BASE): SkillsApi {
  return {
    list: () => req(base, '/skills'),
    get: (id) => req(base, `/skills/${encodeURIComponent(id)}`),
    install: (skill, requestedBy) =>
      req(base, '/skills/install', { method: 'POST', body: JSON.stringify({ skill, requestedBy }) }),
    discover: (profile, select) =>
      req(base, '/skills/discover', { method: 'POST', body: JSON.stringify({ ...profile, select }) }),
    instructions: (id, version) =>
      req(base, `/skills/${encodeURIComponent(id)}/instructions`, {
        method: 'POST',
        body: JSON.stringify({ version }),
      }),
    use: (id, taskId, version) =>
      req(base, `/skills/${encodeURIComponent(id)}/use`, {
        method: 'POST',
        body: JSON.stringify({ taskId, version }),
      }),
  };
}

function trustClass(t: string): string {
  if (t === 'OFFICIAL') return 'st-working';
  if (t === 'VERIFIED') return 'st-active';
  if (t === 'COMMUNITY') return 'st-idle';
  return 'st-failed';
}

/**
 * Skills panel (§47–§49, §74): installed skill list with trust badges,
 * discovery demo (task → candidates → select), instruction viewer.
 */
export function SkillsPanel(props: { taskId?: string | null; skills?: SkillsApi }) {
  const [api] = useState<SkillsApi>(() => props.skills ?? createSkillsApi());
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [candidates, setCandidates] = useState<SkillCandidate[]>([]);
  const [instructions, setInstructions] = useState<{ id: string; version: string; text: string } | null>(null);
  const [dTitle, setDTitle] = useState('Fix flaky e2e login test');
  const [dKeywords, setDKeywords] = useState('e2e, flaky, test');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { skills: s } = await api.list();
      setSkills(s);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);

  useEffect(() => { refresh(); }, [refresh]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doDiscover = () =>
    run(async () => {
      const { candidates: c } = await api.discover({
        title: dTitle,
        keywords: dKeywords.split(',').map((k) => k.trim()).filter(Boolean),
        taskType: 'testing',
      });
      setCandidates(c);
    });

  const viewInstructions = (id: string) =>
    run(async () => {
      const r = await api.instructions(id);
      setInstructions({ id: r.id, version: r.version, text: r.instructions });
    });

  return (
    <div className="skills-panel">
      {error && <div className="banner err">{error}</div>}
      <h4 style={{ margin: '4px 0' }}>Installed skills <span className="muted">({skills.length})</span></h4>
      <ul className="ev-list">
        {skills.map((s) => (
          <li key={s.id} style={{ marginBottom: 4 }}>
            <span className={`status-dot ${trustClass(s.trustLevel)}`} style={{ display: 'inline-block', marginRight: 6 }} />
            <b>{s.id}</b>{' '}
            <span className="muted">v{s.latest} · {s.versions.join(', ')}</span>{' '}
            <span className="pill">{s.trustLevel}</span>{' '}
            <span className="pill">{s.status}</span>
            <button disabled={busy} style={{ marginLeft: 8 }} onClick={() => viewInstructions(s.id)}>
              View SKILL.md
            </button>
            {props.taskId && (
              <button
                disabled={busy}
                style={{ marginLeft: 4 }}
                onClick={() => run(() => api.use(s.id, props.taskId!))}
                title="Record this skill version against the selected task (§49)"
              >
                Use for task
              </button>
            )}
            <div className="muted" style={{ marginTop: 2 }}>{s.description}</div>
          </li>
        ))}
      </ul>
      <h4 style={{ margin: '12px 0 4px' }}>Discovery <span className="muted">(§48)</span></h4>
      <div className="row" style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          value={dTitle}
          onChange={(e) => setDTitle(e.target.value)}
          placeholder="Task title"
          style={{ flex: 2 }}
        />
        <input
          value={dKeywords}
          onChange={(e) => setDKeywords(e.target.value)}
          placeholder="keywords, comma separated"
          style={{ flex: 1 }}
        />
        <button disabled={busy} onClick={doDiscover}>Discover</button>
      </div>
      {candidates.length > 0 && (
        <ul className="ev-list">
          {candidates.map((c) => (
            <li key={`${c.skillId}@${c.version}`}>
              <b>{c.skillId}@{c.version}</b>{' '}
              <span className="pill">score {c.score}</span>
              <div className="muted">{c.reasons.join(' · ')}</div>
            </li>
          ))}
        </ul>
      )}
      {instructions && (
        <div className="card" style={{ marginTop: 8 }}>
          <div className="row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <b>SKILL.md</b> <span className="muted">{instructions.id}@{instructions.version}</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => setInstructions(null)}>Close</button>
          </div>
          <pre className="code-sample" style={{ maxHeight: 300, overflow: 'auto' }}>{instructions.text}</pre>
        </div>
      )}
    </div>
  );
}

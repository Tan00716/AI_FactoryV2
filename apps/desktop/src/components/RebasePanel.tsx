import { useState } from 'react';
import {
  api,
  type RebaseTodoAction,
  type RebaseTodoInput,
  type StashEntry,
} from '../api';
import { useLang } from '../i18n';

/**
 * Interactive rebase editor + stash manager (round-6 task R6-S2).
 *
 * Flow: repo path (empty = inspection root) + base ref → load todos →
 * reorder with up/down, change action per line (pick/reword/squash/
 * fixup/drop), optional single-line reword message → start. A shadow
 * checkpoint is taken before the rebase; a conflict leaves the rebase
 * in progress so the user resolves via the Merge tab and continues.
 * Stash section: list / push with a message / show diff / apply / pop /
 * drop. A conflicted pop keeps the stash entry (git behavior).
 *
 * HONEST BOUNDARIES (rendered in the UI):
 *  - Porcelain-level operations only; semantic conflict resolution stays
 *    with the merge3 editor — this panel never guesses a resolution.
 *  - No filter-branch / filter-repo history rewriting, ever.
 *  - Reword messages are single-line in v1.
 *  - Rebase refuses a dirty tree or an already-running rebase.
 */
const ACTIONS: RebaseTodoAction[] = ['pick', 'reword', 'squash', 'fixup', 'drop'];

export function RebasePanel() {
  const { t } = useLang();
  const [repo, setRepo] = useState('');
  const [base, setBase] = useState('HEAD~3');
  const [todos, setTodos] = useState<RebaseTodoInput[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [stash, setStash] = useState<StashEntry[] | null>(null);
  const [stashMsg, setStashMsg] = useState('');
  const [stashDiff, setStashDiff] = useState<string | null>(null);

  const repoArg = repo.trim() === '' ? undefined : repo.trim();

  const doLoad = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.rebaseTodos(repoArg, base.trim());
      setTodos(r.todos);
    } catch (e) {
      setError(`${t('rebase.err')}: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  const move = (i: number, dir: -1 | 1) => {
    if (!todos) return;
    const j = i + dir;
    if (j < 0 || j >= todos.length) return;
    const next = [...todos];
    const [moved] = next.splice(i, 1);
    next.splice(j, 0, moved);
    setTodos(next);
  };

  const setAction = (i: number, action: RebaseTodoAction) => {
    if (!todos) return;
    const next = [...todos];
    next[i] = { ...next[i], action, message: action === 'reword' ? next[i].message : undefined };
    setTodos(next);
  };

  const setMessage = (i: number, message: string) => {
    if (!todos) return;
    const next = [...todos];
    next[i] = { ...next[i], message: message === '' ? undefined : message };
    setTodos(next);
  };

  const doStart = async () => {
    if (!todos) return;
    setStarting(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.rebaseStart({ repo: repoArg, base: base.trim(), todos });
      setResult(
        `${t('rebase.result')}: ${r.status} (HEAD ${r.headBefore.slice(0, 12)} → ${r.headAfter.slice(0, 12)})` +
          (r.conflictedFiles.length ? ` — ${t('rebase.conflicted')}: ${r.conflictedFiles.join(', ')}` : '') +
          (r.checkpointId ? ` — checkpoint ${r.checkpointId}` : ''),
      );
      if (r.status === 'completed') setTodos(null);
    } catch (e) {
      setError(`${t('rebase.err')}: ${(e as Error).message}`);
    } finally {
      setStarting(false);
    }
  };

  const doLifecycle = async (verb: 'abort' | 'continue' | 'skip') => {
    setError(null);
    try {
      const fn = verb === 'abort' ? api.rebaseAbort : verb === 'continue' ? api.rebaseContinue : api.rebaseSkip;
      const r = await fn(repoArg);
      setStatus(`${verb}: ${r.status}` + (r.conflictedFiles.length ? ` — ${r.conflictedFiles.join(', ')}` : ''));
    } catch (e) {
      setError(`${t('rebase.err')}: ${(e as Error).message}`);
    }
  };

  const doStashList = async () => {
    try {
      const r = await api.stashList(repoArg);
      setStash(r.entries);
    } catch (e) {
      setError(`${t('rebase.err')}: ${(e as Error).message}`);
    }
  };

  const doStash = async (verb: 'push' | 'apply' | 'pop' | 'drop' | 'show', index?: string) => {
    setError(null);
    try {
      if (verb === 'push') {
        await api.stashPush(repoArg, stashMsg.trim());
        setStashMsg('');
      } else if (verb === 'show' && index) {
        const r = await api.stashShow(repoArg, index);
        setStashDiff(r.diff);
      } else if (verb === 'apply' && index) {
        const r = await api.stashApply(repoArg, index);
        setResult(`stash ${verb}: ${r.outcome}` + (r.conflictedFiles.length ? ` — ${r.conflictedFiles.join(', ')}` : ''));
      } else if (verb === 'pop' && index) {
        const r = await api.stashPop(repoArg, index);
        setResult(`stash ${verb}: ${r.outcome}` + (r.conflictedFiles.length ? ` — ${r.conflictedFiles.join(', ')}` : ''));
      } else if (verb === 'drop' && index) {
        await api.stashDrop(repoArg, index);
      }
      await doStashList();
    } catch (e) {
      setError(`${t('rebase.err')}: ${(e as Error).message}`);
    }
  };

  return (
    <div className="panel rebase-panel">
      <h2>{t('rebase.title')}</h2>
      <p className="hint">{t('rebase.hint')}</p>
      <div className="row">
        <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder={t('rebase.repoPlaceholder')} />
        <input value={base} onChange={(e) => setBase(e.target.value)} placeholder={t('rebase.basePlaceholder')} />
        <button onClick={doLoad} disabled={loading || !base.trim()}>{t('rebase.load')}</button>
        <button onClick={() => doLifecycle('abort')}>{t('rebase.abort')}</button>
        <button onClick={() => doLifecycle('continue')}>{t('rebase.continue')}</button>
        <button onClick={() => doLifecycle('skip')}>{t('rebase.skip')}</button>
      </div>
      {status && <p className="status">{status}</p>}
      {todos && (
        <>
          <table className="todo-table">
            <thead>
              <tr>
                <th>{t('rebase.action')}</th>
                <th>{t('rebase.commit')}</th>
                <th>{t('rebase.message')}</th>
                <th>{t('rebase.order')}</th>
              </tr>
            </thead>
            <tbody>
              {todos.map((line, i) => (
                <tr key={line.hash}>
                  <td>
                    <select value={line.action} onChange={(e) => setAction(i, e.target.value as RebaseTodoAction)}>
                      {ACTIONS.map((a) => (
                        <option key={a} value={a}>{a}</option>
                      ))}
                    </select>
                  </td>
                  <td title={line.hash}>{line.hash.slice(0, 12)} — {line.subject}</td>
                  <td>
                    {line.action === 'reword' ? (
                      <input
                        value={line.message ?? ''}
                        onChange={(e) => setMessage(i, e.target.value)}
                        placeholder={t('rebase.rewordPlaceholder')}
                      />
                    ) : (
                      ''
                    )}
                  </td>
                  <td>
                    <button onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                    <button onClick={() => move(i, 1)} disabled={i === todos.length - 1}>↓</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button onClick={doStart} disabled={starting}>{t('rebase.start')}</button>
        </>
      )}
      {result && <p className="status">{result}</p>}
      {error && <p className="error">{error}</p>}

      <h3>{t('rebase.stashTitle')}</h3>
      <div className="row">
        <input value={stashMsg} onChange={(e) => setStashMsg(e.target.value)} placeholder={t('rebase.stashPlaceholder')} />
        <button onClick={() => doStash('push')} disabled={!stashMsg.trim()}>{t('rebase.stashPush')}</button>
        <button onClick={doStashList}>{t('rebase.stashRefresh')}</button>
      </div>
      {stash && (
        <ul className="stash-list">
          {stash.map((e) => (
            <li key={e.index}>
              <span>{e.index} — {e.message}</span>
              <button onClick={() => doStash('show', e.index)}>{t('rebase.show')}</button>
              <button onClick={() => doStash('apply', e.index)}>{t('rebase.apply')}</button>
              <button onClick={() => doStash('pop', e.index)}>{t('rebase.pop')}</button>
              <button onClick={() => doStash('drop', e.index)}>{t('rebase.drop')}</button>
            </li>
          ))}
          {stash.length === 0 && <li>{t('rebase.stashEmpty')}</li>}
        </ul>
      )}
      {stashDiff !== null && (
        <pre className="stash-diff">{stashDiff.slice(0, 8000)}</pre>
      )}
      <p className="hint">{t('rebase.honest')}</p>
    </div>
  );
}

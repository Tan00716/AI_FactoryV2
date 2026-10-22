import { useCallback, useEffect, useState } from 'react';
import { api, type TimelineEntryDto } from '../api';
import { useLang } from '../i18n';
import { editorCursor } from '../editorCursor';

/**
 * Timeline panel (round-5 task R5-A4) — single-file history view fusing
 * git commits and Local History snapshots into one newest-first list.
 * Any two points (git commit / snapshot / current work) can be diffed.
 *
 * HONEST BOUNDARIES (rendered in the UI):
 *  - Blame and timeline are snapshots of the request moment; edit then
 *    reload to refresh. Uncommitted lines are marked, not attributed.
 *  - Directories outside git honestly report "no git history"; the timeline
 *    then shows only Local History snapshots (noGit).
 *  - Large files: blame caps at 2000 lines (truncated flag); diffs fail
 *    closed above 6000 total lines.
 */

function pointOf(e: TimelineEntryDto): string {
  return e.kind === 'git' ? `git:${e.hash}` : `snapshot:${e.id}`;
}

function pointLabel(e: TimelineEntryDto): string {
  return e.kind === 'git' ? e.shortHash : `snap ${e.id.slice(0, 13)}…`;
}

function entryDate(e: TimelineEntryDto): number {
  return e.kind === 'git' ? e.date * 1000 : e.dateMs;
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString();
}

export function TimelinePanel() {
  const { t } = useLang();
  const [path, setPath] = useState(() => editorCursor.path ?? '');
  const [entries, setEntries] = useState<TimelineEntryDto[]>([]);
  const [noGit, setNoGit] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selA, setSelA] = useState<string | null>(null);
  const [selB, setSelB] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ from: string; to: string; text: string } | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);

  const load = useCallback(async () => {
    const p = path.trim();
    if (!p) return;
    setLoading(true);
    setErr(null);
    setDiff(null);
    setSelA(null);
    setSelB(null);
    try {
      const res = await api.timelineFile(p);
      setEntries(res.entries);
      setNoGit(res.noGit);
      if (res.entries.length === 0) setErr(t('timeline.empty'));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [path, t]);

  useEffect(() => {
    if (path.trim()) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = useCallback(
    (pt: string) => {
      if (selA === pt) {
        setSelA(null);
        return;
      }
      if (selB === pt) {
        setSelB(null);
        return;
      }
      if (selA === null) setSelA(pt);
      else if (selB === null) setSelB(pt);
      else {
        setSelA(pt);
        setSelB(null);
      }
    },
    [selA, selB],
  );

  const runDiff = useCallback(async () => {
    const p = path.trim();
    if (!p || !selA || !selB) return;
    setDiffBusy(true);
    setErr(null);
    try {
      const res = await api.timelineDiff(p, selA, selB);
      setDiff({ from: res.from, to: res.to, text: res.diff });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDiffBusy(false);
    }
  }, [path, selA, selB]);

  return (
    <div className="timeline-panel">
      <div className="timeline-toolbar">
        <input
          className="timeline-path"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={t('timeline.pathPh')}
          spellCheck={false}
        />
        <button onClick={() => void load()} disabled={loading || !path.trim()}>
          {loading ? t('timeline.loading') : t('timeline.load')}
        </button>
        <button
          onClick={() => void runDiff()}
          disabled={diffBusy || !selA || !selB}
          title={t('timeline.diffHint')}
        >
          {t('timeline.diff')}
        </button>
        {noGit && <span className="timeline-nogit">{t('timeline.noGit')}</span>}
      </div>
      {err && <div className="timeline-error">{err}</div>}
      <div className="timeline-body">
        <ul className="timeline-list">
          <li
            className={selA === 'work' || selB === 'work' ? 'sel' : ''}
            onClick={() => pick('work')}
            title={t('timeline.workTitle')}
          >
            <span className="tl-kind tl-work">{t('timeline.work')}</span>
            <span className="tl-main">{t('timeline.workDesc')}</span>
          </li>
          {entries.map((e) => {
            const pt = pointOf(e);
            const sel = selA === pt || selB === pt;
            return (
              <li key={pt} className={sel ? 'sel' : ''} onClick={() => pick(pt)}>
                <span className={`tl-kind tl-${e.kind}`}>
                  {e.kind === 'git' ? t('timeline.git') : t('timeline.snapshot')}
                </span>
                <span className="tl-main">
                  {e.kind === 'git' ? (
                    <>
                      <b>{e.shortHash}</b> {e.message} <i>— {e.author}</i>
                    </>
                  ) : (
                    <>
                      <b>{pointLabel(e)}</b> {t(`timeline.kind_${e.snapshotKind}` as string)}{' '}
                      <i>({Math.round(e.size / 1024)} KB)</i>
                    </>
                  )}
                </span>
                <span className="tl-date">{fmtDate(entryDate(e))}</span>
              </li>
            );
          })}
        </ul>
        {diff && (
          <div className="timeline-diff">
            <div className="tl-diff-head">
              {t('timeline.diffFrom')}: {diff.from} → {t('timeline.diffTo')}: {diff.to}
            </div>
            <pre className="tl-diff-body">{diff.text || t('timeline.diffEmpty')}</pre>
          </div>
        )}
      </div>
      <div className="timeline-foot">{t('timeline.boundary')}</div>
    </div>
  );
}

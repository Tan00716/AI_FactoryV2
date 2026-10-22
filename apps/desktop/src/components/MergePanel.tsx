import { useState } from 'react';
import {
  api,
  type MergeAnalysisResponse,
  type MergeConflictFile,
  type MergeResolutionChoice,
} from '../api';
import { useLang } from '../i18n';

/**
 * Three-way merge conflict editor (round-5 task R5-S3).
 *
 * Flow: repo path (empty = inspection root) → list conflicted files →
 * pick a file → analyze (marker hunks + diff3 alignment, read-only) →
 * choose per-hunk resolution (ours / theirs / both / custom) →
 * resolve (sha256 drift-guarded, shadow checkpoint before write,
 * optional git add).
 *
 * HONEST BOUNDARIES (rendered in the UI):
 *  - diff3 alignment is heuristic; needsManual chunks are flagged and
 *    must be reviewed, not trusted;
 *  - diff3-style markers (|||||||) are rejected, not misread;
 *  - resolve writes one file; stage only runs `git add` (never commit);
 *  - a shadow checkpoint is taken before every write (refuse on failure).
 */

interface HunkChoice {
  choice: MergeResolutionChoice;
  customText: string;
}

const DEFAULT_CHOICE: HunkChoice = { choice: 'ours', customText: '' };

function chunkKindLabel(t: (k: string) => string, kind: string): string {
  switch (kind) {
    case 'stable':
      return t('merge.chunkStable');
    case 'ours-only':
      return t('merge.chunkOursOnly');
    case 'theirs-only':
      return t('merge.chunkTheirsOnly');
    case 'both-same':
      return t('merge.chunkBothSame');
    default:
      return t('merge.chunkConflict');
  }
}

export function MergePanel() {
  const { t } = useLang();
  const [repo, setRepo] = useState('');
  const [files, setFiles] = useState<MergeConflictFile[] | null>(null);
  const [listing, setListing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<MergeAnalysisResponse | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [choices, setChoices] = useState<Record<number, HunkChoice>>({});
  const [stage, setStage] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const repoArg = repo.trim() === '' ? undefined : repo.trim();

  const doList = async () => {
    setListing(true);
    setError(null);
    setFiles(null);
    try {
      const r = await api.mergeConflicts(repoArg);
      setFiles(r.files);
    } catch (e) {
      setError(`${t('merge.err')}: ${(e as Error).message}`);
    } finally {
      setListing(false);
    }
  };

  const doAnalyze = async (file: string) => {
    setAnalyzing(true);
    setError(null);
    setAnalysis(null);
    setChoices({});
    setResult(null);
    setSelected(file);
    try {
      const r = await api.mergeAnalyze(repoArg, file);
      setAnalysis(r);
      const init: Record<number, HunkChoice> = {};
      for (const h of r.markerHunks) init[h.index] = { ...DEFAULT_CHOICE };
      setChoices(init);
    } catch (e) {
      setError(`${t('merge.err')}: ${(e as Error).message}`);
    } finally {
      setAnalyzing(false);
    }
  };

  const unresolvedCount = analysis
    ? analysis.markerHunks.filter((h) => {
        const c = choices[h.index];
        if (!c) return true;
        return c.choice === 'custom' && c.customText.trim() === '';
      }).length
    : 0;

  const doResolve = async () => {
    if (!analysis || unresolvedCount > 0) return;
    setResolving(true);
    setError(null);
    setResult(null);
    try {
      const resolutions = analysis.markerHunks.map((h) => ({
        hunk: h.index,
        choice: choices[h.index].choice,
        ...(choices[h.index].choice === 'custom'
          ? { customText: choices[h.index].customText }
          : {}),
      }));
      const r = await api.mergeResolve({
        ...(repoArg ? { repo: repoArg } : {}),
        file: analysis.file,
        sha256: analysis.sha256,
        resolutions,
        stage,
      });
      setResult(
        `${t('merge.resolvedOk')}${r.staged ? ` · ${t('merge.stagedOk')}` : ''} (checkpoint ${r.checkpointId.slice(0, 8)})`,
      );
      // Refresh: the file should no longer be conflicted.
      await doList();
      setAnalysis(null);
      setSelected(null);
    } catch (e) {
      setError(`${t('merge.err')}: ${(e as Error).message}`);
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className="merge-panel panel">
      <h3>{t('merge.title')}</h3>
      <div className="merge-toolbar row">
        <label>
          {t('merge.repo')}
          <input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder={t('merge.repoPh')}
            className="merge-repo-input"
          />
        </label>
        <button onClick={doList} disabled={listing}>
          {listing ? t('merge.listing') : t('merge.list')}
        </button>
      </div>
      {error && <div className="banner err">{error}</div>}
      {files !== null && (
        <div className="merge-files">
          <div className="merge-files-head">
            {t('merge.files')}: {files.length}
            {files.length === 0 && <span> — {t('merge.noConflicts')}</span>}
          </div>
          {files.map((f) => (
            <button
              key={f.path}
              className={selected === f.path ? 'active' : ''}
              onClick={() => doAnalyze(f.path)}
            >
              {f.path} <span className="merge-status">[{f.status}]</span>
            </button>
          ))}
        </div>
      )}
      {analyzing && <div>{t('merge.analyzing')}</div>}
      {analysis && (
        <div className="merge-analysis">
          <div className="merge-file-head">
            <strong>{analysis.file}</strong>
            <span>
              {' '}
              · {t('merge.hunk')}: {analysis.markerHunks.length} ·{' '}
              {t('merge.chunkConflict')}: {analysis.summary.conflictChunks}
              {analysis.summary.needsManual > 0 && (
                <span className="merge-manual"> · {t('merge.needsManual')}: {analysis.summary.needsManual}</span>
              )}
            </span>
          </div>
          {!analysis.stages.base && (
            <div className="banner warn">{t('merge.noBase')}</div>
          )}
          {analysis.markerHunks.map((h) => {
            const c = choices[h.index] ?? DEFAULT_CHOICE;
            return (
              <div key={h.index} className="merge-hunk">
                <div className="merge-hunk-head">
                  {t('merge.hunk')} #{h.index + 1}
                  <span className="merge-lines">
                    {' '}
                    (lines {h.startLine + 1}–{h.endLine + 1}
                    {h.oursLabel ? ` · ours: ${h.oursLabel}` : ''}
                    {h.theirsLabel ? ` · theirs: ${h.theirsLabel}` : ''})
                  </span>
                </div>
                <div className="merge-cols">
                  <div className="merge-col">
                    <div className="merge-col-head">{t('merge.colOurs')}</div>
                    <pre>{h.ours.join('\n')}</pre>
                  </div>
                  <div className="merge-col">
                    <div className="merge-col-head">{t('merge.colTheirs')}</div>
                    <pre>{h.theirs.join('\n')}</pre>
                  </div>
                </div>
                <div className="merge-choice row">
                  {(['ours', 'theirs', 'both', 'custom'] as const).map((ch) => (
                    <label key={ch}>
                      <input
                        type="radio"
                        name={`merge-hunk-${h.index}`}
                        checked={c.choice === ch}
                        onChange={() =>
                          setChoices((prev) => ({ ...prev, [h.index]: { ...c, choice: ch } }))
                        }
                      />
                      {ch === 'ours'
                        ? t('merge.takeOurs')
                        : ch === 'theirs'
                          ? t('merge.takeTheirs')
                          : ch === 'both'
                            ? t('merge.takeBoth')
                            : t('merge.custom')}
                    </label>
                  ))}
                </div>
                {c.choice === 'custom' && (
                  <textarea
                    className="merge-custom"
                    value={c.customText}
                    onChange={(e) =>
                      setChoices((prev) => ({
                        ...prev,
                        [h.index]: { ...c, customText: e.target.value },
                      }))
                    }
                    placeholder={t('merge.customPh')}
                    rows={4}
                  />
                )}
              </div>
            );
          })}
          {analysis.chunks.length > 0 && (
            <details className="merge-diff3">
              <summary>diff3</summary>
              {analysis.chunks.map((ch, i) => (
                <div key={i} className={`merge-chunk kind-${ch.kind}`}>
                  <div className="merge-chunk-head">
                    {chunkKindLabel(t, ch.kind)}
                    {ch.baseStart > 0 && <span> · base L{ch.baseStart}</span>}
                    {ch.needsManual && <span className="merge-manual"> · {t('merge.needsManual')}</span>}
                  </div>
                  <div className="merge-cols merge-cols-3">
                    <div className="merge-col">
                      <div className="merge-col-head">{t('merge.colBase')}</div>
                      <pre>{ch.baseLines.join('\n')}</pre>
                    </div>
                    <div className="merge-col">
                      <div className="merge-col-head">{t('merge.colOurs')}</div>
                      <pre>{ch.oursLines.join('\n')}</pre>
                    </div>
                    <div className="merge-col">
                      <div className="merge-col-head">{t('merge.colTheirs')}</div>
                      <pre>{ch.theirsLines.join('\n')}</pre>
                    </div>
                  </div>
                </div>
              ))}
            </details>
          )}
          <div className="merge-actions row">
            <label>
              <input type="checkbox" checked={stage} onChange={(e) => setStage(e.target.checked)} />
              {t('merge.stage')}
            </label>
            <button onClick={doResolve} disabled={resolving || unresolvedCount > 0}>
              {resolving ? t('merge.resolving') : t('merge.resolve')}
            </button>
            {unresolvedCount > 0 && <span className="merge-unresolved">{t('merge.unresolved')}</span>}
          </div>
          {result && <div className="banner ok">{result}</div>}
        </div>
      )}
    </div>
  );
}

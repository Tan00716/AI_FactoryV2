/**
 * Test explorer panel (Round 7 #3) — package > file > case tree with
 * single-case / single-file / single-package runs. Run results (status,
 * duration, failure output) feed back into the tree; failed output
 * expands per case. A rerun-failed button re-runs only the failures of
 * the last run.
 *
 * Running a test executes project code: runs are operator-initiated
 * only (no auto-run on discover), and the server caps output and
 * enforces a timeout.
 */
import { useCallback, useState } from 'react';
import { api } from '../api';
import { useLang } from '../i18n';

interface TxCase {
  name: string;
  fullName: string;
  line: number;
}

interface TxFile {
  path: string;
  rel: string;
  cases: TxCase[];
  skipped?: string;
}

interface TxPackage {
  name: string;
  path: string;
  rel: string;
  files: TxFile[];
}

interface TxDiscovery {
  root: string;
  packages: TxPackage[];
  totals: { packages: number; files: number; cases: number };
  degraded: boolean;
  degradedReason?: string;
}

interface TxResult {
  file: string;
  name: string;
  fullName: string;
  status: string;
  durationMs: number;
  error?: string;
}

export function TestExplorerPanel({ projectRoot }: { projectRoot: string }) {
  const { t } = useLang();
  const [root, setRoot] = useState(projectRoot);
  const [discovery, setDiscovery] = useState<TxDiscovery | null>(null);
  const [results, setResults] = useState<TxResult[]>([]);
  const [summary, setSummary] = useState<string>('');
  const [runError, setRunError] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const resultFor = useCallback(
    (file: string, fullName: string): TxResult | undefined =>
      results.find((r) => r.file === file && r.fullName === fullName),
    [results],
  );

  const discover = useCallback(async () => {
    const r = root.trim() || projectRoot;
    if (!r) {
      setError(t('testexplorer.discoverFirst'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const d = await api.testexplorerDiscover(r);
      setDiscovery(d);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [root, projectRoot, t]);

  const run = useCallback(
    async (scope: unknown) => {
      const r = root.trim() || projectRoot;
      if (!r) {
        setError(t('testexplorer.discoverFirst'));
        return;
      }
      setLoading(true);
      setError(null);
      setRunError('');
      setNote('');
      try {
        const out = await api.testexplorerRun({ root: r, scope });
        setResults(out.results);
        setSummary(
          `${t('testexplorer.pass')} ${out.summary.pass} · ${t('testexplorer.fail')} ${out.summary.fail} · ${t('testexplorer.skip')} ${out.summary.skip} · ${t('testexplorer.duration')} ${(out.summary.durationMs / 1000).toFixed(1)}s`,
        );
        if (out.runError) setRunError(out.runError);
        if (out.note) setNote(out.note);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [root, projectRoot, t],
  );

  const rerunFailed = useCallback(async () => {
    const r = root.trim() || projectRoot;
    if (!r) return;
    setLoading(true);
    setError(null);
    setRunError('');
    try {
      const out = await api.testexplorerRerunFailed({ root: r });
      setResults(out.results);
      setSummary(
        `${t('testexplorer.pass')} ${out.summary.pass} · ${t('testexplorer.fail')} ${out.summary.fail} · ${t('testexplorer.duration')} ${(out.summary.durationMs / 1000).toFixed(1)}s`,
      );
      if (out.runError) setRunError(out.runError);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [root, projectRoot, t]);

  const badge = (status: string): string =>
    status === 'pass' ? '✔' : status === 'fail' ? '✖' : status === 'skip' ? '○' : '□';

  return (
    <div>
      <h2>{t('testexplorer.title')}</h2>
      <div>
        <label>
          {t('testexplorer.root')}{' '}
          <input value={root} placeholder={t('testexplorer.rootPh')} onChange={(e) => setRoot(e.target.value)} />
        </label>{' '}
        <button disabled={loading} onClick={discover}>
          {loading ? t('testexplorer.running') : t('testexplorer.discover')}
        </button>{' '}
        <button disabled={loading || !discovery} onClick={() => run({ kind: 'all' })}>
          {t('testexplorer.runAll')}
        </button>{' '}
        <button disabled={loading} onClick={rerunFailed}>
          {t('testexplorer.rerunFailed')}
        </button>
      </div>
      {error ? <p className="err">{error}</p> : null}
      {summary ? <p>{summary}</p> : null}
      {runError ? (
        <p className="err">
          {t('testexplorer.runError')}: {runError}
        </p>
      ) : null}
      {note ? (
        <p>
          {t('testexplorer.note')}: {note}
        </p>
      ) : null}
      {!discovery ? (
        <p className="muted">{t('testexplorer.noDiscovery')}</p>
      ) : (
        <div>
          <p>
            {discovery.totals.packages} {t('testexplorer.packages')} · {discovery.totals.files}{' '}
            {t('testexplorer.files')} · {discovery.totals.cases} {t('testexplorer.cases')}
            {discovery.degraded
              ? ` · ${t('testexplorer.degraded')}: ${discovery.degradedReason ?? ''}`
              : ''}
          </p>
          {discovery.packages.map((pkg) => (
            <div key={pkg.path}>
              <h3>
                {pkg.name} ({pkg.rel}){' '}
                <button disabled={loading} onClick={() => run({ kind: 'package', package: pkg.name })}>
                  {t('testexplorer.runPackage')}
                </button>
              </h3>
              {pkg.files.length === 0 ? (
                <p className="muted">{t('testexplorer.empty')}</p>
              ) : null}
              {pkg.files.map((file) => (
                <div key={file.path} style={{ marginLeft: 16 }}>
                  <div>
                    {file.rel}{' '}
                    <button disabled={loading} onClick={() => run({ kind: 'file', file: file.rel })}>
                      {t('testexplorer.runFile')}
                    </button>
                    {file.skipped ? <span className="muted"> ({file.skipped})</span> : null}
                  </div>
                  {file.cases.map((c) => {
                    const r = resultFor(file.path, c.fullName);
                    const key = `${file.path}:${c.fullName}`;
                    return (
                      <div key={key} style={{ marginLeft: 16 }}>
                        <span>
                          {r ? `${badge(r.status)} ` : ''}
                          {c.fullName} <span className="muted">:{c.line}</span>
                          {r ? <span className="muted"> {(r.durationMs / 1000).toFixed(2)}s</span> : null}
                        </span>{' '}
                        <button
                          disabled={loading}
                          onClick={() => run({ kind: 'case', file: file.rel, name: c.name })}
                        >
                          {t('testexplorer.runCase')}
                        </button>{' '}
                        {r?.error ? (
                          <button onClick={() => setExpanded((p) => ({ ...p, [key]: !p[key] }))}>
                            {t('testexplorer.output')}
                          </button>
                        ) : null}
                        {r?.error && expanded[key] ? <pre>{r.error}</pre> : null}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
          {results.length === 0 ? <p className="muted">{t('testexplorer.noResults')}</p> : null}
        </div>
      )}
    </div>
  );
}

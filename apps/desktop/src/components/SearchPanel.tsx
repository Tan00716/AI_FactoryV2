/**
 * Search Editor (round-5 task R5-A8) — the `.code-search` editor.
 *
 * A search run opens results as an independent, saveable document:
 * the query (query/regex/case/glob) is serialized into the file header,
 * results render grouped by file (collapsible, click-to-jump, read-only),
 * and a saved `.code-search` file can be reopened later to reproduce the
 * search or re-run it against the current tree.
 *
 * Honest boundary (rendered below the results): results are a snapshot
 * of the files at run time. File changes after the run require an
 * explicit re-run — nothing here is live-synced.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useLang } from '../i18n';
import { EmptyState } from './EmptyState';
import {
  parseCodeSearchFile,
  serializeCodeSearchFile,
} from '@ai-factory/codesearch/format';

interface ResultMatch {
  line: number;
  column: number;
  text: string;
}
interface ResultGroup {
  file: string;
  matches: ResultMatch[];
}
interface SearchResult {
  groups: ResultGroup[];
  totalMatches: number;
  filesScanned?: number;
  truncated?: boolean;
}

const SAVES_DIR = '.ai-factory/searches';

export function SearchPanel() {
  const { t } = useLang();
  const [query, setQuery] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [glob, setGlob] = useState('');
  const [root, setRoot] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [docPath, setDocPath] = useState<string | null>(null);
  const [saveName, setSaveName] = useState('');
  const [saved, setSaved] = useState<string[]>([]);
  const [showSaved, setShowSaved] = useState(false);

  const loadSaved = useCallback(async () => {
    try {
      const list = await api.files(SAVES_DIR);
      setSaved(
        list.entries
          .filter((e) => e.type === 'file' && e.path.endsWith('.code-search'))
          .map((e) => e.path)
          .sort(),
      );
    } catch {
      setSaved([]);
    }
  }, []);

  useEffect(() => {
    if (showSaved) void loadSaved();
  }, [showSaved, loadSaved]);

  const runSearch = useCallback(async () => {
    if (!query.trim()) {
      setError(t('search.queryRequired'));
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api.codeSearch({
        query: query.trim(),
        regex,
        caseSensitive,
        glob: glob.trim() || undefined,
        root: root.trim() || undefined,
      });
      setResult({
        groups: r.groups,
        totalMatches: r.totalMatches,
        filesScanned: r.stats.filesScanned,
        truncated: r.stats.truncated,
      });
      setCollapsed({});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [query, regex, caseSensitive, glob, root, t]);

  const openJump = useCallback((file: string, line: number) => {
    window.dispatchEvent(
      new CustomEvent('ai-factory:open-file', { detail: { path: file, line } }),
    );
  }, []);

  const toggleGroup = useCallback((file: string) => {
    setCollapsed((c) => ({ ...c, [file]: !c[file] }));
  }, []);

  /** Serialize the current result and save it as a `.code-search` file ("在编辑器中打开"). */
  const saveAsDocument = useCallback(async () => {
    if (!result) return;
    const name = saveName.trim().replace(/\.code-search$/i, '');
    if (!name) {
      setError(t('search.saveNameRequired'));
      return;
    }
    const doc = serializeCodeSearchFile(root.trim() || '.', {
      query: {
        query: query.trim(),
        regex,
        caseSensitive,
        globs: glob.trim() ? glob.split(',').map((g) => g.trim()).filter(Boolean) : [],
        maxMatches: 2000,
      },
      groups: result.groups.map((g) => ({
        file: g.file,
        matches: g.matches.map((m) => ({ file: g.file, line: m.line, column: m.column, text: m.text })),
      })),
      totalMatches: result.totalMatches,
      stats: {
        filesScanned: result.filesScanned ?? 0,
        linesScanned: 0,
        skippedBinary: 0,
        skippedTooLarge: 0,
        truncated: result.truncated ?? false,
        durationMs: 0,
      },
    });
    const path = `${SAVES_DIR}/${name}.code-search`;
    try {
      await api.fileWrite(path, doc);
      setDocPath(path);
      setNotice(t('search.saved', { path }));
      setSaveName('');
      if (showSaved) void loadSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [result, saveName, root, query, regex, caseSensitive, glob, t, showSaved, loadSaved]);

  /** Open a saved `.code-search` file: parse the header, restore query + results. */
  const openDocument = useCallback(
    async (path: string) => {
      setError(null);
      setNotice(null);
      try {
        const body = await api.fileRead(path);
        const parsed = parseCodeSearchFile(body.content);
        setQuery(parsed.header.query);
        setRegex(parsed.header.regex);
        setCaseSensitive(parsed.header.caseSensitive);
        setGlob(parsed.header.globs.join(', '));
        setRoot(parsed.header.root === '.' ? '' : parsed.header.root);
        setResult({
          groups: parsed.groups,
          totalMatches: parsed.header.matches,
          truncated: parsed.header.truncated,
        });
        setCollapsed({});
        setDocPath(path);
        setShowSaved(false);
      } catch (e) {
        setError(t('search.invalidDoc') + ': ' + (e instanceof Error ? e.message : String(e)));
      }
    },
    [t],
  );

  const newSearch = useCallback(() => {
    setDocPath(null);
    setResult(null);
    setError(null);
    setNotice(null);
  }, []);

  return (
    <div className="search-editor">
      {result === null && !loading && <EmptyState panel="search" />}
      <div className="search-editor-head">
        <span className="search-editor-icon" title=".code-search">&#x1F50D;</span>
        <h3>{t('search.title')}</h3>
        {docPath && <span className="search-doc-path">{docPath}</span>}
        {docPath && (
          <button className="btn-link" onClick={newSearch}>
            {t('search.backToSearch')}
          </button>
        )}
      </div>

      <div className="search-form">
        <input
          className="search-query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('search.queryPh')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runSearch();
          }}
        />
        <label className="chk">
          <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} />
          {t('search.regex')}
        </label>
        <label className="chk">
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => setCaseSensitive(e.target.checked)}
          />
          {t('search.caseSensitive')}
        </label>
        <input
          className="search-glob"
          value={glob}
          onChange={(e) => setGlob(e.target.value)}
          placeholder={t('search.globPh')}
          title={t('search.glob')}
        />
        <input
          className="search-root"
          value={root}
          onChange={(e) => setRoot(e.target.value)}
          placeholder={t('search.rootPh')}
          title={t('search.root')}
        />
        <button className="btn-primary" onClick={() => void runSearch()} disabled={loading}>
          {loading ? t('search.running') : t('search.run')}
        </button>
        {docPath && (
          <button className="btn" onClick={() => void runSearch()} disabled={loading}>
            {t('search.rerun')}
          </button>
        )}
      </div>

      {error && <div className="banner err">{error}</div>}
      {notice && <div className="banner ok">{notice}</div>}

      {result && (
        <div className="search-actions">
          <input
            className="search-savename"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder={t('search.savePh')}
          />
          <button className="btn" onClick={() => void saveAsDocument()}>
            {t('search.openInEditor')}
          </button>
          <button
            className="btn-link"
            onClick={() => {
              setShowSaved((s) => !s);
            }}
          >
            {t('search.open')}
          </button>
        </div>
      )}

      {showSaved && (
        <div className="search-saved">
          <h4>{t('search.savedSearches')}</h4>
          {saved.length === 0 ? (
            <div className="muted">{t('search.noSaved')}</div>
          ) : (
            saved.map((p) => (
              <button key={p} className="search-saved-item" onClick={() => void openDocument(p)}>
                {p}
              </button>
            ))
          )}
        </div>
      )}

      {result && (
        <div className="search-results" aria-readonly="true">
          <div className="search-summary">
            {t('search.summary', {
              files: String(result.groups.length),
              matches: String(result.totalMatches),
            })}
            {typeof result.filesScanned === 'number' &&
              ' · ' + t('search.scanned', { files: String(result.filesScanned) })}
            {result.truncated && <span className="warn"> · {t('search.truncated')}</span>}
          </div>
          <div className="muted search-snapshot-note">{t('search.snapshot')}</div>
          {result.groups.length === 0 ? (
            <div className="muted">{t('search.noResults')}</div>
          ) : (
            result.groups.map((g) => (
              <div key={g.file} className="search-group">
                <button className="search-group-head" onClick={() => toggleGroup(g.file)}>
                  <span className="twisty">{collapsed[g.file] ? '▸' : '▾'}</span>
                  <span className="search-group-file">{g.file}</span>
                  <span className="muted">
                    ({g.matches.length} {t('search.matches')})
                  </span>
                </button>
                {!collapsed[g.file] && (
                  <div className="search-group-body">
                    {g.matches.map((m, i) => (
                      <button
                        key={`${m.line}:${m.column}:${i}`}
                        className="search-row"
                        onClick={() => openJump(g.file, m.line)}
                        title={t('search.jumpTitle')}
                      >
                        <span className="search-loc">
                          {m.line}:{m.column}
                        </span>
                        <span className="search-text">{m.text}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

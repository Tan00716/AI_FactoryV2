/**
 * Code Intelligence panel (V3-#6) — position queries against the precise
 * layer: definition, references, hover, outline, rename-preview.
 *
 * Every result carries its source (LSP / semantic engine / heuristic)
 * and the panel badges it; heuristic results are labeled as regex-index
 * guesses, never presented as compiler facts. Rename-preview never
 * writes files — it only lists the edits the caller would apply.
 */
import { useCallback, useState } from 'react';
import { api } from '../api';
import { useLang } from '../i18n';

interface Loc {
  file: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  isDefinition?: boolean;
  isWriteAccess?: boolean;
  oldText?: string;
  newText?: string;
}

type Kind = 'definition' | 'references' | 'hover' | 'outline' | 'rename-preview';

export function LangSrvPanel({ projectRoot }: { projectRoot: string }) {
  const { t } = useLang();
  const [root, setRoot] = useState(projectRoot);
  const [file, setFile] = useState('');
  const [line, setLine] = useState('0');
  const [character, setCharacter] = useState('0');
  const [newName, setNewName] = useState('');
  const [kind, setKind] = useState<Kind>('definition');
  const [source, setSource] = useState('');
  const [warning, setWarning] = useState('');
  const [locations, setLocations] = useState<Loc[]>([]);
  const [hover, setHover] = useState('');
  const [outline, setOutline] = useState<Array<{ name: string; kind: string; line: number; character: number }>>([]);
  const [rename, setRename] = useState<{ oldName: string; newName: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  const sourceLabel = (s: string): string =>
    s === 'lsp' ? t('langsrv.sourceLsp') : s === 'semantic' ? t('langsrv.sourceSemantic') : t('langsrv.sourceHeuristic');

  const run = useCallback(async () => {
    const r = root.trim() || projectRoot;
    if (!r || !file.trim() || line === '' || character === '') {
      setError(t('langsrv.required'));
      return;
    }
    if (kind === 'rename-preview' && !newName.trim()) {
      setError(t('langsrv.renameRequired'));
      return;
    }
    setLoading(true);
    setError(null);
    setWarning('');
    setLocations([]);
    setHover('');
    setOutline([]);
    setRename(null);
    try {
      const pos = { root: r, file: file.trim(), line: Number(line), character: Number(character) };
      if (kind === 'definition') {
        const res = await api.langsrvDefinition(pos);
        setSource(res.source);
        setWarning(res.warning ?? '');
        setLocations(res.locations);
      } else if (kind === 'references') {
        const res = await api.langsrvReferences(pos);
        setSource(res.source);
        setWarning(res.warning ?? '');
        setLocations(res.references);
      } else if (kind === 'hover') {
        const res = await api.langsrvHover(pos);
        setSource(res.source);
        setWarning(res.warning ?? '');
        setHover(res.hover ? res.hover.display : '');
      } else if (kind === 'outline') {
        const res = await api.langsrvOutline({ root: r, file: file.trim() });
        setSource(res.source);
        setWarning(res.warning ?? '');
        setOutline(res.symbols);
      } else {
        const res = await api.langsrvRenamePreview({ ...pos, newName: newName.trim() });
        setSource(res.source);
        setRename({ oldName: res.oldName, newName: newName.trim() });
        setLocations(res.edits);
      }
    } catch (e) {
      setError(t('langsrv.failed', { message: (e as Error).message }));
    } finally {
      setLoading(false);
    }
  }, [root, projectRoot, file, line, character, newName, kind, t]);

  const loadStatus = useCallback(async () => {
    try {
      const res = await api.langsrvStatus();
      setStatus(
        `${res.status.semantic} / LSP ${res.status.lspConfigured ? (res.status.lspConnected ? 'connected' : 'configured') : 'off'} / ${res.status.queries} queries`,
      );
    } catch (e) {
      setStatus((e as Error).message);
    }
  }, []);

  return (
    <div>
      <h2>{t('langsrv.title')}</h2>
      <div>
        <label>
          {t('langsrv.root')} <input value={root} onChange={(e) => setRoot(e.target.value)} placeholder={t('langsrv.rootPh')} />
        </label>{' '}
        <label>
          {t('langsrv.file')} <input value={file} onChange={(e) => setFile(e.target.value)} placeholder={t('langsrv.filePh')} />
        </label>{' '}
        <label>
          {t('langsrv.line')} <input value={line} onChange={(e) => setLine(e.target.value)} inputMode="numeric" />
        </label>{' '}
        <label>
          {t('langsrv.character')} <input value={character} onChange={(e) => setCharacter(e.target.value)} inputMode="numeric" />
        </label>{' '}
        <label>
          {t('langsrv.newName')} <input value={newName} onChange={(e) => setNewName(e.target.value)} />
        </label>
      </div>
      <div>
        {(['definition', 'references', 'hover', 'outline', 'rename-preview'] as Kind[]).map((k) => (
          <button key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
            {t(`langsrv.${k === 'rename-preview' ? 'renamePreview' : k}`)}
          </button>
        ))}{' '}
        <button onClick={run} disabled={loading}>{loading ? t('langsrv.running') : t('langsrv.run')}</button>{' '}
        <button onClick={loadStatus}>{t('langsrv.status')}</button>
      </div>
      {status && <p className="muted">{status}</p>}
      {error && <p className="err">{error}</p>}
      {source && <p className="muted">{t('langsrv.source', { source: sourceLabel(source) })}</p>}
      {warning && <p className="muted">{t('langsrv.warning', { warning })}</p>}
      {kind === 'hover' && hover && <pre>{hover}</pre>}
      {kind === 'hover' && !hover && !loading && !error && <p className="muted">{t('langsrv.noResults')}</p>}
      {kind === 'outline' && outline.length > 0 && (
        <ul>
          {outline.map((s, i) => (
            <li key={i}>{s.kind} {s.name} — {s.line}:{s.character}</li>
          ))}
        </ul>
      )}
      {kind === 'rename-preview' && rename && (
        <p className="muted">{t('langsrv.oldName', { old: rename.oldName, new: rename.newName })} — {t('langsrv.edits', { count: locations.length })}</p>
      )}
      {(kind === 'definition' || kind === 'references' || kind === 'rename-preview') && locations.length > 0 && (
        <ul>
          {locations.map((l, i) => (
            <li key={i}>
              {l.file}:{l.line}:{l.character}–{l.endLine}:{l.endCharacter}
              {l.isDefinition ? ` (${t('langsrv.isDefinition')})` : ''}
              {l.isWriteAccess ? ` (${t('langsrv.isWrite')})` : ''}
              {l.oldText !== undefined ? ` ${l.oldText} → ${l.newText}` : ''}
            </li>
          ))}
        </ul>
      )}
      {(kind === 'definition' || kind === 'references' || kind === 'outline') && locations.length === 0 && outline.length === 0 && !loading && !error && (
        <p className="muted">{t('langsrv.noResults')}</p>
      )}
      <p className="muted">{t('langsrv.boundary')}</p>
    </div>
  );
}

import { useCallback, useState } from 'react';
import {
  api,
  type RefactorAnalyzeInput,
  type RefactorOpName,
  type RefactorProposalItem,
  type RefactorProposalResponse,
} from '../api';
import { useLang } from '../i18n';

/**
 * Deterministic refactoring panel (round-4 task R4-S3).
 * Extract Method / Extract Variable / Inline Variable / Rename Symbol
 * for TS/JS, with a per-item accept/reject preview.
 *
 * Flow: fill op params → Analyze (side-effect free, in-memory diff) →
 * check/uncheck items → Apply selected (sha256 drift-guarded, 409 on drift).
 *
 * HONEST BOUNDARIES (rendered in the UI):
 *  - TS/JS only; extract-method is closure-based and never synthesizes
 *    parameters; escaping return/break/continue selections are refused.
 *  - rename is scope-aware per file; cross-file rename only follows the
 *    explicit otherFiles importers you list.
 *  - apply is all-or-nothing per request: if a file changed since analyze,
 *    nothing is written (409 REFACTOR_DRIFT).
 */

const OPS: RefactorOpName[] = ['extract-variable', 'extract-method', 'inline-variable', 'rename-symbol'];

function opLabel(t: (k: string) => string, op: RefactorOpName): string {
  return {
    'extract-variable': t('refactor.opExtractVariable'),
    'extract-method': t('refactor.opExtractMethod'),
    'inline-variable': t('refactor.opInlineVariable'),
    'rename-symbol': t('refactor.opRenameSymbol'),
  }[op];
}

export function RefactorPanel({ projectId }: { projectId: string }) {
  const { t } = useLang();
  const [op, setOp] = useState<RefactorOpName>('extract-variable');
  const [file, setFile] = useState('');
  const [selStart, setSelStart] = useState('');
  const [selEnd, setSelEnd] = useState('');
  const [startLine, setStartLine] = useState('');
  const [endLine, setEndLine] = useState('');
  const [offset, setOffset] = useState('');
  const [name, setName] = useState('');
  const [newName, setNewName] = useState('');
  const [otherFiles, setOtherFiles] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<RefactorProposalResponse | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [applyMsg, setApplyMsg] = useState<string | null>(null);

  const num = (s: string): number | null => {
    if (!s.trim()) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  const buildInput = useCallback((): RefactorAnalyzeInput | null => {
    if (!file.trim()) return null;
    const base = { projectId, file: file.trim(), op };
    if (op === 'extract-variable') {
      const start = num(selStart);
      const end = num(selEnd);
      if (start === null || end === null || !name.trim()) return null;
      return { ...base, selection: { start, end }, name: name.trim() };
    }
    if (op === 'extract-method') {
      const sl = num(startLine);
      const el = num(endLine);
      if (sl === null || el === null || !name.trim()) return null;
      return { ...base, lines: { startLine: sl, endLine: el }, name: name.trim() };
    }
    if (op === 'inline-variable') {
      const off = num(offset);
      if (off === null) return null;
      return { ...base, offset: off };
    }
    const off = num(offset);
    if (off === null || !newName.trim()) return null;
    const others = otherFiles.split('\n').map((s) => s.trim()).filter(Boolean);
    return { ...base, offset: off, newName: newName.trim(), ...(others.length ? { otherFiles: others } : {}) };
  }, [projectId, file, op, selStart, selEnd, startLine, endLine, offset, name, newName, otherFiles]);

  const analyze = useCallback(async () => {
    const input = buildInput();
    if (!input) {
      setError(t('refactor.fillAll'));
      return;
    }
    setBusy(true);
    setError(null);
    setApplyMsg(null);
    setProposal(null);
    try {
      const p = await api.refactorAnalyze(input);
      setProposal(p);
      setChecked(new Set(p.items.map((i) => i.id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [buildInput, t]);

  const toggle = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const applySelected = useCallback(async () => {
    if (!proposal) return;
    const ids = proposal.items.filter((i) => checked.has(i.id)).map((i) => i.id);
    if (ids.length === 0) {
      setError(t('refactor.selectAtLeastOne'));
      return;
    }
    setBusy(true);
    setError(null);
    setApplyMsg(null);
    try {
      const r = await api.refactorApply(proposal.proposalId, ids);
      if (r.status === 409) {
        setError(t('refactor.drift'));
      } else if (r.status !== 200) {
        setError(`HTTP ${r.status}`);
      } else {
        setApplyMsg(t('refactor.applied', { files: r.body.applied.join(', ') || '—' }));
        setProposal(null);
        setChecked(new Set());
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/409|DRIFT/i.test(msg) ? t('refactor.drift') : msg);
    } finally {
      setBusy(false);
    }
  }, [proposal, checked, t]);

  const renderItem = (item: RefactorProposalItem) => (
    <div key={item.id} className="refactor-item">
      <label className="refactor-item-head">
        <input type="checkbox" checked={checked.has(item.id)} onChange={() => toggle(item.id)} />
        <code>{item.file}</code>
      </label>
      {item.warnings.length > 0 && (
        <ul className="refactor-warnings">
          {item.warnings.map((w, k) => (
            <li key={k}>{w.message}</li>
          ))}
        </ul>
      )}
      <pre className="refactor-diff">{item.diff}</pre>
    </div>
  );

  return (
    <div className="refactor-panel">
      <h2>{t('refactor.title')}</h2>
      <p className="refactor-note">{t('refactor.boundaries')}</p>

      <div className="refactor-form">
        <label>
          {t('refactor.op')}
          <select value={op} onChange={(e) => setOp(e.target.value as RefactorOpName)}>
            {OPS.map((o) => (
              <option key={o} value={o}>{opLabel(t, o)}</option>
            ))}
          </select>
        </label>
        <label>
          {t('refactor.file')}
          <input value={file} onChange={(e) => setFile(e.target.value)} placeholder="packages/foo/src/bar.ts" />
        </label>
        {op === 'extract-variable' && (
          <>
            <label>{t('refactor.selStart')}<input value={selStart} onChange={(e) => setSelStart(e.target.value)} placeholder="128" /></label>
            <label>{t('refactor.selEnd')}<input value={selEnd} onChange={(e) => setSelEnd(e.target.value)} placeholder="137" /></label>
            <label>{t('refactor.varName')}<input value={name} onChange={(e) => setName(e.target.value)} placeholder="total" /></label>
          </>
        )}
        {op === 'extract-method' && (
          <>
            <label>{t('refactor.startLine')}<input value={startLine} onChange={(e) => setStartLine(e.target.value)} placeholder="12" /></label>
            <label>{t('refactor.endLine')}<input value={endLine} onChange={(e) => setEndLine(e.target.value)} placeholder="18" /></label>
            <label>{t('refactor.fnName')}<input value={name} onChange={(e) => setName(e.target.value)} placeholder="computeTotal" /></label>
          </>
        )}
        {op === 'inline-variable' && (
          <label>{t('refactor.offset')}<input value={offset} onChange={(e) => setOffset(e.target.value)} placeholder="256" /></label>
        )}
        {op === 'rename-symbol' && (
          <>
            <label>{t('refactor.offset')}<input value={offset} onChange={(e) => setOffset(e.target.value)} placeholder="256" /></label>
            <label>{t('refactor.newName')}<input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="total" /></label>
            <label>
              {t('refactor.otherFiles')}
              <textarea value={otherFiles} onChange={(e) => setOtherFiles(e.target.value)} placeholder={'a.ts\nb.ts'} rows={2} />
            </label>
          </>
        )}
        <button disabled={busy} onClick={analyze}>{t('refactor.analyze')}</button>
      </div>

      {error && <div className="banner err">{error}</div>}
      {applyMsg && <div className="banner ok">{applyMsg}</div>}

      {proposal && (
        <div className="refactor-proposal">
          <h3>{t('refactor.previewTitle', { n: String(proposal.items.length) })}</h3>
          {proposal.warnings.length > 0 && (
            <ul className="refactor-warnings">
              {proposal.warnings.map((w, k) => (
                <li key={k}>{w.message}</li>
              ))}
            </ul>
          )}
          {proposal.items.map(renderItem)}
          <div className="refactor-actions">
            <button disabled={busy} onClick={applySelected}>{t('refactor.applySelected')}</button>
            <button disabled={busy} onClick={() => { setProposal(null); setChecked(new Set()); }}>{t('refactor.discard')}</button>
          </div>
        </div>
      )}
    </div>
  );
}

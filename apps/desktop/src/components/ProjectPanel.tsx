import { useEffect, useRef, useState } from 'react';
import { api, type QualityGateConfig, type QualityGateLastRun } from '../api';
import { useLang } from '../i18n';

interface Issue { file: string; message: string }

type ImportState =
  | { kind: 'idle' }
  | { kind: 'working'; label: string }
  | { kind: 'error'; message: string }
  | { kind: 'import-ok'; targetDir: string; written: string[] }
  | { kind: 'import-rejected'; issues: Issue[] };

function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Project settings tab — spec §4 module 33 (Import / Export).
 * Export downloads the `.ai/` directory structure (§103) as a single
 * `.ai-export.json` document; import validates it (schema + secret scan)
 * and shows every issue before anything is written.
 */
/**
 * 质量闸门（确定性 lint/test 门禁，零模型）：项目级配置 + 最近一次
 * 运行结果。只做"跑 + 判 + 报"，不做自动修复。
 */
function QualityGateSection({ projectId }: { projectId: string }) {
  const { t } = useLang();
  const [config, setConfig] = useState<QualityGateConfig | null>(null);
  const [lastRun, setLastRun] = useState<Record<'lint' | 'test', QualityGateLastRun | null> | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState<'lint' | 'test' | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [lintCmd, setLintCmd] = useState('');
  const [testCmd, setTestCmd] = useState('');
  const [timeoutMs, setTimeoutMs] = useState('120000');
  const [runOnEdit, setRunOnEdit] = useState(false);
  const [blockOnFailure, setBlockOnFailure] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.qualityGate(projectId);
        if (cancelled) return;
        setConfig(res.config);
        setLastRun(res.lastRun);
        setLintCmd(res.config.lintCmd);
        setTestCmd(res.config.testCmd);
        setTimeoutMs(String(res.config.timeoutMs));
        setRunOnEdit(res.config.runOnEdit);
        setBlockOnFailure(res.config.blockOnFailure);
        setLoaded(true);
      } catch (e) {
        if (!cancelled) setMsg({ kind: 'err', text: t('quality.loadFailed', { message: (e as Error).message }) });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const onSave = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await api.updateQualityGate(projectId, {
        lintCmd,
        testCmd,
        timeoutMs: Number(timeoutMs) || 120000,
        runOnEdit,
        blockOnFailure,
      });
      setConfig(res.config);
      setMsg({ kind: 'ok', text: t('quality.saved') });
    } catch (e) {
      setMsg({ kind: 'err', text: t('quality.saveFailed', { message: (e as Error).message }) });
    } finally {
      setSaving(false);
    }
  };

  const onRun = async (kind: 'lint' | 'test') => {
    setRunning(kind);
    setMsg(null);
    setLastResult(null);
    try {
      const r = await api.runQualityGate(projectId, kind);
      const res = await api.qualityGate(projectId);
      setLastRun(res.lastRun);
      setLastResult(
        r.skipped
          ? t('quality.skipped', { reason: r.skipReason ?? '' })
          : t('quality.runDone', {
              kind,
              verdict: r.ok ? t('quality.pass') : t('quality.fail'),
              ms: r.durationMs,
              blocked: r.blocked ? t('quality.blockedNote') : '',
            }),
      );
    } catch (e) {
      setMsg({ kind: 'err', text: t('quality.runFailed', { message: (e as Error).message }) });
    } finally {
      setRunning(null);
    }
  };

  const runBadge = (r: QualityGateLastRun | null | undefined, kind: string) => {
    if (!r) return <span className="muted">{t('quality.neverRun', { kind })}</span>;
    return (
      <span className={r.ok ? 'ok' : 'err'}>
        {kind}: {r.ok ? t('quality.pass') : t('quality.fail')} · {r.durationMs}ms · {r.at}
        {r.timedOut ? ` · ${t('quality.timedOut')}` : ''}
        {r.truncated ? ` · ${t('quality.truncated')}` : ''}
      </span>
    );
  };

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <h3>{t('quality.title')}</h3>
      <p className="muted">{t('quality.description')}</p>
      {config && (
        <>
          <label className="field">
            <span>{t('quality.lintCmd')}</span>
            <input value={lintCmd} onChange={(e) => setLintCmd(e.target.value)}
              placeholder="ruff check --fix ." style={{ width: '100%' }} />
          </label>
          <label className="field">
            <span>{t('quality.testCmd')}</span>
            <input value={testCmd} onChange={(e) => setTestCmd(e.target.value)}
              placeholder="pytest -x -q" style={{ width: '100%' }} />
          </label>
          <div className="row">
            <label className="field">
              <span>{t('quality.timeoutMs')}</span>
              <input value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)}
                inputMode="numeric" style={{ width: 120 }} />
            </label>
            <label className="check">
              <input type="checkbox" checked={runOnEdit} onChange={(e) => setRunOnEdit(e.target.checked)} />
              {t('quality.runOnEdit')}
            </label>
            <label className="check">
              <input type="checkbox" checked={blockOnFailure} onChange={(e) => setBlockOnFailure(e.target.checked)} />
              {t('quality.blockOnFailure')}
            </label>
          </div>
          <div className="row">
            <button onClick={onSave} disabled={saving}>{t('quality.save')}</button>
            <button onClick={() => void onRun('lint')} disabled={running !== null}>
              {running === 'lint' ? t('quality.running') : t('quality.runLint')}
            </button>
            <button onClick={() => void onRun('test')} disabled={running !== null}>
              {running === 'test' ? t('quality.running') : t('quality.runTest')}
            </button>
          </div>
          <p className="muted">{t('quality.lastRunTitle')}</p>
          <ul>
            <li>{runBadge(lastRun?.lint, 'lint')}</li>
            <li>{runBadge(lastRun?.test, 'test')}</li>
          </ul>
        </>
      )}
      {lastResult && <p className="muted">{lastResult}</p>}
      {msg && <p className={msg.kind === 'ok' ? 'ok' : 'err'}>{msg.text}</p>}
    </div>
  );
}

export function ProjectPanel({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { t } = useLang();
  const [state, setState] = useState<ImportState>({ kind: 'idle' });
  const [exported, setExported] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const onExport = async () => {
    setState({ kind: 'working', label: t('project.exporting') });
    try {
      const res = await api.exportProject(projectId);
      const count = Object.keys(res.files).length;
      setExported(count);
      downloadJson(`${projectName || projectId}.ai-export.json`, res);
      setState({ kind: 'idle' });
    } catch (e) {
      setState({ kind: 'error', message: t('project.exportFailed', { message: (e as Error).message }) });
    }
  };

  const onPickFile = async (f: File) => {
    setState({ kind: 'working', label: t('project.validating', { name: f.name }) });
    try {
      const text = await f.text();
      const parsed = JSON.parse(text) as { files?: Record<string, string> };
      const files = parsed.files ?? (parsed as unknown as Record<string, string>);
      if (!files || typeof files !== 'object' || Array.isArray(files)) {
        throw new Error(t('project.invalidDoc'));
      }
      const res = await api.importProject(projectId, files);
      if (res.ok) {
        setState({
          kind: 'import-ok',
          targetDir: res.targetDir ?? '',
          written: res.written ?? [],
        });
      } else {
        setState({ kind: 'import-rejected', issues: res.issues ?? [] });
      }
    } catch (e) {
      setState({ kind: 'error', message: t('project.importFailed', { message: (e as Error).message }) });
    }
  };

  return (
    <div className="panel">
      <h3>{t('project.title', { name: projectName })}</h3>
      <p className="muted">
        {t('project.desc1')}<code>.ai/</code>{t('project.desc2')}<code>env_refs</code>{t('project.desc3')}
      </p>
      <div className="row">
        <button onClick={onExport}>{t('project.exportBtn')}</button>
        <button onClick={() => fileRef.current?.click()}>{t('project.importBtn')}</button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void onPickFile(f);
          }}
        />
      </div>
      {exported > 0 && state.kind === 'idle' && (
        <p className="ok">{t('project.lastExport', { count: exported })}</p>
      )}
      {state.kind === 'working' && <p className="muted">{state.label}</p>}
      {state.kind === 'error' && <p className="err">{state.message}</p>}
      {state.kind === 'import-ok' && (
        <div>
          <p className="ok">{t('project.importOk', { count: state.written.length })} <code>{state.targetDir}</code></p>
          <ul className="file-list">
            {state.written.slice(0, 20).map((w) => <li key={w}><code>{w}</code></li>)}
          </ul>
          {state.written.length > 20 && <p className="muted">{t('project.andMore', { count: state.written.length })}</p>}
        </div>
      )}
      {state.kind === 'import-rejected' && (
        <div>
          <p className="err">{t('project.importRejected', { count: state.issues.length })}</p>
          <ul className="issue-list">
            {state.issues.map((i, idx) => (
              <li key={idx}><code>{i.file}</code> — {i.message}</li>
            ))}
          </ul>
        </div>
      )}
      <QualityGateSection projectId={projectId} />
    </div>
  );
}

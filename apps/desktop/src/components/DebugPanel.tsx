import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type DebugAdapterInfo,
  type DebugAdapterProbe,
  type DebugBreakpointInput,
  type DebugLaunchConfig,
  type DebugOutputLine,
  type DebugScope,
  type DebugSessionSummary,
  type DebugStackFrame,
  type DebugVariable,
} from '../api';
import { useLang } from '../i18n';

/**
 * DAP 调试器面板 (round-4 task R4-S2).
 *
 * Flow: pick a launch.json config (or inline program) → Launch (breakpoints
 * can ride along; the node adapter launches --inspect-brk internally so they
 * are in place before the target runs) → poll session state → when paused,
 * inspect stack / scopes / variables, step, evaluate watch expressions.
 *
 * HONEST BOUNDARIES (rendered in the UI):
 *  - Only the Node.js adapter is driven. Python (debugpy) and Go (delve)
 *    are registered placeholders: the registry reports whether their
 *    binaries exist, but launching them returns 501 — never silently
 *    reinterpreted as Node. Other debug types are rejected.
 *  - attach is loopback-only (127.0.0.1).
 *  - max 8 concurrent sessions, server-local; sessions die with the server.
 *  - A breakpoint condition with invalid JS syntax is a 400 at set time;
 *    a runtime evaluation error at hit time never breaks the session —
 *    the breakpoint simply does not pause and the target keeps running.
 */
export function DebugPanel({ projectId }: { projectId: string }) {
  const { t } = useLang();
  const [configs, setConfigs] = useState<DebugLaunchConfig[]>([]);
  const [configsNote, setConfigsNote] = useState<string | null>(null);
  const [configName, setConfigName] = useState('');
  const [inlineProgram, setInlineProgram] = useState('');
  const [sessions, setSessions] = useState<DebugSessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // breakpoints drafted before launch (ride along with the start request)
  const [bpFile, setBpFile] = useState('');
  const [bpLine, setBpLine] = useState('');
  const [bpCondition, setBpCondition] = useState('');
  const [bpLogMessage, setBpLogMessage] = useState('');
  const [draftBps, setDraftBps] = useState<DebugBreakpointInput[]>([]);

  // adapter registry (round-7 R7-#7): static list + on-demand probes
  const [adapters, setAdapters] = useState<DebugAdapterInfo[]>([]);
  const [probes, setProbes] = useState<Record<string, DebugAdapterProbe>>({});
  const [probingKind, setProbingKind] = useState<string | null>(null);

  // live session views
  const [frames, setFrames] = useState<DebugStackFrame[]>([]);
  const [frameId, setFrameId] = useState<number | null>(null);
  const [scopes, setScopes] = useState<DebugScope[]>([]);
  const [varsByRef, setVarsByRef] = useState<Record<number, DebugVariable[]>>({});
  const [expandedRefs, setExpandedRefs] = useState<Set<number>>(new Set());
  const [watchExpr, setWatchExpr] = useState('');
  const [watches, setWatches] = useState<string[]>([]);
  const [watchResults, setWatchResults] = useState<Record<string, string>>({});
  const [output, setOutput] = useState<DebugOutputLine[]>([]);
  const outputSeq = useRef(0);

  const active = sessions.find((s) => s.sessionId === activeId) ?? null;
  const paused = active?.state === 'paused';

  const loadConfigs = useCallback(async () => {
    try {
      const r = await api.debugConfigs(projectId);
      setConfigs(r.configurations);
      setConfigsNote(r.note ?? null);
      if (r.configurations.length > 0 && !configName) setConfigName(r.configurations[0].name);
    } catch (e) {
      setError((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const refreshSessions = useCallback(async () => {
    try {
      const r = await api.debugSessions();
      setSessions(r.sessions);
      if (r.sessions.length > 0 && !activeId) setActiveId(r.sessions[0].sessionId);
      if (activeId && !r.sessions.some((s) => s.sessionId === activeId)) setActiveId(null);
    } catch {
      /* polling must not spam errors */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const loadAdapters = useCallback(async () => {
    try {
      const r = await api.debugAdapters();
      setAdapters(r.adapters);
    } catch {
      /* adapter list is informational; a failed load must not break debugging */
    }
  }, []);

  const probeAdapter = useCallback(async (kind: string) => {
    setProbingKind(kind);
    try {
      const r = await api.debugProbeAdapter(kind);
      setProbes((prev) => ({ ...prev, [kind]: r }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProbingKind(null);
    }
  }, []);

  useEffect(() => {
    loadConfigs();
    loadAdapters();
    refreshSessions();
  }, [loadConfigs, loadAdapters, refreshSessions]);

  // poll the active session state + output
  useEffect(() => {
    if (!activeId) return;
    let dead = false;
    const tick = async () => {
      if (dead) return;
      try {
        const r = await api.debugSessions();
        if (dead) return;
        setSessions(r.sessions);
        const o = await api.debugOutput(activeId, outputSeq.current);
        if (dead) return;
        if (o.lines.length > 0) {
          outputSeq.current = o.latestSeq;
          setOutput((prev) => [...prev.slice(-150), ...o.lines]);
        }
      } catch {
        /* ignore */
      }
    };
    tick();
    const iv = setInterval(tick, 1500);
    return () => {
      dead = true;
      clearInterval(iv);
    };
  }, [activeId]);

  const addDraftBp = () => {
    const line = Number(bpLine);
    if (!bpFile.trim() || !Number.isFinite(line) || line < 1) {
      setError(t('debug.bpInvalid'));
      return;
    }
    setError(null);
    setDraftBps((prev) => [
      ...prev,
      {
        file: bpFile.trim(),
        line: Math.floor(line),
        condition: bpCondition.trim() || undefined,
        logMessage: bpLogMessage.trim() || undefined,
      },
    ]);
    setBpFile('');
    setBpLine('');
    setBpCondition('');
    setBpLogMessage('');
  };

  const startSession = async () => {
    setBusy(true);
    setError(null);
    try {
      const input = configName
        ? { projectId, configName, breakpoints: draftBps.length > 0 ? draftBps : undefined }
        : inlineProgram.trim()
          ? {
              projectId,
              config: { name: 'inline', type: 'node', request: 'launch', program: inlineProgram.trim() },
              breakpoints: draftBps.length > 0 ? draftBps : undefined,
            }
          : null;
      if (!input) {
        setError(t('debug.pickConfig'));
        return;
      }
      const r = await api.debugStartSession(input);
      setDraftBps([]);
      outputSeq.current = 0;
      setOutput([]);
      setFrames([]);
      setScopes([]);
      setVarsByRef({});
      setWatches([]);
      setWatchResults({});
      await refreshSessions();
      setActiveId(r.sessionId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stopSession = async () => {
    if (!activeId) return;
    setBusy(true);
    try {
      await api.debugStopSession(activeId);
      await refreshSessions();
      setActiveId(null);
      setFrames([]);
      setScopes([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const step = async (action: 'continue' | 'next' | 'step-in' | 'step-out' | 'pause') => {
    if (!activeId) return;
    try {
      await api.debugStep(activeId, action);
      await refreshSessions();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const loadStack = useCallback(async () => {
    if (!activeId) return;
    try {
      const r = await api.debugStack(activeId);
      setFrames(r.stackFrames);
      const top = r.stackFrames[0];
      setFrameId(top ? top.id : null);
      if (top) {
        const sc = await api.debugScopes(activeId, top.id);
        setScopes(sc.scopes);
        setVarsByRef({});
        setExpandedRefs(new Set());
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [activeId]);

  useEffect(() => {
    if (paused) loadStack();
    else {
      setFrames([]);
      setScopes([]);
    }
  }, [paused, loadStack]);

  const toggleVars = async (ref: number) => {
    if (!activeId || ref <= 0) return;
    if (expandedRefs.has(ref)) {
      setExpandedRefs((prev) => {
        const n = new Set(prev);
        n.delete(ref);
        return n;
      });
      return;
    }
    try {
      const r = await api.debugVariables(activeId, ref);
      setVarsByRef((prev) => ({ ...prev, [ref]: r.variables }));
      setExpandedRefs((prev) => new Set(prev).add(ref));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const selectFrame = async (id: number) => {
    if (!activeId) return;
    setFrameId(id);
    try {
      const sc = await api.debugScopes(activeId, id);
      setScopes(sc.scopes);
      setVarsByRef({});
      setExpandedRefs(new Set());
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const addWatch = () => {
    const expr = watchExpr.trim();
    if (!expr || watches.includes(expr)) return;
    setWatches((prev) => [...prev, expr]);
    setWatchExpr('');
  };

  const evalWatches = useCallback(async () => {
    if (!activeId || !paused || watches.length === 0) return;
    const results: Record<string, string> = {};
    for (const w of watches) {
      try {
        const r = await api.debugEvaluate(activeId, w, frameId ?? undefined);
        results[w] = r.result;
      } catch (e) {
        results[w] = `! ${(e as Error).message}`;
      }
    }
    setWatchResults(results);
  }, [activeId, paused, watches, frameId]);

  useEffect(() => {
    evalWatches();
  }, [evalWatches]);

  const renderVar = (v: DebugVariable, depth: number): React.ReactNode => {
    const expandable = v.variablesReference > 0;
    const expanded = expandedRefs.has(v.variablesReference);
    return (
      <div key={`${v.name}@${depth}`} style={{ marginLeft: depth * 12 }}>
        <span
          className={expandable ? 'dbg-var-toggle' : ''}
          onClick={() => expandable && toggleVars(v.variablesReference)}
        >
          {expandable ? (expanded ? '▾ ' : '▸ ') : ''}
          <span className="dbg-var-name">{v.name}</span>
          {v.type && v.type !== 'undefined' ? <span className="dbg-var-type">: {v.type}</span> : null}
          {' = '}
          <span className="dbg-var-value">{v.value}</span>
        </span>
        {expandable && expanded && (varsByRef[v.variablesReference] ?? []).map((c) => renderVar(c, depth + 1))}
      </div>
    );
  };

  return (
    <div className="panel dbg-panel">
      <h3>{t('debug.title')}</h3>
      <p className="muted">{t('debug.honestNote')}</p>
      {error && <div className="banner err">{error}</div>}

      {adapters.length > 0 && (
        <div className="dbg-adapters">
          <h4>{t('debug.adaptersTitle')}</h4>
          <ul className="dbg-list">
            {adapters.map((a) => {
              const probe = probes[a.kind];
              return (
                <li key={a.kind}>
                  <strong>{a.displayName}</strong>{' '}
                  <span className="muted">
                    ({a.driver === 'builtin' ? t('debug.adapterBuiltin') : t('debug.adapterExternal')}
                    {a.implemented ? '' : ` — ${t('debug.adapterNotDriven')}`})
                  </span>{' '}
                  <button onClick={() => probeAdapter(a.kind)} disabled={probingKind === a.kind}>
                    {probingKind === a.kind ? t('debug.adapterProbing') : t('debug.adapterProbe')}
                  </button>
                  {probe && (
                    <span className="muted">
                      {' '}
                      {probe.available ? t('debug.adapterAvailable') : t('debug.adapterUnavailable')}
                      {probe.version ? ` (${probe.version})` : ''} — {probe.detail}
                      {!probe.available && probe.installHint ? ` ${probe.installHint}` : ''}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="dbg-toolbar">
        <select value={configName} onChange={(e) => setConfigName(e.target.value)} disabled={busy || !!activeId}>
          <option value="">{t('debug.noConfig')}</option>
          {configs.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name} ({c.request}, {c.adapter})
            </option>
          ))}
        </select>
        <input
          value={inlineProgram}
          onChange={(e) => setInlineProgram(e.target.value)}
          placeholder={t('debug.inlineProgramPh')}
          disabled={busy || !!activeId || !!configName}
        />
        {!activeId ? (
          <button onClick={startSession} disabled={busy}>
            {t('debug.launch')}
          </button>
        ) : (
          <button onClick={stopSession} disabled={busy}>
            {t('debug.stop')}
          </button>
        )}
        <button onClick={loadConfigs} disabled={busy}>
          {t('debug.reloadConfigs')}
        </button>
      </div>
      {configsNote && <p className="muted">{configsNote}</p>}

      {active && (
        <div className="dbg-sessionbar">
          <strong>{active.name}</strong>
          <span className={`dbg-state dbg-state-${active.state}`}>{t(`debug.state_${active.state}`)}</span>
          {active.stopReason && <span className="muted">({active.stopReason})</span>}
          <span className="dbg-stepbtns">
            <button onClick={() => step('continue')} disabled={busy || !paused}>{t('debug.continue')}</button>
            <button onClick={() => step('pause')} disabled={busy || paused}>{t('debug.pause')}</button>
            <button onClick={() => step('next')} disabled={busy || !paused}>{t('debug.stepOver')}</button>
            <button onClick={() => step('step-in')} disabled={busy || !paused}>{t('debug.stepIn')}</button>
            <button onClick={() => step('step-out')} disabled={busy || !paused}>{t('debug.stepOut')}</button>
          </span>
        </div>
      )}

      <div className="dbg-cols">
        <div className="dbg-col">
          <h4>{t('debug.breakpoints')}</h4>
          <div className="dbg-bpform">
            <input value={bpFile} onChange={(e) => setBpFile(e.target.value)} placeholder={t('debug.bpFilePh')} disabled={!!activeId} />
            <input value={bpLine} onChange={(e) => setBpLine(e.target.value)} placeholder={t('debug.bpLinePh')} disabled={!!activeId} />
            <input value={bpCondition} onChange={(e) => setBpCondition(e.target.value)} placeholder={t('debug.bpCondPh')} disabled={!!activeId} />
            <input value={bpLogMessage} onChange={(e) => setBpLogMessage(e.target.value)} placeholder={t('debug.bpLogPh')} disabled={!!activeId} />
            <button onClick={addDraftBp} disabled={!!activeId}>{t('debug.bpAdd')}</button>
          </div>
          {draftBps.length === 0 ? (
            <p className="muted">{t('debug.bpEmpty')}</p>
          ) : (
            <ul className="dbg-list">
              {draftBps.map((b, i) => (
                <li key={i}>
                  {b.file}:{b.line}
                  {b.condition ? ` ? ${b.condition}` : ''}
                  {b.logMessage ? ` ${t('debug.bpLog')}: ${b.logMessage}` : ''}
                  <button onClick={() => setDraftBps((prev) => prev.filter((_, j) => j !== i))}>×</button>
                </li>
              ))}
            </ul>
          )}
          <h4>{t('debug.callStack')}</h4>
          {!paused ? (
            <p className="muted">{t('debug.notPaused')}</p>
          ) : (
            <ul className="dbg-list">
              {frames.map((f) => (
                <li key={f.id} className={f.id === frameId ? 'sel' : ''} onClick={() => selectFrame(f.id)}>
                  {f.name} <span className="muted">{f.source?.path ? `${f.source.path.split('/').pop()}:${f.line}` : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="dbg-col">
          <h4>{t('debug.variables')}</h4>
          {!paused ? (
            <p className="muted">{t('debug.notPaused')}</p>
          ) : (
            <div>
              {scopes.map((s) => (
                <div key={`${s.name}-${s.variablesReference}`}>
                  <div className="dbg-scope-name">{s.name}</div>
                  <div>
                    <span className="dbg-var-toggle" onClick={() => toggleVars(s.variablesReference)}>
                      {expandedRefs.has(s.variablesReference) ? '▾' : '▸'} {t('debug.scopeVars')}
                    </span>
                    {expandedRefs.has(s.variablesReference) &&
                      (varsByRef[s.variablesReference] ?? []).map((v) => renderVar(v, 1))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <h4>{t('debug.watch')}</h4>
          <div className="dbg-bpform">
            <input value={watchExpr} onChange={(e) => setWatchExpr(e.target.value)} placeholder={t('debug.watchPh')} />
            <button onClick={addWatch}>{t('debug.watchAdd')}</button>
          </div>
          <ul className="dbg-list">
            {watches.map((w) => (
              <li key={w}>
                <span className="dbg-var-name">{w}</span> ={' '}
                <span className="dbg-var-value">{watchResults[w] ?? '…'}</span>
                <button onClick={() => setWatches((prev) => prev.filter((x) => x !== w))}>×</button>
              </li>
            ))}
          </ul>
        </div>

        <div className="dbg-col">
          <h4>{t('debug.output')}</h4>
          <pre className="dbg-output">
            {output.map((l) => l.output).join('') || t('debug.outputEmpty')}
          </pre>
        </div>
      </div>

      {sessions.length > 1 && (
        <div className="dbg-sessions">
          <h4>{t('debug.sessions')}</h4>
          <ul className="dbg-list">
            {sessions.map((s) => (
              <li key={s.sessionId} className={s.sessionId === activeId ? 'sel' : ''} onClick={() => setActiveId(s.sessionId)}>
                {s.name} <span className="muted">{t(`debug.state_${s.state}`)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

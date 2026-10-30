import { useEffect, useRef, useState } from 'react';
import { api, type EgressBlockEntry, type EgressConfigState, type EgressRule, type EgressTestResult, type IgnorePreview, type QualityGateConfig, type QualityGateLastRun } from '../api';
import EgressWizardPanel from './EgressWizardPanel';
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
  const [secFailOn, setSecFailOn] = useState<string[]>([]);
  const [impactFailOnBreaking, setImpactFailOnBreaking] = useState(false);
  const [flakyRerunOnce, setFlakyRerunOnce] = useState(false);
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
        setSecFailOn(res.config.security?.failOn ?? []);
        setImpactFailOnBreaking(res.config.impact?.failOnBreaking ?? false);
        setFlakyRerunOnce(res.config.flaky?.rerunFlakyOnce ?? false);
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
        security: { failOn: secFailOn },
        impact: { failOnBreaking: impactFailOnBreaking },
        flaky: { rerunFlakyOnce: flakyRerunOnce },
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
            }) +
            (r.security
              ? t('quality.securityRunNote', {
                  secret: r.security.secret,
                  sast: r.security.sast,
                  sca: r.security.sca,
                  blocked: r.security.blocked ? t('quality.blockedNote') : '',
                })
              : '') +
            (r.impact
              ? r.impact.error
                ? t('quality.impactErrorNote', { error: r.impact.error })
                : t('quality.impactRunNote', {
                    changed: r.impact.changedFiles ?? 0,
                    affected: r.impact.affected ?? 0,
                    breaking: r.impact.breaking ?? 0,
                    blocked: r.impact.blocked ? t('quality.blockedNote') : '',
                  })
              : '') +
            (r.flakyRerun
              ? r.flakyRerun.attempted
                ? t('quality.flakyRerunNote', {
                    known: r.flakyRerun.firstRun?.knownFlaky.length ?? 0,
                    other: r.flakyRerun.firstRun?.otherFailing.length ?? 0,
                    rerun: r.flakyRerun.rerun?.ok ? t('quality.pass') : t('quality.fail'),
                    rerunFailing: r.flakyRerun.rerun?.failing.length ?? 0,
                  })
                : t('quality.flakySkippedNote', { reason: r.flakyRerun.reason ?? '' })
              : ''),
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
            <span className="muted">{t('quality.securityFailOn')}</span>
            {(['secret', 'sast', 'sca'] as const).map((cat) => (
              <label className="check" key={cat}>
                <input
                  type="checkbox"
                  checked={secFailOn.includes(cat)}
                  onChange={(e) =>
                    setSecFailOn(e.target.checked ? [...secFailOn, cat] : secFailOn.filter((c) => c !== cat))
                  }
                />
                {t(`quality.secCat.${cat}`)}
              </label>
            ))}
          </div>
          <p className="muted" style={{ fontSize: 11 }}>{t('quality.securityNote')}</p>
          <div className="row">
            <label className="check">
              <input
                type="checkbox"
                checked={impactFailOnBreaking}
                onChange={(e) => setImpactFailOnBreaking(e.target.checked)}
              />
              {t('quality.impactFailOnBreaking')}
            </label>
          </div>
          <p className="muted" style={{ fontSize: 11 }}>{t('quality.impactNote')}</p>
          <div className="row">
            <label className="check">
              <input
                type="checkbox"
                checked={flakyRerunOnce}
                onChange={(e) => setFlakyRerunOnce(e.target.checked)}
              />
              {t('quality.flakyRerunOnce')}
            </label>
          </div>
          <p className="muted" style={{ fontSize: 11 }}>{t('quality.flakyNote')}</p>
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

/**
 * 两级忽略文件（Cursor 式，不依赖模型）：项目级 `.ai-factory/ignore`
 *（硬排除：索引、@ 提供器、搜索、repo 地图、备份全部不可见）+
 * `.ai-factory/indexing-ignore`（只排除索引/repomap，仍可显式引用）。
 * 可视化编辑 + 排除命中预览（dry-run）。
 */
function IgnoresSection({ projectId }: { projectId: string }) {
  const { t } = useLang();
  const [hard, setHard] = useState('');
  const [indexing, setIndexing] = useState('');
  const [template, setTemplate] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [hardPatterns, setHardPatterns] = useState(0);
  const [indexingPatterns, setIndexingPatterns] = useState(0);
  const [errors, setErrors] = useState<{ layer: string; file: string; message: string }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<IgnorePreview | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = async () => {
    setMsg(null);
    try {
      const res = await api.ignores(projectId);
      setHard(res.hard);
      setIndexing(res.indexing);
      setTemplate(res.template);
      setProjectPath(res.projectPath);
      setHardPatterns(res.hardPatterns);
      setIndexingPatterns(res.indexingPatterns);
      setErrors(res.errors);
      setLoaded(true);
    } catch (e) {
      setMsg({ kind: 'err', text: t('ignores.loadFailed', { message: (e as Error).message }) });
      setLoaded(true);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await load();
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const onSave = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await api.updateIgnores(projectId, { hard, indexing });
      setHardPatterns(res.hardPatterns);
      setIndexingPatterns(res.indexingPatterns);
      setErrors(res.errors);
      setMsg({ kind: 'ok', text: t('ignores.saved') });
    } catch (e) {
      setMsg({ kind: 'err', text: t('ignores.saveFailed', { message: (e as Error).message }) });
    } finally {
      setSaving(false);
    }
  };

  const onPreview = async () => {
    setPreviewing(true);
    setMsg(null);
    try {
      const res = await api.previewIgnores(projectId, 200);
      setPreview(res);
    } catch (e) {
      setMsg({ kind: 'err', text: t('ignores.previewFailed', { message: (e as Error).message }) });
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <section className="sub-panel">
      <h4>{t('ignores.title')}</h4>
      <p className="muted">{t('ignores.desc')}</p>
      {!loaded ? (
        <p className="muted">{t('ignores.loading')}</p>
      ) : (
        <>
          <p className="muted">
            <code>{projectPath}/.ai-factory/ignore</code> · {t('ignores.hardPatterns', { count: hardPatterns })}
          </p>
          <label>
            {t('ignores.hardLabel')}
            <textarea
              rows={7}
              value={hard}
              onChange={(e) => setHard(e.target.value)}
              placeholder={t('ignores.hardPlaceholder')}
              spellCheck={false}
              style={{ width: '100%', fontFamily: 'monospace' }}
            />
          </label>
          <p className="muted">
            <code>{projectPath}/.ai-factory/indexing-ignore</code> · {t('ignores.indexingPatterns', { count: indexingPatterns })}
          </p>
          <label>
            {t('ignores.indexingLabel')}
            <textarea
              rows={5}
              value={indexing}
              onChange={(e) => setIndexing(e.target.value)}
              placeholder={t('ignores.indexingPlaceholder')}
              spellCheck={false}
              style={{ width: '100%', fontFamily: 'monospace' }}
            />
          </label>
          <div className="row">
            <button disabled={saving} onClick={() => void onSave()}>
              {saving ? t('ignores.saving') : t('ignores.saveBtn')}
            </button>
            <button disabled={!template} onClick={() => setHard(template)}>
              {t('ignores.templateBtn')}
            </button>
            <button disabled={previewing} onClick={() => void onPreview()}>
              {previewing ? t('ignores.previewing') : t('ignores.previewBtn')}
            </button>
          </div>
          {errors.length > 0 && (
            <div>
              {errors.map((e, i) => (
                <p key={i} className="err">
                  {t('ignores.layerSkipped', { layer: e.layer, message: e.message })}
                </p>
              ))}
            </div>
          )}
          {preview && (
            <div>
              <p>
                {t('ignores.previewSummary', {
                  hard: preview.hardIgnored.length,
                  indexing: preview.indexingIgnored.length,
                  visited: preview.visited,
                })}
                {preview.truncated && ` · ${t('ignores.truncated')}`}
              </p>
              {preview.hardIgnored.length > 0 && (
                <>
                  <p className="muted">{t('ignores.hardHits')}</p>
                  <ul className="file-list">
                    {preview.hardIgnored.map((f) => (
                      <li key={f.rel}>
                        <code>{f.rel}</code> <span className="muted">← {f.pattern}:{f.line}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {preview.indexingIgnored.length > 0 && (
                <>
                  <p className="muted">{t('ignores.indexingHits')}</p>
                  <ul className="file-list">
                    {preview.indexingIgnored.map((f) => (
                      <li key={f.rel}>
                        <code>{f.rel}</code> <span className="muted">← {f.pattern}:{f.line}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <p className="muted">{preview.note}</p>
            </div>
          )}
          {msg && <p className={msg.kind === 'ok' ? 'ok' : 'err'}>{msg.text}</p>}
          <p className="muted">{t('ignores.honest')}</p>
        </>
      )}
    </section>
  );
}

/**
 * 出站防火墙（细粒度 allowlist，零模型）：global / project / task 三层
 * 规则编辑、启用开关 + 默认策略、干跑测试框、最近拦截列表。只约束
 * 服务端自己的工具/代理出站面（web 搜索、远程 MCP、调度器 webhook）；
 * 不约束 shell、浏览器与系统网络 ——— 文案明说。
 */
function EgressRuleRows({
  rules,
  onChange,
}: {
  rules: EgressRule[];
  onChange: (rules: EgressRule[]) => void;
}) {
  const { t } = useLang();
  const set = (i: number, patch: Partial<EgressRule>) =>
    onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div>
      {rules.map((r, i) => (
        <div key={i} className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <select
            value={r.action}
            onChange={(e) => set(i, { action: e.target.value as 'allow' | 'deny' })}
            aria-label={t('egress.action')}
          >
            <option value="allow">{t('egress.allow')}</option>
            <option value="deny">{t('egress.deny')}</option>
          </select>
          <input
            value={r.domain}
            onChange={(e) => set(i, { domain: e.target.value })}
            placeholder={t('egress.domainPlaceholder')}
            style={{ fontFamily: 'monospace', minWidth: 180 }}
            spellCheck={false}
          />
          <input
            value={r.pathPrefix ?? ''}
            onChange={(e) => set(i, { pathPrefix: e.target.value || undefined })}
            placeholder={t('egress.pathPlaceholder')}
            style={{ fontFamily: 'monospace', width: 120 }}
            spellCheck={false}
          />
          <input
            value={r.note ?? ''}
            onChange={(e) => set(i, { note: e.target.value || undefined })}
            placeholder={t('egress.note')}
            style={{ width: 160 }}
          />
          <button onClick={() => onChange(rules.filter((_, j) => j !== i))}>
            {t('egress.removeRule')}
          </button>
        </div>
      ))}
      <button onClick={() => onChange([...rules, { domain: '', action: 'allow' }])}>
        {t('egress.addRule')}
      </button>
    </div>
  );
}

function EgressSection({ projectId }: { projectId: string }) {
  const { t } = useLang();
  const [state, setState] = useState<EgressConfigState | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [defaultPolicy, setDefaultPolicy] = useState<'allow' | 'deny'>('deny');
  const [globalRules, setGlobalRules] = useState<EgressRule[]>([]);
  const [projectRules, setProjectRules] = useState<EgressRule[]>([]);
  const [taskId, setTaskId] = useState('');
  const [taskRules, setTaskRules] = useState<EgressRule[]>([]);
  const [taskLoaded, setTaskLoaded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [testUrl, setTestUrl] = useState('');
  const [testOut, setTestOut] = useState<EgressTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [log, setLog] = useState<EgressBlockEntry[]>([]);

  const loadLog = async () => {
    try {
      const res = await api.egressLog(50);
      setLog(res.entries);
    } catch {
      /* log is best-effort display */
    }
  };

  const load = async (forTaskId?: string) => {
    setMsg(null);
    try {
      const res = await api.egressConfig(projectId, forTaskId || undefined);
      setState(res);
      setEnabled(res.global.enabled);
      setDefaultPolicy(res.global.defaultPolicy);
      setGlobalRules(res.global.rules);
      setProjectRules(res.project?.rules ?? []);
      if (forTaskId) {
        setTaskRules(res.task?.rules ?? []);
        setTaskLoaded(true);
      }
      setLoaded(true);
      void loadLog();
    } catch (e) {
      setMsg({ kind: 'err', text: t('egress.loadFailed', { message: (e as Error).message }) });
      setLoaded(true);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await load();
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const save = async (scope: 'global' | 'project' | 'task') => {
    setSaving(scope);
    setMsg(null);
    try {
      if (scope === 'global') {
        await api.updateEgressGlobal({ enabled, defaultPolicy, rules: globalRules });
      } else if (scope === 'project') {
        await api.updateEgressProject(projectId, projectRules);
      } else {
        await api.updateEgressTask(projectId, taskId.trim(), taskRules);
      }
      setMsg({ kind: 'ok', text: t('egress.saved') });
      await load(taskId.trim() || undefined);
    } catch (e) {
      setMsg({ kind: 'err', text: t('egress.saveFailed', { message: (e as Error).message }) });
    } finally {
      setSaving('');
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestOut(null);
    try {
      const res = await api.egressTest({
        url: testUrl.trim(),
        projectId,
        ...(taskId.trim() ? { taskId: taskId.trim() } : {}),
      });
      setTestOut(res);
    } catch (e) {
      setMsg({ kind: 'err', text: t('egress.testFailed', { message: (e as Error).message }) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="sub-panel">
      <h4>{t('egress.title')}</h4>
      <p className="muted">{t('egress.desc')}</p>
      <EgressWizardPanel onDone={() => void load()} />
      {!loaded ? (
        <p className="muted">{t('egress.loading')}</p>
      ) : (
        <>
          <p>
            <strong>{t('egress.globalTitle')}</strong>
            {state?.projectPath && (
              <span className="muted"> · {t('egress.projectPath', { path: state.projectPath })}</span>
            )}
          </p>
          {state?.global.loadError && <p className="err">{state.global.loadError}</p>}
          {state?.project?.loadError && <p className="err">{state.project.loadError}</p>}
          <label className="row">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            {t('egress.enabled')}
          </label>
          <label className="row">
            {t('egress.defaultPolicy')}
            <select
              value={defaultPolicy}
              onChange={(e) => setDefaultPolicy(e.target.value as 'allow' | 'deny')}
            >
              <option value="deny">{t('egress.defaultDeny')}</option>
              <option value="allow">{t('egress.defaultAllow')}</option>
            </select>
          </label>
          <p className="muted">{t('egress.domainHint')}</p>
          <EgressRuleRows rules={globalRules} onChange={setGlobalRules} />
          <div className="row">
            <button disabled={saving !== ''} onClick={() => void save('global')}>
              {saving === 'global' ? t('egress.saving') : t('egress.saveBtn')}
            </button>
          </div>

          <p><strong>{t('egress.projectTitle')}</strong></p>
          <p className="muted">{t('egress.projectDesc')}</p>
          <EgressRuleRows rules={projectRules} onChange={setProjectRules} />
          <div className="row">
            <button disabled={saving !== ''} onClick={() => void save('project')}>
              {saving === 'project' ? t('egress.saving') : t('egress.saveBtn')}
            </button>
          </div>

          <p><strong>{t('egress.taskTitle')}</strong></p>
          <p className="muted">{t('egress.taskDesc')}</p>
          <div className="row">
            <input
              value={taskId}
              onChange={(e) => { setTaskId(e.target.value); setTaskLoaded(false); }}
              placeholder={t('egress.taskId')}
              style={{ fontFamily: 'monospace', minWidth: 220 }}
              spellCheck={false}
            />
            <button disabled={!taskId.trim()} onClick={() => void load(taskId.trim())}>
              {t('egress.loadTaskRules')}
            </button>
          </div>
          {taskLoaded && (
            <>
              <EgressRuleRows rules={taskRules} onChange={setTaskRules} />
              <div className="row">
                <button disabled={saving !== ''} onClick={() => void save('task')}>
                  {saving === 'task' ? t('egress.saving') : t('egress.saveBtn')}
                </button>
              </div>
            </>
          )}

          <p><strong>{t('egress.testTitle')}</strong></p>
          <p className="muted">{t('egress.testDesc')}</p>
          <div className="row">
            <input
              value={testUrl}
              onChange={(e) => setTestUrl(e.target.value)}
              placeholder="https://api.example.com/v1/models"
              style={{ fontFamily: 'monospace', minWidth: 320 }}
              spellCheck={false}
            />
            <button disabled={testing || !testUrl.trim()} onClick={() => void runTest()}>
              {testing ? t('egress.testing') : t('egress.testBtn')}
            </button>
          </div>
          {testOut && (
            <p className={testOut.allowed ? 'ok' : 'err'}>
              {testOut.allowed ? t('egress.allowed') : t('egress.denied')}
              {` · ${testOut.reason}${testOut.matchedRule ? ` · ${testOut.matchedLayer}: ${testOut.matchedRule}` : ''}`}
            </p>
          )}

          <p>
            <strong>{t('egress.logTitle')}</strong>{' '}
            <button onClick={() => void loadLog()}>{t('egress.refresh')}</button>
          </p>
          {log.length === 0 ? (
            <p className="muted">{t('egress.noBlocks')}</p>
          ) : (
            <ul className="file-list">
              {log.map((e, i) => (
                <li key={i}>
                  <code>{e.at}</code> <span className="err">{e.reason}</span>{' '}
                  <code>{e.url}</code>{' '}
                  <span className="muted">
                    {e.source}
                    {e.matchedRule ? ` ← ${e.matchedLayer}: ${e.matchedRule}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {msg && <p className={msg.kind === 'ok' ? 'ok' : 'err'}>{msg.text}</p>}
          <p className="muted">{t('egress.honest')}</p>
        </>
      )}
    </section>
  );
}

export function ProjectPanel({ projectId, projectName }: { projectId: string; projectName: string }) {  const { t } = useLang();
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
      <IgnoresSection projectId={projectId} />
      <EgressSection projectId={projectId} />
    </div>
  );
}

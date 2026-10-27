/**
 * ExtensionsPanel — extension system manager (round-6 task R6-S1).
 *
 * Lists project-local extensions (<root>/.ai-factory/extensions/<name>/),
 * installs (inline manifest + main.js, or a jailed project directory),
 * enables/disables/uninstalls, renders contributed panels read-only,
 * runs contributed commands in the server vm sandbox, and resolves
 * contributed context providers. Honest boundary text notes the API
 * subset, the sandbox limits, and that there is no cloud marketplace.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useLang } from '../i18n';
import { api } from '../api';
import type { ExtensionDto, ExtensionPanelDto, ExtensionProviderDto } from '../api';

const EMPTY_MANIFEST = `{
  "name": "my-extension",
  "version": "1.0.0",
  "description": "My extension",
  "permissions": ["commands.execute"],
  "contributes": {
    "commands": [{ "id": "my.hello", "title": "Say hello" }]
  }
}`;
const EMPTY_MAIN = `api.registerCommand('my.hello', (args) => ({ greeting: 'hello ' + (args.name || 'world') }));`;

export default function ExtensionsPanel(props: { projectRoot: string }) {
  const { t } = useLang();
  const [extensions, setExtensions] = useState<ExtensionDto[]>([]);
  const [broken, setBroken] = useState<Array<{ name: string; error: string }>>([]);
  const [panels, setPanels] = useState<ExtensionPanelDto[]>([]);
  const [providers, setProviders] = useState<ExtensionProviderDto[]>([]);
  const [manifest, setManifest] = useState(EMPTY_MANIFEST);
  const [main, setMain] = useState(EMPTY_MAIN);
  const [sourceDir, setSourceDir] = useState('');
  const [runExt, setRunExt] = useState('');
  const [runCmd, setRunCmd] = useState('');
  const [runArgs, setRunArgs] = useState('{}');
  const [runResult, setRunResult] = useState('');
  const [queryExt, setQueryExt] = useState('');
  const [queryProv, setQueryProv] = useState('');
  const [queryText, setQueryText] = useState('');
  const [queryResult, setQueryResult] = useState('');
  const [status, setStatus] = useState('');

  const reload = useCallback(async () => {
    try {
      const list = await api.extensionsList(props.projectRoot || undefined);
      setExtensions(list.installed);
      setBroken(list.broken);
      const p = await api.extensionsPanels(props.projectRoot || undefined);
      setPanels(p.panels);
      const pv = await api.extensionsProviders(props.projectRoot || undefined);
      setProviders(pv.providers);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }, [props.projectRoot]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onInstall = async () => {
    setStatus('');
    try {
      const parsed = JSON.parse(manifest) as unknown;
      await api.extensionsInstall(props.projectRoot, parsed, main);
      setStatus(t('extensions.installOk'));
      await reload();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const onInstallFromDir = async () => {
    setStatus('');
    try {
      await api.extensionsInstallFromDir(props.projectRoot, sourceDir.trim());
      setStatus(t('extensions.installOk'));
      await reload();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const onToggle = async (ext: ExtensionDto) => {
    setStatus('');
    try {
      await api.extensionsSetEnabled(ext.name, props.projectRoot, !ext.enabled);
      await reload();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const onUninstall = async (ext: ExtensionDto) => {
    setStatus('');
    try {
      await api.extensionsUninstall(ext.name, props.projectRoot || undefined);
      await reload();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const onRun = async () => {
    setRunResult('');
    try {
      const args = JSON.parse(runArgs) as unknown;
      const out = await api.extensionsRunCommand(runExt.trim(), runCmd.trim(), props.projectRoot, args);
      setRunResult(JSON.stringify(out.result, null, 2) + (out.logs.length > 0 ? `\nlogs:\n${out.logs.join('\n')}` : ''));
    } catch (e) {
      setRunResult(e instanceof Error ? e.message : String(e));
    }
  };

  const onResolve = async () => {
    setQueryResult('');
    try {
      const out = await api.extensionsResolveProvider(queryExt.trim(), queryProv.trim(), props.projectRoot, queryText);
      setQueryResult(JSON.stringify(out.items, null, 2));
    } catch (e) {
      setQueryResult(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="panel extensions-panel">
      <h2>{t('extensions.title')}</h2>
      <p className="hint">{t('extensions.honest')}</p>
      {status !== '' && <p className="status">{status}</p>}

      <h3>{t('extensions.listTitle', { count: String(extensions.length) })}</h3>
      {extensions.length === 0 && <p className="hint">{t('extensions.empty')}</p>}
      <ul>
        {extensions.map((ext) => (
          <li key={ext.name}>
            <strong>{ext.name}</strong> @{ext.version} — {ext.description} [{ext.enabled ? t('extensions.enabled') : t('extensions.disabled')}]
            <span> · {t('extensions.contribs', {
              commands: String(ext.commands.length),
              panels: String(ext.panels.length),
              checkers: String(ext.checkers.length),
              providers: String(ext.providers.length),
            })}</span>
            <button onClick={() => void onToggle(ext)}>{ext.enabled ? t('extensions.disable') : t('extensions.enable')}</button>
            <button onClick={() => void onUninstall(ext)}>{t('extensions.uninstall')}</button>
          </li>
        ))}
      </ul>
      {broken.length > 0 && (
        <div>
          <h4>{t('extensions.brokenTitle')}</h4>
          <ul>
            {broken.map((b) => (
              <li key={b.name}>{b.name}: {b.error}</li>
            ))}
          </ul>
        </div>
      )}

      <h3>{t('extensions.installTitle')}</h3>
      <label>{t('extensions.manifestLabel')}
        <textarea value={manifest} onChange={(e) => setManifest(e.target.value)} rows={10} />
      </label>
      <label>{t('extensions.mainLabel')}
        <textarea value={main} onChange={(e) => setMain(e.target.value)} rows={6} />
      </label>
      <button onClick={() => void onInstall()}>{t('extensions.install')}</button>
      <label>{t('extensions.sourceDirLabel')}
        <input value={sourceDir} onChange={(e) => setSourceDir(e.target.value)} />
      </label>
      <button onClick={() => void onInstallFromDir()}>{t('extensions.installFromDir')}</button>

      <h3>{t('extensions.panelsTitle')}</h3>
      {panels.length === 0 && <p className="hint">{t('extensions.panelsEmpty')}</p>}
      {panels.map((p) => (
        <div key={`${p.extension}:${p.id}`} className="ext-panel">
          <h4>{p.title} <span>({p.extension})</span></h4>
          {p.sections.map((s, i) => (
            <div key={i}>
              {s.heading && <h5>{s.heading}</h5>}
              <p>{s.text}</p>
            </div>
          ))}
        </div>
      ))}

      <h3>{t('extensions.runTitle')}</h3>
      <label>{t('extensions.runExtLabel')}
        <input value={runExt} onChange={(e) => setRunExt(e.target.value)} />
      </label>
      <label>{t('extensions.runCmdLabel')}
        <input value={runCmd} onChange={(e) => setRunCmd(e.target.value)} />
      </label>
      <label>{t('extensions.runArgsLabel')}
        <textarea value={runArgs} onChange={(e) => setRunArgs(e.target.value)} rows={3} />
      </label>
      <button onClick={() => void onRun()}>{t('extensions.run')}</button>
      {runResult !== '' && <pre>{runResult}</pre>}

      <h3>{t('extensions.providersTitle')}</h3>
      {providers.length === 0 && <p className="hint">{t('extensions.providersEmpty')}</p>}
      <ul>
        {providers.map((p) => (
          <li key={`${p.extension}:${p.id}`}>{p.prefix} — {p.description ?? p.id} ({p.extension})</li>
        ))}
      </ul>
      <label>{t('extensions.queryExtLabel')}
        <input value={queryExt} onChange={(e) => setQueryExt(e.target.value)} />
      </label>
      <label>{t('extensions.queryProvLabel')}
        <input value={queryProv} onChange={(e) => setQueryProv(e.target.value)} />
      </label>
      <label>{t('extensions.queryTextLabel')}
        <input value={queryText} onChange={(e) => setQueryText(e.target.value)} />
      </label>
      <button onClick={() => void onResolve()}>{t('extensions.resolve')}</button>
      {queryResult !== '' && <pre>{queryResult}</pre>}
    </div>
  );
}

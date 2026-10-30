import { useCallback, useEffect, useState } from 'react';
import { api, type RemoteConnectionView, type RemoteForwardView } from '../api';
import { useLang } from '../i18n';

/**
 * Remote development panel (R7-#1) — SSH/WSL/container/local access.
 *
 * Flow: create a connection (kind + host + remote root) -> probe it ->
 * browse remote files, read/write one file, run a policy-checked command,
 * and (ssh only) start/stop port forwards. A connection that is not
 * online refuses exec/file/forward work with 409 — it never silently
 * runs the same work on the local machine.
 *
 * HONEST BOUNDARIES (rendered in the UI footer):
 * - Key material is never stored: the form takes a key PATH, and the
 *   server passes it to the local ssh binary as -i only. There is no
 *   password/passphrase/private-key field anywhere.
 * - Port forwards are process-bound: a server restart drops them.
 * - This is file/terminal/task access, not remote debugging or remote
 *   LSP — those are later deepenings.
 * - The `local` kind is a loopback transport for dev/test, chosen
 *   explicitly — never a fallback for a failed remote probe.
 */
export function RemotePanel() {
  const { t } = useLang();
  const [connections, setConnections] = useState<RemoteConnectionView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [kind, setKind] = useState<'ssh' | 'wsl' | 'container' | 'local'>('ssh');
  const [host, setHost] = useState('');
  const [username, setUsername] = useState('');
  const [keyPath, setKeyPath] = useState('');
  const [containerName, setContainerName] = useState('');
  const [distro, setDistro] = useState('');
  const [remoteRoot, setRemoteRoot] = useState('/home/dev');

  const [dirPath, setDirPath] = useState('.');
  const [entries, setEntries] = useState<string[]>([]);
  const [filePath, setFilePath] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [command, setCommand] = useState('echo hello');
  const [execOut, setExecOut] = useState('');
  const [forwards, setForwards] = useState<RemoteForwardView[]>([]);
  const [fwdLocal, setFwdLocal] = useState('18080');
  const [fwdHost, setFwdHost] = useState('localhost');
  const [fwdRemote, setFwdRemote] = useState('3000');

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await api.remoteConnections();
      setConnections(res.connections as unknown as RemoteConnectionView[]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = connections.find((c) => c.id === selectedId) ?? null;

  const select = useCallback(async (c: RemoteConnectionView) => {
    setSelectedId(c.id);
    setErr(null);
    setMsg(null);
    try {
      const f = await api.remoteForwards(c.id);
      setForwards(f.forwards);
    } catch {
      setForwards([]);
    }
  }, []);

  const create = async () => {
    setErr(null);
    setMsg(null);
    try {
      const res = await api.remoteCreateConnection({
        name,
        kind,
        host: host || null,
        username: username || null,
        keyPath: keyPath || null,
        containerName: containerName || null,
        distro: distro || null,
        remoteRoot,
      });
      setMsg(t('remote.created', { name: res.connection.name }));
      await refresh();
      await select(res.connection);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const probe = async () => {
    if (!selected) return;
    setErr(null);
    try {
      const res = await api.remoteProbe(selected.id);
      setMsg(
        res.probe.online
          ? t('remote.probeOnline', { ms: String(res.probe.latencyMs) })
          : t('remote.probeOffline', { reason: res.probe.reason }),
      );
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const disconnect = async () => {
    if (!selected) return;
    setErr(null);
    try {
      await api.remoteDisconnect(selected.id);
      setMsg(t('remote.disconnected'));
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async () => {
    if (!selected) return;
    setErr(null);
    try {
      await api.remoteDeleteConnection(selected.id);
      setSelectedId(null);
      setMsg(t('remote.deleted'));
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const listFiles = async () => {
    if (!selected) return;
    setErr(null);
    try {
      const res = await api.remoteFiles(selected.id, dirPath);
      setEntries(res.entries);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const read = async () => {
    if (!selected || !filePath) return;
    setErr(null);
    try {
      const res = await api.remoteReadFile(selected.id, filePath);
      setFileContent(res.content);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const write = async () => {
    if (!selected || !filePath) return;
    setErr(null);
    try {
      await api.remoteWriteFile(selected.id, filePath, fileContent);
      setMsg(t('remote.written', { path: filePath }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const run = async () => {
    if (!selected) return;
    setErr(null);
    try {
      const res = await api.remoteExec(selected.id, command);
      setExecOut(res.stdout + (res.stderr ? `\n[stderr]\n${res.stderr}` : ''));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const startFwd = async () => {
    if (!selected) return;
    setErr(null);
    try {
      await api.remoteStartForward(selected.id, Number(fwdLocal), fwdHost, Number(fwdRemote));
      setMsg(t('remote.forwardStarted'));
      const f = await api.remoteForwards(selected.id);
      setForwards(f.forwards);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const stopFwd = async (localPort: number) => {
    if (!selected) return;
    setErr(null);
    try {
      await api.remoteStopForward(selected.id, localPort);
      const f = await api.remoteForwards(selected.id);
      setForwards(f.forwards);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <h2>{t('remote.title')}</h2>
      <p>{t('remote.desc')}</p>
      {loading && <p>{t('remote.loading')}</p>}
      {err && <p style={{ color: 'red' }}>{err}</p>}
      {msg && <p>{msg}</p>}
      <button onClick={() => void refresh()}>{t('remote.refresh')}</button>

      <h3>{t('remote.create')}</h3>
      <div>
        <label>
          {t('remote.name')}{' '}
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('remote.namePh')} />
        </label>{' '}
        <label>
          {t('remote.kind')}{' '}
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="ssh">ssh</option>
            <option value="wsl">wsl</option>
            <option value="container">container</option>
            <option value="local">local</option>
          </select>
        </label>{' '}
        <label>
          {t('remote.host')}{' '}
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder={t('remote.hostPh')} />
        </label>{' '}
        <label>
          {t('remote.username')}{' '}
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>{' '}
        <label>
          {t('remote.keyPath')}{' '}
          <input
            value={keyPath}
            onChange={(e) => setKeyPath(e.target.value)}
            placeholder={t('remote.keyPathPh')}
          />
        </label>{' '}
        <label>
          {t('remote.containerName')}{' '}
          <input value={containerName} onChange={(e) => setContainerName(e.target.value)} />
        </label>{' '}
        <label>
          {t('remote.distro')}{' '}
          <input value={distro} onChange={(e) => setDistro(e.target.value)} />
        </label>{' '}
        <label>
          {t('remote.remoteRoot')}{' '}
          <input value={remoteRoot} onChange={(e) => setRemoteRoot(e.target.value)} />
        </label>{' '}
        <button onClick={() => void create()}>{t('remote.createBtn')}</button>
      </div>

      <h3>{t('remote.connections')}</h3>
      <ul>
        {connections.map((c) => (
          <li key={c.id}>
            <button onClick={() => void select(c)}>
              {c.name} ({c.kind}) — {c.status}
            </button>{' '}
            {c.host ? `${c.username ? `${c.username}@` : ''}${c.host}` : ''} {c.remoteRoot}
            {c.lastError ? ` — ${c.lastError}` : ''}
          </li>
        ))}
      </ul>

      {selected && (
        <div>
          <h3>{t('remote.detail', { name: selected.name })}</h3>
          <button onClick={() => void probe()}>{t('remote.probe')}</button>{' '}
          <button onClick={() => void disconnect()}>{t('remote.disconnect')}</button>{' '}
          <button onClick={() => void remove()}>{t('remote.delete')}</button>
          <div>
            <h4>{t('remote.files')}</h4>
            <input value={dirPath} onChange={(e) => setDirPath(e.target.value)} />{' '}
            <button onClick={() => void listFiles()}>{t('remote.list')}</button>
            <ul>
              {entries.map((e) => (
                <li key={e}>
                  <button onClick={() => setFilePath(e.replace(/\/$/, ''))}>{e}</button>
                </li>
              ))}
            </ul>
            <input
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              placeholder={t('remote.filePh')}
            />{' '}
            <button onClick={() => void read()}>{t('remote.read')}</button>{' '}
            <button onClick={() => void write()}>{t('remote.write')}</button>
            <div>
              <textarea
                value={fileContent}
                onChange={(e) => setFileContent(e.target.value)}
                rows={8}
                cols={80}
              />
            </div>
          </div>
          <div>
            <h4>{t('remote.exec')}</h4>
            <input value={command} onChange={(e) => setCommand(e.target.value)} size={60} />{' '}
            <button onClick={() => void run()}>{t('remote.run')}</button>
            <pre>{execOut}</pre>
          </div>
          <div>
            <h4>{t('remote.forwards')}</h4>
            <input value={fwdLocal} onChange={(e) => setFwdLocal(e.target.value)} size={8} />{' '}
            <input value={fwdHost} onChange={(e) => setFwdHost(e.target.value)} size={16} />{' '}
            <input value={fwdRemote} onChange={(e) => setFwdRemote(e.target.value)} size={8} />{' '}
            <button onClick={() => void startFwd()}>{t('remote.forwardStart')}</button>
            <ul>
              {forwards.map((f) => (
                <li key={f.localPort}>
                  {f.localPort} → {f.remoteHost}:{f.remotePort} ({f.alive ? t('remote.alive') : t('remote.dead')}){' '}
                  <button onClick={() => void stopFwd(f.localPort)}>{t('remote.forwardStop')}</button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <p>
        <small>{t('remote.boundary')}</small>
      </p>
    </div>
  );
}

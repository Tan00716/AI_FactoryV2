import { useCallback, useEffect, useState } from 'react';
import { api, type EnvEntryView, type EnvListResponse, type EnvWarning } from '../api';
import { useLang } from '../i18n';

/**
 * .env visual editor (round-6 task R6-A8) — key/value table, masked
 * display with per-row reveal, missing-key checks, and an explicit
 * "load into task environment" action.
 *
 * HONEST BOUNDARIES (rendered in the UI footer):
 *  - This is an editor, not a vault: values are stored plaintext in the
 *    project .env file, exactly as the file format dictates.
 *  - List responses never carry plaintext: every value arrives masked;
 *    plaintext is fetched only when you click Reveal, which the server
 *    audits (key name only) and restricts to the operator role.
 *  - Secret-like values only warn, never block the save: a .env file is
 *    the legitimate home of a secret. The warning uses the same
 *    SECRET_PATTERNS table as the pre-send prompt gate.
 *  - Nothing syncs automatically to a running environment: "Load into
 *    task environment" runs ONE named tasks.json chain with the .env
 *    merged in-memory for that run only; it is never written to
 *    tasks.json, and a task's own options.env wins over the overlay.
 */
export function EnvPanel({ projectRoot }: { projectRoot: string }) {
  const { t } = useLang();
  const [file, setFile] = useState('.env');
  const [data, setData] = useState<EnvListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [required, setRequired] = useState('');
  const [missing, setMissing] = useState<string[] | null>(null);
  const [taskLabel, setTaskLabel] = useState('');
  const [loadResult, setLoadResult] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await api.envList(projectRoot || undefined, file || undefined);
      setData(res);
      setRevealed({});
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectRoot, file]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async (set: Array<{ key: string; value: string }>, del: string[]) => {
    setErr(null);
    setMsg(null);
    try {
      const res = await api.envUpdate({ set, delete: del }, projectRoot || undefined, file || undefined);
      setData(res);
      setRevealed({});
      const secretWarns = res.warnings.filter((w: EnvWarning) => w.kind === 'secret-like');
      setMsg(
        secretWarns.length > 0
          ? `${t('env.saved')} ${t('env.secretWarn')}: ${secretWarns.map((w) => w.key).join(', ')}`
          : t('env.saved'),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const reveal = async (key: string) => {
    if (revealed[key] !== undefined) {
      setRevealed((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    try {
      const res = await api.envReveal(key, projectRoot || undefined, file || undefined);
      setRevealed((prev) => ({ ...prev, [key]: res.value }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const checkMissing = async () => {
    setErr(null);
    try {
      const req = required.split(',').map((s) => s.trim()).filter(Boolean);
      const res = await api.envValidate(req, projectRoot || undefined, file || undefined);
      setMissing(res.missing);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const loadIntoTask = async () => {
    setErr(null);
    setLoadResult(null);
    try {
      const res = await api.envLoad(taskLabel, projectRoot || undefined, file || undefined);
      const chain = res.chain as { ok?: boolean; stoppedAt?: string | null; results?: unknown[] } | undefined;
      setLoadResult(
        chain && chain.ok
          ? `${t('env.loadOk')} (${Array.isArray(chain.results) ? chain.results.length : 0})`
          : `${t('env.loadStopped')}: ${chain?.stoppedAt ?? ''}`,
      );
      void refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const rows: EnvEntryView[] = data?.entries ?? [];
  return (
    <div>
      <h2>{t('env.title')}</h2>
      <div>
        <label>
          {t('env.fileLabel')}{' '}
          <input value={file} onChange={(e) => setFile(e.target.value)} placeholder=".env" />
        </label>{' '}
        <button onClick={() => void refresh()} disabled={loading}>
          {t('env.load')}
        </button>
      </div>
      {data && !data.exists && <p>{t('env.notExists')}</p>}
      {data && data.gitignore.hasGitignore && !data.gitignore.ignored && (
        <p>{t('env.gitignoreWarn')}</p>
      )}
      {data && data.warnings.length > 0 && (
        <ul>
          {data.warnings.map((w, i) => (
            <li key={i}>
              {w.kind === 'secret-like'
                ? `${t('env.warnSecret')}: ${w.key} (${(w.patterns ?? []).join(', ')})`
                : w.kind === 'duplicate'
                  ? `${t('env.warnDuplicate')}: ${w.key}`
                  : `${t('env.warnParse')}: ${t('env.line')} ${w.line}: ${w.message}`}
            </li>
          ))}
        </ul>
      )}
      <table>
        <thead>
          <tr>
            <th>{t('env.key')}</th>
            <th>{t('env.value')}</th>
            <th>{t('env.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>
                {row.key}
                {row.secret ? ` ${t('env.secretBadge')}` : ''}
                {row.occurrences > 1 ? ` (${t('env.duplicateCount', { n: row.occurrences })})` : ''}
              </td>
              <td>
                {editKey === row.key ? (
                  <input value={editValue} onChange={(e) => setEditValue(e.target.value)} />
                ) : revealed[row.key] !== undefined ? (
                  revealed[row.key]
                ) : (
                  row.masked
                )}
              </td>
              <td>
                {editKey === row.key ? (
                  <>
                    <button
                      onClick={() => {
                        void save([{ key: row.key, value: editValue }], []);
                        setEditKey(null);
                      }}
                    >
                      {t('env.save')}
                    </button>{' '}
                    <button onClick={() => setEditKey(null)}>{t('env.cancel')}</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => void reveal(row.key)}>
                      {revealed[row.key] !== undefined ? t('env.hide') : t('env.reveal')}
                    </button>{' '}
                    <button
                      onClick={() => {
                        setEditKey(row.key);
                        setEditValue(revealed[row.key] ?? '');
                      }}
                    >
                      {t('env.edit')}
                    </button>{' '}
                    <button onClick={() => void save([], [row.key])}>{t('env.delete')}</button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div>
        <h3>{t('env.addTitle')}</h3>
        <input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder={t('env.keyPlaceholder')} />{' '}
        <input value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder={t('env.valuePlaceholder')} />{' '}
        <button
          onClick={() => {
            if (!newKey.trim()) return;
            void save([{ key: newKey.trim(), value: newValue }], []);
            setNewKey('');
            setNewValue('');
          }}
        >
          {t('env.add')}
        </button>
      </div>
      <div>
        <h3>{t('env.checkTitle')}</h3>
        <input value={required} onChange={(e) => setRequired(e.target.value)} placeholder={t('env.requiredPlaceholder')} />{' '}
        <button onClick={() => void checkMissing()}>{t('env.check')}</button>
        {missing !== null && (
          <p>{missing.length === 0 ? t('env.allPresent') : `${t('env.missing')}: ${missing.join(', ')}`}</p>
        )}
      </div>
      <div>
        <h3>{t('env.loadTitle')}</h3>
        <input value={taskLabel} onChange={(e) => setTaskLabel(e.target.value)} placeholder={t('env.taskLabelPlaceholder')} />{' '}
        <button onClick={() => void loadIntoTask()} disabled={!taskLabel.trim()}>
          {t('env.loadIntoTask')}
        </button>
        {loadResult && <p>{loadResult}</p>}
      </div>
      {err && <p>{err}</p>}
      {msg && <p>{msg}</p>}
      <p>{t('env.honest')}</p>
    </div>
  );
}

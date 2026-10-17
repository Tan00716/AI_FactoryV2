import { useRef, useState } from 'react';
import { api } from '../api';
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
    </div>
  );
}

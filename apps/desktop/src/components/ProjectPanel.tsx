import { useRef, useState } from 'react';
import { api } from '../api';

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
  const [state, setState] = useState<ImportState>({ kind: 'idle' });
  const [exported, setExported] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const onExport = async () => {
    setState({ kind: 'working', label: '导出项目配置…' });
    try {
      const res = await api.exportProject(projectId);
      const count = Object.keys(res.files).length;
      setExported(count);
      downloadJson(`${projectName || projectId}.ai-export.json`, res);
      setState({ kind: 'idle' });
    } catch (e) {
      setState({ kind: 'error', message: `导出失败：${(e as Error).message}` });
    }
  };

  const onPickFile = async (f: File) => {
    setState({ kind: 'working', label: `校验 ${f.name} …` });
    try {
      const text = await f.text();
      const parsed = JSON.parse(text) as { files?: Record<string, string> };
      const files = parsed.files ?? (parsed as unknown as Record<string, string>);
      if (!files || typeof files !== 'object' || Array.isArray(files)) {
        throw new Error('文件不是有效的导出文档（缺少 files 字段）');
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
      setState({ kind: 'error', message: `导入失败：${(e as Error).message}` });
    }
  };

  return (
    <div className="panel">
      <h3>项目设置 · {projectName}</h3>
      <p className="muted">
        导入 / 导出项目配置（spec §103 <code>.ai/</code> 目录结构：project.yaml、policy.yaml、agents/、skills/、workflows/、knowledge/、memory/、mcp/）。
        凭据只导出引用名（<code>env_refs</code>），不导出值。
      </p>
      <div className="row">
        <button onClick={onExport}>⬇ 导出项目配置</button>
        <button onClick={() => fileRef.current?.click()}>⬆ 导入项目配置</button>
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
        <p className="ok">上次导出包含 {exported} 个文件（已下载）。</p>
      )}
      {state.kind === 'working' && <p className="muted">{state.label}</p>}
      {state.kind === 'error' && <p className="err">{state.message}</p>}
      {state.kind === 'import-ok' && (
        <div>
          <p className="ok">✅ 导入成功：写入 {state.written.length} 个文件到 <code>{state.targetDir}</code></p>
          <ul className="file-list">
            {state.written.slice(0, 20).map((w) => <li key={w}><code>{w}</code></li>)}
          </ul>
          {state.written.length > 20 && <p className="muted">…等共 {state.written.length} 个</p>}
        </div>
      )}
      {state.kind === 'import-rejected' && (
        <div>
          <p className="err">❌ 校验未通过，未写入任何文件（共 {state.issues.length} 个问题）：</p>
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

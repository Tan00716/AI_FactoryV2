import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type TaskSummary, type OrgNode } from '../api';
import { useLang } from '../i18n';
import { flattenAgents, rankMatches, type PaletteAgent } from '../utils/cmdk';

/**
 * Command palette (Cmd+K / Ctrl+K), VS Code / Cursor style.
 * Pure frontend: fuzzy-searches panel jumps, actions, tasks and agents.
 * Mounted once inside IdeShell; owns its own open state + global hotkey.
 */

/** Center-tab names, mirrors the union in App.tsx. */
export const PALETTE_TABS = [
  'Dashboard', 'Ops', 'Report', 'Board', 'Git', 'QA', 'Approvals', 'Permissions',
  'NeedsHuman', 'Dispatch', 'CI/CD', 'Skills', 'Memory', 'MCP', 'Knowledge',
  'Evaluation', 'Agents', 'Orchestrate', 'Observatory', 'Manager', 'Editor',
  'Terminal', 'Changes', 'Stability', 'Project', 'Activity', 'Events', 'Models',
  'Plan', 'Hooks', 'Session', 'Plugins', 'Batch', 'Collab',
] as const;
export type PaletteTab = (typeof PALETTE_TABS)[number];

/** Same key derivation as the tab buttons in App.tsx. */
export function tabI18nKey(name: string): string {
  return `tab.${name.toLowerCase().replace('/', '')}`;
}

type EntryKind = 'tab' | 'action' | 'task' | 'agent';

interface PaletteEntry {
  id: string;
  kind: EntryKind;
  label: string;
  hint?: string;
  searchText: string;
  /** When false the palette stays open after running (async actions show a status line). */
  closeAfter: boolean;
  run: () => void | Promise<void>;
}

interface CommandPaletteProps {
  tasks: TaskSummary[];
  org: OrgNode[];
  onNavigateTab: (tab: PaletteTab) => void;
  onSelectTask: (taskId: string) => void;
  onSelectAgent: (agentId: string) => void;
  onCreateTask: () => void;
}

const GROUP_ORDER: EntryKind[] = ['tab', 'action', 'task', 'agent'];

export function CommandPalette(props: CommandPaletteProps) {
  const { t, lang, setLang } = useLang();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [status, setStatus] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // Global hotkey: Cmd+K / Ctrl+K toggles.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Reset + focus whenever opened.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIdx(0);
      setStatus('');
      // Focus after paint so the input exists in the DOM.
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open ]);

  // Click outside closes.
  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open ]);

  const agents: PaletteAgent[] = useMemo(() => flattenAgents(props.org), [props.org]);

  const entries: PaletteEntry[] = useMemo(() => {
    const list: PaletteEntry[] = [];
    for (const name of PALETTE_TABS) {
      const label = t(tabI18nKey(name));
      list.push({
        id: `tab:${name}`,
        kind: 'tab',
        label,
        searchText: `${label} ${name}`,
        closeAfter: true,
        run: () => props.onNavigateTab(name),
      });
    }
    const action = (
      id: string,
      label: string,
      closeAfter: boolean,
      run: () => void | Promise<void>,
    ) => list.push({ id: `action:${id}`, kind: 'action', label, searchText: label, closeAfter, run });
    action('newTask', t('cmdk.action.newTask'), true, () => props.onCreateTask());
    action('backup', t('cmdk.action.backup'), false, async () => {
      try {
        await api.createBackup();
        setStatus(t('cmdk.status.backupOk'));
      } catch (err) {
        setStatus(t('cmdk.status.backupFail', { error: err instanceof Error ? err.message : String(err) }));
      }
    });
    action('auditVerify', t('cmdk.action.auditVerify'), false, async () => {
      try {
        const v = await api.auditVerify();
        setStatus(
          v.ok
            ? t('cmdk.status.auditOk', { count: v.verifiedCount })
            : t('cmdk.status.auditFail'),
        );
      } catch (err) {
        setStatus(t('cmdk.status.actionFail', { error: err instanceof Error ? err.message : String(err) }));
      }
    });
    action('switchLang', t('cmdk.action.switchLang'), true, () => {
      setLang(lang === 'zh' ? 'en' : 'zh');
    });
    for (const task of props.tasks) {
      list.push({
        id: `task:${task.id}`,
        kind: 'task',
        label: task.title,
        hint: task.id,
        searchText: `${task.title} ${task.id} ${task.status}`,
        closeAfter: true,
        run: () => props.onSelectTask(task.id),
      });
    }
    for (const a of agents) {
      list.push({
        id: `agent:${a.id}`,
        kind: 'agent',
        label: a.displayName,
        hint: a.jobTitle || a.id,
        searchText: `${a.displayName} ${a.jobTitle} ${a.id}`,
        closeAfter: true,
        run: () => props.onSelectAgent(a.id),
      });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.tasks, props.org, agents, t, lang]);

  const visible: PaletteEntry[] = useMemo(() => {
    if (query.trim() === '') return entries;
    const order = rankMatches(query, entries.map((e) => e.searchText));
    return order.map((i) => entries[i]);
  }, [entries, query]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  const runEntry = (entry: PaletteEntry) => {
    if (entry.closeAfter) setOpen(false);
    void Promise.resolve()
      .then(() => entry.run())
      .catch((err) => setStatus(t('cmdk.status.actionFail', { error: err instanceof Error ? err.message : String(err) })));
  };

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => (visible.length === 0 ? 0 : (i + 1) % visible.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => (visible.length === 0 ? 0 : (i - 1 + visible.length) % visible.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const entry = visible[activeIdx];
      if (entry) runEntry(entry);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  if (!open) return null;

  let lastGroup: EntryKind | null = null;
  const groupLabel = (kind: EntryKind): string =>
    kind === 'tab' ? t('cmdk.group.go')
    : kind === 'action' ? t('cmdk.group.actions')
    : kind === 'task' ? t('cmdk.group.tasks')
    : t('cmdk.group.agents');

  return (
    <div className="cmdk-overlay" role="dialog" aria-label="command palette">
      <div className="cmdk-panel" ref={boxRef}>
        <input
          ref={inputRef}
          className="cmdk-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKey}
          placeholder={t('cmdk.placeholder')}
          aria-label={t('cmdk.placeholder')}
        />
        <div className="cmdk-list" role="listbox">
          {visible.length === 0 && <div className="cmdk-empty">{t('cmdk.noResults')}</div>}
          {visible.map((entry, idx) => {
            const header = query.trim() === '' && entry.kind !== lastGroup
              ? (() => { lastGroup = entry.kind; return true; })()
              : false;
            return (
              <div key={entry.id}>
                {header && <div className="cmdk-group">{groupLabel(entry.kind)}</div>}
                <div
                  role="option"
                  aria-selected={idx === activeIdx}
                  className={`cmdk-item${idx === activeIdx ? ' active' : ''}`}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => runEntry(entry)}
                >
                  <span className="cmdk-label">{entry.label}</span>
                  {entry.hint && <span className="cmdk-hint-text">{entry.hint}</span>}
                </div>
              </div>
            );
          })}
        </div>
        {status && <div className="cmdk-status">{status}</div>}
        <div className="cmdk-footer">{t('cmdk.hint')}</div>
      </div>
    </div>
  );
}

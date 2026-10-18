import { useEffect, useState } from 'react';
import {
  api, AgentFull, AuditRecord, MemoryEntry, TaskSummary,
} from '../api';
import { useLang } from '../i18n';

/**
 * AI Employee Detail — spec §87.
 * 从组织图 / 列表点击 Agent 打开，15 个分区：
 * 档案 / 指令 / 技能 / 规则 / 策略 / 模型 / 工具 / MCP /
 * 权限 / 记忆 / 知识 / 当前任务 / 历史 / 评估 / 版本。
 * 缺数据的分区显示"暂无"。
 */

// TABS 持有 i18n key（与语言无关的稳定页签 id），渲染时 t() 翻译。
const TABS = [
  'employeedetail.tab.profile', 'employeedetail.tab.instructions', 'employeedetail.tab.skills',
  'employeedetail.tab.rules', 'employeedetail.tab.policy', 'employeedetail.tab.model',
  'employeedetail.tab.tools', 'employeedetail.tab.mcp', 'employeedetail.tab.permissions',
  'employeedetail.tab.memory', 'employeedetail.tab.knowledge', 'employeedetail.tab.currentTasks',
  'employeedetail.tab.history', 'employeedetail.tab.evaluation', 'employeedetail.tab.version',
] as const;
type Tab = (typeof TABS)[number];

function Empty() {
  const { t } = useLang();
  return <p className="muted">{t('employeedetail.empty')}</p>;
}

function StrList({ items }: { items: string[] }) {
  if (items.length === 0) return <Empty />;
  return (
    <ul className="plain">
      {items.map((s, i) => <li key={i}>{s}</li>)}
    </ul>
  );
}

function useAgent(agentId: string): AgentFull | null | undefined {
  const [agent, setAgent] = useState<AgentFull | null | undefined>(undefined);
  useEffect(() => {
    let dead = false;
    api.agents()
      .then((list) => { if (!dead) setAgent(list.find((a) => a.id === agentId) ?? null); })
      .catch(() => { if (!dead) setAgent(null); });
    return () => { dead = true; };
  }, [agentId]);
  return agent;
}

// ---------------------------------------------------------------- 策略 --
function PolicyTab() {
  const { t } = useLang();
  const [policy, setPolicy] = useState<unknown>(undefined);
  useEffect(() => {
    let dead = false;
    api.policyEffective()
      .then((p) => { if (!dead) setPolicy(p); })
      .catch(() => { if (!dead) setPolicy(null); });
    return () => { dead = true; };
  }, []);
  if (policy === undefined) return <p className="muted">{t('employeedetail.loading')}</p>;
  if (policy === null) return <Empty />;
  return (
    <div>
      <p className="muted">{t('employeedetail.policyNote')}</p>
      <pre className="muted" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
        {JSON.stringify(policy, null, 1)?.slice(0, 3000)}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------- MCP --
function McpTab() {
  const { t } = useLang();
  const [servers, setServers] = useState<Array<{ name: string; status?: string }> | null>(null);
  useEffect(() => {
    let dead = false;
    api.mcpServers()
      .then((r) => {
        if (dead) return;
        const list = Array.isArray(r) ? r : (r.servers ?? []);
        setServers(list);
      })
      .catch(() => { if (!dead) setServers([]); });
    return () => { dead = true; };
  }, []);
  if (servers === null) return <p className="muted">{t('employeedetail.loading')}</p>;
  if (servers.length === 0) return <Empty />;
  return (
    <ul className="plain">
      {servers.map((s, i) => (
        <li key={i}>
          <b>{s.name}</b>
          {s.status && <span className="muted"> · {s.status}</span>}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- 记忆 --
function MemoryTab({ agentId }: { agentId: string }) {
  const { t } = useLang();
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  useEffect(() => {
    let dead = false;
    api.memoryEntries('employee', agentId)
      .then((e) => { if (!dead) setEntries(e); })
      .catch(() => { if (!dead) setEntries([]); });
    return () => { dead = true; };
  }, [agentId]);
  if (entries === null) return <p className="muted">{t('employeedetail.loading')}</p>;
  if (entries.length === 0) return <Empty />;
  return (
    <ul className="plain">
      {entries.map((e) => (
        <li key={e.id}>
          <b>{String(e.title ?? e.type ?? e.id.slice(0, 8))}</b>
          <span className="muted"> · {t('employeedetail.confidence', { value: e.confidence ?? '—' })}</span>
          {e.content && <div className="muted">{String(e.content).slice(0, 300)}</div>}
        </li>
      ))}
    </ul>
  );
}

// -------------------------------------------------------------- 当前任务 --
function CurrentTasksTab({ agentId, onSelectTask }: { agentId: string; onSelectTask: (id: string) => void }) {
  const { t } = useLang();
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  useEffect(() => {
    let dead = false;
    api.tasks()
      .then((all) => {
        if (dead) return;
        setTasks(all.filter(
          (t) => t.currentAgentId === agentId || t.assignedAgentIds.includes(agentId),
        ));
      })
      .catch(() => { if (!dead) setTasks([]); });
    return () => { dead = true; };
  }, [agentId]);
  if (tasks === null) return <p className="muted">{t('employeedetail.loading')}</p>;
  if (tasks.length === 0) return <Empty />;
  return (
    <ul className="plain">
      {tasks.map((task) => (
        <li key={task.id} className="clickable" onClick={() => onSelectTask(task.id)}>
          <span className="pill">{task.status}</span> {task.title}
          {task.currentAgentId === agentId && <span className="pill">{t('employeedetail.currentRunning')}</span>}
          <span className="muted"> · #{task.id.slice(0, 8)}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- 历史 --
function HistoryTab({ agentId }: { agentId: string }) {
  const { t } = useLang();
  const [records, setRecords] = useState<AuditRecord[] | null>(null);
  useEffect(() => {
    let dead = false;
    api.audit(300)
      .then((all) => {
        if (dead) return;
        setRecords(all.filter((r) => r.entityId === agentId || r.actor === agentId));
      })
      .catch(() => { if (!dead) setRecords([]); });
    return () => { dead = true; };
  }, [agentId]);
  if (records === null) return <p className="muted">{t('employeedetail.loading')}</p>;
  if (records.length === 0) return <Empty />;
  return (
    <ul className="timeline">
      {records.map((r) => (
        <li key={r.id}>
          <span className="muted">{new Date(r.ts).toLocaleString()}</span>
          {' '}<b>{r.action}</b>{' '}
          <span className="muted">{r.entityType} · {r.entityId.slice(0, 8)}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- 评估 --
function EvaluationTab({ agentId }: { agentId: string }) {
  const { t } = useLang();
  const [profile, setProfile] = useState<{ agentId: string; [k: string]: unknown } | null | undefined>(undefined);
  useEffect(() => {
    let dead = false;
    api.agentProfile(agentId)
      .then((r) => { if (!dead) setProfile(r.profile); })
      .catch(() => { if (!dead) setProfile(null); });
    return () => { dead = true; };
  }, [agentId]);
  if (profile === undefined) return <p className="muted">{t('employeedetail.loading')}</p>;
  if (profile === null) return <Empty />;
  return (
    <pre className="muted" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
      {JSON.stringify(profile, null, 1)}
    </pre>
  );
}

// ---------------------------------------------------------------- 主体 --
export function EmployeeDetail({ agentId, onClose, onSelectTask }: {
  agentId: string;
  onClose: () => void;
  onSelectTask: (id: string) => void;
}) {
  const { t } = useLang();
  const agent = useAgent(agentId);
  const [tab, setTab] = useState<Tab>(TABS[0]);

  // QA-R1: Esc 关闭抽屉（与 TaskDetailDrawer / CreateTaskModal 行为一致）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="detail wide">
      <div className="detail-head">
        <h2>{agent ? agent.displayName : t('employeedetail.drawerTitle')}</h2>
        <button onClick={onClose}>✕</button>
      </div>
      {agent === undefined && <p className="muted">{t('employeedetail.loading')}</p>}
      {agent === null && <div className="banner err">{t('employeedetail.notFound')}</div>}
      {agent && (
        <>
          <div className="drawer-tabs">
            {TABS.map((k) => (
              <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
                {t(k)}
              </button>
            ))}
          </div>
          <div className="drawer-body">
            {tab === TABS[0] && (
              <div>
                <p><b>{agent.displayName}</b> <span className="muted">{agent.jobTitle}</span></p>
                <div className="kv"><span>{t('employeedetail.label.status')}</span><span>{agent.status}</span></div>
                <div className="kv"><span>{t('employeedetail.label.department')}</span><span>{agent.department || '—'}</span></div>
                <div className="kv"><span>{t('employeedetail.label.mission')}</span><span>{agent.mission || '—'}</span></div>
                <div className="kv"><span>{t('employeedetail.label.autonomy')}</span><span>L{agent.autonomyLevel}</span></div>
                <div className="kv"><span>{t('employeedetail.label.reasoning')}</span><span>{agent.reasoningLevel}</span></div>
              </div>
            )}
            {tab === TABS[1] && (
              agent.instructions
                ? <pre className="muted" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{agent.instructions}</pre>
                : <Empty />
            )}
            {tab === TABS[2] && <StrList items={agent.skills} />}
            {tab === TABS[3] && <StrList items={agent.rules} />}
            {tab === TABS[4] && <PolicyTab />}
            {tab === TABS[5] && (
              <div>
                <div className="kv"><span>{t('employeedetail.label.model')}</span><span>{agent.model || '—'}</span></div>
                <div className="kv"><span>{t('employeedetail.label.reasoning')}</span><span>{agent.reasoningLevel}</span></div>
              </div>
            )}
            {tab === TABS[6] && <StrList items={agent.tools} />}
            {tab === TABS[7] && <McpTab />}
            {tab === TABS[8] && <StrList items={agent.permissions} />}
            {tab === TABS[9] && <MemoryTab agentId={agent.id} />}
            {tab === TABS[10] && <Empty />}
            {tab === TABS[11] && <CurrentTasksTab agentId={agent.id} onSelectTask={onSelectTask} />}
            {tab === TABS[12] && <HistoryTab agentId={agent.id} />}
            {tab === TABS[13] && <EvaluationTab agentId={agent.id} />}
            {tab === TABS[14] && (
              <div>
                <div className="kv"><span>{t('employeedetail.label.version')}</span><span>v{agent.version}</span></div>
                <div className="kv"><span>{t('employeedetail.label.created')}</span><span>{new Date(agent.createdAt).toLocaleString()}</span></div>
                <div className="kv"><span>{t('employeedetail.label.updated')}</span><span>{new Date(agent.updatedAt).toLocaleString()}</span></div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import {
  api, AgentFull, AuditRecord, MemoryEntry, TaskSummary,
} from '../api';

/**
 * AI Employee Detail — spec §87.
 * 从组织图 / 列表点击 Agent 打开，15 个分区：
 * 档案 / 指令 / 技能 / 规则 / 策略 / 模型 / 工具 / MCP /
 * 权限 / 记忆 / 知识 / 当前任务 / 历史 / 评估 / 版本。
 * 缺数据的分区显示"暂无"。
 */

const TABS = [
  '档案', '指令', '技能', '规则', '策略', '模型', '工具', 'MCP',
  '权限', '记忆', '知识', '当前任务', '历史', '评估', '版本',
] as const;
type Tab = (typeof TABS)[number];

function Empty() {
  return <p className="muted">暂无</p>;
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
  const [policy, setPolicy] = useState<unknown>(undefined);
  useEffect(() => {
    let dead = false;
    api.policyEffective()
      .then((p) => { if (!dead) setPolicy(p); })
      .catch(() => { if (!dead) setPolicy(null); });
    return () => { dead = true; };
  }, []);
  if (policy === undefined) return <p className="muted">加载中…</p>;
  if (policy === null) return <Empty />;
  return (
    <div>
      <p className="muted">生效策略（组织 / 项目层叠加结果）</p>
      <pre className="muted" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
        {JSON.stringify(policy, null, 1)?.slice(0, 3000)}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------- MCP --
function McpTab() {
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
  if (servers === null) return <p className="muted">加载中…</p>;
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
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  useEffect(() => {
    let dead = false;
    api.memoryEntries('employee', agentId)
      .then((e) => { if (!dead) setEntries(e); })
      .catch(() => { if (!dead) setEntries([]); });
    return () => { dead = true; };
  }, [agentId]);
  if (entries === null) return <p className="muted">加载中…</p>;
  if (entries.length === 0) return <Empty />;
  return (
    <ul className="plain">
      {entries.map((e) => (
        <li key={e.id}>
          <b>{String(e.title ?? e.type ?? e.id.slice(0, 8))}</b>
          <span className="muted"> · 置信度 {e.confidence ?? '—'}</span>
          {e.content && <div className="muted">{String(e.content).slice(0, 300)}</div>}
        </li>
      ))}
    </ul>
  );
}

// -------------------------------------------------------------- 当前任务 --
function CurrentTasksTab({ agentId, onSelectTask }: { agentId: string; onSelectTask: (id: string) => void }) {
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
  if (tasks === null) return <p className="muted">加载中…</p>;
  if (tasks.length === 0) return <Empty />;
  return (
    <ul className="plain">
      {tasks.map((t) => (
        <li key={t.id} className="clickable" onClick={() => onSelectTask(t.id)}>
          <span className="pill">{t.status}</span> {t.title}
          {t.currentAgentId === agentId && <span className="pill">当前执行</span>}
          <span className="muted"> · #{t.id.slice(0, 8)}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- 历史 --
function HistoryTab({ agentId }: { agentId: string }) {
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
  if (records === null) return <p className="muted">加载中…</p>;
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
  const [profile, setProfile] = useState<{ agentId: string; [k: string]: unknown } | null | undefined>(undefined);
  useEffect(() => {
    let dead = false;
    api.agentProfile(agentId)
      .then((r) => { if (!dead) setProfile(r.profile); })
      .catch(() => { if (!dead) setProfile(null); });
    return () => { dead = true; };
  }, [agentId]);
  if (profile === undefined) return <p className="muted">加载中…</p>;
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
  const agent = useAgent(agentId);
  const [tab, setTab] = useState<Tab>('档案');

  return (
    <div className="detail wide">
      <div className="detail-head">
        <h2>{agent ? agent.displayName : '员工档案'}</h2>
        <button onClick={onClose}>✕</button>
      </div>
      {agent === undefined && <p className="muted">加载中…</p>}
      {agent === null && <div className="banner err">未找到该 Agent</div>}
      {agent && (
        <>
          <div className="drawer-tabs">
            {TABS.map((t) => (
              <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </div>
          <div className="drawer-body">
            {tab === '档案' && (
              <div>
                <p><b>{agent.displayName}</b> <span className="muted">{agent.jobTitle}</span></p>
                <div className="kv"><span>状态</span><span>{agent.status}</span></div>
                <div className="kv"><span>部门</span><span>{agent.department || '—'}</span></div>
                <div className="kv"><span>使命</span><span>{agent.mission || '—'}</span></div>
                <div className="kv"><span>自治等级</span><span>L{agent.autonomyLevel}</span></div>
                <div className="kv"><span>推理强度</span><span>{agent.reasoningLevel}</span></div>
              </div>
            )}
            {tab === '指令' && (
              agent.instructions
                ? <pre className="muted" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{agent.instructions}</pre>
                : <Empty />
            )}
            {tab === '技能' && <StrList items={agent.skills} />}
            {tab === '规则' && <StrList items={agent.rules} />}
            {tab === '策略' && <PolicyTab />}
            {tab === '模型' && (
              <div>
                <div className="kv"><span>模型</span><span>{agent.model || '—'}</span></div>
                <div className="kv"><span>推理强度</span><span>{agent.reasoningLevel}</span></div>
              </div>
            )}
            {tab === '工具' && <StrList items={agent.tools} />}
            {tab === 'MCP' && <McpTab />}
            {tab === '权限' && <StrList items={agent.permissions} />}
            {tab === '记忆' && <MemoryTab agentId={agent.id} />}
            {tab === '知识' && <Empty />}
            {tab === '当前任务' && <CurrentTasksTab agentId={agent.id} onSelectTask={onSelectTask} />}
            {tab === '历史' && <HistoryTab agentId={agent.id} />}
            {tab === '评估' && <EvaluationTab agentId={agent.id} />}
            {tab === '版本' && (
              <div>
                <div className="kv"><span>版本</span><span>v{agent.version}</span></div>
                <div className="kv"><span>创建</span><span>{new Date(agent.createdAt).toLocaleString()}</span></div>
                <div className="kv"><span>更新</span><span>{new Date(agent.updatedAt).toLocaleString()}</span></div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

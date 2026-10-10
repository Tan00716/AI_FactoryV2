import { useState } from 'react';
import { OrgNode } from '../api';

function OrgTreeNode({ node, depth, onSelectAgent }: {
  node: OrgNode; depth: number; onSelectAgent?: (agentId: string) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const statusClass = `st-${node.agent.status.toLowerCase()}`;
  return (
    <div className="org-node" style={{ paddingLeft: depth * 12 }}>
      <div className="org-row" onClick={() => setOpen(!open)}>
        <span className="caret">{node.children.length ? (open ? '▾' : '▸') : '·'}</span>
        <span className={`status-dot ${statusClass}`} title={node.agent.status} />
        <span
          className={`org-name${onSelectAgent ? ' clickable' : ''}`}
          onClick={(e) => { e.stopPropagation(); onSelectAgent?.(node.agent.id); }}
          title={onSelectAgent ? '查看员工档案 §87' : undefined}
        >
          {node.agent.displayName}
        </span>
        <span className="org-role">{node.agent.jobTitle}</span>
      </div>
      {open && node.children.map((c) => (
        <OrgTreeNode key={c.agent.id} node={c} depth={depth + 1} onSelectAgent={onSelectAgent} />
      ))}
    </div>
  );
}

/** §3 left rail: project tree, AI organization (§84 simplified), skills placeholders. */
export function Sidebar({ org, onSelectAgent }: {
  org: OrgNode[];
  onSelectAgent?: (agentId: string) => void;
}) {
  return (
    <aside className="sidebar">
      <section>
        <h3>PROJECT</h3>
        <div className="tree">
          <div>📁 MyApp</div>
          <div className="tree-indent">📁 src</div>
          <div className="tree-indent">📁 tests</div>
          <div className="tree-indent">📁 docs</div>
        </div>
      </section>
      <section>
        <h3>AI ORG</h3>
        {org.length === 0 && <div className="muted">No agents yet</div>}
        {org.map((n) => <OrgTreeNode key={n.agent.id} node={n} depth={0} onSelectAgent={onSelectAgent} />)}
      </section>
      <section>
        <h3>SKILLS</h3>
        <div className="muted">clean-code · debugging · git</div>
        <h3>MCP</h3>
        <div className="muted">github · filesystem <span className="pill">stub</span></div>
        <h3>KNOWLEDGE</h3>
        <div className="muted"><span className="pill">stub</span></div>
        <h3>CI/CD</h3>
        <div className="muted"><span className="pill">stub</span></div>
      </section>
    </aside>
  );
}

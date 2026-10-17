import { useEffect, useState } from 'react';
import { api, OrgNode } from '../api';
import { useLang } from '../i18n';

function OrgTreeNode({ node, depth, onSelectAgent }: {
  node: OrgNode; depth: number; onSelectAgent?: (agentId: string) => void;
}) {
  const { t } = useLang();
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
          title={onSelectAgent ? t('sidebar.profileTitle') : undefined}
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

/** §3 left rail: project tree, AI organization (§84 simplified), skills (live from /api/skills). */
export function Sidebar({ org, onSelectAgent }: {
  org: OrgNode[];
  onSelectAgent?: (agentId: string) => void;
}) {
  const { t } = useLang();
  // Batch 89：SKILLS 摘要走真实数据；拉取失败时回退到硬编码文本（旧服务端/未连通），不猜测。
  const [skillNames, setSkillNames] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    api.skills()
      .then((r) => { if (alive) setSkillNames(r.skills.map((s) => s.id)); })
      .catch(() => { if (alive) setSkillNames([]); });
    return () => { alive = false; };
  }, []);
  return (
    <aside className="sidebar">
      <section>
        <h3>{t('sidebar.project')}</h3>
        <div className="tree">
          <div>📁 MyApp</div>
          <div className="tree-indent">📁 src</div>
          <div className="tree-indent">📁 tests</div>
          <div className="tree-indent">📁 docs</div>
        </div>
      </section>
      <section>
        <h3>{t('sidebar.aiOrg')}</h3>
        {org.length === 0 && <div className="muted">{t('sidebar.noAgents')} {t('sidebar.noAgentsHint')}</div>}
        {org.map((n) => <OrgTreeNode key={n.agent.id} node={n} depth={0} onSelectAgent={onSelectAgent} />)}
      </section>
      <section>
        <h3>{t('sidebar.skills')}</h3>
        <div className="muted">
          {skillNames === null ? '…' : skillNames.length > 0 ? skillNames.join(' · ') : 'clean-code · debugging · git'}
        </div>
        <h3>{t('sidebar.mcp')}</h3>
        <div className="muted">github · filesystem <span className="pill">{t('sidebar.stubBadge')}</span></div>
        <h3>{t('sidebar.knowledge')}</h3>
        <div className="muted"><span className="pill">{t('sidebar.stubBadge')}</span></div>
        <h3>{t('sidebar.cicd')}</h3>
        <div className="muted"><span className="pill">{t('sidebar.stubBadge')}</span></div>
      </section>
    </aside>
  );
}

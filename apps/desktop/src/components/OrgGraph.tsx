import { useMemo, useState } from 'react';
import { OrgNode } from '../api';

/**
 * Organization 可视化图 — spec §84.
 * SVG 树形图渲染 HUMAN → PM → Tech Lead / Design Lead → …，
 * 节点按 Agent 状态着色，点击节点显示详情浮层，支持缩放。
 */

/** §84 节点状态 → 颜色：在线绿 / 空闲灰 / 工作中蓝 / 阻塞橙 / 失败红 / 暂停紫 / 归档暗 */
export const STATUS_COLORS: Record<string, string> = {
  ONLINE: '#3fb950',
  IDLE: '#8b949e',
  WORKING: '#58a6ff',
  BLOCKED: '#d29922',
  FAILED: '#f85149',
  PAUSED: '#bc8cff',
  ARCHIVED: '#484f58',
};

const STATUS_LABEL: Record<string, string> = {
  ONLINE: '在线',
  IDLE: '空闲',
  WORKING: '工作中',
  BLOCKED: '阻塞',
  FAILED: '失败',
  PAUSED: '暂停',
  ARCHIVED: '归档',
};

const NODE_W = 168;
const NODE_H = 64;
const H_GAP = 28;
const V_GAP = 64;

interface Placed {
  node: OrgNode;
  x: number; // left
  y: number; // top
  cx: number; // center x
  w: number; // subtree width
  children: Placed[];
  depth: number;
}

function subtreeWidth(node: OrgNode): number {
  if (node.children.length === 0) return NODE_W;
  const kids = node.children.reduce((s, c) => s + subtreeWidth(c), 0);
  return Math.max(NODE_W, kids + H_GAP * (node.children.length - 1));
}

/** 简单分层布局：后序计算子树宽度，前序分配 x 坐标，深度决定 y。 */
function layout(node: OrgNode, left: number, depth: number): Placed {
  const w = subtreeWidth(node);
  const cx = left + w / 2;
  const x = cx - NODE_W / 2;
  const y = depth * (NODE_H + V_GAP);
  let cursor = left;
  const children = node.children.map((c) => {
    const cw = subtreeWidth(c);
    const p = layout(c, cursor, depth + 1);
    cursor += cw + H_GAP;
    return p;
  });
  return { node, x, y, cx, w, children, depth };
}

function flatten(p: Placed, out: Placed[] = []): Placed[] {
  out.push(p);
  for (const c of p.children) flatten(c, out);
  return out;
}

function colorOf(status: string): string {
  return STATUS_COLORS[status] ?? '#8b949e';
}

export function OrgGraph({
  org,
  onSelectAgent,
}: {
  org: OrgNode[];
  onSelectAgent?: (agentId: string) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [selected, setSelected] = useState<OrgNode | null>(null);

  const roots = useMemo(() => {
    let cursor = 0;
    return org.map((n) => {
      const p = layout(n, cursor, 0);
      cursor += p.w + H_GAP * 3;
      return p;
    });
  }, [org]);

  const all = useMemo(() => roots.flatMap((r) => flatten(r)), [roots]);
  const maxDepth = useMemo(
    () => all.reduce((m, p) => Math.max(m, p.depth), 0),
    [all],
  );
  const totalW = useMemo(
    () => roots.reduce((m, p) => Math.max(m, p.x + p.w), 0),
    [roots],
  );
  const totalH = (maxDepth + 1) * (NODE_H + V_GAP);

  if (org.length === 0) {
    return <p className="muted">暂无组织数据</p>;
  }

  const edges: { x1: number; y1: number; x2: number; y2: number; key: string }[] = [];
  for (const p of all) {
    for (const c of p.children) {
      edges.push({
        x1: p.cx,
        y1: p.y + NODE_H,
        x2: c.cx,
        y2: c.y,
        key: `${p.node.agent.id}-${c.node.agent.id}`,
      });
    }
  }

  return (
    <div className="org-graph-wrap">
      <div className="org-graph-toolbar">
        <span className="muted">组织图谱 §84 · 点击节点查看详情</span>
        <span className="zoom-controls">
          <button onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.2).toFixed(1)))}>−</button>
          <span className="muted">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.min(2, +(z + 0.2).toFixed(1)))}>＋</button>
          <button onClick={() => setZoom(1)}>重置</button>
        </span>
      </div>
      <div className="org-graph-legend">
        {Object.entries(STATUS_COLORS).map(([s, c]) => (
          <span key={s} className="legend-item">
            <span className="status-dot" style={{ background: c }} />
            {STATUS_LABEL[s] ?? s}
          </span>
        ))}
      </div>
      <div className="org-graph-scroll">
        <div style={{ width: totalW * zoom, height: totalH * zoom, position: 'relative' }}>
          <svg
            width={totalW * zoom}
            height={totalH * zoom}
            className="org-svg"
          >
            <g transform={`scale(${zoom})`}>
              {edges.map((e) => (
                <line
                  key={e.key}
                  x1={e.x1}
                  y1={e.y1}
                  x2={e.x2}
                  y2={e.y2}
                  stroke="var(--border)"
                  strokeWidth={1.5}
                />
              ))}
              {all.map((p) => {
                const a = p.node.agent;
                const color = colorOf(a.status);
                const isSel = selected?.agent.id === a.id;
                return (
                  <g
                    key={a.id}
                    transform={`translate(${p.x},${p.y})`}
                    onClick={() => setSelected(p.node)}
                    style={{ cursor: 'pointer' }}
                  >
                    <rect
                      width={NODE_W}
                      height={NODE_H}
                      rx={8}
                      fill="var(--bg3)"
                      stroke={isSel ? '#fff' : color}
                      strokeWidth={isSel ? 2.5 : 2}
                    />
                    <rect width={6} height={NODE_H} rx={3} fill={color} />
                    <text x={16} y={24} fill="var(--text)" fontSize={13} fontWeight={700}>
                      {a.displayName.slice(0, 18)}
                    </text>
                    <text x={16} y={42} fill="var(--muted)" fontSize={11}>
                      {a.jobTitle.slice(0, 22)}
                    </text>
                    <circle cx={NODE_W - 16} cy={16} r={6} fill={color} />
                    <text x={16} y={58} fill="var(--muted)" fontSize={10}>
                      L{a.autonomyLevel} · {STATUS_LABEL[a.status] ?? a.status}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
          {selected && (
            <div className="org-pop">
              <div className="org-pop-head">
                <b>{selected.agent.displayName}</b>
                <button onClick={() => setSelected(null)}>✕</button>
              </div>
              <div className="org-pop-row">
                <span
                  className="status-dot"
                  style={{ background: colorOf(selected.agent.status) }}
                />
                {STATUS_LABEL[selected.agent.status] ?? selected.agent.status}
                <span className="muted"> · {selected.agent.jobTitle}</span>
              </div>
              <div className="org-pop-row muted">
                自治等级 L{selected.agent.autonomyLevel} · 下属 {selected.children.length} 人
              </div>
              {onSelectAgent && (
                <button
                  className="primary"
                  style={{ marginTop: 8 }}
                  onClick={() => onSelectAgent(selected.agent.id)}
                >
                  查看完整档案 §87
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

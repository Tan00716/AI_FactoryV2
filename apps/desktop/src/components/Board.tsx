import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, TaskSummary, NextState } from '../api';
import { useLang, type TFunc } from '../i18n';
import { EmptyState } from './EmptyState';

/**
 * Task Board 完整版 — spec §85.
 * 12 条 happy-path 列 + 2 条异常列（BLOCKED / FAILED）。
 * 终端态 CANCELLED / REJECTED / ESCALATED 并入 DONE 列，
 * ROLLBACK 并入 FAILED 列（卡片上保留原始状态标识）。
 * 拖拽卡片跨列 = POST /tasks/:id/transition 发起工作流流转；
 * 门禁拒绝（422）时 toast 显示缺少的证据。
 */

interface Lane {
  title: string;
  states: string[];
  /** 拖拽落点的主目标状态（多态列由引擎 nextStates 解析）。 */
  primary: string | null;
  exception?: boolean;
}

const LANES: Lane[] = [
  { title: 'TODO', states: ['TODO'], primary: 'TODO' },
  { title: 'PLANNING', states: ['PLANNING'], primary: 'PLANNING' },
  { title: 'IN PROGRESS', states: ['IN_PROGRESS'], primary: 'IN_PROGRESS' },
  { title: 'CODE REVIEW', states: ['CODE_REVIEW'], primary: 'CODE_REVIEW' },
  { title: 'PENDING QA', states: ['PENDING_QA'], primary: 'PENDING_QA' },
  { title: 'QA', states: ['QA'], primary: 'QA' },
  { title: 'PENDING UAT MERGE', states: ['PENDING_UAT_MERGE'], primary: 'PENDING_UAT_MERGE' },
  { title: 'UAT', states: ['UAT'], primary: 'UAT' },
  { title: 'PENDING PROD', states: ['PENDING_PROD'], primary: 'PENDING_PROD' },
  { title: 'PROD DEPLOYING', states: ['PROD_DEPLOYING'], primary: 'PROD_DEPLOYING' },
  { title: 'PROD VERIFICATION', states: ['PROD_VERIFICATION'], primary: 'PROD_VERIFICATION' },
  { title: 'DONE', states: ['DONE', 'CANCELLED', 'REJECTED', 'ESCALATED'], primary: 'DONE' },
  { title: 'BLOCKED', states: ['BLOCKED'], primary: 'BLOCKED', exception: true },
  {
    title: 'FAILED',
    states: ['QA_FAILED', 'UAT_FAILED', 'PROD_FAILED', 'ROLLBACK'],
    primary: null, // 由引擎 nextStates 在列内解析合法目标
    exception: true,
  },
];

/** 列标题 i18n 映射：内部标识（primary ?? title）→ 语言包 key；展示层翻译，内部 key/drag 状态保持英文原值。 */
const LANE_TITLE_KEYS: Record<string, string> = {
  TODO: 'board.lane.todo',
  PLANNING: 'board.lane.planning',
  IN_PROGRESS: 'board.lane.inProgress',
  CODE_REVIEW: 'board.lane.codeReview',
  PENDING_QA: 'board.lane.pendingQa',
  QA: 'board.lane.qa',
  PENDING_UAT_MERGE: 'board.lane.pendingUatMerge',
  UAT: 'board.lane.uat',
  PENDING_PROD: 'board.lane.pendingProd',
  PROD_DEPLOYING: 'board.lane.prodDeploying',
  PROD_VERIFICATION: 'board.lane.prodVerification',
  DONE: 'board.lane.done',
  BLOCKED: 'board.lane.blocked',
  FAILED: 'board.lane.failed',
};

function laneTitle(lane: Lane, t: TFunc): string {
  const key = LANE_TITLE_KEYS[lane.primary ?? lane.title];
  return key ? t(key) : lane.title;
}

/** Happy-path 进度标尺：TODO=0% … DONE=100%。 */
const HAPPY_PATH = [
  'TODO', 'PLANNING', 'IN_PROGRESS', 'CODE_REVIEW', 'PENDING_QA', 'QA',
  'PENDING_UAT_MERGE', 'UAT', 'PENDING_PROD', 'PROD_DEPLOYING',
  'PROD_VERIFICATION', 'DONE',
];

function progressOf(status: string): number | null {
  const i = HAPPY_PATH.indexOf(status);
  return i < 0 ? null : Math.round((i / (HAPPY_PATH.length - 1)) * 100);
}

function runtimeOf(createdAt: string, t: TFunc): string {
  const ms = Date.now() - new Date(createdAt).getTime();
  if (!(ms >= 0)) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 1) return t('board.justNow');
  if (m < 60) return t('board.minute', { m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('board.hour', { h }) + (m % 60 ? t('board.minute', { m: m % 60 }) : '');
  const d = Math.floor(h / 24);
  return t('board.day', { d }) + (h % 24 ? t('board.hour', { h: h % 24 }) : '');
}

interface Toast {
  kind: 'ok' | 'err';
  text: string;
}

export function Board({ tasks, onChanged, onCreate, onSelectTask }: {
  tasks: TaskSummary[];
  onChanged: () => void;
  onCreate: () => void;
  onSelectTask: (id: string) => void;
}) {
  const [toast, setToast] = useState<Toast | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const { t } = useLang();
  /** taskId → 下一步门禁所需的证据标签（当前门禁）。 */
  const [gates, setGates] = useState<Record<string, string[]>>({});
  /** 门禁拉取失败的卡片 id —— 与"确实无门禁"区分，避免误导用户直接流转。 */
  const [gateErr, setGateErr] = useState<Record<string, true>>({});
  /** taskId → nextStates，供多态列拖拽解析合法目标。 */
  const [nextStates, setNextStates] = useState<Record<string, NextState[]>>({});

  const showToast = useCallback((kind: Toast['kind'], text: string) => {
    setToast({ kind, text });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // 懒加载每张卡片的 nextStates → 当前门禁（§12）。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries: [string, string[] | null, NextState[]][] = await Promise.all(
        tasks.map(async (t): Promise<[string, string[] | null, NextState[]]> => {
          try {
            const d = await api.task(t.id);
            const reqs = [...new Set(d.nextStates.flatMap((n) => n.requires))];
            return [t.id, reqs, d.nextStates];
          } catch {
            return [t.id, null, []] as [string, string[] | null, NextState[]];
          }
        }),
      );
      if (cancelled) return;
      const g: Record<string, string[]> = {};
      const ge: Record<string, true> = {};
      const n: Record<string, NextState[]> = {};
      for (const [id, reqs, ns] of entries) {
        if (reqs === null) {
          ge[id] = true;
          continue;
        }
        g[id] = reqs;
        n[id] = ns;
      }
      setGates(g);
      setGateErr(ge);
      setNextStates(n);
    })();
    return () => { cancelled = true; };
  }, [tasks]);

  const byLane = useMemo(
    () =>
      LANES.map((lane) => ({
        lane,
        cards: tasks.filter((t) => lane.states.includes(t.status)),
      })),
    [tasks],
  );

  const dropTarget = useCallback(
    (taskId: string, lane: Lane): string | null => {
      if (lane.primary) return lane.primary;
      // 多态列（FAILED）：在引擎允许的 nextStates 里找落在该列的状态。
      const allowed = (nextStates[taskId] ?? []).map((n) => n.to);
      return allowed.find((s) => lane.states.includes(s)) ?? null;
    },
    [nextStates],
  );

  const onDropCard = useCallback(
    async (taskId: string, lane: Lane) => {
      setDragOver(null);
      const card = tasks.find((t) => t.id === taskId);
      if (!card) return;
      const to = dropTarget(taskId, lane);
      if (!to) {
        showToast('err', t('board.dropNotAllowed', { title: card.title, lane: laneTitle(lane, t) }));
        return;
      }
      if (to === card.status) return;
      try {
        const r = await api.transition(taskId, to);
        showToast('ok', t('board.transitionOk', { title: card.title, from: r.from, to: r.to }));
        onChanged();
      } catch (e) {
        const err = e as Error & { missing?: string[]; status?: number };
        if (err.status === 422 && err.missing) {
          showToast('err', t('board.gateDenied', { missing: err.missing.join(t('board.sep')) }));
        } else if (err.status === 403) {
          // Batch 75 (F61)：v1 transition 现在查 §17.2 授权轴。任务未授权时
          // 拖拽被拒，这里明示去处而不是只报"流转失败"。
          showToast('err', t('board.unauthorized', { message: err.message }));
        } else {
          showToast('err', t('board.transitionFailed', { message: err.message }));
        }
      }
    },
    [tasks, dropTarget, onChanged, showToast, t],
  );

  return (
    <div className="board-wrap">
      {tasks.length === 0 && <EmptyState panel="board" />}
      <div className="board-head">
        <h2>{t('board.title')} <span className="muted">{t('board.taskCount', { count: tasks.length })}</span></h2>
        <button className="primary" onClick={onCreate}>{t('board.newTask')}</button>
      </div>
      <div className="board">
        {byLane.map(({ lane, cards }) => (
          <div
            key={lane.title}
            className={`lane${lane.exception ? ' exception' : ''}${dragOver === lane.title ? ' dragover' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(lane.title);
            }}
            onDragLeave={() => setDragOver((d) => (d === lane.title ? null : d))}
            onDrop={(e) => {
              e.preventDefault();
              const taskId = e.dataTransfer.getData('text/task-id');
              if (taskId) void onDropCard(taskId, lane);
            }}
          >
            <div className="lane-title">
              {laneTitle(lane, t)} <span className="count">{cards.length}</span>
            </div>
            {cards.map((c) => (
              <TaskCard
                key={c.id}
                task={c}
                gates={gates[c.id]}
                gateErr={gateErr[c.id]}
                onOpen={() => onSelectTask(c.id)}
              />
            ))}
          </div>
        ))}
      </div>
      {toast && (
        <div className={`toast ${toast.kind}`}>
          <span>{toast.text}</span>
          <button onClick={() => setToast(null)}>✕</button>
        </div>
      )}
    </div>
  );
}

function TaskCard({ task, gates, gateErr, onOpen }: {
  task: TaskSummary;
  gates?: string[];
  gateErr?: boolean;
  onOpen: () => void;
}) {
  const { t } = useLang();
  const progress = progressOf(task.status);
  return (
    <div
      className="card"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/task-id', task.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={onOpen}
      title={t('board.cardTitle')}
    >
      <div className="card-top">
        <span className="card-id">#{task.id.slice(0, 8)}</span>
        <span className={`prio ${task.priority.toLowerCase()}`}>{task.priority}</span>
        <span className={`risk r-${task.risk.toLowerCase()}`}>{task.risk}</span>
      </div>
      <div className="card-title">{task.title}</div>
      <div className="card-meta">
        <span>👤 {task.currentAgentId ? task.currentAgentId.slice(0, 8) : t('board.unassigned')}</span>
        <span className="muted">{task.assignedAgentIds.length} agents</span>
      </div>
      <div className="card-meta">
        <span className="muted">⏱ {runtimeOf(task.createdAt, t)}</span>
        <span className="muted">{task.status}</span>
      </div>
      {progress !== null ? (
        <div className="card-progress">
          <div className="card-progress-bar" style={{ width: `${progress}%` }} />
          <span className="card-progress-label">{progress}%</span>
        </div>
      ) : (
        <div className="card-meta"><span className="pill warn">{task.status}</span></div>
      )}
      <div className="card-gate">
        <span className="muted">{t('board.gate')}</span>
        {gateErr ? (
          <span className="gate-req">{t('board.gateFetchFailed')}</span>
        ) : gates === undefined ? (
          <span className="muted">…</span>
        ) : gates.length === 0 ? (
          <span className="gate-ok">{t('board.gateNone')}</span>
        ) : (
          <span className="gate-req">{gates.join(' · ')}</span>
        )}
      </div>
    </div>
  );
}

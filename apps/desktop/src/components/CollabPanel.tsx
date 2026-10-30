/**
 * CollabPanel — 第三波任务⑩ 实时协同 MVP（Zed 式，零模型，不做语音/视频）。
 *
 * 四块：在线成员（presence + 跟随）/ 协同聊天 / 共享文档（RGA CRDT 纯文本）
 * / 共享终端只读流。WS 通道 /api/collab（房间 = projectId）。
 *
 * 诚实边界（同样写在 UI 文案里）：
 *  - 共享文档是纯文本 textarea，不是 Monaco；RGA 上限 200k 字符。
 *  - 断线重连重新同步快照，不是操作回放。
 *  - 跟随模式只读同步对方当前面板，不抢控制。
 *  - 终端是只读流：能看输出，不能输入。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { defaultApiBase, getApiToken, authHeaders } from '../api';
import { useLang } from '../i18n';
import { EmptyState } from './EmptyState';
import {
  RgaDocument,
  type RgaOp,
  type CollabServerMsg,
  type CollabMemberView,
  type CollabChatView,
} from '@ai-factory/collab';

/** 跟随目标面板名的白名单（与 App.tsx 的 tab 名一致，防止远端伪造跳转）。 */
const KNOWN_TABS = new Set([
  'Dashboard', 'Ops', 'Report', 'Board', 'Git', 'QA', 'Approvals', 'Permissions',
  'NeedsHuman', 'Dispatch', 'CI/CD', 'Skills', 'Memory', 'MCP', 'Knowledge',
  'Evaluation', 'Agents', 'Orchestrate', 'Observatory', 'Manager', 'Editor',
  'Terminal', 'Changes', 'Stability', 'Project', 'Activity', 'Events', 'Models',
  'Plan', 'Hooks', 'Session', 'Plugins', 'Metrics', 'Inspections', 'Batch', 'Collab',
]);

interface Props {
  projectId: string;
  currentTab: string;
  onFollowPanel: (tab: string) => void;
}

function wsBase(): string {
  return defaultApiBase().replace(/^http/, 'ws');
}

/** 前/后缀公共部分，求编辑 diff。 */
function diffText(oldText: string, newText: string): { pre: number; removed: string; inserted: string } {
  let pre = 0;
  const maxPre = Math.min(oldText.length, newText.length);
  while (pre < maxPre && oldText[pre] === newText[pre]) pre++;
  let suf = 0;
  while (
    suf < oldText.length - pre &&
    suf < newText.length - pre &&
    oldText[oldText.length - 1 - suf] === newText[newText.length - 1 - suf]
  ) {
    suf++;
  }
  return {
    pre,
    removed: oldText.slice(pre, oldText.length - suf),
    inserted: newText.slice(pre, newText.length - suf),
  };
}

export function CollabPanel({ projectId, currentTab, onFollowPanel }: Props) {
  const { t } = useLang();
  const [status, setStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [memberId, setMemberId] = useState<string | null>(null);
  const [members, setMembers] = useState<CollabMemberView[]>([]);
  const [chat, setChat] = useState<CollabChatView[]>([]);
  const [docText, setDocText] = useState('');
  const [termSessions, setTermSessions] = useState<Array<{ id: string; principal: string }>>([]);
  const [watching, setWatching] = useState<string | null>(null);
  const [termLines, setTermLines] = useState<string[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [userName, setUserName] = useState(() => {
    try {
      return localStorage.getItem('factory.collabName') ?? '';
    } catch {
      return '';
    }
  });
  const [allowFollow, setAllowFollow] = useState(false);
  const [followTarget, setFollowTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconnectIn, setReconnectIn] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const docRef = useRef(new RgaDocument());
  const seqRef = useRef(0);
  const memberIdRef = useRef<string | null>(null);
  const followTargetRef = useRef<string | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const chatBoxRef = useRef<HTMLDivElement | null>(null);
  const termBoxRef = useRef<HTMLPreElement | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userNameRef = useRef(userName);
  userNameRef.current = userName;
  followTargetRef.current = followTarget;

  const send = useCallback((msg: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const applyRemoteOps = useCallback((ops: RgaOp[]) => {
    const ta = textAreaRef.current;
    const caret = ta ? { start: ta.selectionStart, end: ta.selectionEnd } : null;
    let changed = false;
    for (const op of ops) {
      const r = docRef.current.apply(op);
      if (r === 'applied' || r === 'buffered') changed = true;
    }
    if (changed) {
      setDocText(docRef.current.text());
      // 尽力恢复光标（MVP：按原偏移钳制，不做精确映射）
      if (ta && caret) {
        requestAnimationFrame(() => {
          const len = ta.value.length;
          const s = Math.min(caret.start, len);
          const e = Math.min(caret.end, len);
          try {
            ta.setSelectionRange(s, e);
          } catch { /* ignore */ }
        });
      }
    }
  }, []);

  const handleServerMsg = useCallback(
    (msg: CollabServerMsg) => {
      switch (msg.t) {
        case 'welcome': {
          memberIdRef.current = msg.memberId;
          setMemberId(msg.memberId);
          docRef.current.loadSnapshot(msg.snapshot);
          seqRef.current = 0;
          setDocText(docRef.current.text());
          setChat(msg.chat);
          setMembers(msg.presence);
          setTermSessions(msg.termSessions);
          // 加入后上报当前面板 + 跟随偏好
          send({ t: 'presence', panel: currentTab, allowFollow });
          break;
        }
        case 'presence': {
          setMembers(msg.members);
          // 跟随模式：目标面板变化 → 只读切换本地 tab
          const targetId = followTargetRef.current;
          if (targetId) {
            const target = msg.members.find((m) => m.id === targetId);
            if (target && target.panel && KNOWN_TABS.has(target.panel) && target.panel !== currentTab) {
              onFollowPanel(target.panel);
            }
          }
          break;
        }
        case 'ops':
          if (msg.from !== memberIdRef.current) applyRemoteOps(msg.ops);
          break;
        case 'chat':
          setChat((prev) => [...prev.slice(-199), msg.msg]);
          break;
        case 'termOut': {
          try {
            const text = atob(msg.b64);
            // b64 是 utf8 字节：还原
            const decoded = decodeURIComponent(escape(text));
            setTermLines((prev) => {
              const next = [...prev, decoded].join('').split('\n');
              return next.slice(-200);
            });
          } catch { /* 忽略坏帧 */ }
          break;
        }
        case 'termClosed':
          setTermLines((prev) => [...prev, `\n[session ${msg.sessionId} closed]`].slice(-200));
          setWatching((w) => (w === msg.sessionId ? null : w));
          break;
        case 'termWatching':
          if (!msg.stopped) {
            setWatching(msg.sessionId);
            setTermLines([]);
          }
          break;
        case 'error':
          setError(msg.code === 'RBAC_DENIED' ? t('collab.viewerReadOnly') : `${msg.code}: ${msg.message}`);
          break;
      }
    },
    [applyRemoteOps, currentTab, onFollowPanel, send, t, allowFollow],
  );

  const connect = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return;
    setStatus('connecting');
    setError(null);
    const token = getApiToken();
    const qs = new URLSearchParams({ projectId });
    if (token) qs.set('token', token);
    const ws = new WebSocket(`${wsBase()}/collab?${qs.toString()}`);
    wsRef.current = ws;
    ws.onopen = () => {
      setStatus('connected');
      setReconnectIn(0);
      const name = userNameRef.current.trim() || 'anonymous';
      ws.send(JSON.stringify({ t: 'hello', user: name, panel: currentTab }));
    };
    ws.onmessage = (ev) => {
      try {
        handleServerMsg(JSON.parse(ev.data) as CollabServerMsg);
      } catch {
        setError(t('collab.badFrame'));
      }
    };
    const scheduleReconnect = () => {
      setStatus('disconnected');
      wsRef.current = null;
      // 5s 后重连（倒计时显示）
      let s = 5;
      setReconnectIn(s);
      const tick = () => {
        s -= 1;
        if (s <= 0) {
          connect();
        } else {
          setReconnectIn(s);
          reconnectTimer.current = setTimeout(tick, 1000);
        }
      };
      reconnectTimer.current = setTimeout(tick, 1000);
    };
    ws.onclose = scheduleReconnect;
    ws.onerror = () => {
      try {
        ws.close();
      } catch { /* ignore */ }
    };
  }, [projectId, currentTab, handleServerMsg, t]);

  const disconnect = useCallback(() => {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    setReconnectIn(0);
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      ws.onclose = null;
      try {
        ws.close();
      } catch { /* ignore */ }
    }
    setStatus('disconnected');
    setMemberId(null);
    setMembers([]);
    setFollowTarget(null);
  }, []);

  // 当前 tab 变化 → 上报 presence（用于跟随模式）
  useEffect(() => {
    if (status === 'connected') send({ t: 'presence', panel: currentTab });
  }, [currentTab, status, send]);

  // 聊天自动滚到底
  useEffect(() => {
    const el = chatBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat]);

  // 终端自动滚到底
  useEffect(() => {
    const el = termBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [termLines]);

  useEffect(() => () => disconnect(), [disconnect]);

  const canEdit = (() => {
    const me = members.find((m) => m.id === memberId);
    return me ? me.role !== 'viewer' : true;
  })();
  /** 已完成 hello 握手（server 下发 memberId）后才允许编辑/发言。 */
  const joined = status === 'connected' && memberId !== null;

  // 本地编辑 → RGA ops → 广播
  const onDocChange = (next: string) => {
    const prev = docRef.current.text();
    if (next === prev) {
      setDocText(next);
      return;
    }
    const { pre, removed, inserted } = diffText(prev, next);
    const ops: RgaOp[] = [];
    const site = memberIdRef.current ?? 'local';
    // 先删（收集 id，避免序号漂移）
    const removeIds: RgaOp[] = [];
    for (let i = 0; i < removed.length; i++) {
      const id = docRef.current.idAt(pre);
      if (!id) break;
      const op = docRef.current.remove(id);
      if (op) removeIds.push(op);
    }
    // 再插
    let left = pre > 0 ? docRef.current.idAt(pre - 1) : null;
    for (const ch of inserted) {
      const op = docRef.current.insert(site, seqRef.current++, left, ch);
      if (!op) break;
      ops.push(op);
      left = op.id;
    }
    const all = [...removeIds, ...ops];
    setDocText(docRef.current.text());
    if (all.length > 0 && joined) send({ t: 'op', ops: all });
  };

  const sendChat = () => {
    const text = chatInput.trim();
    if (!text || !joined) return;
    send({ t: 'chat', text: text.slice(0, 2000) });
    setChatInput('');
  };

  const refreshTermSessions = async () => {
    try {
      const res = await fetch(`${defaultApiBase()}/terminal/sessions`, { headers: authHeaders() });
      if (!res.ok) return;
      const body = (await res.json()) as { sessions?: Array<{ id: string; principal: string }> };
      if (Array.isArray(body.sessions)) setTermSessions(body.sessions);
    } catch { /* 忽略 */ }
  };

  const toggleFollow = (id: string) => {
    const next = followTarget === id ? null : id;
    setFollowTarget(next);
    send({ t: 'follow', target: next });
  };

  const onAllowFollowChange = (v: boolean) => {
    setAllowFollow(v);
    send({ t: 'presence', allowFollow: v });
  };

  const saveName = (v: string) => {
    setUserName(v);
    try {
      localStorage.setItem('factory.collabName', v);
    } catch { /* ignore */ }
  };

  return (
    <div className="panel collab-panel">
      {members.length === 0 && <EmptyState panel="collab" />}
      <div className="panel-head">
        <h2>{t('collab.title')}</h2>
        <p className="muted">{t('collab.subtitle')}</p>
      </div>

      {/* 连接栏 */}
      <div className="collab-connectbar">
        <input
          value={userName}
          onChange={(e) => saveName(e.target.value)}
          placeholder={t('collab.userNamePlaceholder')}
          disabled={status !== 'disconnected'}
          maxLength={40}
        />
        {status === 'connected' ? (
          <button onClick={disconnect}>{t('collab.disconnect')}</button>
        ) : (
          <button onClick={connect} disabled={status === 'connecting'}>
            {status === 'connecting' ? t('collab.connecting') : t('collab.connect')}
          </button>
        )}
        <span className={`dot ${status}`} />
        <span className="muted">
          {status === 'connected'
            ? t('collab.connected')
            : reconnectIn > 0
              ? t('collab.reconnecting', { s: reconnectIn })
              : t('collab.disconnected')}
        </span>
        {error && <span className="err">{error}</span>}
      </div>

      {!canEdit && joined && (
        <div className="banner warn">{t('collab.viewerReadOnly')}</div>
      )}

      <div className="collab-grid">
        {/* 在线成员 + 跟随 */}
        <section className="collab-card">
          <h3>{t('collab.presence')} ({members.length})</h3>
          <label className="row">
            <input type="checkbox" checked={allowFollow} onChange={(e) => onAllowFollowChange(e.target.checked)} />
            {t('collab.allowFollow')}
          </label>
          {followTarget && (
            <div className="banner info">
              {t('collab.following', { name: members.find((m) => m.id === followTarget)?.userName ?? '?' })}
              <button onClick={() => toggleFollow(followTarget)}>{t('collab.unfollow')}</button>
            </div>
          )}
          <p className="muted small">{t('collab.followHint')}</p>
          <ul className="collab-members">
            {members.map((m) => (
              <li key={m.id}>
                <span className="avatar-dot" style={{ background: m.color }} />
                <span>
                  {m.userName}
                  {m.id === memberId ? t('collab.you') : ''}
                </span>
                <span className="muted small">{m.panel || '—'}</span>
                {m.id !== memberId && m.allowFollow && (
                  <button className="link" onClick={() => toggleFollow(m.id)}>
                    {followTarget === m.id ? t('collab.unfollow') : t('collab.follow')}
                  </button>
                )}
              </li>
            ))}
            {members.length === 0 && <li className="muted">{t('collab.noMembers')}</li>}
          </ul>
        </section>

        {/* 聊天 */}
        <section className="collab-card">
          <h3>{t('collab.chat')}</h3>
          <div className="collab-chatbox" ref={chatBoxRef}>
            {chat.map((m) => (
              <div key={m.id} className="chat-msg">
                <span className="chat-user">{m.userName}</span>
                <span className="chat-text">{m.text}</span>
              </div>
            ))}
            {chat.length === 0 && <div className="muted">{t('collab.noChat')}</div>}
          </div>
          <div className="row">
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder={t('collab.chatPlaceholder')}
              disabled={!joined || !canEdit}
              maxLength={2000}
              onKeyDown={(e) => {
                if (e.key === 'Enter') sendChat();
              }}
            />
            <button onClick={sendChat} disabled={!joined || !canEdit}>
              {t('collab.send')}
            </button>
          </div>
        </section>

        {/* 共享文档 */}
        <section className="collab-card wide">
          <h3>
            {t('collab.doc')} <span className="muted small">{t('collab.docChars', { n: docText.length })}</span>
          </h3>
          <p className="muted small">{t('collab.docHint')}</p>
          <textarea
            ref={textAreaRef}
            className="collab-doc"
            value={docText}
            onChange={(e) => onDocChange(e.target.value)}
            disabled={!joined || !canEdit}
            spellCheck={false}
          />
        </section>

        {/* 共享终端（只读） */}
        <section className="collab-card wide">
          <h3>{t('collab.termWatch')}</h3>
          <p className="muted small">{t('collab.termWatchHint')}</p>
          <div className="row">
            <select
              value={watching ?? ''}
              onChange={(e) => {
                const id = e.target.value;
                if (watching) send({ t: 'unwatchTerm', sessionId: watching });
                if (id) send({ t: 'watchTerm', sessionId: id });
              }}
              disabled={status !== 'connected'}
            >
              <option value="">{t('collab.selectSession')}</option>
              {termSessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id} ({s.principal})
                </option>
              ))}
            </select>
            <button onClick={refreshTermSessions} disabled={status !== 'connected'}>
              {t('collab.refresh')}
            </button>
            {watching && (
              <button onClick={() => send({ t: 'unwatchTerm', sessionId: watching })}>
                {t('collab.unwatch')}
              </button>
            )}
          </div>
          {termSessions.length === 0 && <div className="muted small">{t('collab.noTermSessions')}</div>}
          <pre className="collab-term" ref={termBoxRef}>
            {termLines.join('\n')}
          </pre>
        </section>
      </div>
    </div>
  );
}

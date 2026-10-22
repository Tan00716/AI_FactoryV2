import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type DbBrowserConnection,
  type DbBrowserErGraph,
  type DbBrowserQueryResponse,
  type DbBrowserSchema,
  type DbBrowserSchemaDiff,
  type DbBrowserTablePage,
} from '../api';
import { useLang } from '../i18n';

/**
 * R4-A5 数据库浏览器 — JetBrains Database 工具风格。
 *
 * 查询控制台（危险语句守卫）/ 表编辑器（分页+写回验证）/ schema /
 * schema 对比 / DDL 生成 / ER 关系图。Postgres 为最小线协议驱动
 * （trust 认证、无 SSL），只在 SQLite 上做了真机验证。
 *
 * HONEST BOUNDARIES (rendered in the UI):
 *  - 连接是服务端会话级的：重启服务端后连接丢失，需重新注册。
 *  - sqlite 路径被 jail 在服务端数据目录内；prod 连接只读，
 *    任何写入被拒绝（唯一 prod 写入口是 DB 时间旅行的 promote）。
 *  - 破坏性语句（DROP / 无 WHERE 的 DELETE/UPDATE）不直接执行，
 *    走票据：申请 → 批准（需填 decided_by）→ 单次执行。
 *  - schema diff 的 DDL 只有加法；删除只报告、不生成脚本。
 */

type SubTab = 'console' | 'tables' | 'schema' | 'diff' | 'ddl' | 'er';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function Cell({ v }: { v: unknown }) {
  const s = v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return <td title={s}>{s.length > 60 ? s.slice(0, 60) + '…' : s}</td>;
}

export function DbBrowserPanel() {
  const { t } = useLang();
  const [conns, setConns] = useState<DbBrowserConnection[]>([]);
  const [conn, setConn] = useState('');
  const [tab, setTab] = useState<SubTab>('console');
  const [msg, setMsg] = useState<string | null>(null);

  const [regName, setRegName] = useState('');
  const [regPath, setRegPath] = useState('');
  const [regEnv, setRegEnv] = useState('dev');

  const [sql, setSql] = useState('SELECT 1 AS one');
  const [qr, setQr] = useState<DbBrowserQueryResponse | null>(null);
  const [ticket, setTicket] = useState<string | null>(null);
  const [decidedBy, setDecidedBy] = useState('');

  const [tables, setTables] = useState<Array<{ name: string; type: string }>>([]);
  const [table, setTable] = useState('');
  const [page, setPage] = useState<DbBrowserTablePage | null>(null);
  const [pageNo, setPageNo] = useState(1);
  const [editRow, setEditRow] = useState<Record<string, unknown> | null>(null);
  const [editVals, setEditVals] = useState<Record<string, string>>({});

  const [schema, setSchema] = useState<DbBrowserSchema | null>(null);
  const [diffSrc, setDiffSrc] = useState('');
  const [diffTgt, setDiffTgt] = useState('');
  const [diff, setDiff] = useState<DbBrowserSchemaDiff | null>(null);
  const [ddl, setDdl] = useState('');
  const [er, setEr] = useState<DbBrowserErGraph | null>(null);

  const refreshConns = useCallback(async () => {
    try {
      const r = await api.dbConnections();
      setConns(r.connections);
      if (!r.connections.some((c) => c.name === conn) && r.connections.length > 0) {
        setConn(r.connections[0]!.name);
      }
    } catch (e) {
      setMsg(t('dbb.loadFailed', { message: errMsg(e) }));
    }
  }, [conn, t]);

  useEffect(() => {
    void refreshConns();
  }, [refreshConns]);

  const register = useCallback(async () => {
    if (!regName.trim() || !regPath.trim()) return;
    setMsg(null);
    try {
      await api.dbRegister({ name: regName.trim(), kind: 'sqlite', path: regPath.trim(), env: regEnv });
      setRegName('');
      setRegPath('');
      await refreshConns();
      setMsg(t('dbb.registered', { name: regName.trim() }));
    } catch (e) {
      setMsg(t('dbb.registerFailed', { message: errMsg(e) }));
    }
  }, [regName, regPath, regEnv, refreshConns, t]);

  const runSql = useCallback(async () => {
    if (!conn || !sql.trim()) return;
    setMsg(null);
    setQr(null);
    setTicket(null);
    try {
      const r = await api.dbQuery({ connection: conn, sql });
      setQr(r.body);
    } catch (e) {
      const m = errMsg(e);
      // 403 approvalRequired comes back as an error body; surface the ticket path.
      if (/approvalRequired|APPROVAL_REQUIRED/.test(m)) {
        setMsg(t('dbb.needsTicket'));
      } else {
        setMsg(t('dbb.queryFailed', { message: m }));
      }
    }
  }, [conn, sql, t]);

  const requestTicket = useCallback(async () => {
    if (!conn || !sql.trim()) return;
    try {
      const r = await api.dbDestructiveRequest({ connection: conn, sql });
      setTicket(r.ticketId);
      setMsg(t('dbb.ticketMinted', { id: r.ticketId.slice(0, 8) }));
    } catch (e) {
      setMsg(t('dbb.ticketFailed', { message: errMsg(e) }));
    }
  }, [conn, sql, t]);

  const approveTicket = useCallback(async () => {
    if (!ticket || !decidedBy.trim()) return;
    try {
      await api.dbDestructiveApprove(ticket, decidedBy.trim());
      setMsg(t('dbb.ticketApproved'));
    } catch (e) {
      setMsg(t('dbb.approveFailed', { message: errMsg(e) }));
    }
  }, [ticket, decidedBy, t]);

  const executeTicket = useCallback(async () => {
    if (!ticket || !conn) return;
    try {
      const r = await api.dbDestructiveExecute({ ticketId: ticket, connection: conn, sql });
      setTicket(null);
      setMsg(t('dbb.executed', { changes: String(r.body.changes) }));
    } catch (e) {
      setMsg(t('dbb.executeFailed', { message: errMsg(e) }));
    }
  }, [ticket, conn, sql, t]);

  const loadTables = useCallback(async () => {
    if (!conn) return;
    try {
      const r = await api.dbTables(conn);
      setTables(r.tables);
      if (r.tables.length > 0 && !table) setTable(r.tables[0]!.name);
    } catch (e) {
      setMsg(t('dbb.loadFailed', { message: errMsg(e) }));
    }
  }, [conn, table, t]);

  const loadPage = useCallback(
    async (p: number) => {
      if (!conn || !table) return;
      try {
        const r = await api.dbTablePage(conn, table, { page: p, pageSize: 50 });
        setPage(r);
        setPageNo(p);
      } catch (e) {
        setMsg(t('dbb.loadFailed', { message: errMsg(e) }));
      }
    },
    [conn, table, t],
  );

  const startEdit = useCallback((row: Record<string, unknown>) => {
    setEditRow(row);
    const v: Record<string, string> = {};
    for (const [k, val] of Object.entries(row)) v[k] = val === null || val === undefined ? '' : String(val);
    setEditVals(v);
  }, []);

  const saveEdit = useCallback(async () => {
    if (!conn || !table || !editRow || !page) return;
    // PK heuristic: 'id' column, else the first column.
    const pkCol = page.columns.includes('id') ? 'id' : page.columns[0]!;
    const pk: Record<string, unknown> = { [pkCol]: editRow[pkCol] };
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(editVals)) {
      if (String(editRow[k] ?? '') !== v) patch[k] = v === '' ? null : v;
    }
    if (Object.keys(patch).length === 0) {
      setEditRow(null);
      return;
    }
    try {
      await api.dbUpdateRow({ connection: conn, table, pk, patch });
      setEditRow(null);
      await loadPage(pageNo);
      setMsg(t('dbb.rowUpdated'));
    } catch (e) {
      setMsg(t('dbb.updateFailed', { message: errMsg(e) }));
    }
  }, [conn, table, editRow, editVals, page, pageNo, loadPage, t]);

  const loadSchema = useCallback(async () => {
    if (!conn) return;
    try {
      setSchema(await api.dbSchema(conn));
    } catch (e) {
      setMsg(t('dbb.loadFailed', { message: errMsg(e) }));
    }
  }, [conn, t]);

  const runDiff = useCallback(async () => {
    if (!diffSrc || !diffTgt) return;
    try {
      setDiff(await api.dbSchemaDiff(diffSrc, diffTgt));
    } catch (e) {
      setMsg(t('dbb.loadFailed', { message: errMsg(e) }));
    }
  }, [diffSrc, diffTgt, t]);

  const loadDdl = useCallback(async () => {
    if (!conn) return;
    try {
      const r = await api.dbDdl(conn, table || undefined);
      setDdl(r.ddl);
    } catch (e) {
      setMsg(t('dbb.loadFailed', { message: errMsg(e) }));
    }
  }, [conn, table, t]);

  const loadEr = useCallback(async () => {
    if (!conn) return;
    try {
      setEr(await api.dbEr(conn));
    } catch (e) {
      setMsg(t('dbb.loadFailed', { message: errMsg(e) }));
    }
  }, [conn, t]);

  useEffect(() => {
    if (tab === 'tables') void loadTables();
    if (tab === 'schema') void loadSchema();
    if (tab === 'ddl') void loadDdl();
    if (tab === 'er') void loadEr();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, conn]);

  useEffect(() => {
    if (tab === 'tables' && table) void loadPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table]);

  const tabs: Array<[SubTab, string]> = [
    ['console', t('dbb.tabConsole')],
    ['tables', t('dbb.tabTables')],
    ['schema', t('dbb.tabSchema')],
    ['diff', t('dbb.tabDiff')],
    ['ddl', t('dbb.tabDdl')],
    ['er', t('dbb.tabEr')],
  ];

  return (
    <div className="dbb-panel">
      <div className="dbb-bar">
        <select value={conn} onChange={(e) => setConn(e.target.value)} title={t('dbb.connection')}>
          {conns.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name} ({c.kind}/{c.env})
            </option>
          ))}
        </select>
        <input value={regName} onChange={(e) => setRegName(e.target.value)} placeholder={t('dbb.regName')} size={10} />
        <input value={regPath} onChange={(e) => setRegPath(e.target.value)} placeholder={t('dbb.regPath')} size={16} />
        <select value={regEnv} onChange={(e) => setRegEnv(e.target.value)}>
          <option value="dev">dev</option>
          <option value="staging">staging</option>
          <option value="prod">prod</option>
        </select>
        <button onClick={register}>{t('dbb.register')}</button>
        <span className="muted">{t('dbb.sessionNote')}</span>
      </div>
      <div className="dbb-tabs">
        {tabs.map(([k, label]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {msg && <div className="dbb-msg">{msg}</div>}

      {tab === 'console' && (
        <div className="dbb-console">
          <textarea value={sql} onChange={(e) => setSql(e.target.value)} rows={4} spellCheck={false} />
          <div className="dbb-row">
            <button onClick={runSql}>{t('dbb.run')}</button>
            <button onClick={requestTicket}>{t('dbb.requestTicket')}</button>
            <span className="muted">{t('dbb.guardNote')}</span>
          </div>
          {qr && (
            <div>
              <div className="dbb-row">
                <span className={`pill verdict-${qr.verdict}`}>{qr.verdict}</span>
                <span className="muted">
                  {t('dbb.rows', { n: String(qr.result.rowCount) })} · {qr.result.durationMs}ms
                  {qr.result.truncated ? ` · ${t('dbb.truncated')}` : ''}
                  {qr.result.changes !== undefined ? ` · changes=${qr.result.changes}` : ''}
                </span>
              </div>
              {qr.result.columns.length > 0 && (
                <table className="dbb-grid">
                  <thead>
                    <tr>
                      {qr.result.columns.map((c) => (
                        <th key={c}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {qr.result.rows.map((r, i) => (
                      <tr key={i}>
                        {qr.result.columns.map((c) => (
                          <Cell key={c} v={r[c]} />
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
          {ticket && (
            <div className="dbb-ticket">
              <div>
                {t('dbb.ticketId')}: <code>{ticket}</code>
              </div>
              <div className="dbb-row">
                <input
                  value={decidedBy}
                  onChange={(e) => setDecidedBy(e.target.value)}
                  placeholder={t('dbb.decidedBy')}
                  size={14}
                />
                <button onClick={approveTicket}>{t('dbb.approve')}</button>
                <button onClick={executeTicket}>{t('dbb.execute')}</button>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'tables' && (
        <div>
          <div className="dbb-row">
            <select value={table} onChange={(e) => setTable(e.target.value)}>
              {tables.map((x) => (
                <option key={x.name} value={x.name}>
                  {x.name} ({x.type})
                </option>
              ))}
            </select>
            {page && (
              <span className="muted">
                {t('dbb.pageInfo', { page: String(page.page), pages: String(page.totalPages), total: String(page.totalRows) })}
              </span>
            )}
            <button disabled={!page || page.page <= 1} onClick={() => loadPage(pageNo - 1)}>
              {t('dbb.prev')}
            </button>
            <button disabled={!page || page.page >= page.totalPages} onClick={() => loadPage(pageNo + 1)}>
              {t('dbb.next')}
            </button>
          </div>
          {page && (
            <table className="dbb-grid">
              <thead>
                <tr>
                  {page.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {page.rows.map((r, i) => (
                  <tr key={i}>
                    {page.columns.map((c) => (
                      <Cell key={c} v={r[c]} />
                    ))}
                    <td>
                      <button onClick={() => startEdit(r)}>{t('dbb.edit')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {editRow && (
            <div className="dbb-edit">
              <div className="dbb-row">
                <strong>{t('dbb.editRow')}</strong>
                <button onClick={saveEdit}>{t('dbb.save')}</button>
                <button onClick={() => setEditRow(null)}>{t('dbb.cancel')}</button>
              </div>
              {Object.keys(editVals).map((k) => (
                <label key={k} className="dbb-field">
                  {k}:
                  <input value={editVals[k] ?? ''} onChange={(e) => setEditVals({ ...editVals, [k]: e.target.value })} />
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'schema' && schema && (
        <div className="dbb-schema">
          {schema.tables.map((tb) => (
            <details key={tb.name} open>
              <summary>
                <strong>{tb.name}</strong>
                <span className="muted"> ({tb.columns.length} cols)</span>
              </summary>
              <table className="dbb-grid">
                <thead>
                  <tr>
                    <th>{t('dbb.colName')}</th>
                    <th>{t('dbb.colType')}</th>
                    <th>PK</th>
                    <th>NOT NULL</th>
                    <th>{t('dbb.colDefault')}</th>
                  </tr>
                </thead>
                <tbody>
                  {tb.columns.map((c) => (
                    <tr key={c.name}>
                      <td>{c.name}</td>
                      <td>{c.type || '—'}</td>
                      <td>{c.pk > 0 ? c.pk : ''}</td>
                      <td>{c.notNull ? '✓' : ''}</td>
                      <td>{c.defaultValue ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {tb.foreignKeys.length > 0 && (
                <div className="muted">
                  FK: {tb.foreignKeys.map((f) => `${f.column} → ${f.refTable}.${f.refColumn}`).join('; ')}
                </div>
              )}
              {tb.indexes.length > 0 && (
                <div className="muted">
                  IDX: {tb.indexes.map((x) => `${x.name}${x.unique ? ' (unique)' : ''} (${x.columns.join(',')})`).join('; ')}
                </div>
              )}
            </details>
          ))}
          {schema.views.length > 0 && (
            <div className="muted">
              {t('dbb.views')}: {schema.views.map((v) => v.name).join(', ')}
            </div>
          )}
        </div>
      )}

      {tab === 'diff' && (
        <div>
          <div className="dbb-row">
            <select value={diffSrc} onChange={(e) => setDiffSrc(e.target.value)}>
              <option value="">{t('dbb.pickSource')}</option>
              {conns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <span>→</span>
            <select value={diffTgt} onChange={(e) => setDiffTgt(e.target.value)}>
              <option value="">{t('dbb.pickTarget')}</option>
              {conns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <button onClick={runDiff}>{t('dbb.runDiff')}</button>
          </div>
          {diff && (
            <div>
              <div className="muted">
                {t('dbb.diffSummary', {
                  tables: String(diff.addTables.length),
                  cols: String(diff.addColumns.length),
                  drops: String(diff.droppedTables.length + diff.droppedColumns.length),
                })}
              </div>
              {diff.notes.map((n, i) => (
                <div key={i} className="dbb-note">
                  {n}
                </div>
              ))}
              <pre className="dbb-pre">{diff.ddl.join('\n') || t('dbb.noDdl')}</pre>
            </div>
          )}
        </div>
      )}

      {tab === 'ddl' && (
        <div>
          <pre className="dbb-pre">{ddl || t('dbb.noDdl')}</pre>
        </div>
      )}

      {tab === 'er' && er && (
        <div className="dbb-er">
          <div>
            <strong>{t('dbb.erNodes', { n: String(er.nodes.length) })}</strong>
            <ul>
              {er.nodes.map((n) => (
                <li key={n.id}>
                  <code>{n.label}</code>
                  <span className="muted"> pk:[{n.pk.join(',') || '—'}] cols:{n.columns.join(', ')}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <strong>{t('dbb.erEdges', { n: String(er.edges.length) })}</strong>
            <ul>
              {er.edges.map((e, i) => (
                <li key={i}>
                  <code>
                    {e.from} → {e.to}
                  </code>
                  <span className="muted"> ({e.label})</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="dbb-honest muted">{t('dbb.honest')}</div>
    </div>
  );
}

/**
 * terminalHistory.ts — R4-A8 终端命令历史搜索的桌面端纯函数。
 *
 * scanShellMarkers: 线协议的客户端镜像（packages/termhistory 的
 * findMarkers 在服务端用；桌面端不依赖 node 包，避免打包 node
 * 内建模块）。只解析 A/B/C/D/E/H 六种标记。
 */
export type ShellMarkerKind = 'A' | 'B' | 'C' | 'D' | 'E' | 'H';

export interface ShellMarker {
  kind: ShellMarkerKind;
  payload: string;
  index: number;
  length: number;
}

const ESC = '\x1b';
const BEL = '\x07';
const MARKER_RE = new RegExp(
  `${ESC}\\]133;([A-Z])(?:;([^${ESC}${BEL}]*))?(?:${ESC}\\\\|${BEL})`,
  'g',
);

export function scanShellMarkers(text: string): ShellMarker[] {
  const out: ShellMarker[] = [];
  MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(text)) !== null) {
    const kind = m[1] as ShellMarkerKind;
    if (kind === 'A' || kind === 'B' || kind === 'C' || kind === 'D' || kind === 'E' || kind === 'H') {
      out.push({ kind, payload: m[2] ?? '', index: m.index, length: m[0].length });
    }
    if (m[0].length === 0) MARKER_RE.lastIndex++;
  }
  return out;
}

export interface HistoryEntryDto {
  id: string;
  sessionId: string;
  principal: string;
  command: string;
  exitCode: number;
  at: number;
}

export interface HistoryGroup {
  key: string;
  label: string;
  entries: HistoryEntryDto[];
}

/**
 * 按会话分组（保持服务端返回的顺序：搜索时按相关度、空查询时按时间）。
 * label 形如 "a1b2c3d4… · human"。
 */
export function groupEntriesBySession(entries: HistoryEntryDto[]): HistoryGroup[] {
  const order: string[] = [];
  const map = new Map<string, HistoryEntryDto[]>();
  for (const e of entries) {
    let list = map.get(e.sessionId);
    if (!list) {
      list = [];
      map.set(e.sessionId, list);
      order.push(e.sessionId);
    }
    list.push(e);
  }
  return order.map((sid) => {
    const list = map.get(sid) as HistoryEntryDto[];
    return {
      key: sid,
      label: `${sid.slice(0, 8)}… · ${list[0].principal}`,
      entries: list,
    };
  });
}

/** 展平分组为可选中的线性列表（overlay ↑↓ 导航用）。 */
export function flattenGroups(groups: HistoryGroup[]): HistoryEntryDto[] {
  const out: HistoryEntryDto[] = [];
  for (const g of groups) out.push(...g.entries);
  return out;
}

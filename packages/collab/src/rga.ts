/**
 * RGA (Replicated Growable Array) CRDT — 第三波任务⑩ 实时协同 MVP.
 *
 * 纯确定性逻辑，node 内建，无外部依赖（仓库零依赖约定）。
 *
 * 诚实边界（MVP）：
 *  1. 只处理纯文本，按字符建模；富文本/属性不在范围。
 *  2. 引用按同名 ID 匹配，不是语义分析——此处指 RGA 本身是位置无关的，
 *     并发插入的相对顺序由 (site, seq) 全序决定，是确定性的，但不一定
 *     符合人类直觉的"意图"。
 *  3. 文档上限 MAX_DOC_CHARS（200k 字符），超出时 insert 被拒绝（返回
 *     rejected），不静默截断。大文档性能未优化。
 *  4. 快照 = 全量节点；断线重连走"重新同步快照"，不是操作回放。
 *
 * 收敛保证：所有副本应用相同的 op 集合（任意顺序、允许重复、允许
 * remove 先于 insert 到达）最终得到完全相同的文档。单元测试锁定。
 */

export interface RgaId {
  /** 站点标识（每个协同客户端唯一，如 memberId）。*/
  site: string;
  /** 站点内单调递增序号。*/
  seq: number;
}

export type RgaOp =
  | { type: 'insert'; id: RgaId; left: RgaId | null; ch: string }
  | { type: 'remove'; id: RgaId };

/** 文档字符上限（MVP 诚实边界：大文档性能未优化）。 */
export const MAX_DOC_CHARS = 200_000;

function idKey(id: RgaId): string {
  return `${id.site}:${id.seq}`;
}

function parseIdKey(key: string): RgaId | null {
  const i = key.lastIndexOf(':');
  if (i < 0) return null;
  const seq = Number(key.slice(i + 1));
  if (!Number.isInteger(seq) || seq < 0) return null;
  return { site: key.slice(0, i), seq };
}

/**
 * ID 全序：seq 大者为大；seq 相等时 site 按字符串比较。
 * 同一 left 锚点下的并发插入按此序的**降序**排列（id 大者在前，
 * 经典 RGA tie-break），保证所有副本顺序一致。
 */
export function compareRgaId(a: RgaId, b: RgaId): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.site < b.site ? -1 : a.site > b.site ? 1 : 0;
}

interface RgaNode {
  id: RgaId;
  key: string;
  leftKey: string | null;
  ch: string;
  deleted: boolean;
}

const ROOT = '\0root';

export class RgaDocument {
  private nodes = new Map<string, RgaNode>();
  /** leftKey(或 ROOT) -> 子节点 key 列表，按 id 降序排列。 */
  private children = new Map<string, string[]>();
  /** remove 先于 insert 到达时记住，后到的 insert 直接标删除。 */
  private removedEarly = new Set<string>();
  /**
   * 因果缓冲：锚点尚未到达的 insert 暂存于此，每次有新节点落地后
   * 重试。保证乱序到达仍收敛（而不是拒绝丢弃）。
   */
  private pending: Extract<RgaOp, { type: 'insert' }>[] = [];
  private charCount = 0;

  get length(): number {
    return this.charCount;
  }

  /** 本地插入：返回 op（调用方负责广播）。left 为 null 表示文档开头。 */
  insert(site: string, seq: number, left: RgaId | null, ch: string): RgaOp | null {
    if (typeof ch !== 'string' || [...ch].length !== 1) return null;
    if (this.charCount >= MAX_DOC_CHARS) return null;
    const id: RgaId = { site, seq };
    const key = idKey(id);
    if (this.nodes.has(key)) return null; // seq 重用：拒绝，保证 id 唯一
    const leftKey = left ? idKey(left) : null;
    if (leftKey !== null && !this.nodes.has(leftKey)) return null; // 本地锚点必须存在
    const op: RgaOp = { type: 'insert', id, left, ch };
    const r = this.applyInsert(op);
    return r === 'applied' ? op : null;
  }

  /** 本地删除：返回 op（调用方负责广播）；未知 id 返回 null。 */
  remove(id: RgaId): RgaOp | null {
    const key = idKey(id);
    const node = this.nodes.get(key);
    if (!node) {
      // remove 先于 insert 到达：记住，后到的 insert 直接标删除。
      this.removedEarly.add(key);
      return { type: 'remove', id };
    }
    if (node.deleted) return null;
    node.deleted = true;
    this.charCount -= 1;
    return { type: 'remove', id };
  }

  /**
   * 应用远端/本地 op，幂等：
   *  - 'applied'    新 op，已生效
   *  - 'buffered'   锚点未到，已暂存；锚点到达后自动生效
   *  - 'duplicate'  已见过，无变化
   *  - 'rejected'   非法（超上限 / 非法字符），调用方应丢弃
   */
  apply(op: RgaOp): 'applied' | 'buffered' | 'duplicate' | 'rejected' {
    if (op.type === 'insert') return this.applyInsert(op);
    const key = idKey(op.id);
    const node = this.nodes.get(key);
    if (node) {
      if (node.deleted) return 'duplicate';
      node.deleted = true;
      this.charCount -= 1;
      return 'applied';
    }
    if (this.removedEarly.has(key)) return 'duplicate';
    this.removedEarly.add(key);
    return 'applied';
  }

  private applyInsert(
    op: Extract<RgaOp, { type: 'insert' }>,
  ): 'applied' | 'buffered' | 'duplicate' | 'rejected' {
    const key = idKey(op.id);
    if (this.nodes.has(key)) return 'duplicate';
    if (typeof op.ch !== 'string' || [...op.ch].length !== 1) return 'rejected';
    if (this.charCount >= MAX_DOC_CHARS) return 'rejected';
    const leftKey = op.left ? idKey(op.left) : null;
    if (leftKey !== null && !this.nodes.has(leftKey)) {
      // 锚点未到：缓冲而非拒绝，保证乱序到达仍收敛。
      if (!this.pending.some((p) => idKey(p.id) === key)) this.pending.push(op);
      return 'buffered';
    }
    const node: RgaNode = {
      id: op.id,
      key,
      leftKey,
      ch: op.ch,
      deleted: this.removedEarly.has(key),
    };
    this.nodes.set(key, node);
    const bucketKey = leftKey ?? ROOT;
    const bucket = this.children.get(bucketKey) ?? [];
    bucket.push(key);
    // 按 id 降序：并发插入确定性排序。
    bucket.sort((a, b) => {
      const ia = parseIdKey(a) as RgaId;
      const ib = parseIdKey(b) as RgaId;
      return compareRgaId(ib, ia);
    });
    this.children.set(bucketKey, bucket);
    if (!node.deleted) this.charCount += 1;
    this.drainPending();
    return 'applied';
  }

  /** 新节点落地后重试缓冲中的 insert，直到无进展为止。 */
  private drainPending(): void {
    let progressed = true;
    while (progressed && this.pending.length > 0) {
      progressed = false;
      const rest: Extract<RgaOp, { type: 'insert' }>[] = [];
      for (const op of this.pending) {
        const leftKey = op.left ? idKey(op.left) : null;
        if (leftKey === null || this.nodes.has(leftKey)) {
          // 锚点已就绪：直接落地（不再走缓冲路径，避免递归）。
          const key = idKey(op.id);
          if (!this.nodes.has(key) && this.charCount < MAX_DOC_CHARS) {
            const node: RgaNode = {
              id: op.id,
              key,
              leftKey,
              ch: op.ch,
              deleted: this.removedEarly.has(key),
            };
            this.nodes.set(key, node);
            const bucketKey = leftKey ?? ROOT;
            const bucket = this.children.get(bucketKey) ?? [];
            bucket.push(key);
            bucket.sort((a, b) => {
              const ia = parseIdKey(a) as RgaId;
              const ib = parseIdKey(b) as RgaId;
              return compareRgaId(ib, ia);
            });
            this.children.set(bucketKey, bucket);
            if (!node.deleted) this.charCount += 1;
          }
          progressed = true;
          continue;
        }
        rest.push(op);
      }
      this.pending = rest;
    }
  }

  /**
   * 可见字符序号 → 节点 id（桌面端把光标位置映射为 RGA 锚点用）。
   * 越界返回 null。
   */
  idAt(visibleIndex: number): RgaId | null {
    if (visibleIndex < 0) return null;
    let i = 0;
    let found: RgaId | null = null;
    const visit = (bucketKey: string): boolean => {
      const bucket = this.children.get(bucketKey);
      if (!bucket) return false;
      for (const key of bucket) {
        const node = this.nodes.get(key);
        if (!node) continue;
        if (!node.deleted) {
          if (i === visibleIndex) {
            found = node.id;
            return true;
          }
          i += 1;
        }
        if (visit(key)) return true;
      }
      return false;
    };
    visit(ROOT);
    return found;
  }

  /** 当前可见文本。 */
  text(): string {    const out: string[] = [];
    const visit = (bucketKey: string): void => {
      const bucket = this.children.get(bucketKey);
      if (!bucket) return;
      for (const key of bucket) {
        const node = this.nodes.get(key);
        if (!node) continue;
        if (!node.deleted) out.push(node.ch);
        visit(key);
      }
    };
    visit(ROOT);
    return out.join('');
  }

  /** 全量快照（新成员加入 / 断线重连用）。 */
  snapshot(): RgaOp[] {
    const ops: RgaOp[] = [];
    for (const node of this.nodes.values()) {
      ops.push({ type: 'insert', id: node.id, left: node.leftKey ? (parseIdKey(node.leftKey) as RgaId) : null, ch: node.ch });
      if (node.deleted) ops.push({ type: 'remove', id: node.id });
    }
    return ops;
  }

  /** 从快照重建（先清空）。 */
  loadSnapshot(ops: RgaOp[]): void {
    this.nodes.clear();
    this.children.clear();
    this.removedEarly.clear();
    this.charCount = 0;
    // 先应用所有 insert，再应用 remove，保证锚点存在。
    for (const op of ops) if (op.type === 'insert') this.applyInsert(op);
    for (const op of ops) if (op.type === 'remove') this.apply(op);
  }

  /** 调试/测试：节点数（含 tombstone）。 */
  get nodeCount(): number {
    return this.nodes.size;
  }
}

/**
 * RGA CRDT 单元测试 — @ai-factory/collab 包内测试（node:test +
 * node:assert/strict，从 ../src/index 引，跑 dist 编译后）。
 *
 * 锁定：收敛性（乱序/重复/交错 → 同一文档）、幂等、remove 先于 insert、
 * 确定性 tie-break、200k 上限。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RgaDocument, compareRgaId, MAX_DOC_CHARS } from '../src/index';
import type { RgaOp } from '../src/index';

function id(site: string, seq: number) {
  return { site, seq };
}

/** 把文本按顺序插入文档尾（单站点），返回 ops。 */
function typeText(doc: RgaDocument, site: string, startSeq: number, text: string): { ops: RgaOp[]; last: { site: string; seq: number } | null } {
  const ops: RgaOp[] = [];
  let left: { site: string; seq: number } | null = null;
  let seq = startSeq;
  for (const ch of text) {
    const op = doc.insert(site, seq, left, ch);
    assert.ok(op, `insert should succeed for ${ch}`);
    ops.push(op);
    left = { site, seq };
    seq += 1;
  }
  return { ops, last: left };
}

test('单站点顺序插入 → 文本一致', () => {
  const doc = new RgaDocument();
  typeText(doc, 'a', 0, 'hello');
  assert.equal(doc.text(), 'hello');
  assert.equal(doc.length, 5);
});

test('双站点并发插入收敛：乱序应用得同一文档', () => {
  const a = new RgaDocument();
  const b = new RgaDocument();
  // a 在开头插 'X'，b 也在开头插 'Y'（并发，都以 left=null）
  const opA = a.insert('a', 0, null, 'X');
  const opB = b.insert('b', 0, null, 'Y');
  assert.ok(opA && opB);
  // 交换并应用
  assert.equal(a.apply(opB), 'applied');
  assert.equal(b.apply(opA), 'applied');
  assert.equal(a.text(), b.text());
  // tie-break 确定性：id 大者在前 → 'b' > 'a'，所以 Y 在前
  assert.equal(a.text(), 'YX');
  assert.equal(compareRgaId(id('b', 0), id('a', 0)) > 0, true);
});

test('交错合并：三副本最终一致', () => {
  const docs = [new RgaDocument(), new RgaDocument(), new RgaDocument()];
  const sites = ['s1', 's2', 's3'];
  const allOps: RgaOp[] = [];
  // 每个站点在各自文档上打一段文本（含并发）
  const seeds: Array<{ left: { site: string; seq: number } | null; seq: number }> = [
    { left: null, seq: 0 },
    { left: null, seq: 0 },
    { left: null, seq: 0 },
  ];
  const texts = ['aaa', 'bbb', 'ccc'];
  sites.forEach((site, i) => {
    const { ops } = typeText(docs[i], site, 0, texts[i]);
    seeds[i].seq = ops.length;
    allOps.push(...ops);
  });
  // 乱序 + 重复地喂给每个副本（确定性 shuffle：逆序 + 隔一个重复）
  const shuffled = [...allOps].reverse();
  for (const doc of docs) {
    for (const op of shuffled) doc.apply(op);
    for (let i = 0; i < shuffled.length; i += 2) doc.apply(shuffled[i]); // 重复
  }
  const t0 = docs[0].text();
  assert.equal(docs[1].text(), t0);
  assert.equal(docs[2].text(), t0);
  assert.equal(t0.length, 9);
  // 根级并发插入按 id 降序：s3 的 ccc 在前
  assert.equal(t0, 'cccbbbaaa');
});

test('删除收敛：remove 先于 insert 到达', () => {
  const a = new RgaDocument();
  const b = new RgaDocument();
  const op = a.insert('a', 0, null, 'Z');
  assert.ok(op && op.type === 'insert');
  const del = a.remove(op.id);
  assert.ok(del);
  // b 先收到 remove，再收到 insert
  assert.equal(b.apply(del), 'applied');
  assert.equal(b.apply(op), 'applied');
  assert.equal(a.text(), '');
  assert.equal(b.text(), '');
  assert.equal(a.text(), b.text());
});

test('删除幂等：重复 remove 是 duplicate', () => {
  const doc = new RgaDocument();
  const op = doc.insert('a', 0, null, 'Q');
  assert.ok(op && op.type === 'insert');
  const d1 = doc.remove(op.id);
  const d2 = doc.remove(op.id);
  assert.ok(d1);
  assert.equal(d2, null);
  assert.equal(doc.apply(d1), 'duplicate');
  assert.equal(doc.text(), '');
});

test('中间插入保持顺序', () => {
  const doc = new RgaDocument();
  const o1 = doc.insert('a', 0, null, 'a');
  assert.ok(o1 && o1.type === 'insert');
  const o2 = doc.insert('a', 1, o1.id, 'c');
  assert.ok(o2 && o2.type === 'insert');
  const o3 = doc.insert('a', 2, o1.id, 'b'); // 在 a 之后、c 之前
  assert.ok(o3);
  assert.equal(doc.text(), 'abc');
});

test('快照往返：loadSnapshot 重建一致', () => {
  const a = new RgaDocument();
  typeText(a, 'x', 0, 'snapshot-me');
  const del = a.remove({ site: 'x', seq: 2 });
  assert.ok(del);
  const b = new RgaDocument();
  b.loadSnapshot(a.snapshot());
  assert.equal(b.text(), a.text());
  assert.equal(b.text(), 'snpshot-me');
});

test('非法 op 被拒绝：非法字符', () => {
  const doc = new RgaDocument();
  const r = doc.apply({ type: 'insert', id: id('z', 9), left: null, ch: 'ab' });
  assert.equal(r, 'rejected');
  assert.equal(doc.text(), '');
});

test('锚点未到先缓冲，锚点到达后自动生效（乱序收敛）', () => {
  const doc = new RgaDocument();
  // 先到子节点（锚点 ghost 不存在）→ buffered
  const r = doc.apply({ type: 'insert', id: id('z', 9), left: id('z', 8), ch: '!' });
  assert.equal(r, 'buffered');
  assert.equal(doc.text(), '');
  // 锚点到达 → 缓冲自动释放
  const anchor = doc.apply({ type: 'insert', id: id('z', 8), left: null, ch: '?' });
  assert.equal(anchor, 'applied');
  assert.equal(doc.text(), '?!');
});

test('文档上限：MAX_DOC_CHARS 后 insert 返回 null/拒绝', () => {
  const doc = new RgaDocument();
  let left: { site: string; seq: number } | null = null;
  for (let i = 0; i < MAX_DOC_CHARS; i++) {
    const op = doc.insert('s', i, left, 'x');
    assert.ok(op, `insert ${i} should succeed`);
    left = { site: 's', seq: i };
  }
  assert.equal(doc.length, MAX_DOC_CHARS);
  assert.equal(doc.insert('s', MAX_DOC_CHARS, left, 'y'), null);
  assert.equal(doc.apply({ type: 'insert', id: id('s', MAX_DOC_CHARS + 1), left, ch: 'y' }), 'rejected');
});

test('空文档与单字符边界', () => {
  const doc = new RgaDocument();
  assert.equal(doc.text(), '');
  assert.equal(doc.insert('s', 0, null, ''), null); // 空串拒绝
  assert.equal(doc.insert('s', 0, null, 'ab'), null); // 多字符拒绝
});

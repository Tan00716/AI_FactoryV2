/**
 * Design mode core — unit tests for the pure transforms
 * (apps/server/src/design-mode.ts). Imported from src with an explicit
 * .ts suffix — safe under the AGENTS.md dual-mode rule because
 * design-mode.ts has no relative value imports at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyClassTokenEdit,
  applyStyleEdits,
  applyTextEdit,
  classTokenFamily,
  detectTailwind,
  locateElement,
  scanElements,
  type ElementFingerprint,
} from '../src/design-mode.ts';

const HTML = [
  '<!DOCTYPE html>',
  '<html><head><title>Shop</title></head><body>',
  '<h1 class="text-3xl font-bold text-gray-900">Welcome to the shop</h1>',
  '<div class="card p-4">',
  '  <button class="btn bg-red-500 text-white p-2 m-1">Buy now</button>',
  '  <button class="btn bg-red-500 text-white p-2 m-1">Buy now</button>',
  '</div>',
  '<img src="logo.png" class="logo" />',
  '<div id="app">{{ dynamic }}</div>',
  '</body></html>',
].join('\n');

const fpOf = (tag: string, classes: string[], text: string): ElementFingerprint => ({ tag, classes, text });

test('scanElements finds tags with line/column and class tokens', () => {
  const els = scanElements(HTML);
  const h1 = els.find((e) => e.tag === 'h1')!;
  assert.ok(h1);
  assert.equal(h1.line, 3);
  assert.equal(h1.column, 1);
  assert.equal(h1.classValue, 'text-3xl font-bold text-gray-900');
  const img = els.find((e) => e.tag === 'img')!;
  assert.equal(img.selfClosing, true);
  assert.equal(img.classValue, 'logo');
});

test('locateElement matches by class subset + literal text', () => {
  const hit = locateElement(HTML, fpOf('button', ['btn', 'bg-red-500'], 'Buy now'));
  assert.ok(hit);
  assert.equal(hit.line, 5); // first of the two identical buttons (documented boundary)
  assert.deepEqual(hit.text, 'Buy now');
  assert.ok(hit.classes.includes('bg-red-500'));
});

test('locateElement refuses literal-text cross-match', () => {
  const hit = locateElement(HTML, fpOf('h1', ['text-3xl'], 'Goodbye'));
  assert.equal(hit, null);
});

test('locateElement matches class-only when no text', () => {
  const hit = locateElement(HTML, fpOf('img', ['logo'], ''));
  assert.ok(hit);
  assert.equal(hit.line, 8);
  assert.equal(hit.text, null);
});

test('locateElement matches JSX className', () => {
  const jsx = [
    "export default function A() {",
    '  return (',
    '    <div className="wrap p-4">',
    "      <span className={'chip bg-blue-500'}>Hi</span>",
    '    </div>',
    '  );',
    '}',
  ].join('\n');
  const hit = locateElement(jsx, fpOf('span', ['chip'], 'Hi'));
  assert.ok(hit);
  assert.equal(hit.line, 4);
});

test('locateElement does not text-match dynamic content', () => {
  const hit = locateElement(HTML, fpOf('div', [], '{{ dynamic }}'));
  assert.equal(hit, null); // {{ }} is dynamic — honest no-match
});

test('classTokenFamily separates text-color from text-size', () => {
  assert.equal(classTokenFamily('bg-red-500'), 'bg-color');
  assert.equal(classTokenFamily('text-blue-700'), 'text-color');
  assert.equal(classTokenFamily('text-white'), 'text-color');
  assert.equal(classTokenFamily('text-xl'), 'text-size');
  assert.equal(classTokenFamily('text-2xl'), 'text-size');
  assert.equal(classTokenFamily('p-4'), 'padding');
  assert.equal(classTokenFamily('m-1'), 'margin');
  assert.equal(classTokenFamily('hover:bg-red-500'), null); // variants untouched
  assert.equal(classTokenFamily('px-4'), null); // out of scope — p-/m- only
  assert.equal(classTokenFamily('font-bold'), null);
});

test('applyClassTokenEdit replaces a bg token in place', () => {
  const located = locateElement(HTML, fpOf('button', ['btn'], 'Buy now'))!;
  const out = applyClassTokenEdit(HTML, located, 'bg-color', 'bg-blue-500', false)!;
  // replaced (family removal, then append at end — deterministic)
  assert.ok(out.includes('class="btn text-white p-2 m-1 bg-blue-500"'));
  assert.ok(!out.split('\n')[4].includes('bg-red-500'));
  // only the first button changed (line-targeted)
  const second = out.split('\n')[5];
  assert.ok(second.includes('bg-red-500'));
});

test('applyClassTokenEdit appends when the family is absent', () => {
  const located = locateElement(HTML, fpOf('img', ['logo'], ''))!;
  const out = applyClassTokenEdit(HTML, located, 'bg-color', 'bg-green-500', false)!;
  assert.ok(out.includes('class="logo bg-green-500"'));
});

test('applyClassTokenEdit inserts a class attr when missing, respecting jsx', () => {
  const src = '<div id="x">Hi</div>';
  const located = locateElement(src, fpOf('div', [], 'Hi'))!;
  const html = applyClassTokenEdit(src, located, 'padding', 'p-4', false)!;
  assert.ok(html.includes('<div id="x" class="p-4">'));
  const jsx = applyClassTokenEdit(src, located, 'padding', 'p-4', true)!;
  assert.ok(jsx.includes('<div id="x" className="p-4">'));
});

test('applyClassTokenEdit separates text-color and text-size families', () => {
  const located = locateElement(HTML, fpOf('h1', ['text-3xl'], 'Welcome to the shop'))!;
  const color = applyClassTokenEdit(HTML, located, 'text-color', 'text-red-600', false)!;
  assert.ok(color.includes('text-3xl font-bold text-red-600')); // size kept, color replaced
  const size = applyClassTokenEdit(HTML, located, 'text-size', 'text-xl', false)!;
  assert.ok(size.includes('font-bold text-gray-900 text-xl')); // color kept, size replaced
});

test('applyTextEdit replaces literal text, drift-guarded', () => {
  const located = locateElement(HTML, fpOf('h1', ['text-3xl'], 'Welcome to the shop'))!;
  const out = applyTextEdit(HTML, located, located.text!, 'Hello store')!;
  assert.ok(out.includes('>Hello store</h1>'));
  const drifted = applyTextEdit(HTML, located, 'something else', 'Hello store');
  assert.equal(drifted, null);
});

test('applyStyleEdits applies a batch atomically-ish', () => {
  const r = applyStyleEdits(
    HTML,
    fpOf('button', ['btn'], 'Buy now'),
    5,
    { bgColor: 'bg-green-500', padding: 'p-6', text: 'Add to cart' },
    false,
  );
  assert.ok(!('error' in r));
  if (!('error' in r)) {
    assert.deepEqual(r.applied, ['bgColor', 'padding', 'text']);
    const line = r.content.split('\n')[4];
    assert.ok(line.includes('bg-green-500'));
    assert.ok(line.includes('p-6'));
    assert.ok(line.includes('>Add to cart</button>'));
  }
});

test('applyStyleEdits reports drift when the element moved', () => {
  const r = applyStyleEdits(HTML, fpOf('button', ['btn'], 'Buy now'), 6, { bgColor: 'bg-green-500' }, false);
  assert.ok('error' in r);
});

test('detectTailwind finds the three signals', () => {
  assert.equal(
    detectTailwind({ packageJson: '{"devDependencies":{"tailwindcss":"^3"}}', configFiles: [], cssSamples: [] }).tailwind,
    true,
  );
  assert.equal(
    detectTailwind({ packageJson: '{}', configFiles: ['tailwind.config.js'], cssSamples: [] }).tailwind,
    true,
  );
  assert.equal(
    detectTailwind({ packageJson: null, configFiles: [], cssSamples: ['@tailwind base;'] }).tailwind,
    true,
  );
  const none = detectTailwind({ packageJson: '{"dependencies":{"react":"18"}}', configFiles: [], cssSamples: ['body{}'] });
  assert.equal(none.tailwind, false);
  assert.ok(none.reason.length > 0);
});

test('fingerprint edge: empty classes + empty text matches first same-tag element', () => {
  const hit = locateElement('<div>a</div><div>b</div>', fpOf('div', [], ''));
  assert.ok(hit);
  assert.equal(hit.line, 1);
  assert.equal(hit.text, 'a');
});

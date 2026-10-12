/**
 * AI Factory app icon generator — zero external dependencies (node:zlib only).
 *
 * Design: an abstract gear (factory/industry glyph) in amber on a dark-navy
 * rounded square. The same geometry constants drive both the SVG source
 * (icon.svg) and the PNG rasterizer below, which evaluates signed distance
 * fields per pixel for analytic anti-aliasing.
 *
 * Outputs (this directory):
 *   icon.svg       vector source (512 viewBox)
 *   icon.png       512x512 — the file electron-builder consumes
 *   icon-256.png   256x256
 *
 * Regenerate with: node apps/desktop/build/generate-icon.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Geometry + palette (fractions of canvas size unless noted)
// ---------------------------------------------------------------------------
const GEO = {
  cornerRadius: 0.2, // rounded-square background
  teeth: 8,
  toothRIn: 0.2, // gear teeth: radial span
  toothROut: 0.335,
  toothHalfWidth: 0.063, // tangential half-width (local x)
  ringROut: 0.248, // gear ring (annulus)
  ringRIn: 0.118,
};
const BG_TOP = [0x26, 0x35, 0x5a];
const BG_BOTTOM = [0x10, 0x18, 0x2b];
const GEAR_TOP = [0xfb, 0xbf, 0x24];
const GEAR_BOTTOM = [0xd9, 0x77, 0x06];

const lerp = (a, b, t) => a + (b - a) * t;
const mix3 = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// ---------------------------------------------------------------------------
// SVG source
// ---------------------------------------------------------------------------
function buildSvg() {
  const S = 512;
  const c = S / 2;
  const teeth = [];
  const toothW = 2 * GEO.toothHalfWidth * S;
  const toothH = (GEO.toothROut - GEO.toothRIn) * S;
  const toothX = c - toothW / 2;
  const toothY = c - GEO.toothROut * S;
  for (let k = 0; k < GEO.teeth; k++) {
    teeth.push(
      `    <rect x="${toothX.toFixed(1)}" y="${toothY.toFixed(1)}" width="${toothW.toFixed(1)}" height="${toothH.toFixed(1)}" transform="rotate(${k * (360 / GEO.teeth)} ${c} ${c})"/>`,
    );
  }
  const rOut = GEO.ringROut * S;
  const rIn = GEO.ringRIn * S;
  const ring = [
    `M ${c - rOut} ${c} a ${rOut} ${rOut} 0 1 0 ${2 * rOut} 0 a ${rOut} ${rOut} 0 1 0 ${-2 * rOut} 0`,
    `M ${c - rIn} ${c} a ${rIn} ${rIn} 0 1 0 ${2 * rIn} 0 a ${rIn} ${rIn} 0 1 0 ${-2 * rIn} 0`,
  ].join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#26355a"/>
      <stop offset="1" stop-color="#10182b"/>
    </linearGradient>
    <linearGradient id="gear" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fbbf24"/>
      <stop offset="1" stop-color="#d97706"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${S}" height="${S}" rx="${(GEO.cornerRadius * S).toFixed(1)}" fill="url(#bg)"/>
  <g fill="url(#gear)">
    <path fill-rule="evenodd" d="${ring}"/>
${teeth.join('\n')}
  </g>
</svg>
`;
}

// ---------------------------------------------------------------------------
// SDF rasterizer
// ---------------------------------------------------------------------------
function roundedRectSdf(x, y, half, r) {
  const qx = Math.abs(x) - (half - r);
  const qy = Math.abs(y) - (half - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function rectSdf(x, y, hx, hy) {
  const dx = Math.abs(x) - hx;
  const dy = Math.abs(y) - hy;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
}

function gearSdf(x, y, S) {
  // x, y relative to canvas center, in pixels
  const dist = Math.hypot(x, y);
  const mid = ((GEO.ringROut + GEO.ringRIn) / 2) * S;
  const halfThick = ((GEO.ringROut - GEO.ringRIn) / 2) * S;
  let d = Math.abs(dist - mid) - halfThick; // ring
  const toothHx = GEO.toothHalfWidth * S;
  const toothHy = ((GEO.toothROut - GEO.toothRIn) / 2) * S;
  const toothCenterR = ((GEO.toothROut + GEO.toothRIn) / 2) * S;
  for (let k = 0; k < GEO.teeth; k++) {
    const a = (k * 2 * Math.PI) / GEO.teeth;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    // rotate point into tooth frame (tooth points "up": local -y is radial)
    const lx = cos * x + sin * y;
    const ly = -sin * x + cos * y;
    d = Math.min(d, rectSdf(lx, ly + toothCenterR, toothHx, toothHy));
  }
  return d;
}

function renderRgba(S) {
  const px = new Float32Array(S * S * 4);
  const half = S / 2;
  const cornerR = GEO.cornerRadius * S;
  for (let j = 0; j < S; j++) {
    const t = j / (S - 1);
    const bg = mix3(BG_TOP, BG_BOTTOM, t);
    const gearCol = mix3(GEAR_TOP, GEAR_BOTTOM, t);
    for (let i = 0; i < S; i++) {
      const x = i + 0.5 - half;
      const y = j + 0.5 - half;
      const bgCov = clamp01(0.5 - roundedRectSdf(x, y, half, cornerR));
      const gearCov = clamp01(0.5 - gearSdf(x, y, S));
      const idx = (j * S + i) * 4;
      // gear drawn over the background
      px[idx] = lerp(bg[0], gearCol[0], gearCov);
      px[idx + 1] = lerp(bg[1], gearCol[1], gearCov);
      px[idx + 2] = lerp(bg[2], gearCol[2], gearCov);
      px[idx + 3] = Math.max(bgCov, gearCov) * 255;
    }
  }
  const out = Buffer.alloc(S * S * 4);
  for (let n = 0; n < px.length; n++) out[n] = Math.round(px[n]);
  return out;
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder (RGBA8, filter 0 scanlines, zlib via node:zlib)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let n = 0; n < buf.length; n++) c = CRC_TABLE[(c ^ buf[n]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, S) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let j = 0; j < S; j++) {
    raw[j * (S * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, j * (S * 4 + 1) + 1, j * S * 4, (j + 1) * S * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
writeFileSync(join(here, 'icon.svg'), buildSvg());
writeFileSync(join(here, 'icon.png'), encodePng(renderRgba(512), 512));
writeFileSync(join(here, 'icon-256.png'), encodePng(renderRgba(256), 256));
console.log('icon.svg, icon.png (512x512), icon-256.png (256x256) written to', here);

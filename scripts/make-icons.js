'use strict';

// Generates build/icon.png (app icon) and build/trayTemplate(@2x).png (menu bar)
// with a tiny rasterizer + PNG encoder, so the repo needs no image tooling.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'build');

// The glyph: an inbox tray with a down arrow, on a 22×22 grid.
const GLYPH = [
  [3, 12, 3, 17], [3, 17, 4, 18], [4, 18, 18, 18], [18, 18, 19, 17], [19, 17, 19, 12],
  [3, 12, 7, 12], [7, 12, 8.5, 14.5], [8.5, 14.5, 13.5, 14.5], [13.5, 14.5, 15, 12], [15, 12, 19, 12],
  [11, 3, 11, 9.8], [8, 7, 11, 10], [11, 10, 14, 7],
];

function segDist(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1; const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function glyphCoverage(gx, gy, stroke) {
  return GLYPH.some((s) => segDist(gx, gy, s) <= stroke / 2) ? 1 : 0;
}

function roundedRectInside(x, y, x0, y0, size, r) {
  const cx = Math.min(Math.max(x, x0 + r), x0 + size - r);
  const cy = Math.min(Math.max(y, y0 + r), y0 + size - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

/** Render with SS×SS supersampling. shade(x, y) → [r,g,b,a] in 0..255 for a sample point. */
function render(size, shade, SS = 4) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [cr, cg, cb, ca] = shade(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      }
      const i = (y * size + x) * 4;
      if (a > 0) { px[i] = r / a; px[i + 1] = g / a; px[i + 2] = b / a; }
      px[i + 3] = a / (SS * SS);
    }
  }
  return px;
}

function png(size, rgba) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function trayIcon(size) {
  const scale = 22 / size;
  return png(size, render(size, (x, y) => [0, 0, 0, glyphCoverage(x * scale, y * scale, 1.7) * 255]));
}

function appIconPixels(size) {
  const inset = size * 0.1; const box = size - inset * 2; const radius = box * 0.225;
  const top = [110, 168, 255]; const bottom = [72, 84, 232];
  const gScale = 22 / (box * 0.62); const gOff = inset + box * 0.19;
  return render(size, (x, y) => {
    if (!roundedRectInside(x, y, inset, inset, box, radius)) {
      // soft drop shadow below the tile
      const d = roundedRectInside(x, y - size * 0.012, inset, inset, box, radius) ? 1 : 0;
      return [0, 0, 0, d * 60];
    }
    const t = (y - inset) / box;
    const base = top.map((c, i) => c + (bottom[i] - c) * t);
    const inGlyph = glyphCoverage((x - gOff) * gScale, (y - gOff - box * 0.02) * gScale, 1.9);
    return inGlyph ? [255, 255, 255, 255] : [...base, 255];
  }, 2);
}

const appIcon = (size = 1024) => png(size, appIconPixels(size));

/**
 * Sidebar image for the .pkg installer: the app icon in the bottom-left corner of a transparent
 * square, so it sits under the installer's step list in both light and dark mode.
 */
function installerBackground(size = 200, iconSize = 128) {
  const canvas = Buffer.alloc(size * size * 4);
  const iconPx = appIconPixels(iconSize);
  const ox = 30; const oy = size - iconSize - 26;
  for (let y = 0; y < iconSize; y++) iconPx.copy(canvas, ((oy + y) * size + ox) * 4, y * iconSize * 4, (y + 1) * iconSize * 4);
  return png(size, canvas);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'trayTemplate.png'), trayIcon(22));
fs.writeFileSync(path.join(OUT, 'trayTemplate@2x.png'), trayIcon(44));
fs.writeFileSync(path.join(OUT, 'icon.png'), appIcon(1024));
fs.mkdirSync(path.join(OUT, 'pkg'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'pkg', 'background.png'), installerBackground());
console.log('Icons written to', OUT);

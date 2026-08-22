#!/usr/bin/env node
// Draws the extension icon as a PNG.
//
// The Marketplace requires a raster icon of at least 128x128 and will not take
// an SVG, and there is no rasteriser in this toolchain. Rather than commit a
// binary nobody can regenerate, this draws it from the same palette everything
// else uses, supersampled for smooth edges.
//
//   node scripts/generate-icon.mjs

import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PALETTE = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'packages/glua-lsp/tools/palette.json'), 'utf8'),
);

const SIZE = 256; // Marketplace wants >=128; 256 looks better on retina listings
const SCALE = 4; // supersampling factor
const OUT = path.join(ROOT, 'packages/glua-lsp/resources/icon.png');

const hex = (value) => {
  const v = value.replace('#', '');
  return [
    Number.parseInt(v.slice(0, 2), 16),
    Number.parseInt(v.slice(2, 4), 16),
    Number.parseInt(v.slice(4, 6), 16),
  ];
};

const BACKGROUND = hex(PALETTE.accent);
const FOREGROUND = [255, 255, 255];

/* ------------------------------------------------------------- geometry */

const big = SIZE * SCALE;

/** Signed coverage test for a rounded rectangle. */
function insideRoundedRect(x, y, w, h, radius) {
  const dx = Math.max(radius - x, 0, x - (w - radius));
  const dy = Math.max(radius - y, 0, y - (h - radius));
  if (dx === 0 || dy === 0) return x >= 0 && y >= 0 && x <= w && y <= h;
  return dx * dx + dy * dy <= radius * radius;
}

const insideCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

// Same marks as the file icon and the docs favicon: a large disc and a small
// one, reading as a Lua-ish glyph without being a literal moon.
const shapes = (x, y) => {
  const u = (n) => (n / 32) * big; // coordinates in the original 32px design
  if (insideCircle(x, y, u(12.5), u(19.5), u(6.5))) return true;
  if (insideCircle(x, y, u(22), u(11.5), u(3.2))) return true;
  return false;
};

/* ---------------------------------------------------------------- raster */

const pixels = Buffer.alloc(SIZE * SIZE * 4);

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let bgHits = 0;
    let fgHits = 0;

    // Supersample this pixel to get antialiased edges.
    for (let sy = 0; sy < SCALE; sy++) {
      for (let sx = 0; sx < SCALE; sx++) {
        const px = x * SCALE + sx + 0.5;
        const py = y * SCALE + sy + 0.5;
        if (!insideRoundedRect(px, py, big, big, (7 / 32) * big)) continue;
        bgHits++;
        if (shapes(px, py)) fgHits++;
      }
    }

    const samples = SCALE * SCALE;
    const alpha = Math.round((bgHits / samples) * 255);
    const mix = bgHits === 0 ? 0 : fgHits / bgHits;

    const offset = (y * SIZE + x) * 4;
    for (let channel = 0; channel < 3; channel++) {
      pixels[offset + channel] = Math.round(
        BACKGROUND[channel] * (1 - mix) + FOREGROUND[channel] * mix,
      );
    }
    pixels[offset + 3] = alpha;
  }
}

/* ------------------------------------------------------------------ png */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

// Each scanline is prefixed with its filter type; 0 means none.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png);

console.log(`Wrote ${path.relative(ROOT, OUT)} — ${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KB`);

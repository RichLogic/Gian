#!/usr/bin/env node
/** Generate the ZCode plugin logo PNGs (225x225 RGBA, matching the sibling
 *  proxies' asset format) without any image dependency: a bold "Z" glyph on a
 *  rounded tile. Run once; outputs are committed binary assets. */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 225;
const RADIUS = 48;

function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(pixelData /* Uint8Array RGBA rows */) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y += 1) {
    const rowStart = y * (SIZE * 4 + 1);
    raw[rowStart] = 0; // no filter
    for (let x = 0; x < SIZE; x += 1) {
      const src = (y * SIZE + x) * 4;
      raw.copy ? null : null;
      for (let b = 0; b < 4; b += 1) raw[rowStart + 1 + x * 4 + b] = pixelData[src + b];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawTile(background, glyph) {
  const px = new Uint8Array(SIZE * SIZE * 4);
  const inTile = (x, y) => {
    const dx = Math.min(x, SIZE - 1 - x);
    const dy = Math.min(y, SIZE - 1 - y);
    if (dx >= RADIUS || dy >= RADIUS) return true;
    const ox = RADIUS - dx;
    const oy = RADIUS - dy;
    return ox * ox + oy * oy <= RADIUS * RADIUS;
  };
  const barThickness = 26;
  const insetX = 52;
  const topBar = y => y >= 46 && y <= 46 + barThickness;
  const bottomBar = y => y >= SIZE - 46 - barThickness && y <= SIZE - 46;
  const diagonal = (x, y) => {
    // Z diagonal: line from top-right of the glyph box to bottom-left.
    const t = (y - 46) / (SIZE - 92);
    const center = SIZE - insetX - t * (SIZE - insetX * 2);
    return Math.abs(x - center) <= barThickness / 2 + 2 && y > 46 && y < SIZE - 46;
  };
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const i = (y * SIZE + x) * 4;
      if (!inTile(x, y)) continue;
      const inGlyph = (topBar(y) || bottomBar(y) || diagonal(x, y))
        && x >= insetX && x <= SIZE - insetX;
      const color = inGlyph ? glyph : background;
      px[i] = color[0];
      px[i + 1] = color[1];
      px[i + 2] = color[2];
      px[i + 3] = 255;
    }
  }
  return px;
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'logo-light.png'), png(drawTile([244, 247, 251], [17, 24, 39])));
writeFileSync(join(outDir, 'logo-dark.png'), png(drawTile([17, 24, 39], [232, 238, 247])));
console.log('zcode logos written to', resolve(outDir));

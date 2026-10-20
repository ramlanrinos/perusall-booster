// Generates icons/icon-{16,32,48,128}.png (no image dependencies): a rounded deep-teal tile with an
// open book and a small clock. Run with `node scripts/make-icons.mjs`; output is committed.
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const TEAL = [31, 78, 95];      // #1f4e5f
const PAGE = [247, 243, 233];   // #f7f3e9
const GOLD = [214, 162, 76];    // #d6a24c
const SPINE = [20, 55, 68];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      // 4x supersampling for smooth edges
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const p = pixel((x + (sx + 0.5) / 4) / size, (y + (sy + 0.5) / 4) / size);
        if (p) { r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3]; }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? Math.round(r / a) : 0; raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0; raw[o + 3] = Math.round((a / 16) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// Shape in unit coordinates (0..1). Returns [r,g,b,alpha 0..1] or null.
function icon(u, v) {
  const rad = 0.2, inset = 0.02;
  const dx = Math.max(Math.abs(u - 0.5) - (0.5 - inset - rad), 0);
  const dy = Math.max(Math.abs(v - 0.5) - (0.5 - inset - rad), 0);
  if (dx * dx + dy * dy > rad * rad) return null;
  // clock (top-right)
  const cx = 0.7, cy = 0.3, cr = 0.17, d = Math.hypot(u - cx, v - cy);
  if (d < cr) {
    if (d > cr - 0.035) return [...GOLD, 1];
    const hand = (Math.abs(u - cx) < 0.02 && v < cy && v > cy - 0.11) || (Math.abs(v - cy) < 0.02 && u > cx && u < cx + 0.08);
    return hand ? [...GOLD, 1] : [...TEAL, 1];
  }
  // open book (bottom)
  const top = 0.5, bottom = 0.8, curve = 0.05 * Math.sin(Math.PI * Math.abs(u - 0.5) / 0.32);
  if (u > 0.18 && u < 0.82 && v > top - curve && v < bottom - curve * 0.6) {
    if (Math.abs(u - 0.5) < 0.018) return [...SPINE, 1];
    const lineRow = ((v - top + curve) / 0.07) % 1;
    const inText = Math.abs(u - 0.5) > 0.07 && Math.abs(u - 0.5) < 0.26 && v < bottom - 0.08 && lineRow < 0.28;
    return inText ? [...TEAL.map((c) => c + 60), 1] : [...PAGE, 1];
  }
  return [...TEAL, 1];
}

mkdirSync("icons", { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(`icons/icon-${size}.png`, png(size, icon));
console.warn("icons written");

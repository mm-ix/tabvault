// =====================================================================
// gen-icons.mjs —— 生成 TabVault 扩展图标（16/48/128 px）
// 零依赖：用 Node 内置 zlib 手写 PNG 编码，纯像素运算绘制。
// 图案：圆角方块底 + 三条白色圆角横条（"归档/列表"意象）。
// 用法：node tools/gen-icons.mjs
// =====================================================================
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'icons');
mkdirSync(outDir, { recursive: true });

/* ---------------- PNG 编码 ---------------- */
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 6;   // 颜色类型 RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 绘制 ---------------- */

/* 圆角矩形符号距离（像素中心到边界的有符号距离） */
function sdRoundBox(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
/* 像素覆盖率（≈0.5px 抗锯齿过渡带） */
const cov = (d) => clamp01(0.5 - d);

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const margin = size * 0.035;              // 底板外边距
  const half = size / 2 - margin;           // 底板半宽
  const radius = size * 0.22;               // 底板圆角
  const c = size / 2;

  // 三条横条：相对宽度 / 高度 / 间距（按尺寸微调，小尺寸加粗保证可读）
  const barFracs = [0.6, 0.42, 0.52];
  const barH = size <= 16 ? 2 : size <= 48 ? 5 : 13;
  const gap = size <= 16 ? 2 : size <= 48 ? 6 : 16;
  const inner = size - 2 * margin - size * 0.16;   // 条形活动区域宽度
  const blockH = 3 * barH + 2 * gap;               // 条形块总高
  const topY = c - blockH / 2 + barH / 2;          // 第一条中心

  // 底板渐变色（上→下）
  const rgbTop = [0x5b, 0x6c, 0xff];
  const rgbBot = [0x3a, 0x49, 0xe0];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx2 = x + 0.5;
      const cy2 = y + 0.5;
      const dBg = sdRoundBox(cx2, cy2, c, c, half, half, radius);
      const aBg = cov(dBg);
      if (aBg <= 0) continue;

      // 底板：垂直渐变
      const t = clamp01((cy2 - margin) / (2 * half));
      let r = rgbTop[0] + (rgbBot[0] - rgbTop[0]) * t;
      let g = rgbTop[1] + (rgbBot[1] - rgbTop[1]) * t;
      let b = rgbTop[2] + (rgbBot[2] - rgbTop[2]) * t;
      let a = aBg;

      // 白色横条（圆角胶囊形）
      for (let i = 0; i < 3; i++) {
        const by = topY + i * (barH + gap);
        const bw = (inner * barFracs[i]) / 2;
        const d = sdRoundBox(cx2, cy2, c, by, bw, barH / 2, barH / 2);
        const aBar = cov(d) * aBg;
        if (aBar > 0) {
          // 白条以 alpha 叠加在底板上
          r = 255 * aBar + r * (1 - aBar);
          g = 255 * aBar + g * (1 - aBar);
          b = 255 * aBar + b * (1 - aBar);
          a = Math.max(a, aBar);
        }
      }

      const idx = (y * size + x) * 4;
      px[idx] = Math.round(r);
      px[idx + 1] = Math.round(g);
      px[idx + 2] = Math.round(b);
      px[idx + 3] = Math.round(a * 255);
    }
  }
  return encodePNG(size, size, px);
}

for (const size of [16, 48, 128]) {
  const file = join(outDir, size + '.png');
  writeFileSync(file, drawIcon(size));
  console.log('已生成', file);
}

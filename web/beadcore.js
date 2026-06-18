// 拼豆核心算法（浏览器端）。对应 Python beadgen 的「保细节模式」：
// 主色降采样 → 背景剥离 → 逐格最近邻匹配(Lab ΔE) → ΔE 合并相近色 → 去杂点 → 最小色块合并。
import { PALETTE } from './palette.js';

const NAMES = Object.keys(PALETTE);

// ---- sRGB -> CIELab (D65) ----
function rgb2lab(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
  g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
  b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;
  let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  let y = (r * 0.2126 + g * 0.7152 + b * 0.0722);
  let z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const PAL_RGB = NAMES.map(n => PALETTE[n]);
const PAL_LAB = PAL_RGB.map(c => rgb2lab(c[0], c[1], c[2]));

function nearestBead(lab) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < PAL_LAB.length; i++) {
    const p = PAL_LAB[i];
    const d = (lab[0] - p[0]) ** 2 + (lab[1] - p[1]) ** 2 + (lab[2] - p[2]) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// 主色降采样：每格取出现最多的颜色（轻量化分箱后取众数），避免均值池化的灰边。
function downsampleDominant(srcCanvas, gw, gh) {
  const S = 3;                       // 每格采样 S×S 源块
  const tmp = document.createElement('canvas');
  tmp.width = gw * S; tmp.height = gh * S;
  const tctx = tmp.getContext('2d');
  tctx.imageSmoothingEnabled = false;
  tctx.drawImage(srcCanvas, 0, 0, tmp.width, tmp.height);
  const data = tctx.getImageData(0, 0, tmp.width, tmp.height).data;
  const cells = new Array(gw * gh);
  for (let cy = 0; cy < gh; cy++) {
    for (let cx = 0; cx < gw; cx++) {
      const bins = new Map();
      for (let dy = 0; dy < S; dy++) {
        for (let dx = 0; dx < S; dx++) {
          const px = (cx * S + dx), py = (cy * S + dy);
          const i = (py * tmp.width + px) * 4;
          const a = data[i + 3];
          const r = data[i], g = data[i + 1], b = data[i + 2];
          // 量化到 5 bit 分箱取众数，再累计真实和求均值
          const key = (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3);
          let o = bins.get(key);
          if (!o) { o = { n: 0, r: 0, g: 0, b: 0, a: 0 }; bins.set(key, o); }
          o.n++; o.r += r; o.g += g; o.b += b; o.a += a;
        }
      }
      let bestO = null;
      for (const o of bins.values()) if (!bestO || o.n > bestO.n) bestO = o;
      cells[cy * gw + cx] = {
        r: bestO.r / bestO.n, g: bestO.g / bestO.n,
        b: bestO.b / bestO.n, a: bestO.a / bestO.n,
      };
    }
  }
  return cells;
}

// 从四角洪水填充剥离近白/透明背景 → fg 布尔数组
function removeBackground(cells, gw, gh, thresh) {
  const bg = new Uint8Array(gw * gh);
  const isBgPix = i => {
    const c = cells[i];
    return c.a < 32 || (c.r + c.g + c.b) > thresh * 3;
  };
  const stack = [];
  const push = (x, y) => {
    const i = y * gw + x;
    if (x >= 0 && x < gw && y >= 0 && y < gh && !bg[i] && isBgPix(i)) {
      bg[i] = 1; stack.push(i);
    }
  };
  for (let x = 0; x < gw; x++) { push(x, 0); push(x, gh - 1); }
  for (let y = 0; y < gh; y++) { push(0, y); push(gw - 1, y); }
  while (stack.length) {
    const i = stack.pop(), x = i % gw, y = (i / gw) | 0;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  return bg;   // 1 = 背景
}

// 凝聚式合并相近色：把用量少的色号并入 Lab 最近的色号，直到 ≤ maxColors 且最近两色 ΔE > delta
function mergeSimilar(grid, maxColors, delta) {
  const remap = {};
  while (true) {
    const cnt = {};
    for (const v of grid) if (v >= 0) cnt[v] = (cnt[v] || 0) + 1;
    const used = Object.keys(cnt).map(Number);
    if (used.length <= 2) break;
    let bi = -1, bj = -1, bd = Infinity;
    for (let a = 0; a < used.length; a++) {
      for (let b = a + 1; b < used.length; b++) {
        const p = PAL_LAB[used[a]], q = PAL_LAB[used[b]];
        const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
        if (d < bd) { bd = d; bi = used[a]; bj = used[b]; }
      }
    }
    if (used.length <= maxColors && Math.sqrt(bd) > delta) break;
    const lose = cnt[bi] <= cnt[bj] ? bi : bj;
    const keep = lose === bi ? bj : bi;
    for (let i = 0; i < grid.length; i++) if (grid[i] === lose) grid[i] = keep;
  }
  return grid;
}

// 去孤立噪点：某格与周围多数不同则同化
function despeckle(grid, gw, gh) {
  const out = grid.slice();
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      if (grid[i] < 0) continue;
      const nb = {};
      let best = -1, bn = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const v = grid[ny * gw + nx];
          if (v < 0) continue;
          nb[v] = (nb[v] || 0) + 1;
          if (nb[v] > bn) { bn = nb[v]; best = v; }
        }
      if (best !== grid[i] && bn >= 5) out[i] = best;
    }
  }
  return out;
}

// 最小色块：用量 < minCells 的稀有色逐格并入邻居多数色
function consolidate(grid, gw, gh, minCells) {
  if (minCells <= 0) return grid;
  let out = grid.slice();
  for (let pass = 0; pass < 6; pass++) {
    const cnt = {};
    for (const v of out) if (v >= 0) cnt[v] = (cnt[v] || 0) + 1;
    const rare = new Set(Object.keys(cnt).filter(k => cnt[k] < minCells).map(Number));
    if (!rare.size) break;
    let changed = false;
    for (let y = 0; y < gh; y++)
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        if (out[i] < 0 || !rare.has(out[i])) continue;
        const nb = {}; let best = -1, bn = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
            const v = out[ny * gw + nx];
            if (v < 0 || rare.has(v)) continue;
            nb[v] = (nb[v] || 0) + 1;
            if (nb[v] > bn) { bn = nb[v]; best = v; }
          }
        if (best >= 0) { out[i] = best; changed = true; }
      }
    if (!changed) break;
  }
  return out;
}

function autocropCanvas(srcCanvas, thresh) {
  const ctx = srcCanvas.getContext('2d');
  const { width: W, height: H } = srcCanvas;
  const d = ctx.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = 0, y1 = 0, found = false;
  const step = Math.max(1, Math.floor(Math.min(W, H) / 400));
  for (let y = 0; y < H; y += step)
    for (let x = 0; x < W; x += step) {
      const i = (y * W + x) * 4;
      const fg = d[i + 3] > 32 && (d[i] + d[i + 1] + d[i + 2]) <= thresh * 3;
      if (fg) { found = true; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  if (!found) return srcCanvas;
  const pad = Math.floor(Math.max(W, H) * 0.02);
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(W, x1 + pad); y1 = Math.min(H, y1 + pad);
  const cw = x1 - x0, ch = y1 - y0;
  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  out.getContext('2d').drawImage(srcCanvas, x0, y0, cw, ch, 0, 0, cw, ch);
  return out;
}

// 主流程。srcCanvas: 输入图(已绘制)。返回 {grid, gw, gh, used, counts}
export function process(srcCanvas, opts = {}) {
  const o = Object.assign({
    gridW: 100, maxColors: 20, removeBg: true, bgThresh: 235,
    autocrop: true, minArea: 10, mergeDelta: 8, saturation: 1.15,
  }, opts);

  let canvas = srcCanvas;
  if (o.autocrop && o.removeBg) canvas = autocropCanvas(canvas, o.bgThresh);

  // 饱和度增强（可选）
  if (o.saturation !== 1.0) {
    const c2 = document.createElement('canvas');
    c2.width = canvas.width; c2.height = canvas.height;
    const cx = c2.getContext('2d');
    cx.filter = `saturate(${o.saturation})`;
    cx.drawImage(canvas, 0, 0);
    canvas = c2;
  }

  const gw = o.gridW;
  const gh = Math.max(1, Math.round(gw * canvas.height / canvas.width));
  const cells = downsampleDominant(canvas, gw, gh);
  const bg = o.removeBg ? removeBackground(cells, gw, gh, o.bgThresh)
                        : new Uint8Array(gw * gh);

  let grid = new Int32Array(gw * gh);
  for (let i = 0; i < cells.length; i++) {
    if (bg[i]) { grid[i] = -1; continue; }
    const c = cells[i];
    grid[i] = nearestBead(rgb2lab(c.r, c.g, c.b));
  }
  grid = mergeSimilar(grid, o.maxColors, o.mergeDelta);
  grid = despeckle(grid, gw, gh);
  grid = consolidate(grid, gw, gh, o.minArea);

  const counts = {};
  for (const v of grid) if (v >= 0) counts[v] = (counts[v] || 0) + 1;
  const used = Object.keys(counts).map(Number).sort((a, b) => counts[b] - counts[a]);
  return { grid, gw, gh, used, counts, names: NAMES, palette: PALETTE };
}

export function beadName(i) { return NAMES[i]; }
export function beadRGB(i) { return PAL_RGB[i]; }

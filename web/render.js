// 渲染：成品预览（紧凑圆豆白底）+ 带编号色号指导图。
import { beadRGB } from './beadcore.js';

function rgbStr(i) { const c = beadRGB(i); return `rgb(${c[0]|0},${c[1]|0},${c[2]|0})`; }

// 成品预览：紧凑圆豆 + 白底（锐利鲜亮）
export function renderPreview(res, cell = 12) {
  const { grid, gw, gh } = res;
  const cv = document.createElement('canvas');
  cv.width = gw * cell; cv.height = gh * cell;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  const pad = Math.max(0, cell * 0.04);
  for (let y = 0; y < gh; y++)
    for (let x = 0; x < gw; x++) {
      const b = grid[y * gw + x];
      if (b < 0) continue;
      ctx.fillStyle = rgbStr(b);
      ctx.beginPath();
      ctx.ellipse(x * cell + cell / 2, y * cell + cell / 2,
                  cell / 2 - pad, cell / 2 - pad, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  return cv;
}

// 带编号指导图：填色块 + 网格线 + 每格色号编号
export function renderGuide(res, cell = 22) {
  const { grid, gw, gh, used } = res;
  const bead2num = {};
  used.forEach((b, i) => bead2num[b] = i + 1);
  const cv = document.createElement('canvas');
  cv.width = gw * cell + 1; cv.height = gh * cell + 1;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#edeae0'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.font = `${Math.max(8, cell * 0.5) | 0}px Arial`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let y = 0; y < gh; y++)
    for (let x = 0; x < gw; x++) {
      const b = grid[y * gw + x];
      if (b < 0) continue;
      const c = beadRGB(b);
      ctx.fillStyle = rgbStr(b);
      ctx.fillRect(x * cell, y * cell, cell, cell);
      ctx.strokeStyle = '#c8c8c8'; ctx.lineWidth = 1;
      ctx.strokeRect(x * cell + 0.5, y * cell + 0.5, cell, cell);
      if (cell >= 14) {
        ctx.fillStyle = (c[0] + c[1] + c[2]) > 360 ? '#000' : '#fff';
        ctx.fillText(String(bead2num[b]), x * cell + cell / 2, y * cell + cell / 2 + 1);
      }
    }
  return { canvas: cv, bead2num };
}

import { process, beadName, beadRGB } from './beadcore.js';
import { renderPreview, renderGuide } from './render.js';
import { CONFIG } from './config.js';
import { initAnalytics, track } from './analytics.js';

const $ = s => document.querySelector(s);
const state = { srcCanvas: null, aiCanvas: null, preview: null, guide: null, bead2num: {}, res: null, view: 'preview', excluded: new Set(), editing: false, brush: null, curCell: 12, brand: 'MARD' };
$('#brand').onchange = () => { state.brand = $('#brand').value;
  if (state.res) { buildLegend(); buildBrushes(); track('change_brand', { brand: state.brand }); } };

// ---------- 初始化：埋点 + AI 模式 ----------
initAnalytics(); track('pageview');
(function initAI() {
  const mode = CONFIG.aiMode;
  if (mode === 'byok' || mode === 'enabled') $('#aiByok').hidden = false;
  else if (mode === 'disabled') {
    $('#aiDisabled').hidden = false;
    $('#aiDemoImg').src = CONFIG.aiDemo;
    const KEY = 'beadgo_ai_interest';
    const done = () => { $('#interestBtn').disabled = true;
      $('#interestBtn').textContent = '已收到你的期待 🙌';
      $('#interestCount').textContent = '感谢！攒够人气就开放 AI 转绘～'; };
    $('#interestBtn').onclick = () => { track('interest_ai'); localStorage.setItem(KEY, '1'); done(); };
    if (localStorage.getItem(KEY)) done();
  }
})();
const aiActive = () => CONFIG.aiMode !== 'disabled' && $('#useAI') && $('#useAI').checked;

// ---------- 上传 ----------
function setSource(img, ev) {
  const cap = 1400, sc = Math.min(1, cap / Math.max(img.width, img.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);   // 白底，兼容透明图
  ctx.drawImage(img, 0, 0, cv.width, cv.height);
  state.srcCanvas = cv; state.aiCanvas = null;
  $('#workspace').hidden = false;
  $('#workspace').scrollIntoView({ behavior: 'smooth' });
  track(ev || 'upload');
  generate();
}
function loadFile(file) {
  const img = new Image();
  img.onload = () => setSource(img, 'upload');
  img.src = URL.createObjectURL(file);
}
function loadFromUrl(url, ev) {
  const img = new Image();
  img.onload = () => setSource(img, ev || 'gallery');
  img.src = url;
}
$('#pickBtn').onclick = () => $('#file').click();
$('#file').onchange = e => e.target.files[0] && loadFile(e.target.files[0]);

// 新手灵感库
const GALLERY = [
  ['1F353', '草莓'], ['1F344', '蘑菇'], ['2764', '爱心'], ['2B50', '星星'],
  ['1F431', '猫'], ['1F33C', '小花'], ['1F47B', '幽灵'], ['1F308', '彩虹'],
  ['1F351', '桃子'], ['1F995', '恐龙'],
];
(function buildGallery() {
  const wrap = $('#gallery');
  GALLERY.forEach(([code, name]) => {
    const im = new Image(); im.src = `./assets/gallery/${code}.png`; im.alt = name; im.title = name;
    im.onclick = () => { track('gallery_pick', { name }); loadFromUrl(im.src, 'gallery'); };
    wrap.appendChild(im);
  });
})();
const drop = $('#drop');
['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag'); }));
drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) loadFile(f); });

// ---------- 滑块联动 ----------
const bind = (id, out, fn) => { const el = $('#' + id); const o = $('#' + out);
  el.oninput = () => { o.textContent = fn ? fn(el.value) : el.value; }; };
bind('gridW', 'gridOut'); bind('maxColors', 'mcOut'); bind('sat', 'satOut'); bind('minArea', 'maOut');
$('#useAI').onchange = () => { if ($('#useAI').checked) $('#aiBox').open = true; };

// 持久化 AI key
$('#aiKey').value = localStorage.getItem('or_key') || '';
$('#aiKey').oninput = () => localStorage.setItem('or_key', $('#aiKey').value.trim());

// ---------- AI 卡通化（浏览器直连 OpenRouter）----------
async function aiCartoonify(srcCanvas) {
  const key = $('#aiKey').value.trim();
  if (!key) throw new Error('请先在「AI 设置」里填入 OpenRouter API Key');
  const dataUrl = srcCanvas.toDataURL('image/jpeg', 0.92);
  const prompt = $('#aiPrompt').value.trim() ||
    "Redraw this pet/subject as a cute flat 2D cartoon sticker. Keep breed, colors, " +
    "markings and expression recognizable. Bold clean dark outlines, big clear eyes, " +
    "simplified flat color regions, no photographic texture, no gradients, pure white " +
    "background, centered. Chibi sticker style for pixel/perler bead art.";
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'bytedance-seed/seedream-4.5', modalities: ['image'],
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl } }] }],
    }),
  });
  if (!r.ok) throw new Error('OpenRouter ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  const url = j.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url) throw new Error('AI 未返回图片');
  return await new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => { const cv = document.createElement('canvas');
      cv.width = im.width; cv.height = im.height; cv.getContext('2d').drawImage(im, 0, 0); res(cv); };
    im.onerror = rej; im.src = url;
  });
}

// ---------- 生成 ----------
async function generate() {
  if (!state.srcCanvas) return;
  const status = $('#status');
  try {
    let bead = state.srcCanvas;
    if (aiActive()) {
      if (!state.aiCanvas) {
        status.textContent = '🎨 AI 卡通化中（约 20 秒）…';
        $('#genBtn').disabled = true;
        state.aiCanvas = await aiCartoonify(state.srcCanvas);
      }
      bead = state.aiCanvas;
    }
    status.textContent = '处理中…';
    await new Promise(r => setTimeout(r, 10));
    const res = process(bead, {
      gridW: +$('#gridW').value, maxColors: +$('#maxColors').value,
      saturation: +$('#sat').value, minArea: +$('#minArea').value,
      removeBg: $('#removeBg').checked, excluded: [...state.excluded],
    });
    state.res = res;
    state.preview = renderPreview(res, 12);
    const g = renderGuide(res, 22); state.guide = g.canvas; state.bead2num = g.bead2num;
    paint(); buildLegend(); buildBrushes(); status.textContent = '';
    track('generate', { grid: res.gw, colors: res.used.length, ai: aiActive() });
  } catch (e) {
    status.textContent = '❌ ' + e.message;
  } finally { $('#genBtn').disabled = false; }
}
$('#genBtn').onclick = () => { state.aiCanvas = null; generate(); };

// ---------- 视图切换 ----------
function paint() {
  const stage = $('#stage'); stage.innerHTML = '';
  let el;
  if (state.view === 'preview') el = state.preview;
  else if (state.view === 'guide') el = state.guide;
  else el = state.srcCanvas && (state.aiCanvas || state.srcCanvas);
  if (el) stage.appendChild(el);
  state.curCell = state.view === 'guide' ? 22 : state.view === 'preview' ? 12 : 0;
  const res = state.res;
  if (res) $('#meta').textContent = `网格 ${res.gw}×${res.gh} · ${res.used.length} 种色 · 共 ${Object.values(res.counts).reduce((a, b) => a + b, 0)} 颗`;
}
document.querySelectorAll('.tab[data-v]').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab[data-v]').forEach(x => x.classList.remove('active'));
  t.classList.add('active'); state.view = t.dataset.v; paint();
});

// ---------- 手动精修 ----------
function buildBrushes() {
  const wrap = $('#brushes'); wrap.innerHTML = '';
  (state.res?.used || []).forEach(b => {
    const c = beadRGB(b);
    const btn = document.createElement('button'); btn.className = 'brush';
    btn.style.background = `rgb(${c[0]|0},${c[1]|0},${c[2]|0})`;
    btn.title = beadName(b, state.brand);
    if (state.brush === b) btn.classList.add('sel');
    btn.onclick = () => { state.brush = b; markBrush(); };
    wrap.appendChild(btn);
  });
  markBrush();
}
function markBrush() {
  document.querySelectorAll('#brushes .brush').forEach((el, i) => {
    el.classList.toggle('sel', state.res.used[i] === state.brush);
  });
  $('#eraser').classList.toggle('sel', state.brush === -1);
}
$('#eraser').onclick = () => { state.brush = -1; markBrush(); };
$('#editToggle').onclick = () => {
  if (!state.res) return;
  state.editing = !state.editing;
  $('#editToggle').classList.toggle('on', state.editing);
  $('#brushbar').hidden = !state.editing;
  $('#stage').classList.toggle('editing', state.editing);
  if (state.editing) {
    if (state.brush === null) state.brush = state.res.used[0];
    if (state.view === 'src') { state.view = 'guide';
      document.querySelectorAll('.tab[data-v]').forEach(x => x.classList.toggle('active', x.dataset.v === 'guide')); paint(); }
    buildBrushes();
  }
};
// 点格子上色
function paintCell(e) {
  if (!state.editing || !state.curCell || state.brush === null) return;
  const cv = state.view === 'guide' ? state.guide : state.preview;
  if (!cv) return;
  const rect = cv.getBoundingClientRect();
  const cx = Math.floor((e.clientX - rect.left) * (cv.width / rect.width) / state.curCell);
  const cy = Math.floor((e.clientY - rect.top) * (cv.height / rect.height) / state.curCell);
  const { gw, gh, grid } = state.res;
  if (cx < 0 || cy < 0 || cx >= gw || cy >= gh) return;
  const idx = cy * gw + cx;
  if (grid[idx] === state.brush) return;
  grid[idx] = state.brush;
  refreshAfterEdit();
}
let painting = false;
$('#stage').addEventListener('pointerdown', e => { if (state.editing) { painting = true; paintCell(e); } });
$('#stage').addEventListener('pointermove', e => { if (painting) paintCell(e); });
window.addEventListener('pointerup', () => painting = false);

function refreshAfterEdit() {
  const res = state.res;
  res.counts = {};
  for (const v of res.grid) if (v >= 0) res.counts[v] = (res.counts[v] || 0) + 1;
  res.used = Object.keys(res.counts).map(Number).sort((a, b) => res.counts[b] - res.counts[a]);
  state.preview = renderPreview(res, 12);
  const g = renderGuide(res, 22); state.guide = g.canvas; state.bead2num = g.bead2num;
  paint(); buildLegend(); buildBrushes();
}

// ---------- 配料清单 ----------
function buildLegend() {
  const res = state.res, leg = $('#legend'); leg.innerHTML = '';
  const total = Object.values(res.counts).reduce((a, b) => a + b, 0);
  $('#sumTxt').textContent = `· 共 ${total} 颗 · ${res.used.length} 种色`;
  const swHTML = b => { const c = beadRGB(b);
    const tc = (c[0] + c[1] + c[2]) > 360 ? '#000' : '#fff';
    return `background:rgb(${c[0]|0},${c[1]|0},${c[2]|0});color:${tc}`; };
  res.used.forEach(b => {
    const d = document.createElement('div'); d.className = 'item';
    const sw = document.createElement('span'); sw.className = 'sw';
    sw.style.cssText = swHTML(b); sw.textContent = state.bead2num[b];
    const lbl = document.createElement('span'); lbl.textContent = `${beadName(b, state.brand)} × ${res.counts[b]}`;
    const x = document.createElement('button'); x.className = 'xbtn'; x.textContent = '✕';
    x.title = '排除这个颜色'; x.onclick = () => { state.excluded.add(b); generate(); };
    d.append(sw, lbl, x); leg.appendChild(d);
  });
  // 已排除区
  const ex = $('#excluded'); ex.innerHTML = '';
  $('#excludedWrap').hidden = state.excluded.size === 0;
  [...state.excluded].forEach(b => {
    const d = document.createElement('div'); d.className = 'item';
    const sw = document.createElement('span'); sw.className = 'sw'; sw.style.cssText = swHTML(b); sw.textContent = '✕';
    const lbl = document.createElement('span'); lbl.textContent = beadName(b, state.brand) + ' （恢复）';
    d.append(sw, lbl); d.style.cursor = 'pointer'; d.style.opacity = '.6';
    d.onclick = () => { state.excluded.delete(b); generate(); };
    ex.appendChild(d);
  });
}

// 配料清单导出为图片
function legendCanvas() {
  const res = state.res, W = 900, rowH = 38, cols = 3;
  const per = Math.ceil(res.used.length / cols);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = 70 + per * rowH;
  const x = cv.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, cv.width, cv.height);
  x.fillStyle = '#3a3531'; x.font = 'bold 24px Arial';
  const total = Object.values(res.counts).reduce((a, b) => a + b, 0);
  x.fillText(`配料清单  ·  共 ${total} 颗  ·  ${res.used.length} 种色`, 20, 36);
  x.font = '18px Arial';
  res.used.forEach((b, i) => {
    const c = beadRGB(b), col = (i / per) | 0, row = i % per;
    const px = 20 + col * (W - 40) / cols, py = 60 + row * rowH;
    x.fillStyle = `rgb(${c[0]|0},${c[1]|0},${c[2]|0})`; x.fillRect(px, py, 26, 26);
    x.strokeStyle = '#0003'; x.strokeRect(px + .5, py + .5, 26, 26);
    x.fillStyle = (c[0] + c[1] + c[2]) > 360 ? '#000' : '#fff';
    x.fillText(String(state.bead2num[b]), px + 6, py + 20);
    x.fillStyle = '#3a3531'; x.fillText(`${beadName(b, state.brand)} × ${res.counts[b]}`, px + 36, py + 20);
  });
  return cv;
}

const save = (cv, name) => { const a = document.createElement('a');
  a.download = name; a.href = cv.toDataURL('image/png'); a.click(); };
$('#dlPreview').onclick = () => { if (state.preview) { save(state.preview, '拼豆成品预览.png'); track('download', { t: 'preview' }); } };
$('#dlGuide').onclick = () => { if (state.guide) { save(state.guide, '拼豆色号指导图.png'); track('download', { t: 'guide' }); } };
$('#dlList').onclick = () => { if (state.res) { save(legendCanvas(), '拼豆配料清单.png'); track('download', { t: 'list' }); } };
$('#printBtn').onclick = () => {
  if (!state.res) return;
  track('print');
  const guideUrl = state.guide.toDataURL('image/png');
  const listUrl = legendCanvas().toDataURL('image/png');
  const w = window.open('', '_blank');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>拼豆图纸</title>
    <style>@page{margin:10mm}body{font-family:sans-serif;text-align:center;margin:0;padding:10px}
    h2{font-size:16px}img{max-width:100%;page-break-inside:avoid}
    .p{page-break-after:always}</style></head><body>
    <div class="p"><h2>色号指导图（照此放豆）</h2><img src="${guideUrl}"></div>
    <div><h2>配料清单（按色号买豆）</h2><img src="${listUrl}"></div>
    <script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script>
    </body></html>`);
  w.document.close();
};

// ---------- 晒图卡（小红书友好，带水印）----------
function shareCardCanvas() {
  const prev = state.preview, res = state.res;
  const W = 760, pad = 44, headH = 116, footH = 84;
  const pw = W - 2 * pad, ph = Math.round(prev.height * (pw / prev.width));
  const cv = document.createElement('canvas'); cv.width = W; cv.height = headH + ph + footH;
  const x = cv.getContext('2d');
  x.fillStyle = '#ffd000'; x.fillRect(0, 0, W, cv.height);
  x.fillStyle = '#1c1a26'; x.textAlign = 'center';
  x.font = '900 34px -apple-system,sans-serif';
  x.fillText('我用豆豆铺拼的！🧩', W / 2, 54);
  const total = Object.values(res.counts).reduce((a, b) => a + b, 0);
  x.font = '700 18px -apple-system,sans-serif';
  x.fillText(`${res.gw}×${res.gh} 格 · ${res.used.length} 种色 · ${total} 颗`, W / 2, 88);
  x.fillStyle = '#fff'; x.fillRect(pad - 6, headH - 6, pw + 12, ph + 12);
  x.drawImage(prev, pad, headH, pw, ph);
  x.strokeStyle = '#1c1a26'; x.lineWidth = 5; x.strokeRect(pad - 6, headH - 6, pw + 12, ph + 12);
  x.fillStyle = '#1c1a26'; x.font = '900 23px -apple-system,sans-serif';
  x.fillText('豆豆铺 BEADGO · 拍张照，一键变拼豆', W / 2, headH + ph + 48);
  return cv;
}
$('#shareBtn').onclick = () => { if (state.res) { track('share_card'); save(shareCardCanvas(), '豆豆铺晒图卡.png'); } };

// ---------- 大图分块（按拼豆板尺寸切片，逐块打印拼接）----------
function renderTile(x0, y0, B, cell) {
  const { grid, gw, gh } = state.res;
  const w = Math.min(B, gw - x0), h = Math.min(B, gh - y0);
  const cv = document.createElement('canvas'); cv.width = w * cell + 1; cv.height = h * cell + 1;
  const x = cv.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, cv.width, cv.height);
  x.font = `${(cell * 0.5) | 0}px Arial`; x.textAlign = 'center'; x.textBaseline = 'middle';
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const b = grid[(y0 + j) * gw + (x0 + i)];
    const px = i * cell, py = j * cell;
    if (b >= 0) {
      const c = beadRGB(b);
      x.fillStyle = `rgb(${c[0]|0},${c[1]|0},${c[2]|0})`; x.fillRect(px, py, cell, cell);
      x.fillStyle = (c[0] + c[1] + c[2]) > 360 ? '#000' : '#fff';
      x.fillText(String(state.bead2num[b]), px + cell / 2, py + cell / 2 + 1);
    }
    x.strokeStyle = '#ccc'; x.lineWidth = 1; x.strokeRect(px + .5, py + .5, cell, cell);
  }
  // 每 5 格加粗线，便于数格
  x.strokeStyle = '#1c1a26'; x.lineWidth = 2;
  for (let i = 0; i <= w; i += 5) { x.beginPath(); x.moveTo(i * cell + .5, 0); x.lineTo(i * cell + .5, h * cell); x.stroke(); }
  for (let j = 0; j <= h; j += 5) { x.beginPath(); x.moveTo(0, j * cell + .5); x.lineTo(w * cell, j * cell + .5); x.stroke(); }
  return cv;
}
$('#tileBtn').onclick = () => {
  if (!state.res) return;
  const B = +$('#boardSize').value;
  const { gw, gh } = state.res;
  const cols = Math.ceil(gw / B), rows = Math.ceil(gh / B);
  track('tile_print', { board: B, tiles: cols * rows });
  const overview = state.preview.toDataURL('image/png');
  let pages = `<div class="p"><h2>总览（共 ${cols}×${rows}=${cols * rows} 块 · 每块 ${B}×${B}）</h2>
    <img src="${overview}" style="max-width:80%"><p>按「行R-列C」顺序拼，拼完拼接起来即可。</p></div>`;
  for (let ry = 0; ry < rows; ry++) for (let cx = 0; cx < cols; cx++) {
    const url = renderTile(cx * B, ry * B, B, 30).toDataURL('image/png');
    pages += `<div class="p"><h2>第 ${ry + 1} 行 · 第 ${cx + 1} 列</h2><img src="${url}"></div>`;
  }
  const w = window.open('', '_blank');
  w.document.write(`<!doctype html><meta charset="utf-8"><title>大图分块图纸</title>
    <style>@page{margin:8mm}body{font-family:sans-serif;text-align:center;margin:0}
    h2{font-size:15px;margin:6px}img{max-width:100%;page-break-inside:avoid}.p{page-break-after:always}</style>
    ${pages}<script>window.onload=()=>setTimeout(()=>window.print(),400)<\/script>`);
  w.document.close();
};

// ---------- 打赏 ----------
$('#tipBtn').onclick = () => { $('#tipModal').hidden = false; track('open_tip'); };
$('#tipClose').onclick = () => $('#tipModal').hidden = true;
$('#tipModal').onclick = e => { if (e.target.id === 'tipModal') $('#tipModal').hidden = true; };
// 若放了收款码图片 web/assets/tip.png 自动显示
(() => { const im = new Image(); im.onload = () => { $('#qrSlot').innerHTML = ''; $('#qrSlot').appendChild(im); };
  im.src = './assets/tip.png'; })();
$('#aboutLink').onclick = e => { e.preventDefault(); alert('豆豆铺 BEADGO：上传图片→拼豆图纸。图片在你浏览器本地处理不上传；AI 卡通化会调用 OpenRouter。开源 MIT。'); };

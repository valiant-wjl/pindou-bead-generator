import { process, beadName, beadRGB } from './beadcore.js';
import { renderPreview, renderGuide } from './render.js';

const $ = s => document.querySelector(s);
const state = { srcCanvas: null, aiCanvas: null, preview: null, guide: null, bead2num: {}, res: null, view: 'preview', excluded: new Set(), editing: false, brush: null, curCell: 12, brand: 'MARD' };
$('#brand').onchange = () => { state.brand = $('#brand').value;
  if (state.res) { buildLegend(); buildBrushes(); } };

// ---------- 上传 ----------
function loadFile(file) {
  const img = new Image();
  img.onload = () => {
    const cap = 1400, sc = Math.min(1, cap / Math.max(img.width, img.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    state.srcCanvas = cv; state.aiCanvas = null;
    $('#workspace').hidden = false;
    $('#workspace').scrollIntoView({ behavior: 'smooth' });
    generate();
  };
  img.src = URL.createObjectURL(file);
}
$('#pickBtn').onclick = () => $('#file').click();
$('#file').onchange = e => e.target.files[0] && loadFile(e.target.files[0]);
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
    if ($('#useAI').checked) {
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
$('#dlPreview').onclick = () => state.preview && save(state.preview, '拼豆成品预览.png');
$('#dlGuide').onclick = () => state.guide && save(state.guide, '拼豆色号指导图.png');
$('#dlList').onclick = () => state.res && save(legendCanvas(), '拼豆配料清单.png');
$('#printBtn').onclick = () => {
  if (!state.res) return;
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

// ---------- 打赏 ----------
$('#tipBtn').onclick = () => $('#tipModal').hidden = false;
$('#tipClose').onclick = () => $('#tipModal').hidden = true;
$('#tipModal').onclick = e => { if (e.target.id === 'tipModal') $('#tipModal').hidden = true; };
// 若放了收款码图片 web/assets/tip.png 自动显示
(() => { const im = new Image(); im.onload = () => { $('#qrSlot').innerHTML = ''; $('#qrSlot').appendChild(im); };
  im.src = './assets/tip.png'; })();
$('#aboutLink').onclick = e => { e.preventDefault(); alert('豆豆铺 BEADGO：上传图片→拼豆图纸。图片在你浏览器本地处理不上传；AI 卡通化会调用 OpenRouter。开源 MIT。'); };

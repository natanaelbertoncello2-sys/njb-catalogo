// Pantalla «Medidas reales»: muestra la foto con cada objeto medido, regla libre,
// esquinas manuales de la referencia y exportación de la foto con las medidas dibujadas.
import { $, toast, dialog, actionSheet } from './ui.js';
import { makeCanvas, canvasToBlob } from './process.js';

export const MEASURE_REFS = {
  A4: { label: 'Hoja A4', long: 297, short: 210, sheet: true },
  CARTA: { label: 'Hoja Carta', long: 279.4, short: 215.9, sheet: true },
  OFICIO: { label: 'Hoja Oficio', long: 355.6, short: 215.9, sheet: true },
  TARJETA: { label: 'Tarjeta (DNI / crédito)', long: 85.6, short: 53.98, sheet: false },
};
const WORK_SIDE = 1800;
const EXPORT_SIDE = 3000; // lado mayor de la foto guardada con medidas
const COLORS = ['#2ec4d6', '#ffd84d', '#ff6fa8', '#9be15d', '#ff9f43', '#b48cff', '#5cc8ff', '#ff5d6c'];

/* ---------- worker ---------- */

let worker = null;
let seq = 0;
const jobs = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker('js/measure-worker.js');
  worker.onmessage = (ev) => {
    const { id, result, error } = ev.data;
    const job = jobs.get(id);
    if (!job) return;
    jobs.delete(id);
    if (error) job.reject(new Error(error)); else job.resolve(result);
  };
  worker.onerror = (ev) => {
    const err = new Error(ev.message || 'Falló el motor de medición');
    for (const j of jobs.values()) j.reject(err);
    jobs.clear();
    worker.terminate();
    worker = null;
  };
  return worker;
}
// Empieza a descargar el motor apenas se activa el modo, así la primera medición no espera.
export function warmMeasure() { getWorker().postMessage({ warm: true }); }
function runWorker(image, ref, quad) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    jobs.set(id, { resolve, reject });
    getWorker().postMessage({ id, image, ref, quad }, [image.data.buffer]);
  });
}

/* ---------- geometría ---------- */

function homography(src, dst) {
  const a = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u], [0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    const d = a[c][c];
    for (let k = c; k < 9; k++) a[c][k] /= d;
    for (let r = 0; r < 8; r++) if (r !== c) { const f = a[r][c]; for (let k = c; k < 9; k++) a[r][k] -= f * a[c][k]; }
  }
  return [...a.map((r) => r[8]), 1];
}
const applyH = (h, [x, y]) => { const w = h[6] * x + h[7] * y + h[8]; return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function pointInPoly([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[j];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

/* ---------- formato ---------- */

const num = (v, d) => v.toFixed(d).replace('.', ',');
const UNITS = { cm: (mm) => [num(mm / 10, 1), 'cm'], mm: (mm) => [num(mm, 0), 'mm'], in: (mm) => [num(mm / 25.4, 2), 'in'] };
const fmtLen = (mm, u) => UNITS[u](mm).join(' ');
function fmtObj(o, u) {
  if (o.round) return 'Ø ' + fmtLen((o.length + o.width) / 2, u);
  const [w] = UNITS[u](o.width), [l, unit] = UNITS[u](o.length);
  return `${w} × ${l} ${unit}`;
}
const refSize = (r) => `${num(r.short / 10, 1)} × ${num(r.long / 10, 1)} cm`;

/* ---------- estado y apertura ---------- */

const st = {
  img: null, w: 0, h: 0, ref: 'A4', result: null, busy: false, unit: 'cm',
  hidden: new Set(), ruler: false, ra: null, rb: null, manual: null, drag: null,
  opts: null, layout: null, src: null,
};

// opts: { blob, ref, name, onRef(key), prepareSave() → nombre|null, onSave(blob, w, h, nombre), onAdd(blob, w, h), onClose() }
export async function openMeasure(opts) {
  bindOnce();
  st.opts = opts;
  st.ref = MEASURE_REFS[opts.ref] ? opts.ref : 'A4';
  st.src?.close?.();
  Object.assign(st, { result: null, img: null, src: null, view: null, busy: true, hidden: new Set(), ruler: false, ra: null, rb: null, manual: null, drag: null });
  $('#msBusy').classList.remove('hidden');
  $('#msBusyText').textContent = 'Abriendo foto…';
  $('#msCanvas').getContext('2d').clearRect(0, 0, $('#msCanvas').width, $('#msCanvas').height);
  renderPanel();
  const bmp = await createImageBitmap(opts.blob);
  const s = Math.min(1, WORK_SIDE / Math.max(bmp.width, bmp.height));
  st.w = Math.round(bmp.width * s);
  st.h = Math.round(bmp.height * s);
  st.img = makeCanvas(st.w, st.h);
  st.img.getContext('2d').drawImage(bmp, 0, 0, st.w, st.h);
  st.src = bmp; // la original, para guardar en alta resolución
  renderPanel();
  draw();
  run();
}

async function run(quad) {
  st.busy = true;
  $('#msBusy').classList.remove('hidden');
  $('#msBusyText').textContent = 'Midiendo…';
  const slow = setTimeout(() => { $('#msBusyText').textContent = 'Preparando el motor de medición (solo la primera vez)…'; }, 2500);
  renderPanel();
  try {
    const image = st.img.getContext('2d').getImageData(0, 0, st.w, st.h);
    const r = await runWorker(image, st.ref, quad || undefined);
    st.result = r;
    st.hidden.clear();
    st.ra = st.rb = null;
    st.manual = r.quad ? null : defaultQuad();
  } catch (err) {
    st.result = { w: st.w, h: st.h, error: err.message, objects: [] };
    st.manual = defaultQuad();
  } finally {
    clearTimeout(slow);
    st.busy = false;
    $('#msBusy').classList.add('hidden');
    renderPanel();
    draw();
  }
}

const defaultQuad = () => [[st.w * 0.2, st.h * 0.2], [st.w * 0.8, st.h * 0.2], [st.w * 0.8, st.h * 0.8], [st.w * 0.2, st.h * 0.8]];

/* ---------- dibujo ---------- */

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}

function pill(ctx, x, y, text, color, u, size = 13) {
  ctx.font = `800 ${size * u}px -apple-system, "Segoe UI", Roboto, sans-serif`;
  const tw = ctx.measureText(text).width, ph = size * u * 1.55, pw = tw + 14 * u;
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  rrect(ctx, x - pw / 2, y - ph / 2 + 1.5 * u, pw, ph, 8 * u); ctx.fill();
  ctx.fillStyle = color;
  rrect(ctx, x - pw / 2, y - ph / 2, pw, ph, 8 * u); ctx.fill();
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5 * u);
}

function poly(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

// Dibuja en coordenadas de imagen. u = px de imagen por «punto» de interfaz.
function drawOverlay(ctx, u, { forExport = false } = {}) {
  const r = st.result;
  const quad = st.manual || r?.quad;
  if (quad) {
    poly(ctx, quad);
    ctx.fillStyle = st.manual ? 'rgba(53,208,127,.15)' : 'rgba(53,208,127,.07)';
    ctx.fill();
    ctx.strokeStyle = '#35d07f'; ctx.lineWidth = 2 * u; ctx.stroke();
    if (st.manual) {
      for (const [x, y] of quad) {
        ctx.fillStyle = 'rgba(53,208,127,.35)'; ctx.beginPath(); ctx.arc(x, y, 16 * u, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 4 * u, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
  if (!st.manual && r?.objects) {
    r.objects.forEach((o, i) => {
      const color = COLORS[i % COLORS.length];
      if (st.hidden.has(i)) {
        if (forExport) return;
        poly(ctx, o.box); ctx.strokeStyle = 'rgba(255,255,255,.3)'; ctx.lineWidth = 1 * u; ctx.stroke();
        return;
      }
      poly(ctx, o.outline);
      ctx.fillStyle = color + '1f'; ctx.fill();
      ctx.strokeStyle = color; ctx.lineWidth = 2.5 * u; ctx.lineJoin = 'round'; ctx.stroke();
      if (!o.round) { poly(ctx, o.box); ctx.strokeStyle = color + '99'; ctx.lineWidth = 1.2 * u; ctx.stroke(); }
      pill(ctx, o.center[0], o.center[1], `${i + 1}  ${fmtObj(o, st.unit)}${o.partial ? '  ⚠' : ''}`, color, u);
    });
  }
  if (st.ruler && st.ra && !st.manual) {
    ctx.lineCap = 'round';
    if (st.rb) {
      ctx.beginPath(); ctx.moveTo(...st.ra); ctx.lineTo(...st.rb);
      ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 5 * u; ctx.stroke();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5 * u; ctx.stroke();
    }
    for (const p of [st.ra, st.rb].filter(Boolean)) {
      ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.beginPath(); ctx.arc(p[0], p[1], 7 * u, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(p[0], p[1], 5 * u, 0, Math.PI * 2); ctx.fill();
    }
    const mm = rulerMm();
    if (mm != null) pill(ctx, (st.ra[0] + st.rb[0]) / 2, (st.ra[1] + st.rb[1]) / 2 - 18 * u, fmtLen(mm, st.unit), '#fff', u, 15);
  }
}

const rulerMm = () => (st.ra && st.rb && st.result?.toMm ? dist(applyH(st.result.toMm, st.ra), applyH(st.result.toMm, st.rb)) : null);

function draw() {
  const c = $('#msCanvas');
  if (!st.img || !c.clientWidth) return;
  const dpr = devicePixelRatio || 1;
  c.width = c.clientWidth * dpr;
  c.height = c.clientHeight * dpr;
  const W = c.clientWidth, H = c.clientHeight;
  // Vista: zoom (z) y desplazamiento (x, y) sobre la foto ajustada a la pantalla (s0).
  const s0 = Math.min(W / st.w, H / st.h);
  if (!st.view || st.view.W !== W || st.view.H !== H) st.view = { W, H, s0, z: 1, x: (W - st.w * s0) / 2, y: (H - st.h * s0) / 2 };
  const v = st.view;
  const s = s0 * v.z;
  const L = { s, x: v.x, y: v.y };
  st.layout = L;
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.translate(L.x, L.y);
  ctx.scale(s, s);
  // Con zoom se dibuja la foto original para ver el detalle de verdad.
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(v.z > 1.05 && st.src ? st.src : st.img, 0, 0, st.w, st.h);
  drawOverlay(ctx, 1 / s);
  if (st.drag?.screen) drawLoupe();
  const zb = $('#msZoom');
  zb.classList.toggle('hidden', v.z < 1.05);
  zb.textContent = `${num(v.z, 1)}× · ver todo`;
}

const MAX_ZOOM = 8;
function clampView() {
  const v = st.view;
  const iw = st.w * v.s0 * v.z, ih = st.h * v.s0 * v.z;
  v.x = iw <= v.W ? (v.W - iw) / 2 : Math.min(0, Math.max(v.W - iw, v.x));
  v.y = ih <= v.H ? (v.H - ih) / 2 : Math.min(0, Math.max(v.H - ih, v.y));
}
// Zoom manteniendo fijo el punto de la foto que está bajo (sx, sy) en pantalla.
function zoomAt(sx, sy, z, from = st.view) {
  const v = st.view;
  const ix = (sx - from.x) / (v.s0 * from.z), iy = (sy - from.y) / (v.s0 * from.z);
  v.z = Math.min(MAX_ZOOM, Math.max(1, z));
  v.x = sx - ix * v.s0 * v.z;
  v.y = sy - iy * v.s0 * v.z;
  clampView();
}
function resetZoom() {
  if (!st.view) return;
  st.view.z = 1;
  clampView();
  draw();
}

// Lupa sobre el dedo para ubicar esquinas y puntas con precisión.
function drawLoupe() {
  const lp = $('#msLoupe');
  const { screen, img } = st.drag;
  const size = 120, zoom = 2.5;
  lp.style.left = screen[0] - size / 2 + 'px';
  lp.style.top = Math.max(0, screen[1] - size - 50) + 'px';
  lp.classList.remove('hidden');
  const ctx = lp.getContext('2d');
  const k = lp.width / size; // resolución del canvas de la lupa
  const s = st.layout.s * zoom * k;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, lp.width, lp.height);
  ctx.setTransform(s, 0, 0, s, lp.width / 2 - img[0] * s, lp.height / 2 - img[1] * s);
  ctx.drawImage(st.img, 0, 0);
  drawOverlay(ctx, 1 / (st.layout.s * zoom));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = '#35d07f'; ctx.lineWidth = 2 * k;
  ctx.beginPath();
  ctx.moveTo(lp.width / 2 - 10 * k, lp.height / 2); ctx.lineTo(lp.width / 2 + 10 * k, lp.height / 2);
  ctx.moveTo(lp.width / 2, lp.height / 2 - 10 * k); ctx.lineTo(lp.width / 2, lp.height / 2 + 10 * k);
  ctx.stroke();
}

/* ---------- panel ---------- */

function renderPanel() {
  const r = st.result;
  const ref = MEASURE_REFS[st.ref];
  $('#msRef').textContent = ref.sheet ? ref.label.replace('Hoja ', '') : 'Tarjeta';
  const status = $('#msStatus');
  status.className = 'ms-status';
  if (st.busy || !r) status.textContent = '';
  else if (st.manual) {
    status.classList.add('warn');
    status.textContent = (r.error ? r.error + ' ' : '') + `Arrastrá los 4 puntos verdes a las esquinas de la ${ref.label.replace(/^\S+/, (s) => s.toLowerCase())}.`;
  } else if (r.error) {
    status.classList.add('warn');
    status.textContent = r.error;
  } else {
    const used = MEASURE_REFS[r.ref];
    status.classList.add('ok');
    status.textContent = `${r.ref !== st.ref ? 'No vi la hoja: usé la ' : 'Referencia: '}${used.label.replace(/^\S+/, (s) => s.toLowerCase())} (${refSize(used)}) · ${r.objects.length} objeto(s). Tocá uno para ocultarlo; pellizcá o tocá dos veces para hacer zoom.`;
  }

  const chips = $('#msChips');
  chips.innerHTML = '';
  if (r && !st.manual) {
    r.objects.forEach((o, i) => {
      const b = document.createElement('button');
      b.className = 'ms-chip' + (st.hidden.has(i) ? ' off' : '');
      b.style.setProperty('--c', COLORS[i % COLORS.length]);
      b.textContent = `${i + 1}  ${fmtObj(o, st.unit)}${o.partial ? ' ⚠' : ''}`;
      b.onclick = () => toggleHidden(i);
      chips.append(b);
    });
  }
  chips.classList.toggle('hidden', !chips.childElementCount);

  const rl = $('#msRuler');
  rl.classList.toggle('hidden', !st.ruler || !!st.manual || !r?.toMm);
  const mm = rulerMm();
  rl.textContent = mm != null ? `Regla: ${fmtLen(mm, st.unit)}` : 'Regla: tocá o arrastrá entre dos puntos de la foto';

  $('#msActions').classList.toggle('hidden', !!st.manual);
  $('#msSaveRow').classList.toggle('hidden', !!st.manual);
  $('#msSave').disabled = $('#msShare').disabled = st.busy || !r?.quad;
  $('#msManual').classList.toggle('hidden', !st.manual);
  $('#msManualCancel').classList.toggle('hidden', !r?.quad);
  const act = (k) => $(`#msActions [data-a="${k}"]`);
  act('ruler').disabled = !r?.toMm;
  act('ruler').classList.toggle('on', st.ruler);
  act('unit').querySelector('span').textContent = st.unit === 'in' ? 'Pulgadas' : st.unit;
  act('copy').disabled = !r?.objects?.length && mm == null;
  act('tray').disabled = st.busy || !r?.quad;
  $('#msManualGo').disabled = st.busy;
}

function toggleHidden(i) {
  if (st.hidden.has(i)) st.hidden.delete(i); else st.hidden.add(i);
  renderPanel();
  draw();
}

function summary() {
  const r = st.result;
  const lines = [`Medidas reales (referencia: ${MEASURE_REFS[r.ref].label.replace(/^\S+/, (s) => s.toLowerCase())})`];
  r.objects.forEach((o, i) => { if (!st.hidden.has(i)) lines.push(`${i + 1}) ${fmtObj(o, st.unit)}${o.partial ? ' (puede estar cortado)' : ''}`); });
  const mm = rulerMm();
  if (mm != null) lines.push(`Regla: ${fmtLen(mm, st.unit)}`);
  return lines.join('\n');
}

async function copySummary() {
  const text = summary();
  try { await navigator.clipboard.writeText(text); toast('Medidas copiadas', { type: 'ok' }); }
  catch { await dialog({ title: 'Medidas', text, okLabel: 'Cerrar', noCancel: true }); }
}

// Foto en alta resolución con las medidas dibujadas y, abajo, una franja con la lista de medidas.
async function exportAnnotated() {
  const k = Math.min(EXPORT_SIDE, Math.max(st.src.width, st.src.height)) / Math.max(st.w, st.h);
  const W = Math.round(st.w * k), H = Math.round(st.h * k);
  const r = st.result;
  const items = r.objects.map((o, i) => ({ o, i })).filter(({ i }) => !st.hidden.has(i))
    .map(({ o, i }) => ({ color: COLORS[i % COLORS.length], text: `${i + 1}  ${fmtObj(o, st.unit)}${o.partial ? ' (cortado)' : ''}` }));
  const mm = st.ruler ? rulerMm() : null;
  if (mm != null) items.push({ color: '#ffffff', text: `Regla  ${fmtLen(mm, st.unit)}` });

  // Diseño de la franja: «pastillas» que pasan a la línea siguiente si no entran.
  const F = Math.max(16, Math.round(W / 34)), pad = Math.round(F * 0.9), gap = Math.round(F * 0.6), ph = Math.round(F * 1.9);
  const font = (wt, f) => `${wt} ${f}px -apple-system, "Segoe UI", Roboto, sans-serif`;
  const probe = makeCanvas(1, 1).getContext('2d');
  probe.font = font(800, F);
  const rows = [[]];
  let x = pad;
  for (const it of items) {
    it.w = probe.measureText(it.text).width + F * 1.4;
    if (x + it.w > W - pad && rows[rows.length - 1].length) { rows.push([]); x = pad; }
    rows[rows.length - 1].push({ ...it, x });
    x += it.w + gap;
  }
  const titleH = Math.round(F * 1.6);
  const band = items.length ? pad + titleH + rows.length * ph + (rows.length - 1) * gap + pad : 0;

  const c = makeCanvas(W, H + band);
  const ctx = c.getContext('2d');
  ctx.drawImage(st.src, 0, 0, W, H);
  ctx.save();
  ctx.scale(k, k);
  drawOverlay(ctx, Math.max(st.w, st.h) / 520, { forExport: true });
  ctx.restore();
  if (band) {
    ctx.fillStyle = '#0a0e17';
    ctx.fillRect(0, H, W, band);
    ctx.fillStyle = '#8a96ab';
    ctx.font = font(700, Math.round(F * 0.8));
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const ref = MEASURE_REFS[r.ref];
    ctx.fillText(`MEDIDAS REALES · referencia: ${ref.label.replace(/^\S+/, (s) => s.toLowerCase())}${st.opts.name ? ' · ' + st.opts.name : ''}`, pad, H + pad + titleH / 2 - F * 0.2);
    ctx.font = font(800, F);
    rows.forEach((row, ri) => {
      const y = H + pad + titleH + ri * (ph + gap);
      for (const it of row) {
        ctx.fillStyle = it.color;
        rrect(ctx, it.x, y, it.w, ph, ph / 2); ctx.fill();
        ctx.fillStyle = '#000';
        ctx.fillText(it.text, it.x + F * 0.7, y + ph / 2 + 1);
      }
    });
  }
  return { blob: await canvasToBlob(c, 'image/jpeg', 0.92), w: W, h: H + band };
}

async function withBusy(text, fn) {
  st.busy = true;
  $('#msBusy').classList.remove('hidden');
  $('#msBusyText').textContent = text;
  renderPanel();
  try { return await fn(); } finally {
    st.busy = false;
    $('#msBusy').classList.add('hidden');
    renderPanel();
  }
}

// Guarda directo en el destino elegido (carpeta, Drive, Fotos compartidas…).
async function saveAnnotated() {
  const name = await st.opts.prepareSave?.(); // pide nombre y permisos dentro del toque
  if (!name) return;
  st.opts.name = name;
  const { blob, w, h } = await withBusy('Preparando foto…', exportAnnotated);
  await st.opts.onSave(blob, w, h, name);
}

async function shareAnnotated() {
  const { blob } = await withBusy('Preparando foto…', exportAnnotated);
  const file = new File([blob], `${st.opts.name || 'medidas'}.jpg`, { type: 'image/jpeg' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], text: summary() }); } catch (err) { if (err.name !== 'AbortError') throw err; }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

async function addToTray() {
  const { blob, w, h } = await withBusy('Preparando foto…', exportAnnotated);
  await st.opts.onAdd?.(blob, w, h);
  toast('Foto con medidas agregada a la bandeja', { type: 'ok' });
}

async function pickRef() {
  const k = await actionSheet('¿Qué usaste de referencia?', Object.entries(MEASURE_REFS).map(([key, r]) => ({
    key, label: `${key === st.ref ? '✓ ' : ''}${r.label} · ${refSize(r)}${r.sheet ? ' (producto encima)' : ' (al lado del producto)'}`,
  })));
  if (!k || k === st.ref) return;
  st.ref = k;
  st.opts.onRef?.(k);
  run(st.manual);
}

function showTips() {
  dialog({
    title: 'Para medidas exactas',
    text: '• Apoyá el producto ENCIMA de una hoja blanca (A4, Carta u Oficio) que se vea entera en la foto.\n'
      + '• Si el producto es más grande, poné una tarjeta (DNI / crédito) al lado, sobre la misma mesa.\n'
      + '• Sacá la foto desde arriba, con el celular paralelo a la mesa.\n'
      + '• Luz pareja y sin flash: las sombras fuertes se miden como parte del objeto.\n'
      + '• Mide largo y ancho de lo que se ve desde arriba. Los objetos muy altos se ven un poco más grandes: para medir el alto, acostalos.\n'
      + '• Con la Regla medís cualquier distancia sobre el plano de la hoja.',
    okLabel: 'Entendido',
    noCancel: true,
  });
}

/* ---------- gestos ---------- */

function toImg(ev) {
  const b = $('#msCanvas').getBoundingClientRect();
  const L = st.layout;
  const sx = ev.clientX - b.left, sy = ev.clientY - b.top;
  return { img: [(sx - L.x) / L.s, (sy - L.y) / L.s], screen: [sx, sy] };
}
const clampImg = ([x, y]) => [Math.min(st.w, Math.max(0, x)), Math.min(st.h, Math.max(0, y))];
function nearest(pts, p, max) {
  let best = -1, bd = max;
  pts.forEach((q, i) => { if (q) { const d = dist(q, p); if (d < bd) { bd = d; best = i; } } });
  return best;
}

// Un dedo: tocar / arrastrar esquinas, regla o mover la foto con zoom. Dos dedos: zoom y mover.
// Doble toque: acercar ahí (o volver a ver todo). Rueda del mouse: zoom.
const ptrs = new Map();
let pinch = null;
let lastTap = null;

function screenOf(ev) {
  const b = $('#msCanvas').getBoundingClientRect();
  return [ev.clientX - b.left, ev.clientY - b.top];
}

function startPinch() {
  const [a, b] = [...ptrs.values()];
  pinch = { d: Math.max(1, dist(a, b)), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], from: { ...st.view } };
}

function bindGestures() {
  const c = $('#msCanvas');
  c.addEventListener('wheel', (ev) => {
    if (!st.view || st.busy) return;
    ev.preventDefault();
    const [sx, sy] = screenOf(ev);
    zoomAt(sx, sy, st.view.z * (ev.deltaY < 0 ? 1.2 : 1 / 1.2));
    draw();
  }, { passive: false });
  c.addEventListener('pointerdown', (ev) => {
    if (!st.layout || st.busy) return;
    c.setPointerCapture(ev.pointerId);
    ptrs.set(ev.pointerId, screenOf(ev));
    if (ptrs.size === 2) {
      // Empieza el pellizco: se cancela el arrastre de un dedo (sin perder lo ya movido).
      st.drag = null;
      $('#msLoupe').classList.add('hidden');
      startPinch();
      return;
    }
    if (ptrs.size > 2) return;
    const p = toImg(ev);
    const grab = 40 / st.layout.s;
    let target = null;
    if (st.manual) {
      const i = nearest(st.manual, p.img, grab);
      if (i >= 0) target = { kind: 'corner', i };
    } else if (st.ruler) {
      const i = nearest([st.ra, st.rb], p.img, grab);
      if (i >= 0) target = { kind: 'ruler', i };
    }
    st.drag = { start: p, target, moved: false, view: { ...st.view } };
  });
  c.addEventListener('pointermove', (ev) => {
    if (ptrs.has(ev.pointerId)) ptrs.set(ev.pointerId, screenOf(ev));
    if (pinch && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      zoomAt(pinch.mid[0], pinch.mid[1], pinch.from.z * dist(a, b) / pinch.d, pinch.from);
      // y además se arrastra con los dos dedos
      st.view.x += mid[0] - pinch.mid[0];
      st.view.y += mid[1] - pinch.mid[1];
      clampView();
      draw();
      return;
    }
    const d = st.drag;
    if (!d) return;
    const p = toImg(ev);
    if (!d.moved && dist(p.screen, d.start.screen) < 6) return;
    d.moved = true;
    // Sin nada agarrado (y fuera de la regla): mover la foto ampliada.
    if (!d.target && !(st.ruler && !st.manual)) {
      st.view.x = d.view.x + p.screen[0] - d.start.screen[0];
      st.view.y = d.view.y + p.screen[1] - d.start.screen[1];
      clampView();
      draw();
      return;
    }
    // Arrastrar en vacío con la regla dibuja una medida nueva.
    if (!d.target && st.ruler && !st.manual) { st.ra = clampImg(d.start.img); st.rb = st.ra; d.target = { kind: 'ruler', i: 1 }; }
    if (!d.target) return;
    const q = clampImg(p.img);
    if (d.target.kind === 'corner') st.manual[d.target.i] = q;
    else if (d.target.i === 0) st.ra = q; else st.rb = q;
    d.screen = p.screen;
    d.img = q;
    draw();
    renderPanel();
  });
  const end = (ev) => {
    ptrs.delete(ev.pointerId);
    if (pinch) {
      // Al terminar el pellizco no cuenta como toque; con un dedo todavía apoyado no se hace nada.
      if (ptrs.size < 2) pinch = null;
      return;
    }
    const d = st.drag;
    st.drag = null;
    $('#msLoupe').classList.add('hidden');
    if (d && !d.moved && ev.type === 'pointerup') {
      const now = Date.now();
      if (lastTap && now - lastTap.t < 320 && dist(lastTap.screen, d.start.screen) < 30) {
        lastTap = null;
        // Doble toque: acercar ahí, o volver a ver todo si ya estaba ampliado.
        if (st.view.z > 1.05) resetZoom();
        else { zoomAt(d.start.screen[0], d.start.screen[1], 3); draw(); }
        return;
      }
      lastTap = { t: now, screen: d.start.screen };
      onTap(d.start.img);
    } else draw();
  };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
}

function onTap(p) {
  const r = st.result;
  if (!r) return;
  if (st.manual) {
    st.manual[nearest(st.manual, p, Infinity)] = clampImg(p);
  } else if (st.ruler) {
    if (!st.ra || st.rb) { st.ra = clampImg(p); st.rb = null; } else st.rb = clampImg(p);
  } else {
    const i = r.objects.findIndex((o) => pointInPoly(p, o.box));
    if (i >= 0) { toggleHidden(i); return; }
  }
  renderPanel();
  draw();
}

/* ---------- enlaces ---------- */

let bound = false;
function bindOnce() {
  if (bound) return;
  bound = true;
  bindGestures();
  $('#msClose').addEventListener('click', () => { st.img = null; st.src?.close?.(); st.src = null; st.opts?.onClose?.(); });
  $('#msRef').addEventListener('click', () => { if (!st.busy) pickRef(); });
  $('#msManualCancel').addEventListener('click', () => { st.manual = null; renderPanel(); draw(); });
  $('#msManualGo').addEventListener('click', () => run(st.manual));
  $('#msZoom').addEventListener('click', resetZoom);
  $('#msSave').addEventListener('click', async () => {
    if (st.busy) return;
    try { await saveAnnotated(); } catch (err) { toast('No se pudo guardar: ' + err.message, { type: 'error' }); }
  });
  $('#msShare').addEventListener('click', async () => {
    if (st.busy) return;
    try { await shareAnnotated(); } catch (err) { toast('No se pudo compartir: ' + err.message, { type: 'error' }); }
  });
  $('#msActions').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-a]');
    if (!b || b.disabled) return;
    switch (b.dataset.a) {
      case 'adjust': st.manual = (st.result?.quad || defaultQuad()).map((p) => [...p]); break;
      case 'ruler': st.ruler = !st.ruler; break;
      case 'unit': st.unit = st.unit === 'cm' ? 'mm' : st.unit === 'mm' ? 'in' : 'cm'; break;
      case 'copy': copySummary(); return;
      case 'tray':
        try { await addToTray(); } catch (err) { toast('No se pudo agregar: ' + err.message, { type: 'error' }); }
        return;
      case 'tips': showTips(); return;
    }
    renderPanel();
    draw();
  });
  window.addEventListener('resize', () => { if (st.img) draw(); });
}

import { $, $$, toast, dialog, showSheet, closeSheet, showView, actionSheet, debounce, uid } from './ui.js';
import { db, loadSettings, saveSettings } from './db.js';
import { drive, AuthError, uniqueName, cleanName } from './drive.js';
import { Camera } from './camera.js';
import { Renderer } from './render.js';
import { BASE_EDITS, cloneEdits, normalizeImport } from './process.js';
import { GOOGLE_CLIENT_ID, APP_VERSION } from './config.js';

/* ================================================================== */
/* Estado                                                              */
/* ================================================================== */

const settings = loadSettings({
  clientId: GOOGLE_CLIENT_ID,
  folder: null,            // {id, name}
  outSize: 2048,
  jpgQ: 90,
  autoApply: false,
  keepOriginal: false,
  sep: '_',
  haptics: true,
  defaultEdits: { ...BASE_EDITS, bg: 'auto', aspect: '1', autoCenter: true, margin: 8 },
  tools: { grid: false, square: false, ghost: false, timer: false, burst: false },
});
if (!settings.clientId && GOOGLE_CLIENT_ID) settings.clientId = GOOGLE_CLIENT_ID;
const persistSettings = () => saveSettings(settings);

let photos = [];              // fotos de la sesión (aún no guardadas)
const thumbUrls = new Map();  // id → objectURL
let uploading = false;
let lastBatch = null;         // para «Deshacer»
let ghostOverride = null;     // URL de una foto del catálogo usada como fantasma

const renderer = new Renderer({
  onAIMask: async (photo, key, blob) => {
    photo.aiMask = { key, blob };
    if (photos.includes(photo)) await db.put(photo);
  },
});
const camera = new Camera($('#video'));

/* ================================================================== */
/* Arranque                                                            */
/* ================================================================== */

async function init() {
  $('#appVersion').textContent = 'Versión ' + APP_VERSION;
  try {
    if (drive.handleRedirect()) toast('Google Drive conectado', { type: 'ok' });
  } catch (err) { toast(err.message, { type: 'error', ms: 5000 }); }

  navigator.storage?.persist?.().catch(() => {});
  try {
    photos = await db.all();
    for (const p of photos) if (p.status === 'uploading') p.status = 'queued';
  } catch (err) {
    toast('No se pudo leer el almacenamiento local: ' + err.message, { type: 'error' });
  }

  bindCamera();
  bindEditor();
  bindSaving();
  bindFolderSheet();
  bindSettings();
  bindCatalog();
  applyToolState();
  renderTray();
  updateFolderChip();
  startCamera();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  if (photos.some((p) => p.status === 'queued')) processQueue();
  if (settings.folder && drive.token()) loadNameSuggestions();
}

/* ================================================================== */
/* Cámara                                                              */
/* ================================================================== */

async function startCamera() {
  if (!$('#view-camera').classList.contains('active') || document.hidden) return;
  try {
    await camera.start();
    $('#camMsg').classList.add('hidden');
    $('#btnTorch').hidden = !camera.hasTorch;
    buildZoom();
    layoutOverlay();
  } catch (err) {
    $('#camMsg').classList.remove('hidden');
    $('#camMsg p').textContent = err.name === 'NotAllowedError'
      ? 'Permiso de cámara denegado. Habilitalo en Ajustes › Safari › Cámara.'
      : 'No se pudo abrir la cámara: ' + err.message;
  }
}

function stopCamera() { camera.stop(); }

function buildZoom() {
  const box = $('#zoomBox');
  const r = camera.zoomRange;
  box.innerHTML = '';
  if (!r || r[1] <= r[0]) { box.hidden = true; return; }
  const steps = [1, 2, 3, 5].filter((z) => z >= r[0] && z <= r[1]);
  if (r[0] < 1) steps.unshift(r[0]);
  for (const z of steps) {
    const b = document.createElement('button');
    b.textContent = (z < 1 ? z.toFixed(1) : z) + '×';
    b.classList.toggle('on', Math.abs(camera.zoom - z) < 0.05);
    b.onclick = async () => { await camera.setZoom(z).catch(() => {}); buildZoom(); };
    box.append(b);
  }
  box.hidden = false;
}

// Ubica las guías exactamente sobre la imagen visible del video (object-fit: contain).
function layoutOverlay() {
  const v = $('#video');
  const stage = $('#camStage').getBoundingClientRect();
  const vw = v.videoWidth || 3, vh = v.videoHeight || 4;
  const s = Math.min(stage.width / vw, stage.height / vh);
  const w = vw * s, h = vh * s;
  const ov = $('#overlay');
  Object.assign(ov.style, { left: (stage.width - w) / 2 + 'px', top: (stage.height - h) / 2 + 'px', width: w + 'px', height: h + 'px' });
  const fg = $('#frameGuide');
  const side = Math.min(w, h);
  Object.assign(fg.style, { left: (w - side) / 2 + 'px', top: (h - side) / 2 + 'px', width: side + 'px', height: side + 'px' });
}

function applyToolState() {
  const t = settings.tools;
  $$('.tool[data-toggle]').forEach((b) => b.classList.toggle('on', !!t[b.dataset.toggle]));
  $('#grid').classList.toggle('hidden', !t.grid);
  $('#frameGuide').classList.toggle('hidden', !t.square);
  updateGhost();
}

function updateGhost() {
  const g = $('#ghost');
  const last = photos[photos.length - 1];
  const src = ghostOverride || (last && thumbUrls.get(last.id + ':orig'));
  if (settings.tools.ghost && src) { g.src = src; g.classList.remove('hidden'); }
  else g.classList.add('hidden');
}

let orientationAsked = false;
function askOrientation() {
  if (orientationAsked) return;
  orientationAsked = true;
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') DOE.requestPermission().catch(() => {});
}

let wasLevel = false;
function onOrientation(ev) {
  if (ev.gamma == null) return;
  const lvl = $('#level');
  const flat = Math.abs(ev.beta) < 25;
  // De pie: el giro lateral es gamma. Plano (foto cenital): usamos gamma y beta.
  const roll = flat ? 0 : (screen.orientation?.angle === 90 ? -ev.beta : screen.orientation?.angle === 270 ? ev.beta : ev.gamma);
  const ok = flat ? Math.abs(ev.beta) < 2 && Math.abs(ev.gamma) < 2 : Math.abs(roll) < 1.5;
  lvl.style.transform = `rotate(${-roll}deg)`;
  lvl.classList.toggle('ok', ok);
  $('#btnShutter').classList.toggle('level-ok', ok);
  if (ok && !wasLevel && settings.haptics) navigator.vibrate?.(15);
  wasLevel = ok;
}

let shooting = false;
async function shoot() {
  if (shooting) return;
  if (!camera.active) { $('#pickNative').click(); return; }
  shooting = true;
  $('#btnShutter').classList.add('busy');
  try {
    if (settings.tools.timer) {
      const cd = $('#countdown');
      cd.classList.remove('hidden');
      for (let i = 3; i > 0; i--) { cd.textContent = i; await new Promise((r) => setTimeout(r, 1000)); }
      cd.classList.add('hidden');
    }
    const shots = settings.tools.burst ? 3 : 1;
    for (let i = 0; i < shots; i++) {
      const fx = $('#flashFx');
      fx.classList.remove('go'); void fx.offsetWidth; fx.classList.add('go');
      const { blob, w, h } = await camera.capture();
      await addPhoto(blob, w, h);
      if (i < shots - 1) await new Promise((r) => setTimeout(r, 350));
    }
  } catch (err) {
    toast('Error al capturar: ' + err.message, { type: 'error' });
  } finally {
    shooting = false;
    $('#btnShutter').classList.remove('busy');
    $('#countdown').classList.add('hidden');
  }
}

async function importFiles(files) {
  let n = 0;
  for (const f of files) {
    try {
      const { blob, w, h } = await normalizeImport(f);
      await addPhoto(blob, w, h);
      n++;
    } catch (err) {
      toast(`No se pudo abrir ${f.name}: ${err.message}`, { type: 'error' });
    }
  }
  if (n > 1) toast(`${n} fotos añadidas`);
}

async function addPhoto(blob, w, h, extra = {}) {
  const edits = settings.autoApply ? cloneEdits(settings.defaultEdits) : cloneEdits();
  if (settings.tools.square && !settings.autoApply) edits.aspect = '1';
  const photo = {
    id: uid(), createdAt: Date.now(), name: cleanName($('#productName').value),
    blob, w, h, edits, status: 'new', ...extra,
  };
  photos.push(photo);
  await db.put(photo).catch((err) => toast('Sin espacio para guardar la foto: ' + err.message, { type: 'error' }));
  renderTray();
  refreshThumb(photo);
  return photo;
}

function bindCamera() {
  $('#btnShutter').addEventListener('click', () => { askOrientation(); shoot(); });
  $('#retryCam').addEventListener('click', () => { askOrientation(); startCamera(); });
  window.addEventListener('deviceorientation', onOrientation);
  document.addEventListener('pointerdown', askOrientation, { once: true });

  $$('.tool[data-toggle]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.toggle;
    settings.tools[k] = !settings.tools[k];
    if (k === 'ghost' && !settings.tools.ghost) ghostOverride = null;
    persistSettings();
    applyToolState();
  }));

  $('#btnTorch').addEventListener('click', async () => {
    try { await camera.setTorch(!camera.torch); } catch { toast('No se pudo encender la linterna'); }
    $('#btnTorch').classList.toggle('on', camera.torch);
  });

  $('#pickGallery').addEventListener('change', (ev) => { importFiles([...ev.target.files]); ev.target.value = ''; });
  $('#pickNative').addEventListener('change', (ev) => { importFiles([...ev.target.files]); ev.target.value = ''; });

  $('#btnRandomName').addEventListener('click', () => { $('#productName').value = randomName(); });
  $('#productName').addEventListener('change', (ev) => { ev.target.value = cleanName(ev.target.value); });

  window.addEventListener('resize', debounce(layoutOverlay, 100));
  $('#video').addEventListener('loadedmetadata', layoutOverlay);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopCamera();
    else startCamera();
  });
}

function randomName() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return 'P_' + Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/* ---------- bandeja de fotos ---------- */

function renderTray() {
  const tray = $('#tray');
  tray.innerHTML = '';
  photos.forEach((p, i) => {
    const d = document.createElement('button');
    d.className = 'thumb' + (p.edits.bg !== 'none' || p.edits.aspect !== 'orig' ? ' edited' : '');
    const img = document.createElement('img');
    img.alt = '';
    const url = thumbUrls.get(p.id);
    if (url) img.src = url;
    d.append(img);
    if (p.name) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = p.name; d.append(t); }
    if (p.status === 'queued' || p.status === 'uploading' || p.status === 'error') {
      const st = document.createElement('i'); st.className = 'st ' + (p.status === 'error' ? 'error' : 'uploading'); d.append(st);
    }
    d.addEventListener('click', () => openEditor(i));
    tray.append(d);
  });
  const n = photos.length;
  $('#btnSave').disabled = n === 0 || uploading;
  $('#saveCount').textContent = n ? n : '';
  updateGhost();
  updateQueuePill();
}

const thumbQueue = [];
let thumbBusy = false;
function refreshThumb(photo) {
  if (!thumbQueue.includes(photo)) thumbQueue.push(photo);
  if (thumbBusy) return;
  thumbBusy = true;
  (async () => {
    while (thumbQueue.length) {
      const p = thumbQueue.shift();
      if (!photos.includes(p)) continue;
      try {
        if (!thumbUrls.has(p.id + ':orig')) thumbUrls.set(p.id + ':orig', URL.createObjectURL(p.blob));
        const blob = await renderer.thumbnail(p, p.edits);
        const old = thumbUrls.get(p.id);
        if (old) URL.revokeObjectURL(old);
        thumbUrls.set(p.id, URL.createObjectURL(blob));
      } catch (err) { console.warn('miniatura', err); }
      renderTray();
    }
    thumbBusy = false;
  })();
}

function forgetPhoto(p) {
  for (const k of [p.id, p.id + ':orig']) { const u = thumbUrls.get(k); if (u) URL.revokeObjectURL(u); thumbUrls.delete(k); }
  renderer.forget(p.id);
}

/* ================================================================== */
/* Editor                                                              */
/* ================================================================== */

const ed = { index: -1, photo: null, wand: false, crop: null, map: null, token: 0, tab: 'fondo' };
const RANGE_IDS = ['bgTol', 'bgFeather', 'shadow', 'margin', 'straighten', 'exposure', 'contrast', 'saturation', 'warmth', 'sharpen'];
const RANGE_KEY = { bgTol: 'tol', bgFeather: 'feather' };
const STYLE_KEYS = ['bg', 'tol', 'feather', 'bgColor', 'shadow', 'aspect', 'autoCenter', 'margin', 'autoLevels', 'exposure', 'contrast', 'saturation', 'warmth', 'sharpen'];

function openEditor(i) {
  ed.index = i;
  ed.photo = photos[i];
  ed.wand = false;
  ed.crop = null;
  stopCamera();
  showView('view-editor');
  syncEditorControls();
  renderPreview();
}

async function closeEditor() {
  if (ed.crop) exitCrop(false);
  const p = ed.photo;
  ed.photo = null;
  showView('view-camera');
  if (p && photos.includes(p)) { await db.put(p); refreshThumb(p); }
  renderTray();
  startCamera();
}

function syncEditorControls() {
  const p = ed.photo, e = p.edits;
  $('#edIndex').textContent = `${ed.index + 1}/${photos.length}`;
  $('#edName').value = p.name || '';
  $('#edPrev').classList.toggle('hidden', ed.index <= 0);
  $('#edNext').classList.toggle('hidden', ed.index >= photos.length - 1);
  for (const id of RANGE_IDS) {
    const el = $('#' + id);
    el.value = e[RANGE_KEY[id] || id];
    el.nextElementSibling.textContent = el.value;
  }
  $$('#bgMode button').forEach((b) => b.classList.toggle('active', b.dataset.v === e.bg));
  $$('#aspect button').forEach((b) => b.classList.toggle('active', b.dataset.v === String(e.aspect)));
  $$('#bgColors [data-c]').forEach((b) => b.classList.toggle('active', b.dataset.c === e.bgColor));
  $('#bgCustom').value = e.bgColor;
  $('#autoCenter').checked = e.autoCenter;
  $('#autoLevels').classList.toggle('on', e.autoLevels);
  $('#wandBtn').classList.toggle('on', ed.wand);
  $('#edStage').classList.toggle('wand', ed.wand);
  $$('[data-show]').forEach((el) => el.classList.toggle('hidden', !el.dataset.show.split(' ').includes(e.bg)));
  $('[data-show-center]').classList.toggle('hidden', !(e.autoCenter && e.bg !== 'none'));
  $('#autoCenter').closest('label').classList.toggle('hidden', e.bg === 'none');
}

let previewQueued = false;
function renderPreview() {
  if (previewQueued) return;
  previewQueued = true;
  requestAnimationFrame(async () => {
    previewQueued = false;
    const p = ed.photo;
    if (!p) return;
    const token = ++ed.token;
    const stage = $('#edStage').getBoundingClientRect();
    const maxSide = Math.min(1400, Math.round(Math.max(stage.width, stage.height) * Math.min(2, devicePixelRatio || 1)));
    const slow = setTimeout(() => busy(true, p.edits.bg === 'ai' ? 'Analizando con IA…' : 'Procesando…'), 120);
    try {
      const { canvas, map } = await renderer.render(p, p.edits, maxSide, {
        onProgress: (key, cur, total) => {
          if (key.startsWith('fetch') && total) busy(true, `Descargando IA ${Math.round((cur / total) * 100)}%`);
        },
      });
      if (token !== ed.token || p !== ed.photo) return;
      const out = $('#edCanvas');
      out.width = canvas.width;
      out.height = canvas.height;
      out.getContext('2d').drawImage(canvas, 0, 0);
      ed.map = map;
    } catch (err) {
      if (token === ed.token) {
        toast(err.message, { type: 'error', ms: 5000 });
        if (p.edits.bg === 'ai') { p.edits.bg = 'auto'; syncEditorControls(); renderPreview(); }
      }
    } finally {
      clearTimeout(slow);
      if (token === ed.token) busy(false);
    }
  });
}

function busy(on, text) {
  $('#edBusy').classList.toggle('hidden', !on);
  if (text) $('#edBusyText').textContent = text;
}

const persistEdit = debounce(() => { if (ed.photo) db.put(ed.photo).catch(() => {}); }, 600);
function changed() { syncEditorControls(); renderPreview(); persistEdit(); }

function bindEditor() {
  $('#edClose').addEventListener('click', closeEditor);
  $('#edDone').addEventListener('click', closeEditor);
  $('#edPrev').addEventListener('click', () => navEditor(-1));
  $('#edNext').addEventListener('click', () => navEditor(1));
  $('#edName').addEventListener('input', (ev) => { ed.photo.name = cleanName(ev.target.value); persistEdit(); });

  $$('#edTabs button').forEach((b) => b.addEventListener('click', () => {
    if (ed.crop && b.dataset.tab !== 'recorte') exitCrop(true);
    ed.tab = b.dataset.tab;
    $$('#edTabs button').forEach((x) => x.classList.toggle('active', x === b));
    $$('.tab-body').forEach((x) => x.classList.toggle('hidden', x.dataset.body !== ed.tab));
  }));

  for (const id of RANGE_IDS) {
    $('#' + id).addEventListener('input', (ev) => {
      ed.photo.edits[RANGE_KEY[id] || id] = Number(ev.target.value);
      ev.target.nextElementSibling.textContent = ev.target.value;
      renderPreview();
      persistEdit();
    });
  }
  $$('#bgMode button').forEach((b) => b.addEventListener('click', () => {
    ed.photo.edits.bg = b.dataset.v;
    if (b.dataset.v !== 'auto') ed.wand = false;
    changed();
  }));
  $$('#aspect button').forEach((b) => b.addEventListener('click', () => { ed.photo.edits.aspect = b.dataset.v; changed(); }));
  $$('#bgColors [data-c]').forEach((b) => b.addEventListener('click', () => { ed.photo.edits.bgColor = b.dataset.c; changed(); }));
  $('#bgCustom').addEventListener('input', (ev) => { ed.photo.edits.bgColor = ev.target.value; changed(); });
  $('#autoCenter').addEventListener('change', (ev) => { ed.photo.edits.autoCenter = ev.target.checked; changed(); });

  const rotate = (d) => {
    const e = ed.photo.edits;
    e.rot = (((e.rot + d) % 4) + 4) % 4;
    e.crop = rotateCrop(e.crop, d);
    e.wand = [];
    changed();
  };
  $('#rotL').addEventListener('click', () => rotate(-1));
  $('#rotR').addEventListener('click', () => rotate(1));
  $('#flipH').addEventListener('click', () => {
    const e = ed.photo.edits;
    e.flip = !e.flip;
    if (e.crop) e.crop = { ...e.crop, x: 1 - e.crop.x - e.crop.w };
    e.wand = [];
    changed();
  });
  $('#straighten').addEventListener('change', () => { ed.photo.edits.wand = []; });

  $('#autoLevels').addEventListener('click', () => { ed.photo.edits.autoLevels = !ed.photo.edits.autoLevels; changed(); });
  $('#resetLight').addEventListener('click', () => {
    Object.assign(ed.photo.edits, { autoLevels: false, exposure: 0, contrast: 0, saturation: 0, warmth: 0, sharpen: 0 });
    changed();
  });

  $('#wandBtn').addEventListener('click', () => { ed.wand = !ed.wand; syncEditorControls(); });
  $('#wandUndo').addEventListener('click', () => { ed.photo.edits.wand.pop(); changed(); });
  $('#edCanvas').addEventListener('click', (ev) => {
    if (!ed.wand || !ed.map) return;
    const c = ev.currentTarget;
    const r = c.getBoundingClientRect();
    const pt = ed.map((ev.clientX - r.left) / r.width * c.width, (ev.clientY - r.top) / r.height * c.height);
    if (pt.x < 0 || pt.y < 0 || pt.x > 1 || pt.y > 1) return;
    ed.photo.edits.wand.push({ x: +pt.x.toFixed(4), y: +pt.y.toFixed(4) });
    changed();
  });

  // Comparar con el original mientras se mantiene presionado.
  const cmp = $('#edCompare');
  const showOrig = async () => {
    ed.token++;
    const bmp = await renderer.bitmap(ed.photo);
    const c = $('#edCanvas');
    const s = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
    c.width = bmp.width * s; c.height = bmp.height * s;
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  };
  cmp.addEventListener('pointerdown', showOrig);
  for (const evn of ['pointerup', 'pointerleave', 'pointercancel']) cmp.addEventListener(evn, () => renderPreview());

  $('#edDelete').addEventListener('click', async () => {
    if (!await dialog({ title: '¿Eliminar esta foto?', okLabel: 'Eliminar', danger: true })) return;
    const p = ed.photo;
    await removePhotos([p]);
    if (!photos.length) { ed.photo = null; closeEditor(); return; }
    openEditor(Math.min(ed.index, photos.length - 1));
  });

  $('#edApplyAll').addEventListener('click', async () => {
    const src = ed.photo.edits;
    for (const p of photos) {
      if (p === ed.photo) continue;
      for (const k of STYLE_KEYS) p.edits[k] = src[k];
      await db.put(p);
      refreshThumb(p);
    }
    toast(`Estilo aplicado a ${photos.length} fotos`, { type: 'ok' });
  });
  $('#edSaveDefault').addEventListener('click', () => {
    const d = {};
    for (const k of STYLE_KEYS) d[k] = ed.photo.edits[k];
    settings.defaultEdits = { ...BASE_EDITS, ...d };
    settings.autoApply = true;
    persistSettings();
    toast('Estilo guardado: se aplicará a cada foto nueva', { type: 'ok' });
  });

  $('#cropEdit').addEventListener('click', () => (ed.crop ? exitCrop(true) : enterCrop()));
  $('#cropReset').addEventListener('click', () => {
    if (ed.crop) exitCrop(false);
    ed.photo.edits.crop = null;
    ed.photo.edits.wand = [];
    changed();
  });
  bindCropGestures();
  window.addEventListener('resize', debounce(() => { if (ed.photo) { renderPreview(); if (ed.crop) drawCrop(); } }, 150));
}

function navEditor(d) {
  const i = ed.index + d;
  if (i < 0 || i >= photos.length) return;
  if (ed.crop) exitCrop(true);
  db.put(ed.photo).catch(() => {});
  refreshThumb(ed.photo);
  openEditor(i);
}

// Al rotar 90°, el recorte normalizado también rota.
function rotateCrop(c, d) {
  if (!c) return null;
  return d > 0 ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w };
}

/* ---------- recorte manual ---------- */

async function enterCrop() {
  const e = ed.photo.edits;
  const full = await renderer.geometry(ed.photo, e, 1400, true);
  ed.crop = { img: full, rect: e.crop ? { ...e.crop } : { x: 0.05, y: 0.05, w: 0.9, h: 0.9 }, drag: null };
  $('#edCropCanvas').classList.remove('hidden');
  $('#edStage').classList.add('cropping');
  $('#cropEdit').textContent = 'Aplicar recorte';
  $('#cropEdit').classList.add('on');
  drawCrop();
}

function exitCrop(apply) {
  if (!ed.crop) return;
  if (apply) {
    const r = ed.crop.rect;
    const full = r.x <= 0.001 && r.y <= 0.001 && r.w >= 0.998 && r.h >= 0.998;
    ed.photo.edits.crop = full ? null : { x: +r.x.toFixed(4), y: +r.y.toFixed(4), w: +r.w.toFixed(4), h: +r.h.toFixed(4) };
    ed.photo.edits.wand = [];
  }
  ed.crop = null;
  $('#edCropCanvas').classList.add('hidden');
  $('#edStage').classList.remove('cropping');
  $('#cropEdit').textContent = 'Editar recorte';
  $('#cropEdit').classList.remove('on');
  changed();
}

function cropLayout() {
  const c = $('#edCropCanvas');
  const W = c.clientWidth, H = c.clientHeight;
  const img = ed.crop.img;
  const pad = 24;
  const s = Math.min((W - pad * 2) / img.width, (H - pad * 2) / img.height);
  const w = img.width * s, h = img.height * s;
  return { W, H, x: (W - w) / 2, y: (H - h) / 2, w, h };
}

function drawCrop() {
  const c = $('#edCropCanvas');
  const dpr = devicePixelRatio || 1;
  c.width = c.clientWidth * dpr;
  c.height = c.clientHeight * dpr;
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const L = cropLayout();
  ctx.fillStyle = '#0a0e17';
  ctx.fillRect(0, 0, L.W, L.H);
  ctx.drawImage(ed.crop.img, L.x, L.y, L.w, L.h);
  const r = ed.crop.rect;
  const rx = L.x + r.x * L.w, ry = L.y + r.y * L.h, rw = r.w * L.w, rh = r.h * L.h;
  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.beginPath();
  ctx.rect(L.x, L.y, L.w, L.h);
  ctx.rect(rx, ry, rw, rh);
  ctx.fill('evenodd');
  ctx.strokeStyle = '#2ec4d6';
  ctx.lineWidth = 2;
  ctx.strokeRect(rx, ry, rw, rh);
  ctx.strokeStyle = 'rgba(255,255,255,.35)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    ctx.beginPath(); ctx.moveTo(rx + rw * i / 3, ry); ctx.lineTo(rx + rw * i / 3, ry + rh); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(rx, ry + rh * i / 3); ctx.lineTo(rx + rw, ry + rh * i / 3); ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  for (const [hx, hy] of [[rx, ry], [rx + rw, ry], [rx, ry + rh], [rx + rw, ry + rh]]) {
    ctx.beginPath(); ctx.arc(hx, hy, 9, 0, Math.PI * 2); ctx.fill();
  }
}

function bindCropGestures() {
  const c = $('#edCropCanvas');
  const toNorm = (ev) => {
    const b = c.getBoundingClientRect();
    const L = cropLayout();
    return { x: (ev.clientX - b.left - L.x) / L.w, y: (ev.clientY - b.top - L.y) / L.h, L };
  };
  c.addEventListener('pointerdown', (ev) => {
    if (!ed.crop) return;
    c.setPointerCapture(ev.pointerId);
    const p = toNorm(ev);
    const r = ed.crop.rect;
    const tolX = 30 / p.L.w, tolY = 30 / p.L.h;
    const near = (ax, ay) => Math.abs(p.x - ax) < tolX && Math.abs(p.y - ay) < tolY;
    let mode = null;
    if (near(r.x, r.y)) mode = 'tl';
    else if (near(r.x + r.w, r.y)) mode = 'tr';
    else if (near(r.x, r.y + r.h)) mode = 'bl';
    else if (near(r.x + r.w, r.y + r.h)) mode = 'br';
    else if (p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h) mode = 'move';
    else mode = 'new';
    ed.crop.drag = { mode, start: p, orig: { ...r } };
  });
  c.addEventListener('pointermove', (ev) => {
    const dr = ed.crop?.drag;
    if (!dr) return;
    const p = toNorm(ev);
    const dx = p.x - dr.start.x, dy = p.y - dr.start.y;
    const o = dr.orig;
    const clamp = (v) => Math.min(1, Math.max(0, v));
    const MIN = 0.05;
    let { x, y, w, h } = o;
    let x2 = x + w, y2 = y + h;
    switch (dr.mode) {
      case 'move':
        x = Math.min(1 - w, Math.max(0, o.x + dx)); y = Math.min(1 - h, Math.max(0, o.y + dy)); x2 = x + w; y2 = y + h; break;
      case 'tl': x = clamp(Math.min(x2 - MIN, o.x + dx)); y = clamp(Math.min(y2 - MIN, o.y + dy)); break;
      case 'tr': x2 = clamp(Math.max(x + MIN, x2 + dx)); y = clamp(Math.min(y2 - MIN, o.y + dy)); break;
      case 'bl': x = clamp(Math.min(x2 - MIN, o.x + dx)); y2 = clamp(Math.max(y + MIN, y2 + dy)); break;
      case 'br': x2 = clamp(Math.max(x + MIN, x2 + dx)); y2 = clamp(Math.max(y + MIN, y2 + dy)); break;
      case 'new': {
        const a = { x: clamp(dr.start.x), y: clamp(dr.start.y) }, b = { x: clamp(p.x), y: clamp(p.y) };
        x = Math.min(a.x, b.x); y = Math.min(a.y, b.y); x2 = Math.max(a.x, b.x); y2 = Math.max(a.y, b.y);
        if (x2 - x < MIN || y2 - y < MIN) return;
      }
    }
    ed.crop.rect = { x, y, w: x2 - x, h: y2 - y };
    drawCrop();
  });
  const end = () => { if (ed.crop) ed.crop.drag = null; };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
}

/* ================================================================== */
/* Guardar / subir                                                     */
/* ================================================================== */

function bindSaving() {
  $('#btnSave').addEventListener('click', onSave);
  $('#queuePill').addEventListener('click', () => {
    if (!drive.token() && settings.clientId) drive.connect(settings.clientId);
    else processQueue();
  });
}

async function onSave() {
  if (!photos.length || uploading) return;
  const useDrive = !!settings.clientId;
  if (useDrive && !settings.folder) {
    toast('Primero elegí la carpeta de Drive');
    openFolderSheet();
    return;
  }

  const unnamed = photos.filter((p) => !p.name);
  if (unnamed.length) {
    const typed = cleanName($('#productName').value);
    const name = await dialog({
      title: 'Nombre del producto',
      text: `${unnamed.length} foto(s) sin nombre. Se guardarán como NOMBRE.jpg, NOMBRE${settings.sep}1.jpg…`,
      input: typed || randomName(),
      okLabel: 'Guardar',
    });
    if (name === null) return;
    const clean = cleanName(name);
    if (!clean) { toast('El nombre no puede estar vacío', { type: 'error' }); return; }
    unnamed.forEach((p) => { p.name = clean; });
  }

  for (const p of photos) { p.status = 'queued'; p.error = null; await db.put(p); }
  $('#productName').value = '';
  renderTray();

  if (useDrive) {
    // Si el token venció, redirigimos ya (estamos dentro del toque del usuario).
    if (!drive.token()) { drive.connect(settings.clientId); return; }
    processQueue();
  } else {
    shareFallback();
  }
}

function updateQueuePill() {
  const pill = $('#queuePill');
  const q = photos.filter((p) => p.status === 'queued' || p.status === 'error').length;
  if (!q || uploading || !settings.clientId) { pill.classList.add('hidden'); return; }
  pill.textContent = drive.token() ? `${q} pendiente(s) · tocar para reintentar` : `${q} pendiente(s) · tocar para reconectar Drive`;
  pill.classList.remove('hidden');
}

async function processQueue() {
  if (uploading || !settings.clientId) return;
  const queue = photos.filter((p) => p.status === 'queued' || p.status === 'error');
  if (!queue.length) return;
  if (!drive.token()) { updateQueuePill(); return; }
  if (!settings.folder) { openFolderSheet(); return; }

  uploading = true;
  renderTray();
  const folder = settings.folder;
  const batch = { folder, items: [] };
  let ok = 0, failed = 0;
  try {
    const taken = await drive.namesIn(folder.id);
    let origFolder = null, origTaken = null;
    for (const p of queue) {
      p.status = 'uploading';
      renderTray();
      showUploadProgress(ok + failed + 1, queue.length);
      try {
        const blob = await renderer.exportBlob(p, p.edits, settings.outSize, settings.jpgQ / 100);
        let res;
        if (p.driveFileId) {
          const name = p.driveName && p.driveName.replace(/\.[^.]+$/, '').startsWith(p.name) ? p.driveName : uniqueName(p.name, taken, settings.sep);
          res = await drive.upload(blob, { name, fileId: p.driveFileId });
        } else {
          res = await drive.upload(blob, { name: uniqueName(p.name, taken, settings.sep), parentId: folder.id });
        }
        let origId = null;
        if (settings.keepOriginal) {
          origFolder ||= await drive.findOrCreateFolder('originales', folder.id);
          origTaken ||= await drive.namesIn(origFolder.id);
          origId = (await drive.upload(p.blob, { name: uniqueName(p.name, origTaken, settings.sep), parentId: origFolder.id })).id;
        }
        batch.items.push({ photo: { ...p, status: 'new' }, fileId: res.id, origId, replaced: !!p.driveFileId });
        photos.splice(photos.indexOf(p), 1);
        await db.delete(p.id);
        forgetPhoto(p);
        ok++;
        renderTray();
        continue;
      } catch (err) {
        if (err instanceof AuthError) { p.status = 'queued'; throw err; }
        p.status = 'error';
        p.error = err.message;
        failed++;
        toast(`Error con «${p.name}»: ${err.message}`, { type: 'error', ms: 5000 });
      }
      await db.put(p).catch(() => {});
      renderTray();
    }
  } catch (err) {
    if (err instanceof AuthError) {
      toast('La sesión de Drive venció. Tocá «reconectar» para continuar.', { type: 'error', ms: 6000 });
    } else {
      toast('No se pudo subir: ' + err.message, { type: 'error', ms: 6000 });
      queue.forEach((p) => { if (p.status === 'uploading') p.status = 'error'; });
    }
  } finally {
    uploading = false;
    renderTray();
  }

  if (ok) {
    lastBatch = batch;
    toast(`${ok} foto(s) guardadas en «${folder.name}»${failed ? ` · ${failed} con error` : ''}`, {
      type: failed ? 'error' : 'ok',
      action: batch.items.some((i) => !i.replaced) ? undoLastBatch : null,
      actionLabel: 'Deshacer',
    });
    loadNameSuggestions();
  }
}

function showUploadProgress(i, n) {
  const pill = $('#queuePill');
  pill.textContent = `Subiendo ${i}/${n}…`;
  pill.classList.remove('hidden');
}

async function undoLastBatch() {
  const b = lastBatch;
  lastBatch = null;
  if (!b) return;
  let n = 0;
  for (const it of b.items) {
    if (it.replaced) continue;
    try {
      await drive.trash(it.fileId);
      if (it.origId) await drive.trash(it.origId).catch(() => {});
      photos.push(it.photo);
      await db.put(it.photo);
      refreshThumb(it.photo);
      n++;
    } catch (err) { toast('No se pudo deshacer: ' + err.message, { type: 'error' }); }
  }
  photos.sort((a, c) => a.createdAt - c.createdAt);
  renderTray();
  if (n) toast(`Deshecho: ${n} foto(s) volvieron a la bandeja (en Drive quedaron en la papelera)`);
}

// Sin Drive configurado: se generan los JPG y se abre el menú Compartir de iOS.
async function shareFallback() {
  const queue = photos.filter((p) => p.status === 'queued');
  uploading = true;
  renderTray();
  const files = [];
  const taken = new Set();
  try {
    for (const [i, p] of queue.entries()) {
      showUploadProgress(i + 1, queue.length);
      const blob = await renderer.exportBlob(p, p.edits, settings.outSize, settings.jpgQ / 100);
      files.push(new File([blob], uniqueName(p.name, taken, settings.sep), { type: 'image/jpeg' }));
    }
  } catch (err) {
    toast('Error al generar: ' + err.message, { type: 'error' });
    queue.forEach((p) => { p.status = 'new'; });
    uploading = false;
    renderTray();
    return;
  }
  uploading = false;
  queue.forEach((p) => { p.status = 'new'; });
  renderTray();

  const canShare = navigator.canShare?.({ files });
  const go = await dialog({
    title: `${files.length} foto(s) listas`,
    text: canShare
      ? 'Tocá «Compartir» y elegí «Guardar en Archivos» → Google Drive → tu carpeta.\n\nPara subir directo a Drive, configurá el Client ID en Ajustes.'
      : 'Se descargarán los archivos. Para subir directo a Drive, configurá el Client ID en Ajustes.',
    okLabel: canShare ? 'Compartir' : 'Descargar',
  });
  if (!go) return;
  try {
    if (canShare) await navigator.share({ files });
    else for (const f of files) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f);
      a.download = f.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    }
  } catch (err) {
    if (err.name !== 'AbortError') toast('No se pudo compartir: ' + err.message, { type: 'error' });
    return;
  }
  if (await dialog({ title: '¿Quitar las fotos de la bandeja?', text: 'Hacelo solo si se guardaron bien.', okLabel: 'Quitar' })) {
    await removePhotos(queue);
  }
}

async function removePhotos(list) {
  for (const p of list) {
    const i = photos.indexOf(p);
    if (i >= 0) photos.splice(i, 1);
    forgetPhoto(p);
    await db.delete(p.id).catch(() => {});
  }
  renderTray();
}

/* ================================================================== */
/* Carpeta de Drive                                                    */
/* ================================================================== */

const folderNav = { stack: [{ id: 'root', name: 'Mi unidad' }] };

function updateFolderChip() {
  const chip = $('#btnFolder');
  const f = settings.folder;
  $('#folderName').textContent = f ? f.name : settings.clientId ? 'Elegir carpeta' : 'Configurar Drive';
  chip.classList.toggle('warn', !!settings.clientId && !f);
}

function needDrive() {
  if (!settings.clientId) {
    showSheet('#sheetSettings');
    toast('Pegá tu Client ID de Google para conectar Drive');
    return true;
  }
  if (!drive.token()) {
    drive.connect(settings.clientId);
    return true;
  }
  return false;
}

function openFolderSheet() {
  if (needDrive()) return;
  showSheet('#sheetFolder');
  loadFolderLevel();
}

async function loadFolderLevel() {
  const cur = folderNav.stack[folderNav.stack.length - 1];
  const crumbs = $('#folderCrumbs');
  crumbs.innerHTML = '';
  folderNav.stack.forEach((f, i) => {
    if (i) crumbs.append(' › ');
    const b = document.createElement('button');
    b.textContent = f.name;
    b.onclick = () => { folderNav.stack.length = i + 1; loadFolderLevel(); };
    crumbs.append(b);
  });
  const list = $('#folderList');
  list.innerHTML = '<li class="empty">Cargando…</li>';
  try {
    const folders = await drive.listFolders(cur.id);
    list.innerHTML = '';
    if (!folders.length) list.innerHTML = '<li class="empty">Sin subcarpetas</li>';
    for (const f of folders) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg><span></span>';
      b.querySelector('span').textContent = f.name;
      b.onclick = () => { folderNav.stack.push(f); loadFolderLevel(); };
      li.append(b);
      list.append(li);
    }
  } catch (err) {
    list.innerHTML = '';
    if (err instanceof AuthError) { closeSheet(); drive.connect(settings.clientId); return; }
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = err.message;
    list.append(li);
  }
}

function bindFolderSheet() {
  $('#btnFolder').addEventListener('click', openFolderSheet);
  $('#sheetBackdrop').addEventListener('click', closeSheet);
  $$('[data-close]').forEach((b) => b.addEventListener('click', closeSheet));
  $('#folderChoose').addEventListener('click', () => {
    const cur = folderNav.stack[folderNav.stack.length - 1];
    settings.folder = { id: cur.id, name: cur.name };
    persistSettings();
    updateFolderChip();
    closeSheet();
    toast(`Carpeta: ${cur.name}`, { type: 'ok' });
    loadNameSuggestions();
    processQueue();
  });
  $('#folderNew').addEventListener('click', async () => {
    const name = await dialog({ title: 'Nueva carpeta', input: '', okLabel: 'Crear' });
    if (!name?.trim()) return;
    const cur = folderNav.stack[folderNav.stack.length - 1];
    try {
      const f = await drive.createFolder(name.trim(), cur.id);
      folderNav.stack.push(f);
      loadFolderLevel();
    } catch (err) { toast(err.message, { type: 'error' }); }
  });
}

// Reconoce la numeración final («_3», «-3», « 3») para obtener el nombre base del producto.
const suffixRegex = () => new RegExp(`[${settings.sep.replace(/[-\\\]^]/g, '\\$&')}]\\d+$`);

async function loadNameSuggestions() {
  if (!settings.folder || !drive.token()) return;
  try {
    const files = await drive.listImages(settings.folder.id);
    const re = suffixRegex();
    const bases = new Set(files.map((f) => f.name.replace(/\.[^.]+$/, '').replace(re, '')));
    const dl = $('#nameSuggestions');
    dl.innerHTML = '';
    for (const b of [...bases].slice(0, 300)) { const o = document.createElement('option'); o.value = b; dl.append(o); }
  } catch { /* opcional */ }
}

/* ================================================================== */
/* Ajustes                                                             */
/* ================================================================== */

async function refreshDriveStatus() {
  const st = $('#driveStatus');
  if (!settings.clientId) { st.textContent = 'Falta el Client ID (ver README).'; return; }
  if (!drive.token()) { st.textContent = drive.wasConnected() ? 'Sesión vencida — tocá Conectar' : 'No conectado'; return; }
  st.textContent = 'Conectado';
  try { const u = await drive.user(); st.textContent = `Conectado como ${u.emailAddress}`; } catch { /* nada */ }
}

function bindSettings() {
  $('#btnSettings').addEventListener('click', () => {
    $('#clientId').value = settings.clientId || '';
    $('#outSize').value = String(settings.outSize);
    $('#jpgQ').value = settings.jpgQ;
    $('#jpgQOut').textContent = settings.jpgQ + '%';
    $('#autoApply').checked = settings.autoApply;
    $('#keepOriginal').checked = settings.keepOriginal;
    $('#sep').value = settings.sep;
    $('#haptics').checked = settings.haptics;
    refreshDriveStatus();
    showSheet('#sheetSettings');
  });
  $('#clientId').addEventListener('change', (ev) => {
    settings.clientId = ev.target.value.trim();
    persistSettings();
    updateFolderChip();
    refreshDriveStatus();
  });
  $('#outSize').addEventListener('change', (ev) => { settings.outSize = Number(ev.target.value); persistSettings(); });
  $('#jpgQ').addEventListener('input', (ev) => { settings.jpgQ = Number(ev.target.value); $('#jpgQOut').textContent = settings.jpgQ + '%'; persistSettings(); });
  $('#autoApply').addEventListener('change', (ev) => { settings.autoApply = ev.target.checked; persistSettings(); });
  $('#keepOriginal').addEventListener('change', (ev) => { settings.keepOriginal = ev.target.checked; persistSettings(); });
  $('#sep').addEventListener('change', (ev) => { settings.sep = ev.target.value; persistSettings(); });
  $('#haptics').addEventListener('change', (ev) => { settings.haptics = ev.target.checked; persistSettings(); });
  $('#driveConnect').addEventListener('click', () => {
    settings.clientId = $('#clientId').value.trim();
    persistSettings();
    try { drive.connect(settings.clientId); } catch (err) { toast(err.message, { type: 'error' }); }
  });
  $('#driveDisconnect').addEventListener('click', () => { drive.disconnect(); refreshDriveStatus(); toast('Drive desconectado'); });
}

/* ================================================================== */
/* Catálogo (contenido de la carpeta de Drive)                         */
/* ================================================================== */

const cat = { stack: [], files: [], folders: [], urls: new Map(), observer: null, active: 0 };

function bindCatalog() {
  $('#btnCatalog').addEventListener('click', () => {
    if (needDrive()) return;
    if (!settings.folder) { openFolderSheet(); return; }
    cat.stack = [settings.folder];
    stopCamera();
    showView('view-catalog');
    loadCatalog();
  });
  $('#catClose').addEventListener('click', () => {
    if (cat.stack.length > 1) { cat.stack.pop(); loadCatalog(); return; }
    showView('view-camera');
    startCamera();
  });
  $('#catRefresh').addEventListener('click', loadCatalog);
  $('#catSearch').addEventListener('input', debounce(renderCatalog, 150));
}

async function loadCatalog() {
  const cur = cat.stack[cat.stack.length - 1];
  $('#catTitle').textContent = cur.name;
  $('#catGrid').innerHTML = '';
  $('#catEmpty').textContent = 'Cargando…';
  $('#catEmpty').classList.remove('hidden');
  try {
    const [folders, files] = await Promise.all([drive.listFolders(cur.id), drive.listImages(cur.id)]);
    cat.folders = folders;
    cat.files = files;
    renderCatalog();
  } catch (err) {
    if (err instanceof AuthError) { drive.connect(settings.clientId); return; }
    $('#catEmpty').textContent = err.message;
  }
}

function renderCatalog() {
  const q = $('#catSearch').value.trim().toLowerCase();
  const grid = $('#catGrid');
  grid.innerHTML = '';
  cat.observer?.disconnect();
  cat.observer = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { cat.observer.unobserve(en.target); loadCatThumb(en.target); }
  }, { root: grid, rootMargin: '200px' });

  const folders = cat.folders.filter((f) => !q || f.name.toLowerCase().includes(q));
  const files = cat.files.filter((f) => !q || f.name.toLowerCase().includes(q));
  for (const f of folders) {
    const d = document.createElement('button');
    d.className = 'cat-item folder';
    d.innerHTML = '<svg viewBox="0 0 24 24"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg><span></span>';
    d.querySelector('span').textContent = f.name;
    d.onclick = () => { cat.stack.push(f); loadCatalog(); };
    grid.append(d);
  }
  for (const f of files) {
    const d = document.createElement('button');
    d.className = 'cat-item';
    d.innerHTML = '<img alt=""><span></span>';
    d.querySelector('span').textContent = f.name;
    d._file = f;
    const url = cat.urls.get(f.id + f.modifiedTime);
    if (url) d.querySelector('img').src = url; else cat.observer.observe(d);
    d.onclick = () => catalogAction(f);
    grid.append(d);
  }
  const empty = !folders.length && !files.length;
  $('#catEmpty').textContent = q ? 'Sin resultados' : 'La carpeta está vacía';
  $('#catEmpty').classList.toggle('hidden', !empty);
  $('#catTitle').textContent = `${cat.stack[cat.stack.length - 1].name} · ${cat.files.length}`;
}

const catQueue = [];
function loadCatThumb(el) {
  catQueue.push(el);
  pumpCatThumbs();
}
function pumpCatThumbs() {
  while (cat.active < 4 && catQueue.length) {
    const el = catQueue.shift();
    if (!el.isConnected) continue;
    const f = el._file;
    cat.active++;
    drive.thumbnail(f)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        cat.urls.set(f.id + f.modifiedTime, url);
        el.querySelector('img').src = url;
      })
      .catch(() => {})
      .finally(() => { cat.active--; pumpCatThumbs(); });
  }
}

async function catalogAction(f) {
  const k = await actionSheet(f.name, [
    { key: 'edit', label: 'Editar y volver a guardar (reemplaza)' },
    { key: 'copy', label: 'Usar como base para una foto nueva' },
    { key: 'ghost', label: 'Usar como guía fantasma en la cámara' },
    { key: 'trash', label: 'Mover a la papelera', danger: true },
  ]);
  if (!k) return;
  try {
    if (k === 'trash') {
      if (!await dialog({ title: `¿Eliminar «${f.name}»?`, text: 'Se mueve a la papelera de Drive.', okLabel: 'Eliminar', danger: true })) return;
      await drive.trash(f.id);
      cat.files = cat.files.filter((x) => x.id !== f.id);
      renderCatalog();
      return;
    }
    toast('Descargando…');
    const blob = await drive.download(f.id);
    if (k === 'ghost') {
      if (ghostOverride) URL.revokeObjectURL(ghostOverride);
      ghostOverride = URL.createObjectURL(blob);
      settings.tools.ghost = true;
      persistSettings();
      applyToolState();
      $('#catClose').click();
      toast('Guía fantasma activada');
      return;
    }
    const { blob: b, w, h } = await normalizeImport(new File([blob], f.name, { type: blob.type || 'image/jpeg' }));
    const base = f.name.replace(/\.[^.]+$/, '');
    // La foto del catálogo ya está procesada: arranca sin ediciones.
    const extra = k === 'edit'
      ? { driveFileId: f.id, driveName: f.name, name: base, edits: cloneEdits() }
      : { name: base.replace(suffixRegex(), ''), edits: cloneEdits() };
    const p = await addPhoto(b, w, h, extra);
    showView('view-camera');
    openEditor(photos.indexOf(p));
  } catch (err) {
    if (err instanceof AuthError) { drive.connect(settings.clientId); return; }
    toast(err.message, { type: 'error' });
  }
}

init();

// Evita que el doble toque haga zoom en iOS.
document.addEventListener('dblclick', (ev) => ev.preventDefault(), { passive: false });

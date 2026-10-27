import { $, $$, toast, dialog, showSheet, closeSheet, showView, actionSheet, debounce, uid } from './ui.js';
import { db, outbox, loadSettings, saveSettings } from './db.js';
import { drive, AuthError, uniqueName, cleanName } from './drive.js';
import { Camera } from './camera.js';
import { Renderer } from './render.js';
import { BASE_EDITS, cloneEdits, normalizeImport } from './process.js';
import { GOOGLE_CLIENT_ID, APP_VERSION } from './config.js';
import { folderTarget, folderSupported, makeDriveTarget, sharedTarget, NeedsGesture } from './targets.js';
import { uploadShared } from './shared.js';
import { stitchPanorama, warmPanorama } from './pano.js';

/* ================================================================== */
/* Estado                                                              */
/* ================================================================== */

const settings = loadSettings({
  dest: folderSupported ? 'folder' : 'share', // 'folder' | 'share' | 'drive' | 'shared'
  alsoShared: false,       // además del destino, subir una copia a «Fotos compartidas»
  clientId: GOOGLE_CLIENT_ID,
  folder: null,            // carpeta de Drive {id, name}
  outSize: 2048,
  jpgQ: 90,
  autoApply: false,
  keepOriginal: false,
  sep: '_',
  haptics: true,
  defaultEdits: { ...BASE_EDITS, bg: 'auto', aspect: '1', autoCenter: true, margin: 8 },
  tools: { grid: false, square: false, ghost: false, timer: false, burst: false, pano: false },
});
settings.tools.pano ??= false;
if (!settings.clientId && GOOGLE_CLIENT_ID) settings.clientId = GOOGLE_CLIENT_ID;
if (settings.dest === 'folder' && !folderSupported) settings.dest = 'share';
const persistSettings = () => saveSettings(settings);

const driveTarget = makeDriveTarget(settings);
// Destino actual (null = «Guardar en Archivos» / Compartir).
const TARGETS = { folder: folderTarget, drive: driveTarget, shared: sharedTarget };
const target = () => TARGETS[settings.dest] || null;

let photos = [];              // fotos de la sesión (aún no guardadas)
const thumbUrls = new Map();  // id → objectURL
let uploading = false;
let lastBatch = null;         // para «Deshacer»
let ghostOverride = null;     // URL de una foto del catálogo usada como fantasma
let panoFrames = [];          // fotos de la panorámica en curso (solo en memoria)
let panoBusy = false;
let panoStep = '';

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
  await folderTarget.load();
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
  bindPano();
  applyToolState();
  renderTray();
  updateFolderChip();
  startCamera();
  loadOutbox();
  window.addEventListener('online', () => { processQueue(); pumpOutbox(); });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  }
  setupAutoUpdate();
  setupInstall();

  if (photos.some((p) => p.status === 'queued')) processQueue();
  loadNameSuggestions();
}

/* ================================================================== */
/* Actualización automática e instalación                              */
/* ================================================================== */

// Al volver a la app (o cada 30 min) se compara la versión publicada con la que está corriendo.
// Si hay una nueva, se recarga sola apenas no haya nada en curso (guardado, edición, temporizador).
function setupAutoUpdate() {
  const prev = localStorage.getItem('njb-version');
  if (prev && prev !== APP_VERSION) toast(`App actualizada a la versión ${APP_VERSION}`, { type: 'ok' });
  localStorage.setItem('njb-version', APP_VERSION);

  let pending = false;
  const safeToReload = () => !uploading && !shooting && !encoding && !panoBusy && !panoFrames.length && !ed.photo
    && $('#dialog').classList.contains('hidden')
    && $('#view-camera').classList.contains('active');
  const tryReload = () => {
    if (!pending) return;
    if (safeToReload()) location.reload();
    else setTimeout(tryReload, 3000);
  };
  const check = async () => {
    if (pending || !navigator.onLine) return;
    try {
      const txt = await (await fetch('js/config.js', { cache: 'no-store' })).text();
      const remote = txt.match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1];
      if (remote && remote !== APP_VERSION) { pending = true; tryReload(); }
    } catch { /* sin conexión */ }
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  setInterval(check, 30 * 60 * 1000);
  setTimeout(check, 5000);
}

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = () => /Android/i.test(navigator.userAgent);
const APK_URL = 'descargas/njb-camara.apk';
let installEvent = null;

function setupInstall() {
  const btn = $('#installBtn');
  const refresh = () => { btn.hidden = isStandalone() || (!installEvent && !isIOS() && !isAndroid()); };
  window.addEventListener('beforeinstallprompt', (ev) => { ev.preventDefault(); installEvent = ev; refresh(); offerInstall(); });
  if (isAndroid()) offerInstall();
  window.addEventListener('appinstalled', () => { installEvent = null; refresh(); toast('¡App instalada! Abrila desde el ícono NJB', { type: 'ok' }); });
  btn.addEventListener('click', installApp);
  refresh();
  if (isIOS()) offerInstall();
}

// Sugerencia única (por día) de instalar, si todavía se usa desde el navegador.
function offerInstall() {
  if (isStandalone()) return;
  // No tapar otro aviso (p. ej. «App actualizada»): reintentar más tarde.
  if (!$('#toast').classList.contains('hidden')) { setTimeout(offerInstall, 4000); return; }
  const last = Number(localStorage.getItem('njb-install-offer') || 0);
  if (Date.now() - last < 24 * 3600 * 1000) return;
  localStorage.setItem('njb-install-offer', String(Date.now()));
  toast('Instalá NJB como app en tu pantalla de inicio', { action: installApp, actionLabel: 'Instalar', ms: 8000 });
}

async function installApp() {
  // Android: la app nativa (APK) es la opción principal.
  if (isAndroid()) {
    const k = await actionSheet('Instalar NJB Cámara', [
      { key: 'apk', label: '📦 Descargar app para Android (APK, recomendado)' },
      ...(installEvent ? [{ key: 'pwa', label: 'Instalar desde Chrome (acceso directo)' }] : []),
    ]);
    if (k === 'apk') {
      location.href = APK_URL;
      await dialog({
        title: 'Instalar el APK',
        text: '1. Abrí el archivo «njb-camara.apk» cuando termine de descargar.\n2. Si Android pregunta, permití «Instalar apps de esta fuente» para Chrome.\n3. Tocá «Instalar».\n\nLa app se actualiza sola: no hace falta volver a descargarla.',
        okLabel: 'Entendido',
        noCancel: true,
      });
      return;
    }
    if (k !== 'pwa') return;
  }
  if (installEvent) {
    installEvent.prompt();
    await installEvent.userChoice.catch(() => {});
    installEvent = null;
    $('#installBtn').hidden = true;
    return;
  }
  if (isIOS()) {
    const safari = !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
    await dialog({
      title: 'Instalar en iPhone',
      text: safari
        ? '1. Tocá el botón Compartir (cuadrado con flecha ↑) abajo en Safari.\n2. Elegí «Agregar a pantalla de inicio».\n3. Tocá «Agregar».\n\nLa app queda con su ícono y se actualiza sola.'
        : 'Abrí este mismo link en Safari para poder instalarla:\nCompartir → «Agregar a pantalla de inicio».',
      okLabel: 'Entendido',
      noCancel: true,
    });
    return;
  }
  await dialog({
    title: 'Instalar app',
    text: 'En el menú del navegador (⋮) elegí «Instalar app» o «Agregar a pantalla principal».',
    okLabel: 'Entendido',
    noCancel: true,
  });
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
  updatePanoBar();
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

// El obturador solo congela el cuadro (instantáneo); la codificación a JPG va en una cola
// aparte y en orden, así se pueden sacar fotos seguidas sin esperar.
let shooting = false;
let encoding = 0;
let encodeChain = Promise.resolve();

function queueEncode(frame, pano) {
  encoding++;
  encodeChain = encodeChain.then(async () => {
    try {
      const { blob, w, h } = await camera.encode(frame);
      if (pano) { frame.close?.(); addPanoFrame(blob, w, h); }
      else await addPhoto(blob, w, h, {}, frame);
    } catch (err) {
      toast('Error al capturar: ' + err.message, { type: 'error' });
    } finally {
      encoding--;
    }
  });
}

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
    // Si se acumulan muchas sin codificar, esperamos un poco (cuida la memoria del celular).
    if (encoding >= 3) await encodeChain;
    const shots = settings.tools.burst ? 3 : 1;
    for (let i = 0; i < shots; i++) {
      const fx = $('#flashFx');
      fx.classList.remove('go'); void fx.offsetWidth; fx.classList.add('go');
      queueEncode(await camera.grab(), settings.tools.pano);
      if (i < shots - 1) await new Promise((r) => setTimeout(r, 200));
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

// frame (opcional): el cuadro ya decodificado, para que la miniatura no tenga que volver a leer el JPG.
async function addPhoto(blob, w, h, extra = {}, frame = null) {
  const edits = settings.autoApply ? cloneEdits(settings.defaultEdits) : cloneEdits();
  if (settings.tools.square && !settings.autoApply) edits.aspect = '1';
  const photo = {
    id: uid(), createdAt: Date.now(), name: cleanName($('#productName').value),
    blob, w, h, edits, status: 'new', ...extra,
  };
  photos.push(photo);
  if (frame) renderer.bitmaps.set(photo.id, frame);
  // Se guarda en segundo plano: la foto ya está en la bandeja.
  db.put(photo).catch((err) => toast('Sin espacio para guardar la foto: ' + err.message, { type: 'error' }));
  renderTray();
  refreshThumb(photo);
  return photo;
}

/* ---------- panorámica ---------- */

function addPanoFrame(blob, w, h) {
  panoFrames.push({ blob, w, h });
  updatePanoBar();
}

function updatePanoBar() {
  const n = panoFrames.length;
  $('#panoBar').classList.toggle('hidden', !settings.tools.pano && !n && !panoBusy);
  $('#panoText').textContent = panoBusy ? panoStep
    : n ? `Panorámica · ${n} foto${n > 1 ? 's' : ''}${n < 2 ? ' (mínimo 2)' : ''}`
    : 'Panorámica: mové el celu de a poco, superponiendo 30-50%';
  $('#panoJoin').disabled = panoBusy || n < 2;
  $('#panoCancel').hidden = panoBusy || !n;
}

async function joinPanorama() {
  if (panoBusy || panoFrames.length < 2) return;
  const frames = panoFrames;
  panoFrames = [];
  panoBusy = true;
  panoStep = 'Preparando…';
  updatePanoBar();
  try {
    const { blob, w, h } = await stitchPanorama(frames.map((f) => f.blob), (s) => { panoStep = s; updatePanoBar(); });
    // Mantiene la forma de la panorámica aunque el estilo por defecto sea cuadrado.
    const edits = settings.autoApply ? cloneEdits({ ...settings.defaultEdits, aspect: 'orig' }) : cloneEdits();
    await addPhoto(blob, w, h, { edits, pano: true });
    toast(`Panorámica lista (${w}×${h})`, { type: 'ok' });
  } catch (err) {
    panoFrames = frames.concat(panoFrames); // quedan para reintentar o descartar
    toast('Panorámica: ' + err.message, { type: 'error', ms: 7000 });
  } finally {
    panoBusy = false;
    updatePanoBar();
  }
}

function bindPano() {
  $('#panoJoin').addEventListener('click', joinPanorama);
  $('#panoCancel').addEventListener('click', async () => {
    if (!await dialog({ title: `¿Descartar ${panoFrames.length} foto(s) de la panorámica?`, okLabel: 'Descartar', danger: true })) return;
    panoFrames = [];
    updatePanoBar();
  });
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
    if (k === 'pano' && settings.tools.pano) warmPanorama();
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
/* Guardar                                                             */
/* ================================================================== */

const DEST_LABEL = { folder: 'Carpeta del dispositivo', share: 'Guardar en Archivos / Compartir', drive: 'Google Drive directo' };

function bindSaving() {
  $('#btnSave').addEventListener('click', onSave);
  $('#queuePill').addEventListener('click', async () => {
    if (settings.dest === 'drive' && !drive.token()) { connectDrive(); return; }
    if (settings.dest === 'folder') {
      try { await folderTarget.prepare({ interactive: true }); } catch (err) { toast(err.message, { type: 'error' }); return; }
    }
    processQueue();
  });
}

function connectDrive() {
  try { drive.connect(settings.clientId); } catch (err) { toast(err.message, { type: 'error' }); showSettings(); }
}

async function onSave() {
  if (!photos.length || uploading) return;
  const t = target();

  // Carpeta del dispositivo: elegirla o renovar el permiso aprovechando este toque.
  if (settings.dest === 'folder') {
    try {
      if (!folderTarget.configured()) { if (!await pickLocalFolder()) return; }
      await folderTarget.prepare({ interactive: true });
    } catch (err) { toast(err.message, { type: 'error' }); return; }
  }
  if (settings.dest === 'drive') {
    if (!settings.clientId) { toast('Falta el Client ID de Google (Ajustes)'); showSettings(); return; }
    if (!settings.folder) { toast('Primero elegí la carpeta de Drive'); openDriveFolderSheet(); return; }
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

  if (!t) { shareFallback(); return; }
  // Drive: si el token venció, redirigimos ya (estamos dentro del toque del usuario).
  if (settings.dest === 'drive' && !drive.token()) { connectDrive(); return; }
  processQueue();
}

function updateQueuePill() {
  const pill = $('#queuePill');
  const q = photos.filter((p) => p.status === 'queued' || p.status === 'error').length;
  if (!q || uploading || !target()) { pill.classList.add('hidden'); return; }
  pill.textContent = settings.dest === 'drive' && !drive.token()
    ? `${q} pendiente(s) · tocar para reconectar Drive`
    : `${q} pendiente(s) · tocar para guardar`;
  pill.classList.remove('hidden');
}

async function processQueue() {
  const t = target();
  if (uploading || !t) return;
  const queue = photos.filter((p) => p.status === 'queued' || p.status === 'error');
  if (!queue.length) return;
  try {
    await t.prepare();
  } catch (err) {
    // Sin permiso/sesión todavía: queda en cola hasta que el usuario toque la píldora.
    if (!(err instanceof NeedsGesture) && !(err instanceof AuthError)) toast(err.message, { type: 'error' });
    updateQueuePill();
    return;
  }

  uploading = true;
  renderTray();
  const dest = t.label();
  const batch = { kind: t.kind, items: [] };
  let ok = 0, failed = 0, authErr = null;
  const fail = (p, err) => {
    p.status = 'error';
    p.error = err.message;
    failed++;
    toast(`Error con «${p.name}»: ${err.message}`, { type: 'error', ms: 5000 });
  };
  // Mientras una foto sube por la red se va preparando la siguiente (la carpeta local es instantánea).
  const parallel = t.kind === 'folder' ? 1 : 3;
  const inflight = new Set();
  try {
    const taken = await t.names();
    for (const [i, p] of queue.entries()) {
      if (authErr) break;
      p.status = 'uploading';
      renderTray();
      showUploadProgress(i + 1, queue.length);
      let blob;
      try {
        blob = await renderer.exportBlob(p, p.edits, exportSize(p), settings.jpgQ / 100);
      } catch (err) {
        fail(p, err);
        await db.put(p).catch(() => {});
        renderTray();
        continue;
      }
      const replacing = p.replace && p.replace.kind === t.kind;
      const keep = replacing && p.replace.name.replace(/\.[^.]+$/, '').startsWith(p.name);
      const name = keep ? p.replace.name : uniqueName(p.name, taken, settings.sep);
      const job = (async () => {
        try {
          const id = replacing ? await t.replace(blob, p.replace.id, name) : await t.create(blob, name);
          const origId = settings.keepOriginal ? await t.saveOriginal(p.blob, p.name, settings.sep) : null;
          if (settings.alsoShared && t.kind !== 'shared') mirrorShared(blob, name);
          batch.items.push({ photo: { ...p, status: 'new' }, id, origId, replaced: replacing });
          photos.splice(photos.indexOf(p), 1);
          await db.delete(p.id);
          forgetPhoto(p);
          ok++;
        } catch (err) {
          if (err instanceof AuthError) { p.status = 'queued'; authErr = err; } else fail(p, err);
          await db.put(p).catch(() => {});
        }
        renderTray();
      })();
      inflight.add(job);
      job.finally(() => inflight.delete(job));
      if (inflight.size >= parallel) await Promise.race(inflight);
    }
    await Promise.all(inflight);
    if (authErr) throw authErr;
  } catch (err) {
    if (err instanceof AuthError) {
      toast('La sesión de Drive venció. Tocá «reconectar» para continuar.', { type: 'error', ms: 6000 });
    } else {
      toast('No se pudo guardar: ' + err.message, { type: 'error', ms: 6000 });
      queue.forEach((p) => { if (p.status === 'uploading') p.status = 'error'; });
    }
  } finally {
    uploading = false;
    renderTray();
  }

  if (ok) {
    lastBatch = batch;
    toast(`${ok} foto(s) guardadas en «${dest}»${failed ? ` · ${failed} con error` : ''}`, {
      type: failed ? 'error' : 'ok',
      action: t.trash && batch.items.some((i) => !i.replaced) ? undoLastBatch : null,
      actionLabel: 'Deshacer',
    });
    loadNameSuggestions();
  }
}

// Las panorámicas salen a resolución completa: para eso se sacaron.
const exportSize = (p) => (p.pano ? 0 : settings.outSize);

/* ---------- copia a «Fotos compartidas» (en segundo plano, con reintentos) ---------- */

const ob = { items: [], active: 0, timer: null, warned: false };

async function loadOutbox() {
  try { ob.items = (await outbox.all()).map((it) => ({ ...it, tries: 0, next: 0 })); } catch { ob.items = []; }
  pumpOutbox();
}

function mirrorShared(blob, name) {
  const it = { id: uid(), blob, name, tries: 0, next: 0 };
  ob.items.push(it);
  outbox.put({ id: it.id, blob, name }).catch(() => {});
  pumpOutbox();
}

function pumpOutbox() {
  clearTimeout(ob.timer);
  const now = Date.now();
  while (ob.active < 3) {
    const it = ob.items.find((x) => !x.busy && x.next <= now);
    if (!it) break;
    it.busy = true;
    ob.active++;
    uploadShared(it.blob, it.name)
      .then(() => {
        ob.items = ob.items.filter((x) => x !== it);
        outbox.delete(it.id).catch(() => {});
        if (!ob.items.length) ob.warned = false;
      })
      .catch((err) => {
        it.tries++;
        it.next = Date.now() + Math.min(5 * 60_000, 5000 * 2 ** it.tries);
        if (!ob.warned) { ob.warned = true; toast(`No se pudo subir a Fotos compartidas (${err.message}). Se reintenta sola.`, { type: 'error', ms: 5000 }); }
      })
      .finally(() => { it.busy = false; ob.active--; updateFolderChip(); pumpOutbox(); });
  }
  const waiting = ob.items.filter((x) => !x.busy);
  if (waiting.length && ob.active < 3) ob.timer = setTimeout(pumpOutbox, Math.max(1000, Math.min(...waiting.map((x) => x.next)) - now));
  updateFolderChip();
}

function showUploadProgress(i, n) {
  const pill = $('#queuePill');
  pill.textContent = `Guardando ${i}/${n}…`;
  pill.classList.remove('hidden');
}

async function undoLastBatch() {
  const b = lastBatch;
  lastBatch = null;
  const t = target();
  if (!b || !t || t.kind !== b.kind || !t.trash) return;
  let n = 0;
  for (const it of b.items) {
    if (it.replaced) continue;
    try {
      await t.trash(it.id);
      if (it.origId) await t.trash(it.origId).catch(() => {});
      photos.push(it.photo);
      await db.put(it.photo);
      refreshThumb(it.photo);
      n++;
    } catch (err) { toast('No se pudo deshacer: ' + err.message, { type: 'error' }); }
  }
  photos.sort((a, c) => a.createdAt - c.createdAt);
  renderTray();
  if (n) toast(b.kind === 'drive' ? `Deshecho: ${n} foto(s) volvieron a la bandeja (en Drive quedaron en la papelera)` : `Deshecho: ${n} foto(s) volvieron a la bandeja`);
}

// iPhone (o sin carpeta): se generan los JPG y se abre el menú Compartir → «Guardar en Archivos».
async function shareFallback() {
  const queue = photos.filter((p) => p.status === 'queued');
  uploading = true;
  renderTray();
  const files = [];
  const taken = new Set();
  try {
    for (const [i, p] of queue.entries()) {
      showUploadProgress(i + 1, queue.length);
      const blob = await renderer.exportBlob(p, p.edits, exportSize(p), settings.jpgQ / 100);
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
      ? 'Tocá «Guardar», elegí «Guardar en Archivos» y después la carpeta (puede ser una carpeta de Drive). La próxima vez el iPhone te propone la misma carpeta.'
      : 'Se descargarán a la carpeta de descargas del navegador.',
    okLabel: canShare ? 'Guardar' : 'Descargar',
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
    if (err.name !== 'AbortError') toast('No se pudo guardar: ' + err.message, { type: 'error' });
    return;
  }
  if (settings.alsoShared) files.forEach((f) => mirrorShared(f, f.name));
  if (await dialog({ title: '¿Se guardaron bien?', text: 'Si es así, quito las fotos de la bandeja.', okLabel: 'Sí, quitar' })) {
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
/* Elegir destino / carpeta                                            */
/* ================================================================== */

function updateFolderChip() {
  const chip = $('#btnFolder');
  let label, warn = false;
  if (settings.dest === 'folder') { label = folderTarget.label() || 'Elegir carpeta'; warn = !folderTarget.configured(); }
  else if (settings.dest === 'drive') { label = settings.folder?.name || 'Elegir carpeta de Drive'; warn = !settings.folder; }
  else if (settings.dest === 'shared') label = 'Fotos compartidas';
  else label = 'Guardar en Archivos';
  if (settings.alsoShared && settings.dest !== 'shared') label += ' + Compartidas';
  if (ob.items.length) label += ` · ☁${ob.items.length}`;
  $('#folderName').textContent = label;
  chip.classList.toggle('warn', warn);
  $('#btnCatalog').hidden = !target()?.list;
}

async function pickLocalFolder() {
  try {
    await folderTarget.pick();
    updateFolderChip();
    toast(`Las fotos se guardarán en «${folderTarget.label()}»`, { type: 'ok' });
    loadNameSuggestions();
    return true;
  } catch (err) {
    if (err.name !== 'AbortError') toast('No se pudo usar esa carpeta: ' + err.message, { type: 'error' });
    return false;
  }
}

async function onFolderChip() {
  if (settings.dest === 'folder') {
    if (await pickLocalFolder()) processQueue();
  } else if (settings.dest === 'drive') {
    openDriveFolderSheet();
  } else {
    const k = await actionSheet('¿Dónde se guardan las fotos?', [
      { key: 'info', label: settings.dest === 'shared'
        ? 'Se suben a la carpeta «Fotos compartidas» de Google Drive'
        : 'Al guardar elegís la carpeta con «Guardar en Archivos»' },
      { key: 'settings', label: 'Cambiar destino en Ajustes' },
    ]);
    if (k === 'settings') showSettings();
  }
}

/* ---------- carpeta de Drive (modo avanzado) ---------- */

const folderNav = { stack: [{ id: 'root', name: 'Mi unidad' }] };

function openDriveFolderSheet() {
  if (!settings.clientId) { toast('Falta el Client ID de Google (Ajustes)'); showSettings(); return; }
  if (!drive.token()) { connectDrive(); return; }
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
    if (err instanceof AuthError) { closeSheet(); connectDrive(); return; }
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = err.message;
    list.append(li);
  }
}

function bindFolderSheet() {
  $('#btnFolder').addEventListener('click', onFolderChip);
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
  const t = target();
  if (!t?.allNames || !t.configured()) return;
  try {
    if (t.kind === 'folder' && !await folderTarget.hasPermission()) return;
    if (t.kind === 'drive' && !drive.token()) return;
    const names = await t.allNames();
    const re = suffixRegex();
    const bases = new Set(names.map((n) => n.replace(/\.[^.]+$/, '').replace(re, '')));
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
  if (!settings.clientId) { st.textContent = 'Falta el Client ID.'; return; }
  if (!drive.token()) { st.textContent = drive.wasConnected() ? 'Sesión vencida — tocá Conectar' : 'No conectado'; return; }
  st.textContent = 'Conectado';
  try { const u = await drive.user(); st.textContent = `Conectado como ${u.emailAddress}`; } catch { /* nada */ }
}

function syncDestUI() {
  $('#dest').value = settings.dest;
  $('#destFolderRow').classList.toggle('hidden', settings.dest !== 'folder');
  $('#destFolderName').textContent = folderTarget.label() || 'ninguna';
  $('#driveSection').classList.toggle('hidden', settings.dest !== 'drive');
  $('#alsoSharedRow').classList.toggle('hidden', settings.dest === 'shared');
  $('#alsoShared').checked = settings.alsoShared;
  $('#destHint').textContent = {
    folder: 'Las fotos se escriben directo en la carpeta que elijas. En una PC podés elegir la carpeta de Google Drive para escritorio y se sincroniza sola.',
    share: 'Al guardar se abre el menú del sistema: elegí «Guardar en Archivos» y la carpeta (en iPhone puede ser una carpeta de Drive).',
    drive: 'Sube directo a Google Drive. Requiere un Client ID propio de Google Cloud y que tu cuenta esté autorizada.',
    shared: 'Se suben solas a la carpeta «Fotos compartidas» de Google Drive, sin iniciar sesión. Es lo más rápido en iPhone. Si no hay conexión quedan en cola y se suben al volver.',
  }[settings.dest];
}

function showSettings() {
  $('#clientId').value = settings.clientId || '';
  $('#outSize').value = String(settings.outSize);
  $('#jpgQ').value = settings.jpgQ;
  $('#jpgQOut').textContent = settings.jpgQ + '%';
  $('#autoApply').checked = settings.autoApply;
  $('#keepOriginal').checked = settings.keepOriginal;
  $('#sep').value = settings.sep;
  $('#haptics').checked = settings.haptics;
  syncDestUI();
  refreshDriveStatus();
  showSheet('#sheetSettings');
}

function bindSettings() {
  $('#btnSettings').addEventListener('click', showSettings);
  const folderOpt = $('#dest option[value="folder"]');
  folderOpt.disabled = !folderSupported;
  if (!folderSupported) folderOpt.textContent += ' (no disponible en este navegador)';
  $('#dest').addEventListener('change', (ev) => {
    settings.dest = ev.target.value;
    persistSettings();
    syncDestUI();
    updateFolderChip();
    updateQueuePill();
    loadNameSuggestions();
  });
  $('#destPick').addEventListener('click', async () => { if (await pickLocalFolder()) syncDestUI(); });
  $('#alsoShared').addEventListener('change', (ev) => { settings.alsoShared = ev.target.checked; persistSettings(); updateFolderChip(); });
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
    connectDrive();
  });
  $('#driveDisconnect').addEventListener('click', () => { drive.disconnect(); refreshDriveStatus(); toast('Drive desconectado'); });
}

/* ================================================================== */
/* Catálogo (contenido de la carpeta destino)                          */
/* ================================================================== */

const cat = { stack: [], files: [], folders: [], urls: new Map(), observer: null, active: 0 };

function bindCatalog() {
  $('#btnCatalog').addEventListener('click', async () => {
    const t = target();
    if (!t) return;
    try {
      if (t.kind === 'folder') {
        if (!t.configured() && !await pickLocalFolder()) return;
        await folderTarget.prepare({ interactive: true });
      } else {
        if (!drive.token()) { connectDrive(); return; }
        if (!settings.folder) { openDriveFolderSheet(); return; }
      }
    } catch (err) { toast(err.message, { type: 'error' }); return; }
    cat.stack = [t.rootNode()];
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
    const { folders, files } = await target().list(cur);
    cat.folders = folders;
    cat.files = files;
    renderCatalog();
  } catch (err) {
    if (err instanceof AuthError) { connectDrive(); return; }
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
    const url = cat.urls.get(f.key);
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
    f.thumb()
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        cat.urls.set(f.key, url);
        el.querySelector('img').src = url;
      })
      .catch(() => {})
      .finally(() => { cat.active--; pumpCatThumbs(); });
  }
}

async function catalogAction(f) {
  const t = target();
  const k = await actionSheet(f.name, [
    { key: 'edit', label: 'Editar y volver a guardar (reemplaza)' },
    { key: 'copy', label: 'Usar como base para una foto nueva' },
    { key: 'ghost', label: 'Usar como guía fantasma en la cámara' },
    { key: 'trash', label: t.kind === 'drive' ? 'Mover a la papelera' : 'Eliminar', danger: true },
  ]);
  if (!k) return;
  try {
    if (k === 'trash') {
      const text = t.kind === 'drive' ? 'Se mueve a la papelera de Drive.' : 'Se borra de la carpeta.';
      if (!await dialog({ title: `¿Eliminar «${f.name}»?`, text, okLabel: 'Eliminar', danger: true })) return;
      await t.trash(f.id);
      cat.files = cat.files.filter((x) => x.id !== f.id);
      renderCatalog();
      return;
    }
    const blob = await f.blob();
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
      ? { replace: { kind: t.kind, id: f.id, name: f.name }, name: base, edits: cloneEdits() }
      : { name: base.replace(suffixRegex(), ''), edits: cloneEdits() };
    const p = await addPhoto(b, w, h, extra);
    showView('view-camera');
    openEditor(photos.indexOf(p));
  } catch (err) {
    if (err instanceof AuthError) { connectDrive(); return; }
    toast(err.message, { type: 'error' });
  }
}

init();

// Evita que el doble toque haga zoom en iOS.
document.addEventListener('dblclick', (ev) => ev.preventDefault(), { passive: false });

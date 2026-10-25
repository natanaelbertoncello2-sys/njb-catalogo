// Motor de edición no destructiva.
// Pipeline: geometría (rotar/enderezar/recortar) → máscara de fondo → luz y color → composición final.
// Todo se recalcula desde la foto original, así que cualquier ajuste se puede deshacer.

export const BASE_EDITS = Object.freeze({
  bg: 'none',          // 'none' | 'auto' (fondo liso) | 'ai'
  tol: 30,             // tolerancia del fondo liso
  feather: 1,          // suavizado del borde de la máscara
  bgColor: '#ffffff',
  shadow: 0,           // 0-100 sombra suave bajo el producto
  wand: [],            // toques de varita [{x, y}] normalizados sobre la imagen recortada
  aspect: 'orig',      // 'orig' | relación ancho/alto como string ('1', '0.8', ...)
  autoCenter: true,
  margin: 8,           // % de margen alrededor del producto
  rot: 0,              // múltiplos de 90°
  flip: false,
  straighten: 0,       // grados
  crop: null,          // {x, y, w, h} normalizado sobre la imagen rotada
  autoLevels: false,
  exposure: 0, contrast: 0, saturation: 0, warmth: 0, sharpen: 0,
});

export const cloneEdits = (e) => JSON.parse(JSON.stringify({ ...BASE_EDITS, ...(e || {}) }));

// iOS Safari limita los canvas a ~16,7 MP.
const MAX_AREA = 16_000_000;
const MASK_MAX_SIDE = 1100;

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export const canvasToBlob = (cv, type = 'image/jpeg', q = 0.92) =>
  new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('No se pudo generar la imagen'))), type, q));

export async function loadBitmap(blob) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(blob); } catch { /* fallback abajo */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const dims = (src) => [src.naturalWidth || src.width, src.naturalHeight || src.height];

// Reduce fotos gigantes (24/48 MP) para que entren en memoria del iPhone. Devuelve el blob a guardar.
export async function normalizeImport(file, maxSide = 4096) {
  const bmp = await loadBitmap(file);
  const [w, h] = dims(bmp);
  if (Math.max(w, h) <= maxSide && /jpe?g|png|webp/i.test(file.type || '')) {
    return { blob: file, w, h, bmp };
  }
  const s = Math.min(1, maxSide / Math.max(w, h));
  const cv = makeCanvas(w * s, h * s);
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
  const blob = await canvasToBlob(cv, 'image/jpeg', 0.95);
  return { blob, w: cv.width, h: cv.height, bmp: cv };
}

/* ------------------------------------------------------------------ */
/* Geometría                                                           */
/* ------------------------------------------------------------------ */

export const geomKey = (e) => JSON.stringify([e.rot, e.flip, e.straighten, e.crop]);

export function rotatedSize(src, rot) {
  const [w, h] = dims(src);
  return ((rot % 4) + 4) % 2 ? [h, w] : [w, h];
}

// Dibuja la foto rotada/enderezada/recortada con el lado mayor ≤ maxSide (0 = sin límite).
export function renderGeometry(src, e, maxSide, ignoreCrop = false) {
  const [w, h] = dims(src);
  const rot = ((e.rot % 4) + 4) % 4;
  const [rw, rh] = rotatedSize(src, rot);
  const th = Math.abs(e.straighten || 0) * Math.PI / 180;
  const k = th ? Math.max((rw * Math.cos(th) + rh * Math.sin(th)) / rw, (rw * Math.sin(th) + rh * Math.cos(th)) / rh) : 1;
  const c = (!ignoreCrop && e.crop) || { x: 0, y: 0, w: 1, h: 1 };
  const cx = c.x * rw, cy = c.y * rh;
  const cw = Math.max(1, c.w * rw), ch = Math.max(1, c.h * rh);
  let s = maxSide ? Math.min(1, maxSide / Math.max(cw, ch)) : 1;
  s = Math.min(s, Math.sqrt(MAX_AREA / (cw * ch)));
  const cv = makeCanvas(cw * s, ch * s);
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.scale(cv.width / cw, cv.height / ch);
  ctx.translate(-cx, -cy);
  ctx.translate(rw / 2, rh / 2);
  if (e.straighten) ctx.rotate(e.straighten * Math.PI / 180);
  ctx.scale(e.flip ? -k : k, k);
  if (rot) ctx.rotate(rot * Math.PI / 2);
  ctx.drawImage(src, -w / 2, -h / 2);
  return cv;
}

/* ------------------------------------------------------------------ */
/* Máscara de fondo                                                    */
/* ------------------------------------------------------------------ */

function downscaled(cv, maxSide) {
  const s = Math.min(1, maxSide / Math.max(cv.width, cv.height));
  if (s === 1) return cv;
  const out = makeCanvas(cv.width * s, cv.height * s);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cv, 0, 0, out.width, out.height);
  return out;
}

const median = (arr) => { const a = Float32Array.from(arr).sort(); return a[a.length >> 1]; };

// Fondo liso: crecimiento de región desde los bordes (y desde los toques de varita).
// Compara en YCbCr dando menos peso al brillo, así las sombras suaves del fondo también se borran.
export function computeAutoMask(geomCanvas, e) {
  const small = downscaled(geomCanvas, MASK_MAX_SIDE);
  const W = small.width, H = small.height, N = W * H;
  const px = small.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const Y = new Float32Array(N), Cb = new Float32Array(N), Cr = new Float32Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    const r = px[j], g = px[j + 1], b = px[j + 2];
    Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    Cb[i] = 0.564 * (b - Y[i]);
    Cr[i] = 0.713 * (r - Y[i]);
  }

  const border = [];
  const step = Math.max(1, Math.floor((W + H) / 400));
  for (let x = 0; x < W; x += step) border.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y += step) border.push(y * W, y * W + W - 1);

  const bg = new Uint8Array(N); // 1 = fondo
  const tol = e.tol;
  const queue = new Int32Array(N);

  const grow = (seeds, refY, refCb, refCr, loose) => {
    let head = 0, tail = 0;
    const dRef = (i) => {
      const dy = (Y[i] - refY) * 0.45, db = Cb[i] - refCb, dr = Cr[i] - refCr;
      return Math.sqrt(dy * dy + db * db + dr * dr);
    };
    const dNb = (a, b) => {
      const dy = (Y[a] - Y[b]) * 0.6, db = Cb[a] - Cb[b], dr = Cr[a] - Cr[b];
      return Math.sqrt(dy * dy + db * db + dr * dr);
    };
    for (const s of seeds) {
      if (!bg[s] && (loose || dRef(s) < tol * 1.6)) { bg[s] = 1; queue[tail++] = s; }
    }
    const localTol = tol * 0.22, farTol = tol * 2.4;
    while (head < tail) {
      const i = queue[head++];
      const x = i % W;
      const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W];
      for (const n of nb) {
        if (n < 0 || n >= N || bg[n]) continue;
        const d = dRef(n);
        if (d < tol || (d < farTol && dNb(i, n) < localTol)) { bg[n] = 1; queue[tail++] = n; }
      }
    }
  };

  if (border.length) {
    grow(border, median(border.map((i) => Y[i])), median(border.map((i) => Cb[i])), median(border.map((i) => Cr[i])), false);
  }
  for (const p of e.wand || []) {
    const x = Math.min(W - 1, Math.max(0, Math.round(p.x * (W - 1))));
    const y = Math.min(H - 1, Math.max(0, Math.round(p.y * (H - 1))));
    const i = y * W + x;
    grow([i], Y[i], Cb[i], Cr[i], true);
  }

  // Quitar motitas sueltas: píxeles de producto rodeados casi por completo de fondo.
  const alpha = new Uint8ClampedArray(N);
  for (let i = 0; i < N; i++) alpha[i] = bg[i] ? 0 : 255;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!alpha[i]) continue;
      const n = bg[i - 1] + bg[i + 1] + bg[i - W] + bg[i + W] + bg[i - W - 1] + bg[i - W + 1] + bg[i + W - 1] + bg[i + W + 1];
      if (n >= 7) alpha[i] = 0;
    }
  }
  return { alpha, w: W, h: H };
}

let aiLib = null;
async function loadAI() {
  if (aiLib) return aiLib;
  const sources = [
    'https://esm.sh/@imgly/background-removal@1.7.0?deps=onnxruntime-web@1.21.0',
    'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm',
  ];
  let lastErr;
  for (const url of sources) {
    try { aiLib = await import(/* @vite-ignore */ url); return aiLib; } catch (err) { lastErr = err; }
  }
  throw new Error('No se pudo cargar la IA (¿sin conexión?): ' + (lastErr?.message || lastErr));
}

// Devuelve un PNG cuyo canal alfa es la máscara del producto.
export async function computeAIMaskBlob(geomCanvas, onProgress) {
  const lib = await loadAI();
  const input = await canvasToBlob(downscaled(geomCanvas, 1024), 'image/png');
  return lib.segmentForeground(input, {
    model: 'isnet_fp16',
    output: { format: 'image/png' },
    progress: (key, cur, total) => onProgress?.(key, cur, total),
  });
}

export async function alphaFromMaskBlob(blob) {
  const bmp = await loadBitmap(blob);
  const [w, h] = dims(bmp);
  const cv = makeCanvas(w, h);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, w, h).data;
  const alpha = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 3; i < alpha.length; i++, j += 4) alpha[i] = d[j];
  return { alpha, w, h };
}

function boxBlurAlpha(a, w, h, r) {
  if (r < 1) return a;
  const tmp = new Float32Array(w * h);
  const out = new Uint8ClampedArray(w * h);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    const row = y * w;
    for (let x = -r; x <= r; x++) acc += a[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / win;
      acc += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / win;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// Escala la máscara al tamaño final aplicando el suavizado de bordes.
export function scaleMask(mask, W, H, feather) {
  let a = mask.alpha;
  if (feather > 0) a = boxBlurAlpha(boxBlurAlpha(a, mask.w, mask.h, feather), mask.w, mask.h, Math.ceil(feather / 2));
  const src = makeCanvas(mask.w, mask.h);
  const sctx = src.getContext('2d');
  const img = sctx.createImageData(mask.w, mask.h);
  for (let i = 0, j = 0; i < a.length; i++, j += 4) { img.data[j] = img.data[j + 1] = img.data[j + 2] = 255; img.data[j + 3] = a[i]; }
  sctx.putImageData(img, 0, 0);
  if (mask.w === W && mask.h === H) return src;
  const out = makeCanvas(W, H);
  const octx = out.getContext('2d');
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(src, 0, 0, W, H);
  return out;
}

// Caja del producto (normalizada) a partir de la máscara.
export function maskBBox(mask) {
  const { alpha, w, h } = mask;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (alpha[row + x] > 127) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h };
}

/* ------------------------------------------------------------------ */
/* Luz y color                                                         */
/* ------------------------------------------------------------------ */

function levelsFromHistogram(d) {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let n = 0;
  for (let j = 0; j < d.length; j += 16) { hist[0][d[j]]++; hist[1][d[j + 1]]++; hist[2][d[j + 2]]++; n++; }
  const pct = (hst, p) => { let acc = 0; const lim = n * p; for (let v = 0; v < 256; v++) { acc += hst[v]; if (acc >= lim) return v; } return 255; };
  return hist.map((hst) => {
    const lo = pct(hst, 0.004), hi = pct(hst, 0.996);
    return hi - lo < 30 ? [0, 255] : [lo, hi];
  });
}

export function hasColorEdits(e) {
  return e.autoLevels || e.exposure || e.contrast || e.saturation || e.warmth || e.sharpen;
}

export function applyColor(cv, e) {
  if (!hasColorEdits(e)) return cv;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, cv.width, cv.height);
  const d = img.data;
  const lv = e.autoLevels ? levelsFromHistogram(d) : [[0, 255], [0, 255], [0, 255]];
  const expo = Math.pow(2, e.exposure / 100);
  const con = e.contrast >= 0 ? 1 + e.contrast / 60 : 1 + e.contrast / 140;
  const warm = e.warmth / 100;
  const gains = [1 + warm * 0.12, 1 + warm * 0.02, 1 - warm * 0.12];
  const luts = [0, 1, 2].map((c) => {
    const lut = new Uint8ClampedArray(256);
    const [lo, hi] = lv[c];
    for (let v = 0; v < 256; v++) {
      let x = ((v - lo) / Math.max(1, hi - lo)) * 255;
      x = x * expo * gains[c];
      x = (x - 128) * con + 128;
      lut[v] = x;
    }
    return lut;
  });
  const sat = 1 + e.saturation / 100;
  for (let j = 0; j < d.length; j += 4) {
    let r = luts[0][d[j]], g = luts[1][d[j + 1]], b = luts[2][d[j + 2]];
    if (sat !== 1) {
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
    }
    d[j] = r; d[j + 1] = g; d[j + 2] = b;
  }
  if (e.sharpen) unsharp(d, cv.width, cv.height, e.sharpen / 100);
  ctx.putImageData(img, 0, 0);
  return cv;
}

function unsharp(d, w, h, amount) {
  const src = new Uint8ClampedArray(d);
  const k = amount * 1.2;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const p = i + c;
        const blur = (src[p - 4] + src[p + 4] + src[p - w * 4] + src[p + w * 4]) * 0.25;
        d[p] = src[p] + (src[p] - blur) * k;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Composición final                                                   */
/* ------------------------------------------------------------------ */

// geom: canvas de geometría; maskCanvas: canvas alfa del mismo tamaño (o null);
// bbox: caja del producto normalizada (o null). Devuelve {canvas, map} donde map permite
// convertir un toque sobre el resultado en coordenadas de la imagen recortada (para la varita).
export function compose(geom, colorCanvas, maskCanvas, bbox, e, maxSide) {
  const W = geom.width, H = geom.height;
  const hasBg = e.bg !== 'none' && maskCanvas;
  const ratio = e.aspect === 'orig' ? null : parseFloat(e.aspect);

  // Región de la imagen de geometría que queremos mostrar.
  let region = { x: 0, y: 0, w: W, h: H };
  let fill = true; // true: la región llena el lienzo; false: contener con márgenes

  if (hasBg && e.autoCenter && bbox) {
    region = { x: bbox.x * W, y: bbox.y * H, w: bbox.w * W, h: bbox.h * H };
    fill = false;
  } else if (ratio && !hasBg) {
    // Sin fondo removido: recortar al centro para respetar la proporción.
    if (W / H > ratio) { const nw = H * ratio; region = { x: (W - nw) / 2, y: 0, w: nw, h: H }; }
    else { const nh = W / ratio; region = { x: 0, y: (H - nh) / 2, w: W, h: nh }; }
  } else if (ratio && hasBg) {
    fill = false;
  }

  const m = hasBg && e.autoCenter && bbox ? e.margin / 100 : 0;
  const outRatio = ratio || region.w / region.h;
  // Tamaño de salida
  let OW, OH;
  const baseLong = Math.max(region.w, region.h) / (1 - 2 * m);
  const long = maxSide ? Math.min(maxSide, Math.max(baseLong, 400)) : baseLong;
  if (outRatio >= 1) { OW = long; OH = long / outRatio; } else { OH = long; OW = long * outRatio; }
  const s0 = Math.min(1, Math.sqrt(MAX_AREA / (OW * OH)));
  OW = Math.round(OW * s0); OH = Math.round(OH * s0);

  const out = makeCanvas(OW, OH);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';

  let dx, dy, dw, dh;
  if (fill) {
    dx = 0; dy = 0; dw = OW; dh = OH;
  } else {
    const availW = OW * (1 - 2 * m), availH = OH * (1 - 2 * m);
    const sc = Math.min(availW / region.w, availH / region.h);
    dw = region.w * sc; dh = region.h * sc;
    dx = (OW - dw) / 2; dy = (OH - dh) / 2;
  }

  if (hasBg) {
    ctx.fillStyle = e.bgColor;
    ctx.fillRect(0, 0, OW, OH);
    if (e.shadow > 0 && bbox) {
      // Base del producto en coordenadas de salida.
      const baseY = dy + ((bbox.y + bbox.h) * H - region.y) / region.h * dh;
      const cx = dx + ((bbox.x + bbox.w / 2) * W - region.x) / region.w * dw;
      drawShadow(ctx, cx, baseY, (bbox.w * W / region.w) * dw, (bbox.h * H / region.h) * dh, e.shadow / 100);
    }
    // Producto recortado por la máscara
    const fg = makeCanvas(W, H);
    const fctx = fg.getContext('2d');
    fctx.drawImage(colorCanvas, 0, 0);
    fctx.globalCompositeOperation = 'destination-in';
    fctx.drawImage(maskCanvas, 0, 0);
    ctx.drawImage(fg, region.x, region.y, region.w, region.h, dx, dy, dw, dh);
  } else {
    ctx.drawImage(colorCanvas, region.x, region.y, region.w, region.h, dx, dy, dw, dh);
  }

  const map = (ox, oy) => ({
    x: (region.x + ((ox - dx) / dw) * region.w) / W,
    y: (region.y + ((oy - dy) / dh) * region.h) / H,
  });
  return { canvas: out, map };
}

function drawShadow(ctx, cx, baseY, pw, ph, strength) {
  // Elipse difusa apoyada en la base del producto.
  const rx = pw * 0.42, ry = Math.max(6, ph * 0.035);
  ctx.save();
  ctx.translate(cx, baseY - ry * 0.3);
  ctx.scale(1, ry / rx);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, `rgba(0,0,0,${0.45 * strength})`);
  g.addColorStop(0.55, `rgba(0,0,0,${0.18 * strength})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

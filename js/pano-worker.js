// Worker de panorámicas: une las fotos fuera del hilo principal para que la cámara siga fluida.
// OpenCV.js (~10 MB) se descarga la primera vez y después lo sirve la caché del navegador.
/* global importScripts, PanoCore */
const CV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';
const WORK_SIDE = 2560; // lado mayor de cada foto al unir (más = más detalle, más memoria)

// Devuelve {cv} y no cv directo: el módulo de OpenCV tiene un .then propio y, si se lo resuelve
// como promesa, el navegador lo «espera» para siempre y el worker queda colgado.
let ready = null;
function loadCV() {
  if (!ready) {
    ready = (async () => {
      importScripts(CV_URL, 'pano-core.js');
      let cv = self.cv;
      if (cv instanceof Promise) cv = (await cv.then((m) => ({ m }))).m;
      else if (!cv.Mat) await new Promise((r) => { cv.onRuntimeInitialized = r; });
      return { cv };
    })();
    ready.catch(() => { ready = null; });
  }
  return ready;
}

const errText = (err) => (typeof err === 'number' ? 'Error interno de OpenCV' : err?.message || String(err));

self.onmessage = async (ev) => {
  const { id, blobs, warm } = ev.data;
  const post = (m) => self.postMessage({ id, ...m });
  if (warm) { loadCV().catch(() => {}); return; }

  const mats = [];
  try {
    if (typeof OffscreenCanvas === 'undefined') throw new Error('Este navegador no permite panorámicas (actualizalo)');
    post({ step: 'Preparando motor de panorámicas…' });
    const { cv } = await loadCV().catch(() => { throw new Error('No se pudo descargar el motor de panorámicas (¿sin conexión?)'); });
    for (const b of blobs) {
      const bmp = await createImageBitmap(b);
      const s = Math.min(1, WORK_SIDE / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
      const ctx = new OffscreenCanvas(w, h).getContext('2d');
      ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close();
      mats.push(cv.matFromImageData(ctx.getImageData(0, 0, w, h)));
    }
    const r = PanoCore.stitch(cv, mats, (t) => post({ step: t }));
    const out = new OffscreenCanvas(r.width, r.height);
    out.getContext('2d').putImageData(new ImageData(r.data, r.width, r.height), 0, 0);
    const blob = await out.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
    post({ done: true, blob, w: r.width, h: r.height });
  } catch (err) {
    post({ error: errText(err) });
  } finally {
    mats.forEach((m) => m.delete());
  }
};

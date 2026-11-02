// Worker de «Medidas reales»: detecta la referencia y mide fuera del hilo principal.
// Usa el mismo OpenCV.js que las panorámicas (se descarga una vez y queda en caché).
/* global importScripts, MeasureCore */
const CV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';

// Devuelve {cv} y no cv directo: el módulo de OpenCV tiene un .then propio (ver pano-worker.js).
let ready = null;
function loadCV() {
  if (!ready) {
    ready = (async () => {
      importScripts(CV_URL, 'measure-core.js');
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
  const { id, image, ref, quad, warm } = ev.data;
  if (warm) { loadCV().catch(() => {}); return; }
  let mat = null;
  try {
    const { cv } = await loadCV().catch(() => { throw new Error('No se pudo descargar el motor de medición (¿sin conexión?)'); });
    mat = cv.matFromImageData(image);
    self.postMessage({ id, result: MeasureCore.measure(cv, mat, ref, quad) });
  } catch (err) {
    self.postMessage({ id, error: errText(err) });
  } finally {
    mat?.delete();
  }
};

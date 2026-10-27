// Interfaz con el worker de panorámicas (js/pano-worker.js).
let worker = null;
let seq = 0;
const jobs = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker('js/pano-worker.js');
  worker.onmessage = (ev) => {
    const { id, step, done, error, blob, w, h } = ev.data;
    const job = jobs.get(id);
    if (!job) return;
    if (step) job.onStep?.(step);
    if (error) { jobs.delete(id); job.reject(new Error(error)); }
    if (done) { jobs.delete(id); job.resolve({ blob, w, h }); }
  };
  worker.onerror = (ev) => {
    const err = new Error(ev.message || 'Falló el motor de panorámicas');
    for (const j of jobs.values()) j.reject(err);
    jobs.clear();
    worker.terminate();
    worker = null;
  };
  return worker;
}

// Empieza a descargar el motor apenas se activa el modo, así «Unir» no espera la descarga.
export function warmPanorama() { getWorker().postMessage({ warm: true }); }

export function stitchPanorama(blobs, onStep) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    jobs.set(id, { resolve, reject, onStep });
    getWorker().postMessage({ id, blobs });
  });
}

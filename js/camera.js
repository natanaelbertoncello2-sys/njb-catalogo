// Cámara en vivo con getUserMedia (cámara trasera, máxima resolución disponible).
import { makeCanvas, canvasToBlob } from './process.js';

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.track = null;
    this.caps = {};
    this.torch = false;
    this.zoom = 1;
  }

  get active() { return !!this.stream; }

  async start() {
    if (this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador no permite usar la cámara (se necesita HTTPS).');
    const attempts = [
      { facingMode: { ideal: 'environment' }, width: { ideal: 4032 }, height: { ideal: 3024 } },
      { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      { facingMode: 'environment' },
      true,
    ];
    let lastErr;
    for (const video of attempts) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        break;
      } catch (err) {
        lastErr = err;
        if (err.name === 'NotAllowedError') break;
      }
    }
    if (!this.stream) throw lastErr || new Error('Cámara no disponible');
    this.track = this.stream.getVideoTracks()[0];
    this.caps = this.track.getCapabilities?.() || {};
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    await new Promise((r) => (this.video.videoWidth ? r() : this.video.addEventListener('loadedmetadata', r, { once: true })));
    this.torch = false;
    this.zoom = this.track.getSettings?.().zoom || 1;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    this.video.srcObject = null;
  }

  get hasTorch() { return !!this.caps.torch; }
  get zoomRange() { return this.caps.zoom ? [this.caps.zoom.min, this.caps.zoom.max] : null; }

  async setTorch(on) {
    if (!this.hasTorch) return;
    await this.track.applyConstraints({ advanced: [{ torch: on }] });
    this.torch = on;
  }

  async setZoom(z) {
    const r = this.zoomRange;
    if (!r) return;
    this.zoom = Math.min(r[1], Math.max(r[0], z));
    await this.track.applyConstraints({ advanced: [{ zoom: this.zoom }] });
  }

  // Captura el cuadro actual a resolución completa.
  async capture() {
    const v = this.video;
    const w = v.videoWidth, h = v.videoHeight;
    if (!w || !h) throw new Error('La cámara todavía no está lista');
    const cv = makeCanvas(w, h);
    cv.getContext('2d').drawImage(v, 0, 0, w, h);
    const blob = await canvasToBlob(cv, 'image/jpeg', 0.95);
    return { blob, w, h };
  }
}

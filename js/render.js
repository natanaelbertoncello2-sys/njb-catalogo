// Orquesta el pipeline de process.js con cachés para que la vista previa sea fluida.
import {
  loadBitmap, renderGeometry, geomKey, computeAutoMask, computeAIMaskBlob, alphaFromMaskBlob,
  scaleMask, maskBBox, applyColor, compose, makeCanvas, canvasToBlob,
} from './process.js';

const MASK_SIDE = 1100;

class LRU extends Map {
  constructor(limit) { super(); this.limit = limit; }
  get(k) { if (!super.has(k)) return undefined; const v = super.get(k); super.delete(k); super.set(k, v); return v; }
  set(k, v) { super.delete(k); super.set(k, v); while (this.size > this.limit) this.delete(this.keys().next().value); return this; }
}

export class Renderer {
  constructor({ onAIMask } = {}) {
    this.bitmaps = new LRU(3);
    this.masks = new LRU(12);
    this.geoms = new LRU(4);
    this.onAIMask = onAIMask; // (photo, key, blob) => persiste la máscara IA
  }

  forget(id) {
    for (const cache of [this.bitmaps, this.masks, this.geoms]) {
      for (const k of [...cache.keys()]) if (k === id || k.startsWith(id + '|')) cache.delete(k);
    }
  }

  async bitmap(photo) {
    let b = this.bitmaps.get(photo.id);
    if (!b) { b = await loadBitmap(photo.blob); this.bitmaps.set(photo.id, b); }
    return b;
  }

  async geometry(photo, e, maxSide, ignoreCrop = false) {
    const key = `${photo.id}|${geomKey(e)}|${maxSide}|${ignoreCrop}`;
    let g = this.geoms.get(key);
    if (!g) { g = renderGeometry(await this.bitmap(photo), e, maxSide, ignoreCrop); this.geoms.set(key, g); }
    return g;
  }

  maskKey(photo, e) {
    const gk = geomKey(e);
    return e.bg === 'ai' ? `${photo.id}|ai|${gk}` : `${photo.id}|auto|${gk}|${e.tol}|${JSON.stringify(e.wand)}`;
  }

  async mask(photo, e, onProgress) {
    if (e.bg === 'none') return null;
    const key = this.maskKey(photo, e);
    let m = this.masks.get(key);
    if (m) return m;
    const g = await this.geometry(photo, e, MASK_SIDE);
    if (e.bg === 'auto') {
      m = computeAutoMask(g, e);
    } else {
      let blob = photo.aiMask?.key === key ? photo.aiMask.blob : null;
      if (!blob) {
        blob = await computeAIMaskBlob(g, onProgress);
        await this.onAIMask?.(photo, key, blob);
      }
      m = await alphaFromMaskBlob(blob);
    }
    m.bbox = maskBBox(m);
    this.masks.set(key, m);
    return m;
  }

  // Render completo. maxSide: lado mayor de salida (0 = original).
  async render(photo, e, maxSide, { onProgress, cacheGeom = true } = {}) {
    const mask = await this.mask(photo, e, onProgress);
    const geom = cacheGeom
      ? await this.geometry(photo, e, maxSide)
      : renderGeometry(await this.bitmap(photo), e, maxSide);
    const color = makeCanvas(geom.width, geom.height);
    color.getContext('2d').drawImage(geom, 0, 0);
    applyColor(color, e);
    const maskCanvas = mask ? scaleMask(mask, geom.width, geom.height, e.feather) : null;
    return compose(geom, color, maskCanvas, mask?.bbox || null, e, maxSide);
  }

  async exportBlob(photo, e, maxSide, quality, onProgress) {
    const { canvas } = await this.render(photo, e, maxSide, { onProgress, cacheGeom: false });
    return canvasToBlob(canvas, 'image/jpeg', quality);
  }

  async thumbnail(photo, e) {
    try {
      const { canvas } = await this.render(photo, e, 220);
      return await canvasToBlob(canvas, 'image/jpeg', 0.8);
    } catch {
      const g = await this.geometry(photo, e, 220);
      return canvasToBlob(g, 'image/jpeg', 0.8);
    }
  }
}

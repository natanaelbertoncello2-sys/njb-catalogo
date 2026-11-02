// Medidas reales: mide los objetos de una foto en milímetros usando una referencia de tamaño
// conocido en la misma foto (hoja A4 / Carta / Oficio, o una tarjeta tipo DNI/crédito).
// Con las 4 esquinas de la referencia se calcula la perspectiva del plano de apoyo, así que
// las medidas salen bien aunque la foto no esté perfectamente desde arriba.
// Script clásico: lo usa el worker (importScripts) y también se puede probar con Node (require).

/* global self, module */
(function (root) {
  const REFS = {
    A4: { label: 'Hoja A4', long: 297, short: 210, sheet: true },
    CARTA: { label: 'Hoja Carta', long: 279.4, short: 215.9, sheet: true },
    OFICIO: { label: 'Hoja Oficio', long: 355.6, short: 215.9, sheet: true },
    TARJETA: { label: 'Tarjeta (DNI / crédito)', long: 85.6, short: 53.98, sheet: false },
  };
  const CARD_RATIO = 85.6 / 53.98;
  const SHEET_PPM = 4;      // px por mm de la hoja «enderezada»
  const SHEET_MARGIN = 4;   // mm que se ignoran junto al borde de la hoja

  /* ---------------- geometría (sin OpenCV) ---------------- */

  // Homografía 3x3 (h33 = 1) que lleva los 4 puntos src a dst. Puntos: [x, y].
  function homography(src, dst) {
    const a = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
      a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
    }
    for (let c = 0; c < 8; c++) {
      let p = c;
      for (let r = c + 1; r < 8; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
      [a[c], a[p]] = [a[p], a[c]];
      const d = a[c][c];
      if (Math.abs(d) < 1e-12) throw new Error('Esquinas de referencia inválidas');
      for (let k = c; k < 9; k++) a[c][k] /= d;
      for (let r = 0; r < 8; r++) {
        if (r === c || !a[r][c]) continue;
        const f = a[r][c];
        for (let k = c; k < 9; k++) a[r][k] -= f * a[c][k];
      }
    }
    return [...a.map((r) => r[8]), 1];
  }

  const applyH = (h, [x, y]) => {
    const w = h[6] * x + h[7] * y + h[8];
    return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
  };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  // Ordena 4 esquinas: arriba-izq, arriba-der, abajo-der, abajo-izq.
  function orderQuad(pts) {
    const cx = pts.reduce((s, p) => s + p[0], 0) / 4, cy = pts.reduce((s, p) => s + p[1], 0) / 4;
    const s = [...pts].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    let start = 0;
    for (let i = 1; i < 4; i++) if (s[i][0] + s[i][1] < s[start][0] + s[start][1]) start = i;
    return [0, 1, 2, 3].map((i) => s[(start + i) % 4]);
  }

  function convexHull(pts) {
    if (pts.length < 3) return pts.slice();
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }

  function polyArea(p) {
    let s = 0;
    for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; }
    return Math.abs(s) / 2;
  }
  function polyPerimeter(p) {
    let s = 0;
    for (let i = 0; i < p.length; i++) s += dist(p[i], p[(i + 1) % p.length]);
    return s;
  }
  function pointInPoly([x, y], poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[j];
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    }
    return inside;
  }

  // Rectángulo de área mínima (calibres rotantes sobre la envolvente convexa).
  function minAreaRect(hull) {
    let best = null;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length];
      const len = dist(a, b);
      if (len < 1e-9) continue;
      const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (const p of hull) {
        const u = p[0] * ux + p[1] * uy, v = -p[0] * uy + p[1] * ux;
        minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v);
      }
      const area = (maxU - minU) * (maxV - minV);
      if (!best || area < best.area) best = { area, ux, uy, minU, maxU, minV, maxV };
    }
    if (!best) return null;
    const { ux, uy, minU, maxU, minV, maxV } = best;
    const pt = (u, v) => [u * ux - v * uy, u * uy + v * ux];
    return { w: maxU - minU, h: maxV - minV, corners: [pt(minU, minV), pt(maxU, minV), pt(maxU, maxV), pt(minU, maxV)] };
  }

  function isReasonableQuad(q) {
    for (let i = 0; i < 4; i++) {
      const p = q[i], a = q[(i + 3) % 4], b = q[(i + 1) % 4];
      const v1 = [a[0] - p[0], a[1] - p[1]], v2 = [b[0] - p[0], b[1] - p[1]];
      const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2));
      const ang = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
      if (ang < 35 || ang > 145) return false;
    }
    return true;
  }
  function quadAspect(q) {
    const s1 = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2, s2 = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
    return Math.max(s1, s2) / Math.max(1e-6, Math.min(s1, s2));
  }
  const bounds = (pts) => {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const [x, y] of pts) { l = Math.min(l, x); t = Math.min(t, y); r = Math.max(r, x); b = Math.max(b, y); }
    return { l, t, r, b };
  };
  const touches = (pts, w, h, m) => pts.some(([x, y]) => x <= m || y <= m || x >= w - 1 - m || y >= h - 1 - m);

  /* ---------------- visión (OpenCV.js) ---------------- */

  function contoursOf(cv, mask, mode) {
    const cs = new cv.MatVector(), hier = new cv.Mat();
    cv.findContours(mask, cs, hier, mode, cv.CHAIN_APPROX_SIMPLE);
    const out = [];
    for (let i = 0; i < cs.size(); i++) {
      const c = cs.get(i);
      const d = c.data32S, pts = [];
      for (let k = 0; k < d.length; k += 2) pts.push([d[k], d[k + 1]]);
      c.delete();
      out.push(pts);
    }
    cs.delete(); hier.delete();
    return out;
  }

  function approxQuad(cv, hull) {
    if (hull.length < 4) return null;
    const peri = polyPerimeter(hull);
    const curve = cv.matFromArray(hull.length, 1, cv.CV_32SC2, hull.flatMap(([x, y]) => [Math.round(x), Math.round(y)]));
    const approx = new cv.Mat();
    try {
      for (let eps = 0.01; eps <= 0.0801; eps += 0.005) {
        cv.approxPolyDP(curve, approx, eps * peri, true);
        const n = approx.rows;
        if (n === 4) {
          const d = approx.data32S;
          const q = orderQuad([[d[0], d[1]], [d[2], d[3]], [d[4], d[5]], [d[6], d[7]]]);
          return isReasonableQuad(q) ? q : null;
        }
        if (n < 4) return null;
      }
      return null;
    } finally { curve.delete(); approx.delete(); }
  }

  // Bordes de Canny por canal: una tarjeta azul sobre madera puede tener el mismo gris que la mesa.
  function colorEdges(cv, blurRGBA, t1, t2) {
    const ch = new cv.MatVector();
    cv.split(blurRGBA, ch);
    const acc = new cv.Mat(), e = new cv.Mat();
    for (let i = 0; i < 3; i++) {
      const c = ch.get(i);
      cv.Canny(c, i ? e : acc, t1, t2);
      if (i) cv.bitwise_or(acc, e, acc);
      c.delete();
    }
    e.delete(); ch.delete();
    return acc;
  }

  const kernel = (cv, shape, k) => cv.getStructuringElement(shape, new cv.Size(k, k));

  // Una hoja es claramente más clara que lo que la rodea (descarta productos rectangulares).
  function isPaper(gray, q, w, h) {
    const px = (x, y) => gray.data[Math.round(y) * w + Math.round(x)];
    const toImg = homography([[0, 0], [1, 0], [1, 1], [0, 1]], q);
    let inSum = 0, inN = 0, outSum = 0, outN = 0;
    for (let i = 1; i < 10; i++) for (let j = 1; j < 10; j++) {
      const [x, y] = applyH(toImg, [i / 10, j / 10]);
      inSum += px(x, y); inN++;
      const ox = (i / 10) * (w - 1), oy = (j / 10) * (h - 1);
      if (!pointInPoly([ox, oy], q)) { outSum += px(ox, oy); outN++; }
    }
    const inside = inSum / inN, outside = outN ? outSum / outN : 0;
    return inside > 110 && (!outN || inside > outside + 30);
  }

  // La hoja: el cuadrilátero claro más grande que no toque el borde de la foto.
  function findSheet(cv, blurGray, blurRGBA, w, h) {
    const imgArea = w * h;
    let best = null, bestArea = 0;
    const consider = (mask, mode) => {
      for (const c of contoursOf(cv, mask, mode)) {
        if (c.length < 4) continue;
        const hull = convexHull(c);
        const area = polyArea(hull);
        if (area < imgArea * 0.08 || area > imgArea * 0.98 || area <= bestArea) continue;
        if (touches(hull, w, h, 2)) continue;
        const q = approxQuad(cv, hull);
        if (!q) continue;
        const ar = quadAspect(q);
        if (ar < 1 || ar > 2.4 || !isPaper(blurGray, q, w, h)) continue;
        best = q; bestArea = area;
      }
    };
    const bin = new cv.Mat(), opened = new cv.Mat(), dil = new cv.Mat();
    const k5 = kernel(cv, cv.MORPH_RECT, 5), k3 = kernel(cv, cv.MORPH_RECT, 3);
    cv.threshold(blurGray, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(bin, opened, cv.MORPH_OPEN, k5);
    consider(opened, cv.RETR_EXTERNAL);
    const edges = colorEdges(cv, blurRGBA, 30, 90);
    cv.dilate(edges, dil, k3, new cv.Point(-1, -1), 2);
    consider(dil, cv.RETR_LIST);
    [bin, opened, dil, k5, k3, edges].forEach((m) => m.delete());
    return best;
  }

  // Tarjeta: rectángulo con la proporción exacta 85,6 × 54 mm (1,586).
  function findCard(cv, blurRGBA, w, h) {
    const imgArea = w * h;
    let best = null, bestScore = 0;
    for (const [t1, t2] of [[40, 120], [20, 60]]) {
      const edges = colorEdges(cv, blurRGBA, t1, t2);
      const k3 = kernel(cv, cv.MORPH_RECT, 3), dil = new cv.Mat();
      cv.dilate(edges, dil, k3);
      for (const c of contoursOf(cv, dil, cv.RETR_LIST)) {
        if (c.length < 4) continue;
        const hull = convexHull(c);
        const area = polyArea(hull);
        if (area < imgArea * 0.003 || area > imgArea * 0.6 || touches(hull, w, h, 2)) continue;
        const q = approxQuad(cv, hull);
        if (!q) continue;
        const ar = quadAspect(q);
        if (ar < 1.38 || ar > 1.82) continue;
        if (area / Math.max(1, polyArea(q)) < 0.9) continue;
        // Lo que manda es la proporción exacta; el tamaño solo desempata.
        const score = Math.exp(-(((ar - CARD_RATIO) / 0.06) ** 2)) * (1 + 0.05 * area / imgArea);
        if (score > bestScore) { bestScore = score; best = q; }
      }
      [edges, k3, dil].forEach((m) => m.delete());
      if (best) break;
    }
    return best;
  }

  // Objetos por bordes. No necesita contornos cerrados: el rectángulo mínimo se calcula sobre
  // los puntos del borde, así que un contorno abierto mide igual.
  function detectBlobs(cv, rgba, { minSide, closeK, t1, t2, mergeGap, borderTol }) {
    const w = rgba.cols, h = rgba.rows;
    const blur = new cv.Mat(), closed = new cv.Mat();
    cv.GaussianBlur(rgba, blur, new cv.Size(5, 5), 0);
    const edges = colorEdges(cv, blur, t1, t2);
    const kc = kernel(cv, cv.MORPH_ELLIPSE, closeK);
    cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kc);
    let blobs = [];
    for (const pts of contoursOf(cv, closed, cv.RETR_EXTERNAL)) {
      const b = bounds(pts);
      if (Math.max(b.r - b.l, b.b - b.t) < minSide * 0.5) continue;
      blobs.push({ pts, b, partial: touches(pts, w, h, borderTol) });
    }
    [blur, closed, edges, kc].forEach((m) => m.delete());

    // Unimos pedazos del mismo objeto (bordes cortados por reflejos o dibujos).
    const near = (a, b) => a.l - mergeGap <= b.r && b.l <= a.r + mergeGap && a.t - mergeGap <= b.b && b.t <= a.b + mergeGap;
    for (let merged = true; merged;) {
      merged = false;
      outer: for (let i = 0; i < blobs.length; i++) {
        for (let j = i + 1; j < blobs.length; j++) {
          if (!near(blobs[i].b, blobs[j].b)) continue;
          const a = blobs[i], c = blobs[j];
          blobs[i] = { pts: a.pts.concat(c.pts), b: { l: Math.min(a.b.l, c.b.l), t: Math.min(a.b.t, c.b.t), r: Math.max(a.b.r, c.b.r), b: Math.max(a.b.b, c.b.b) }, partial: a.partial || c.partial };
          blobs.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
    return blobs.filter(({ b }) => Math.max(b.r - b.l, b.b - b.t) >= minSide && (b.r - b.l) * (b.b - b.t) < w * h * 0.85);
  }

  function buildObject(mmPts, mmToImg, partial) {
    const hull = convexHull(mmPts);
    if (hull.length < 3) return null;
    const rr = minAreaRect(hull);
    if (!rr) return null;
    const length = Math.max(rr.w, rr.h), width = Math.min(rr.w, rr.h);
    if (width < 1) return null;
    const circ = 4 * Math.PI * polyArea(hull) / polyPerimeter(hull) ** 2;
    const box = rr.corners.map((p) => applyH(mmToImg, p));
    return {
      box,
      outline: hull.map((p) => applyH(mmToImg, p)),
      center: [box.reduce((s, p) => s + p[0], 0) / 4, box.reduce((s, p) => s + p[1], 0) / 4],
      length, width,
      round: circ > 0.88 && length / width < 1.12,
      partial,
    };
  }

  // rgba: cv.Mat RGBA. refKey: clave de REFS. quad: 4 esquinas [[x,y]…] marcadas a mano (opcional).
  function measure(cv, rgba, refKey, quad) {
    const ref = REFS[refKey] || REFS.A4;
    const w = rgba.cols, h = rgba.rows;
    const blurRGBA = new cv.Mat(), gray = new cv.Mat(), blurGray = new cv.Mat();
    cv.GaussianBlur(rgba, blurRGBA, new cv.Size(5, 5), 0);
    cv.cvtColor(blurRGBA, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurGray, new cv.Size(5, 5), 0);
    try {
      let used = refKey in REFS ? refKey : 'A4';
      if (quad) quad = orderQuad(quad);
      else {
        if (ref.sheet) quad = findSheet(cv, blurGray, blurRGBA, w, h);
        if (!quad) { quad = findCard(cv, blurRGBA, w, h); if (quad) used = 'TARJETA'; }
      }
      if (!quad) {
        return { w, h, error: ref.sheet
          ? `No encontré la ${ref.label.replace(/^\S+/, (s) => s.toLowerCase())} ni una tarjeta. Marcá las esquinas a mano.`
          : 'No encontré la tarjeta. Marcá sus esquinas a mano.' };
      }
      const R = REFS[used];
      // ¿El lado «de arriba» de la referencia es el largo o el corto?
      const horiz = dist(quad[0], quad[1]) + dist(quad[3], quad[2]);
      const vert = dist(quad[0], quad[3]) + dist(quad[1], quad[2]);
      const rw = horiz >= vert ? R.long : R.short, rh = horiz >= vert ? R.short : R.long;
      const mmQuad = [[0, 0], [rw, 0], [rw, rh], [0, rh]];
      const toMm = homography(quad, mmQuad);
      const toImg = homography(mmQuad, quad);

      const objects = [];
      if (R.sheet) {
        // Enderezamos la hoja (vista cenital perfecta) sin un margen para no tomar su propio borde.
        const ppm = SHEET_PPM, m = SHEET_MARGIN;
        const H = homography(quad, mmQuad.map(([x, y]) => [(x - m) * ppm, (y - m) * ppm]));
        const M = cv.matFromArray(3, 3, cv.CV_64F, H);
        const warped = new cv.Mat();
        cv.warpPerspective(rgba, warped, M, new cv.Size(Math.round((rw - 2 * m) * ppm), Math.round((rh - 2 * m) * ppm)));
        const blobs = detectBlobs(cv, warped, { minSide: 5 * ppm, closeK: 9, t1: 40, t2: 120, mergeGap: 2 * ppm, borderTol: 1.5 * ppm });
        M.delete(); warped.delete();
        for (const b of blobs) {
          const o = buildObject(b.pts.map(([x, y]) => [x / ppm + m, y / ppm + m]), toImg, b.partial);
          if (o) objects.push(o);
        }
      } else {
        const blobs = detectBlobs(cv, rgba, { minSide: Math.max(w, h) * 0.03, closeK: 5, t1: 50, t2: 150, mergeGap: 3, borderTol: 4 });
        const rb = bounds(quad);
        for (const b of blobs) {
          // Descartamos la propia tarjeta.
          const iw = Math.min(b.b.r, rb.r) - Math.max(b.b.l, rb.l), ih = Math.min(b.b.b, rb.b) - Math.max(b.b.t, rb.t);
          const smaller = Math.min((b.b.r - b.b.l) * (b.b.b - b.b.t), (rb.r - rb.l) * (rb.b - rb.t));
          if (iw > 0 && ih > 0 && iw * ih > 0.5 * smaller) continue;
          const o = buildObject(b.pts.map((p) => applyH(toMm, p)), toImg, b.partial);
          if (o && o.length < 5000) objects.push(o);
        }
      }
      objects.sort((a, b) => b.length * b.width - a.length * a.width);
      return {
        w, h, ref: used, quad, toMm,
        objects: objects.slice(0, 15),
        error: objects.length ? null : 'Encontré la referencia pero ningún objeto. Usá un fondo liso y buena luz.',
      };
    } finally {
      [blurRGBA, gray, blurGray].forEach((m) => m.delete());
    }
  }

  const api = { REFS, measure, homography, applyH, pointInPoly, orderQuad };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MeasureCore = api;
})(typeof self !== 'undefined' ? self : this);
